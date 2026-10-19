import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {readJsonRecord,writeFileDurable} from '../core/durable-file.mjs'
import {acquireLock} from '../locking.mts'
import {readUserGiver} from '../giver-registry.mjs'
import {isAutomatic,roleIdentity,roleModel,roleRouteFromIdentity,roleRouteOf,roleSelection,type Role,type RoleRoute,type RoleSelection} from './role-settings'
import {questSettingsFile} from '../config/quest-settings.mjs'
import {availabilityOf,readRouteLimits,routeLimitsFile,type Availability} from '../../usage/route-limits'
import {accountsForRoute,proxyAccountProvider,readAccountUsage,relevantAccountWindows} from '../../usage-service/on-computer'
import type {AccountSnapshot} from '../../usage-service/on-computer'

export const ROUTE_ROLES=['giver'] as const
export type RouteRole=typeof ROUTE_ROLES[number]
export type RouteState={
 role:RouteRole;set:string;live:string;on:'set'|'fallback';automatic?:boolean;why:string;since:string
 goodAnswers:number;healthySince?:string;moves:{at:string;to:'set'|'fallback';why:string}[]
}
export type RoutesRecord={version:1;roles:Partial<Record<RouteRole,RouteState>>}
export type RouteDecision={kind:'stay'}|{kind:'move';to:'set'|'fallback';route:RoleRoute;why:string}

export const routesFile=(runtime:string)=>join(runtime,'role-routes.json')
const iso=(at:number)=>new Date(at).toISOString()

export function readRoutes(runtime:string):RoutesRecord{
 const row=readJsonRecord<RoutesRecord>(routesFile(runtime))
 return row?.version===1&&row.roles&&typeof row.roles==='object'?row:{version:1,roles:{}}
}

function update(runtime:string,change:(record:RoutesRecord)=>RoutesRecord){
 mkdirSync(runtime,{recursive:true})
 const lock=acquireLock(runtime,'role-routes')
 try{
  const prior=readRoutes(runtime),next=change(prior)
  if(JSON.stringify(next)!==JSON.stringify(prior))writeFileDurable(routesFile(runtime),JSON.stringify(next,null,1))
  return next
 }finally{lock.release()}
}

export function liveRoute(role:RouteRole,runtime:string,file=questSettingsFile()):{selection:RoleSelection;route:RoleRoute;on:'set'|'fallback';automatic?:boolean;state?:RouteState}|undefined{
 const selection=roleSelection(role as Role,file)
 if(!selection)return undefined
 const state=readRoutes(runtime).roles[role]
 if(isAutomatic(selection)){
  const route=state?roleRouteFromIdentity(state.live):undefined
  return route?{selection,route,on:'set',state,automatic:true}:undefined
 }
 const set=roleRouteOf(selection)
 if(!set)return undefined
 const onFallback=state?.on==='fallback'&&!!selection.fallback&&state.set===roleIdentity(set)&&state.live===roleIdentity(selection.fallback)
 return {selection,route:onFallback?selection.fallback!:set,on:onFallback?'fallback':'set',state}
}

export function routeAvailability(route:RoleRoute,at=Date.now(),limits=routeLimitsFile()):Availability{
 return availabilityOf(route.model,at,readRouteLimits(limits))
}

export type UsageAvailability={covered:boolean;state:'available'|'exhausted'|'unknown';until:string|null;why:string}
export function usageAvailability(route:RoleRoute,at=Date.now(),snapshot:AccountSnapshot=readAccountUsage(undefined,at)):UsageAvailability{
 const model=roleModel(route),linked=accountsForRoute(snapshot,model.providerID,model.id)
 const accounts=(linked.length||model.providerID!=='cliproxyapi')?linked:snapshot.accounts.filter(account=>account.provider===proxyAccountProvider(model.id))
 if(!accounts.length)return {covered:false,state:'unknown',until:null,why:'Usage has no account for '+route.model}
 const readings=accounts.map(account=>{
  const windows=relevantAccountWindows(account,model.id)
  const spentWindows=windows.filter(window=>window.state==='exhausted'||(window.remainingPercent!==null&&window.remainingPercent<=0))
  const currentSpent=spentWindows.filter(window=>{
   const reset=window.resetAt?Date.parse(window.resetAt):NaN
   return !Number.isFinite(reset)||reset>at
  })
  const resets=currentSpent.flatMap(window=>{const reset=window.resetAt?Date.parse(window.resetAt):NaN;return Number.isFinite(reset)?[reset]:[]})
  const until=resets.length?new Date(Math.max(...resets)).toISOString():null
  const labels=[...new Set((currentSpent.length?currentSpent:spentWindows).map(window=>window.label||window.id))]
  const named=labels.length?labels.join(', ')+' '+(labels.length===1?'window is':'windows are')+' exhausted':'account is exhausted'
  if(account.state==='exhausted'||currentSpent.length)return {covered:true,state:'exhausted' as const,until,why:account.provider+' '+named+(until?' until '+until:'')}
  if(account.state!=='available')return {covered:true,state:'unknown' as const,until:null,why:account.provider+' usage is '+account.state}
  return {covered:true,state:'available' as const,until:null,why:account.provider+' has usage'}
 })
 const available=readings.find(reading=>reading.state==='available')
 if(available)return available
 const exhausted=readings.filter(reading=>reading.state==='exhausted')
 if(exhausted.length){
  const untils=exhausted.flatMap(reading=>reading.until?[Date.parse(reading.until)]:[]).filter(Number.isFinite)
  return {covered:true,state:'exhausted',until:untils.length?new Date(Math.min(...untils)).toISOString():null,why:exhausted.map(reading=>reading.why).join('; ')}
 }
 return {covered:true,state:'unknown',until:null,why:readings.map(reading=>reading.why).join('; ')}
}
const usageReason=(route:RoleRoute,usage:UsageAvailability)=>
 usage.state==='available'||usage.state==='exhausted'?'Usage says '+usage.why:
 usage.covered?'Usage cannot read '+route.model+' ('+usage.why+'), so its route health decides':
 'Usage does not cover '+route.model+', so its route health decides'

