import {appendFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {dirname} from 'node:path'
import {COMPACTION_CONSIDER_TOKENS} from './compaction-floor'
import {acquireLock,LockBusyError} from '../locking.mts'
import {ownHostEndpoint} from '../host/host-role'
import {confirmWorkerIdle} from '../workers/worker-inspection'
import {boundedInspection} from '../worker-observation.mjs'
import {readRequestsSince,TELEMETRY_FILE,type TelemetryCursor} from '../../usage/telemetry-store'
import {outputIncludingReasoning,type RequestRecord} from '../../usage/telemetry'
import {enforceJsonlBudget,TELEMETRY_BUDGET} from '../../scripts/telemetry-budget.mjs'
const unwrap=(value:any)=>value?.data??value
export const COMPACTION_FORCE_TOKENS=110_000
export const COMPACTION_REGROWTH_TOKENS=20_000
export const COMPACTION_RETRY_MS=10*60_000
export type CompactionReason='below-window'|'regrowth'|'mid-task'|'natural-boundary'|'forced'|'missing-tokens'
export type GiverCompactionDecision={context:number|null;due:boolean;requests:number;reason:CompactionReason}
export type CompactionEndpoint={url:string;authorization:string}
const LOCAL_HOSTS=new Set(['127.0.0.1','localhost','[::1]'])
const promptTokens=(r:RequestRecord)=>{const {input,cacheRead,cacheWrite}=r.tokens;return input===null||cacheRead===null||cacheWrite===null?null:input+cacheRead+cacheWrite}
const contextTokens=(r:RequestRecord)=>{const prompt=promptTokens(r);return prompt===null?null:prompt+(outputIncludingReasoning(r)??0)}
export function giverCompactionDue(requests:RequestRecord[],boundary:{quiet:boolean;compacted:boolean}):GiverCompactionDecision{
 const ordered=[...requests].sort((a,b)=>a.startedAt-b.startedAt),context=ordered.length?contextTokens(ordered.at(-1)!):null
 const decide=(due:boolean,reason:CompactionReason):GiverCompactionDecision=>({context,due,requests:ordered.length,reason})
 if(context===null)return decide(false,'missing-tokens')
 if(context<COMPACTION_CONSIDER_TOKENS)return decide(false,'below-window')
 if(boundary.compacted&&context-(contextTokens(ordered[0])??context)<COMPACTION_REGROWTH_TOKENS)return decide(false,'regrowth')
 if(context>=COMPACTION_FORCE_TOKENS)return decide(true,'forced')
 return boundary.quiet?decide(true,'natural-boundary'):decide(false,'mid-task')
}
export function compactionRequestID(sessionID:string,since:number|null){
 const time=BigInt.asUintN(48,BigInt(Math.trunc(since??0))*0x1000n).toString(16).padStart(12,'0')
 return 'msg_'+time+createHash('sha256').update(sessionID+':'+(since??'start')).digest('hex').slice(0,14)
}
export const SUMMARY_RESOLVED_RULES=[
 '- Drop every question, open item and blocker that a later message answered or made moot; keep only what is still unresolved after the latest message.',
 '- When the user has made a choice, record the choice as a decision and do not list the question again.',
 '- When the previous summary and the newer history disagree, the newer history wins.',
].join('\n')
export const SUMMARY_RESOLVED_NOTE='Rules for the conversation summary:\n'+SUMMARY_RESOLVED_RULES
export function hostSummarizeAdapter(endpoint:CompactionEndpoint,transport:typeof fetch=fetch){
 const url=new URL(endpoint.url)
 if(!LOCAL_HOSTS.has(url.hostname)||!['http:','https:'].includes(url.protocol))throw new Error('Compaction needs the owning local host endpoint')
 return async(input:{sessionID:string;providerID:string;modelID:string;id?:string})=>{
  const response=await transport(new URL('/api/session/'+encodeURIComponent(input.sessionID)+'/compact',url),{method:'POST',headers:{'content-type':'application/json',authorization:endpoint.authorization},body:JSON.stringify({...(input.id?{id:input.id}:{}),delivery:'queue'}),signal:AbortSignal.timeout(20_000)})
  if(response.status===409){await response.body?.cancel();return {requestedAt:Date.now(),duplicate:true}}
  if(!response.ok)throw new Error('Host compaction request failed ('+response.status+'); the history is unchanged')
  await response.body?.cancel()
  return {requestedAt:Date.now(),duplicate:false}
 }
}
async function lastCompaction(host:any,sessionID:string){
 if(typeof host.context!=='function')throw Error('The host does not expose session context, so the last compaction is unknown')
 const messages=unwrap(await boundedInspection((signal:AbortSignal)=>host.context({sessionID},{signal})))
 if(!Array.isArray(messages))throw Error('The host returned no context for the session')
 if(messages[0]?.type!=='compaction')return null
 const at=Number(messages[0].time?.created)
 if(!Number.isFinite(at))throw Error('The latest compaction has no time')
 return at
}
async function hostQuiet(host:any,sessionID:string){
 if(typeof host.active!=='function')return false
 try{const active=unwrap(await boundedInspection((signal:AbortSignal)=>host.active({signal})));return !!active&&typeof active==='object'&&Object.keys(active).every(id=>id===sessionID)}catch{return false}
}
export type GiverCompactionOptions={telemetryFile?:string;decisionsFile?:string;endpoint?:()=>CompactionEndpoint|undefined;transport?:typeof fetch}
export function giverCompaction(runtime:string,host:any,options:GiverCompactionOptions={}){
 const file=options.telemetryFile??TELEMETRY_FILE,decisions=options.decisionsFile??file+'.giver-compaction.jsonl'
 const endpoint=options.endpoint??ownHostEndpoint
 let cursor:TelemetryCursor|null=null
 const rows=new Map<string,Map<string,RequestRecord>>(),evaluated=new Map<string,string>(),pending=new Map<string,number>(),retryAt=new Map<string,number>()
 const requests=(sessionID:string)=>{
  if(!rows.has(sessionID))rows.set(sessionID,new Map())
  const next=readRequestsSince(cursor,file)
  if(next.restarted)for(const map of rows.values())map.clear()
  cursor=next.cursor
  for(const r of next.records){const map=rows.get(r.sessionID);if(map)map.set(r.id,r)}
  return [...rows.get(sessionID)!.values()].filter(r=>r.state==='completed'&&r.kind==='primary')
 }
 const record=(row:object)=>{const lock=acquireLock(dirname(decisions),'giver-compaction-decisions');try{mkdirSync(dirname(decisions),{recursive:true});appendFileSync(decisions,JSON.stringify(row)+'\n',{mode:0o600});enforceJsonlBudget(decisions,TELEMETRY_BUDGET.decisionsBytes)}finally{lock.release()}}
 const settle=(sessionID:string,row:object)=>{try{record({sessionID,at:Date.now(),...row})}catch(error){console.error('[quests] compaction outcome not recorded',error instanceof Error?error.message:error)}}
 const failed=(sessionID:string,row:object,error:unknown)=>{retryAt.set(sessionID,Date.now()+COMPACTION_RETRY_MS);const result={...row,outcome:'failed',error:String(error instanceof Error?error.message:error).slice(0,1000)};record(result);return result}
 return {
  decisionsFile:decisions,
  observe(event:any){
   const type=String(event?.type??''),sessionID=event?.data?.sessionID??event?.properties?.sessionID
   if(typeof sessionID!=='string')return
   if(type==='session.compaction.started'){if(!pending.has(sessionID))pending.set(sessionID,Date.now());return}
   if(!pending.has(sessionID))return
   if(type==='session.compaction.ended'){pending.delete(sessionID);settle(sessionID,{outcome:'applied'})}
   else if(type==='session.compaction.failed'){pending.delete(sessionID);retryAt.set(sessionID,Date.now()+COMPACTION_RETRY_MS);settle(sessionID,{outcome:'failed',error:String(event?.data?.error?.message??'The host reported no reason').slice(0,1000)})}
  },
  async evaluate(sessionID:string){
   const done=requests(sessionID),latest=done.reduce<RequestRecord|undefined>((a,r)=>!a||r.startedAt>a.startedAt?r:a,undefined)
   if(!latest||latest.id===evaluated.get(sessionID)||Date.now()<(retryAt.get(sessionID)??0))return
   if(!await confirmWorkerIdle(host,sessionID))return
   let lock
   try{lock=acquireLock(runtime,'giver-compaction',{timeoutMs:0})}catch(error){if(error instanceof LockBusyError)return;throw error}
   try{
    const since=await lastCompaction(host,sessionID),asked=pending.get(sessionID)
    if(asked!==undefined){
     if(since!==null&&since>=asked)pending.delete(sessionID)
     else if(Date.now()-asked<COMPACTION_RETRY_MS)return
     else{pending.delete(sessionID);settle(sessionID,{outcome:'lost'})}
    }
    const row={sessionID,at:Date.now(),since,...giverCompactionDue(done.filter(r=>since===null||r.startedAt>since),{quiet:await hostQuiet(host,sessionID),compacted:since!==null}),latestRequestID:latest.id}
    if(row.reason!=='mid-task')evaluated.set(sessionID,latest.id)
    if(!row.due){record({...row,outcome:'retained'});return row}
    const current=unwrap(await host.get({sessionID})),model=current?.model
    const target=endpoint()
    if(typeof model?.providerID!=='string'||typeof model?.id!=='string')return failed(sessionID,row,'The session reports no model to summarize with')
    if(!target)return failed(sessionID,row,'This host has no connector record naming its own endpoint, so it cannot compact a session')
    const at=Date.now()
    try{
     const asked=await hostSummarizeAdapter(target,options.transport)({sessionID,providerID:model.providerID,modelID:model.id,id:compactionRequestID(sessionID,since)})
     if(asked.duplicate){pending.set(sessionID,at);const result={...row,outcome:'already-requested'};record(result);return result}
     pending.set(sessionID,at);const result={...row,outcome:'requested',model:{providerID:model.providerID,modelID:model.id}};record(result);return result}
    catch(error){console.error('[quests] compaction failed; the history is unchanged',error instanceof Error?error.message:error);return failed(sessionID,row,error)}
   }finally{lock.release()}
  },
 }
}
