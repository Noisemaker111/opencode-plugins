import {createHash} from 'node:crypto'
import {giverStartModel,replaceUserGiver,setUserGiverModel} from './user-giver'
import {pictureHandoff} from '../board/pictures'
import {liveRoute,modelRouteIdentity,recordHandoff,recordGoodAnswer,evaluateRoute,nextCheckAt,routeAvailability,usageAvailability,ROUTE_ROLES,type RouteRole,type RouteDecision} from '../routing/role-routes'
import {isAutomatic,roleIdentity,roleModel,roleRouteFromIdentity,roleSelection,type RoleRoute} from '../routing/role-settings'
import {chooseGiverRoute,routeModelDeprecated} from '../routing/role-route-choice'
import {questSettingsFile} from '../config/quest-settings.mjs'
import {contextGrowth,historyOverBudget} from '../board/context-growth'
import {readSessionRequests,TELEMETRY_FILE} from '../../usage/telemetry-store'
import {readUserGiver,saveUserGiver} from '../giver-registry.mjs'
import {readAccountUsage} from '../../usage-service/on-computer'
import {timerWait,type Wait} from '../core/timer'
import {discardSession} from '../routing/bind-and-ask'
import type {QuestStore} from '../store'
import type {QuestHost} from '../runs/runtime'

const unwrap=(value:any)=>value?.data??value

export async function handOffGiver(store:QuestStore,host:Pick<QuestHost,'create'|'get'>&Partial<Pick<QuestHost,'prompt'|'interrupt'>>,directory:string,why:string,options:{route?:RoleRoute;telemetryFile?:string;file?:string;notify?:boolean}={}){
 const note=pictureHandoff(store,why,{telemetryFile:options.telemetryFile})
 const file=options.file??questSettingsFile(),current=liveRoute('giver',store.runtime,file)
 const selected=options.route?roleModel(options.route):await giverStartModel(file,current?.automatic?current.route:undefined)
 const result=await replaceUserGiver(store,host as any,directory,{model:selected})
 if(options.notify===false){const giver=readUserGiver(store.runtime);if(giver?.sessionID===result.sessionID)saveUserGiver(store.runtime,{...giver,generation:process.env.OPENCODE_PLUGIN_GENERATION})}
 const identity=modelRouteIdentity(result.model),movedTo=identity?roleRouteFromIdentity(identity):undefined
 try{recordHandoff(store.runtime,'giver',why,options.file??questSettingsFile(),undefined,movedTo)}catch(error){console.error('[quests] Quest Giver move not recorded',error instanceof Error?error.message:error)}
 if(options.notify===false||typeof host.prompt!=='function')return {...result,handoff:'not sent' as const}
 const messageID='msg_giverhandoff'+createHash('sha256').update(result.sessionID+note).digest('hex').slice(0,20)
 await host.prompt({sessionID:result.sessionID,id:messageID,delivery:'queue',resume:false,text:note,metadata:{questGiverHandoff:true}})
 return {...result,handoff:'sent' as const,messageID}
}


export type RoleSessionHost=Pick<QuestHost,'create'|'get'|'prompt'>&Partial<Pick<QuestHost,'generate'|'switchModel'|'interrupt'|'context'>>&{delete?:(input:any)=>Promise<any>}

export async function probeRoute(host:RoleSessionHost,directory:string,route:RoleRoute):Promise<boolean>{
 if(typeof host.generate!=='function')return false
 let created:any
 try{
  created=unwrap(await host.create({title:'Route probe',agent:'speed-calibration',model:roleModel(route),location:{directory}}))
  if(!created?.id)return false
  const answer=unwrap(await host.generate({sessionID:created.id,prompt:'Answer with the single word ready.'}))
  return typeof answer?.text==='string'&&answer.text.trim().length>0
 }catch{return false}
 finally{if(created?.id)await discardSession(host,created.id)}
}

export function roleSessionID(store:Pick<QuestStore,'runtime'>,role:RouteRole){
 try{const row=readUserGiver(store.runtime);return row?.state==='bound'?row.sessionID as string:undefined}catch{return undefined}
}