const describe=(route:RoleRoute,availability:Availability)=>route.model+' is '+availability.state+(availability.reason?' ('+availability.reason+')':'')+(availability.until?'; next try '+availability.until:'')

export function evaluateRoute(runtime:string,role:RouteRole,file=questSettingsFile(),at=Date.now(),limits=routeLimitsFile(),snapshot?:AccountSnapshot):RouteDecision{
 const live=liveRoute(role,runtime,file)
 if(!live||live.automatic||!live.selection.fallback)return {kind:'stay'}
 const selection=live.selection,setRoute=roleRouteOf(selection)!,fallback=selection.fallback
 const setA=routeAvailability(setRoute,at,limits),fallbackA=routeAvailability(fallback,at,limits)
 let decision:RouteDecision={kind:'stay'}
 update(runtime,record=>{
  const set=roleIdentity(setRoute),prior=record.roles[role]
  const state:RouteState=prior&&prior.set===set&&!prior.automatic?{...prior}:{role,set,live:set,on:'set',why:'set under Roles',since:iso(at),goodAnswers:0,moves:[]}
  const move=(to:'set'|'fallback',route:RoleRoute,why:string)=>{
   Object.assign(state,{live:roleIdentity(route),on:to,why,since:iso(at),goodAnswers:0,healthySince:undefined,moves:[...state.moves,{at:iso(at),to,why}].slice(-20)})
   decision={kind:'move',to,route,why}
  }
  if(state.on==='set'){
   if(setA.state==='up')state.healthySince=undefined
   else if(fallbackA.state==='up')move('fallback',fallback,describe(setRoute,setA)+'; moved to the fallback without waiting')
   else state.why=describe(setRoute,setA)+'; the fallback is '+fallbackA.state+', so the Quest Giver stays until a route is up'
  }else if(setA.state!=='up'){
   state.healthySince=undefined
  }else{
   state.healthySince??=iso(at)
   const usage=usageAvailability(setRoute,at,snapshot??readAccountUsage(undefined,at))
   const allowed=usage.state!=='exhausted'
   const routeWhy=usageReason(setRoute,usage)
   const minutes=selection.returnAfter?.healthyMinutes,answers=selection.returnAfter?.goodAnswers
   const healthy=minutes!==undefined?at-Date.parse(state.healthySince)>=minutes*60_000:answers!==undefined?state.goodAnswers>=answers:true
   const ready=allowed&&(fallbackA.state!=='up'||healthy)
   if(ready)move('set',setRoute,fallbackA.state!=='up'?describe(fallback,fallbackA)+'; the set route is up and '+routeWhy+', so the Quest Giver returns to it':routeWhy)
   else if(!allowed)state.why=describe(setRoute,setA)+'; '+routeWhy+'; the Quest Giver stays on the fallback'
   else state.why=describe(setRoute,setA)+'; '+routeWhy+'; waiting for its healthy wait'
  }
  return {...record,roles:{...record.roles,[role]:state}}
 })
 return decision
}

export function recordGoodAnswer(runtime:string,role:RouteRole,file=questSettingsFile()){
 const live=liveRoute(role,runtime,file)
 if(!live||live.on!=='fallback')return
 update(runtime,record=>{const state=record.roles[role];if(!state)return record;return {...record,roles:{...record.roles,[role]:{...state,goodAnswers:state.goodAnswers+1}}}})
}

