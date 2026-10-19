import {existsSync,mkdirSync,readFileSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {digest} from '../privacy'
import {ownerAlive} from '../locking.mts'
import {runFileStem,writeFileDurable} from '../core/durable-file.mjs'
import type {PermissionDecision} from './permission-jev'
import {decisionsFile,readDecisions} from './decision-log'

export const UNANSWERED_ASK='Permission ask went unanswered'
export type DecisionTimes={count:number;p99?:number;max?:number}
export type AskWatch={askedAt:number;checkedAt?:number;dueAt?:number}
export type WatchVerdict={act:'wait';dueAt?:number;watch:AskWatch}|{act:'stop';reason:string;watch:AskWatch}
export type RoleState={inFlight:boolean;hostAlive:boolean;startedAt?:number}

const signature=(runtime:string)=>[decisionsFile(runtime),join(runtime,'permission-decisions','attempts'),join(runtime,'permission-allowers','attempts')].map(path=>{try{const stat=statSync(path);return stat.mtimeMs+'/'+stat.size}catch{return '-'}}).join(' ')
const cache=new Map<string,{key:string;times:DecisionTimes}>()
export function decisionTimes(runtime:string):DecisionTimes{
 const key=signature(runtime),held=cache.get(runtime)
 if(held?.key===key)return held.times
 const values=readDecisions(runtime).filter(row=>row.decision!=='user'&&typeof row.ms==='number'&&Number.isFinite(row.ms)&&row.ms>=0).map(row=>row.ms!)
 values.sort((a,b)=>a-b)
 const times:DecisionTimes=values.length?{count:values.length,p99:values[Math.max(0,Math.ceil(values.length*.99)-1)],max:values.at(-1)}:{count:0}
 cache.set(runtime,{key,times})
 return times
}

const callCache=new Map<string,{key:string;perModel:Map<string,number[]>}>()
export function jevCallTimes(runtime:string,model:string):DecisionTimes{
 const key=signature(runtime)
 let held=callCache.get(runtime)
 if(held?.key!==key){
  const perModel=new Map<string,number[]>()
  for(const row of readDecisions(runtime)){
   if(row.by!=='jev'||!row.model||row.decision==='user'||typeof row.ms!=='number'||!(row.ms>=0)||!row.calls||!(row.calls>0))continue
   perModel.set(row.model,[...(perModel.get(row.model)??[]),row.ms/row.calls])
  }
  for(const values of perModel.values())values.sort((a,b)=>a-b)
  held={key,perModel}
  callCache.set(runtime,held)
 }
 const values=held.perModel.get(model)
 return values?.length?{count:values.length,p99:values[Math.max(0,Math.ceil(values.length*.99)-1)],max:values.at(-1)}:{count:0}
}

export const permissionJevLockName=(giverID:string,requestKey:string)=>'permission-jev-'+digest(giverID+requestKey)
export function roleState(runtime:string,giverID:string|undefined,requestKey:string,decision:PermissionDecision|undefined,alive=ownerAlive):RoleState{
 if(!giverID)return {inFlight:false,hostAlive:false}
 const path=join(runtime,'locks',runFileStem(permissionJevLockName(giverID,requestKey))+'.lock')
 if(existsSync(path))try{
  const stat=statSync(path),owner=JSON.parse(readFileSync(stat.isDirectory()?join(path,'owner.json'):path,'utf8'))
  return {inFlight:true,hostAlive:alive(Number(owner.pid),String(owner.processStart)),startedAt:stat.mtimeMs}
 }catch{}
 if(decision&&['retrying','checking'].includes(decision.state))return {inFlight:true,hostAlive:true}
 return {inFlight:false,hostAlive:true}
}

const seconds=(ms:number)=>Math.round(ms/100)/10+'s'
export function watchdogVerdict(input:{watch:AskWatch;now:number;times:DecisionTimes;role:()=>RoleState;ask:string}):WatchVerdict{
 const {now,times,ask}=input,watch={...input.watch}
 const limit=times.p99??0
 if(watch.checkedAt===undefined||watch.dueAt===undefined){
  if(now<watch.askedAt+limit)return {act:'wait',dueAt:watch.askedAt+limit,watch:{...watch,dueAt:watch.askedAt+limit}}
  const role=input.role()
  watch.checkedAt=now
  const measured=times.p99===undefined?'the permission role has no measured decisions':'past the permission role p99 of '+seconds(limit)+' from '+times.count+' decisions'
  if(!role.hostAlive)return {act:'stop',watch,reason:UNANSWERED_ASK+' ('+measured+'; its host is down): '+ask}
  if(!role.inFlight)return {act:'stop',watch,reason:UNANSWERED_ASK+' ('+measured+'; no decision was in flight): '+ask}
  if(times.max===undefined)return {act:'wait',watch}
  const dueAt=Math.max(now,(role.startedAt??now)+times.max)
  return {act:'wait',dueAt,watch:{...watch,dueAt}}
 }
 if(watch.dueAt===undefined||now<watch.dueAt)return {act:'wait',dueAt:watch.dueAt,watch}
 return {act:'stop',watch,reason:UNANSWERED_ASK+' (its decision ran past the permission role max of '+seconds(times.max??0)+'): '+ask}
}

export function logUnanswered(runtime:string,record:{questID:string;runID:string;requestID:string;requestKey:string;action:string;resources:string[];ask:string;reason:string;times:DecisionTimes;askedAt:number}){
 try{
  const directory=join(runtime,'permission-decisions','unanswered')
  mkdirSync(directory,{recursive:true})
  writeFileDurable(join(directory,digest(record.requestKey)+'.json'),JSON.stringify({...record,askedAt:new Date(record.askedAt).toISOString(),at:new Date().toISOString()}))
 }catch(error){console.error('[quests] unanswered ask not logged',error instanceof Error?error.message:error)}
}