export class RoleRouteWatch{
 private waits=new Map<RouteRole,()=>void>()
 constructor(readonly store:QuestStore,readonly host:RoleSessionHost,readonly directory:string,readonly options:{file?:string;telemetryFile?:string;wait?:Wait;clock?:()=>number;choose?:()=>Promise<{route:RoleRoute;why:string}>}={}){}
 private file(){return this.options.file??questSettingsFile()}
 private now(){return (this.options.clock??Date.now)()}
 private chooseRoute(){return (this.options.choose??(()=>chooseGiverRoute({file:this.file(),now:this.now()})))()}
 private roleOf(sessionID:string|undefined):RouteRole|undefined{return ROUTE_ROLES.find(role=>!!sessionID&&roleSessionID(this.store,role)===sessionID)}
 async observe(event:any){
  const type=String(event?.type??''),role=this.roleOf(event?.data?.sessionID)
  if(!role)return
  if(type==='session.execution.failed'||type==='session.error')await this.evaluate(role)
  else if(type==='session.execution.succeeded'){
   recordGoodAnswer(this.store.runtime,role,this.file())
   await this.evaluate(role)
   if(await this.drift(role,event?.data?.model))return
   await this.budget(role,'its history passed the budget set under Roles')
  }
 }
 async settle(review=false){for(const role of ROUTE_ROLES){if(review&&role==='giver'&&isAutomatic(roleSelection('giver',this.file())))await this.reviewAutomatic(role);else await this.evaluate(role)}}
 private async reviewAutomatic(role:RouteRole){
  if(role!=='giver'||!isAutomatic(roleSelection('giver',this.file())))return
  const binding=readUserGiver(this.store.runtime)
  if(binding?.state!=='bound'||!binding.sessionID)return
  const running=modelRouteIdentity(binding.model)
  if(!running)return
  try{
   const choice=await this.chooseRoute()
   if(running!==roleIdentity(choice.route))await this.handoff(role,choice.route,choice.why)
  }catch(error){console.error('[quests] automatic Quest Giver route not reviewed',error instanceof Error?error.message:error)}
  this.arm(role)
 }
 private health=new Map<string,boolean>()
 async healthChange(model:{providerID?:string;id?:string}|undefined,answered=true){
  if(!model?.providerID||!model.id)return
  const key=model.providerID+'/'+model.id,before=this.health.get(key)
  this.health.set(key,answered)
  if(!answered||before!==false)return
  await this.settle()
 }
 async settingsChanged(){
  for(const role of ROUTE_ROLES){
   if(role==='giver'&&isAutomatic(roleSelection('giver',this.file())))await this.reviewAutomatic(role)
   else await this.drift(role)
  }
 }
 private drifted=new Set<string>()
 private async drift(role:RouteRole,model?:unknown):Promise<boolean>{
  if(role!=='giver')return false
  const live=liveRoute(role,this.store.runtime,this.file())
  const binding=readUserGiver(this.store.runtime)
  if(!live||binding?.state!=='bound'||!binding.sessionID)return false
  const running=modelRouteIdentity(model)??modelRouteIdentity(binding.model),wanted=roleIdentity(live.route)
  if(!running||running===wanted)return false
  const key=binding.sessionID+' '+wanted
  if(this.drifted.has(key))return false
  this.drifted.add(key)
  await this.handoff(role,live.route,'it ran on '+running+' while Roles sets '+wanted)
  return true
 }
 async questEnded(){for(const role of ROUTE_ROLES)await this.budget(role,'a Quest ended',true)}
 private async budget(role:RouteRole,why:string,ended=false){
  const live=liveRoute(role,this.store.runtime,this.file()),sessionID=roleSessionID(this.store,role)
  if(!live?.selection.historyBudget||!sessionID)return
  if(role==='giver')return
  const growth=contextGrowth(sessionID,readSessionRequests(sessionID,this.options.telemetryFile??TELEMETRY_FILE).records)
  if(!historyOverBudget(growth,ended?Math.floor(live.selection.historyBudget/2):live.selection.historyBudget))return
  await this.handoff(role,live.route,why)
 }
 private async evaluate(role:RouteRole){
  const live=liveRoute(role,this.store.runtime,this.file())
  if(live?.automatic)return this.apply(role,await this.evaluateAutomatic(live))
  if(role==='giver'&&isAutomatic(roleSelection('giver',this.file()))){
   try{
    const choice=await chooseGiverRoute({file:this.file(),now:this.now()})
    recordHandoff(this.store.runtime,'giver',choice.why,this.file(),undefined,choice.route)
    const binding=readUserGiver(this.store.runtime),running=modelRouteIdentity(binding?.model)
    if(binding?.state==='bound'&&binding.sessionID&&running&&running!==roleIdentity(choice.route))await this.handoff(role,choice.route,choice.why)
    this.arm(role)
   }catch(error){console.error('[quests] automatic Quest Giver route not chosen',error instanceof Error?error.message:error)}
   return
  }
  await this.apply(role,evaluateRoute(this.store.runtime,role,this.file(),this.now()))
 }
 private async evaluateAutomatic(live:ReturnType<typeof liveRoute>):Promise<RouteDecision>{
  const now=this.now()
  if(!live)return {kind:'stay'}
  const health=routeAvailability(live.route,now),usage=usageAvailability(live.route,now),deprecated=await routeModelDeprecated(live.route,now).catch(()=>undefined)
  if(health.state!=='down'&&usage.state!=='exhausted'&&deprecated!==true)return {kind:'stay'}
  try{
   const choice=await chooseGiverRoute({file:this.file(),now})
   if(roleIdentity(choice.route)===roleIdentity(live.route))return {kind:'stay'}
   return {kind:'move',to:'set',route:choice.route,why:choice.why}
  }catch(error){
   console.error('[quests] automatic Quest Giver route not chosen',error instanceof Error?error.message:error)
   return {kind:'stay'}
  }
 }
 private async apply(role:RouteRole,decision:RouteDecision){
  if(decision.kind==='move')await this.handoff(role,decision.route,decision.why)
  this.arm(role)
 }
 private async handoff(role:RouteRole,route:RoleRoute,why:string){
  try{
   await this.keepGiver(route,why)
  }catch(error){console.error('[quests] '+role+' handoff failed',error instanceof Error?error.message:error)}
 }
 private async keepGiver(route:RoleRoute,why:string){
  const sessionID=roleSessionID(this.store,'giver')
  if(!sessionID)return
  if(typeof this.host.switchModel!=='function'){console.error('[quests] the Quest Giver stays on its session and route: the host cannot switch its model, and only the user replaces a Quest Giver ('+why+')');return}
  await setUserGiverModel(this.store,this.host as any,sessionID,roleModel(route))
  recordHandoff(this.store.runtime,'giver',why,this.file(),undefined,route)
 }
 private arm(role:RouteRole){
  this.waits.get(role)?.();this.waits.delete(role)
  const due=nextCheckAt(this.store.runtime,role,this.file(),this.now())
  if(due===undefined)return
  this.waits.set(role,(this.options.wait??timerWait)(Math.max(0,due-this.now()),()=>{this.waits.delete(role);void this.evaluate(role)}))
 }
 dispose(){for(const cancel of this.waits.values())cancel();this.waits.clear()}
}

export function resetWatch(file?:string,clock=()=>Date.now()){
 let known:Map<string,string|null>|undefined
 const read=()=>new Map(readAccountUsage(file,clock()).accounts.flatMap(account=>account.windows.map(window=>[account.id+'/'+window.id,window.resetAt] as [string,string|null])))
 return {seen(){
  let next:Map<string,string|null>
  try{next=read()}catch{return false}
  const before=known
  known=next
  return !!before&&[...next].some(([key,at])=>before.has(key)&&before.get(key)!==at&&!!before.get(key)&&Date.parse(before.get(key)!)<=clock())
 }}
}

export function endedQuestWatch(store:Pick<QuestStore,'projectRoot'|'read'>){
 const over=(q:any)=>!!q&&(q.state==='Archived'||q.stages.length>0&&q.stages.every((step:any)=>step.status==='done'))
 const known=new Map<string,boolean>()
 return {seen(name?:string){
  const id=name?.endsWith('.md')?name.slice(0,-3):undefined
  if(!id)return false
  let quest:any
  try{quest=store.read(id)}catch{return false}
  const ended=over(quest),before=known.get(id)
  known.set(id,ended)
  return ended&&before===false
 }}
}