export function nextCheckAt(runtime:string,role:RouteRole,file=questSettingsFile(),at=Date.now(),limits=routeLimitsFile(),snapshot?:AccountSnapshot):number|undefined{
 const live=liveRoute(role,runtime,file)
 if(!live)return undefined
 if(live.automatic){
  const health=routeAvailability(live.route,at,limits),usage=usageAvailability(live.route,at,snapshot??readAccountUsage(undefined,at))
  const times=[
   ...(health.state!=='up'&&health.until?[Date.parse(health.until)]:[]),
   ...(usage.state==='exhausted'&&usage.until?[Date.parse(usage.until)]:[]),
  ].filter(time=>Number.isFinite(time)&&time>at)
  return times.length?Math.min(...times):undefined
 }
 if(live.on!=='fallback')return undefined
 const selection=live.selection,setRoute=roleRouteOf(selection)!
 const usage=usageAvailability(setRoute,at,snapshot??readAccountUsage(undefined,at))
 if(usage.state==='exhausted'){
  const next=usage.until?Date.parse(usage.until):NaN
  return Number.isFinite(next)&&next>at?next:undefined
 }
 const setA=routeAvailability(setRoute,at,limits)
 if(setA.state!=='up'){
  const next=setA.until?Date.parse(setA.until):NaN
  return Number.isFinite(next)&&next>at?next:undefined
 }
 const minutes=selection.returnAfter?.healthyMinutes
 if(minutes===undefined||!live.state?.healthySince)return undefined
 return Date.parse(live.state.healthySince)+minutes*60_000
}

export function modelRouteIdentity(model:any):string|undefined{
 const id=model?.id??model?.modelID
 return typeof model?.providerID==='string'&&typeof id==='string'?model.providerID+'/'+id+(model.variant?'#'+model.variant:''):undefined
}
function boundRoute(runtime:string):string|undefined{
 try{const row=readUserGiver(runtime);return row?.state==='bound'?modelRouteIdentity(row.model):undefined}catch{return undefined}
}
export function recordHandoff(runtime:string,role:RouteRole,why:string,file=questSettingsFile(),at=iso(Date.now()),movedTo?:RoleRoute){
 const selection=roleSelection(role as Role,file)
 if(!selection)return
 if(isAutomatic(selection)){
  const route=movedTo??liveRoute(role,runtime,file)?.route
  if(!route)return
  update(runtime,record=>{
   const prior=record.roles[role],set=roleIdentity(route)
   const state:RouteState={role,set,live:set,on:'set',automatic:true,why,since:at,goodAnswers:0,moves:[...(prior?.moves??[]),{at,to:'set',why}].slice(-20)}
   return {...record,roles:{...record.roles,[role]:state}}
  })
  return
 }
 const live=liveRoute(role,runtime,file)
 if(!live)return
 const setRoute=roleRouteOf(selection)!
 const set=roleIdentity(setRoute),liveRouteIdentity=roleIdentity(movedTo??live.route)
 const on=movedTo?(selection.fallback&&roleIdentity(selection.fallback)===liveRouteIdentity?'fallback':'set'):live.on
 update(runtime,record=>{
  const prior=record.roles[role]
  const state:RouteState=prior&&prior.set===set&&!prior.automatic?{...prior}:{role,set,live:liveRouteIdentity,on,why:'set under Roles',since:at,goodAnswers:0,moves:[]}
  Object.assign(state,{live:liveRouteIdentity,on,why,since:at,moves:[...state.moves,{at,to:on,why}].slice(-20)})
  return {...record,roles:{...record.roles,[role]:state}}
 })
}

export function routesView(runtime:string,file=questSettingsFile(),at=Date.now(),limits=routeLimitsFile()){
 return ROUTE_ROLES.flatMap(role=>{
  const live=liveRoute(role,runtime,file)
  if(!live)return []
  const route=roleIdentity(live.route),bound=boundRoute(runtime),differs=!!bound&&bound!==route
  const automatic=live.automatic===true,setRoute=automatic?live.route:roleRouteOf(live.selection)!
  const set=automatic?route:roleIdentity(setRoute)
  const setA=routeAvailability(setRoute,at,limits)
  return [{role,automatic,set,fallback:automatic?null:live.selection.fallback?roleIdentity(live.selection.fallback):null,live:bound??route,route,differs,on:live.on,why:differs?'the bound session runs '+bound+', not '+route+(automatic?' chosen by automatic routing':' set under Roles'):live.state?.why??(automatic?'automatic routing':'set under Roles'),since:live.state?.since??null,goodAnswers:live.state?.goodAnswers??0,setState:setA.state,setUntil:setA.until,setWait:setA.cls,moves:(live.state?.moves??[]).slice(-5)}]
 })
}
