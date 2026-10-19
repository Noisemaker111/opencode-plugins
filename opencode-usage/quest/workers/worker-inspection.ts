import {existsSync} from 'node:fs'
import { noteReason, plainWords, sentence } from '../review/plain-words'
import {hostExecution,hostPermissions,hostSettledIdleSince,recordHostActivity} from "../host/host-observation"
import {HOST_NEVER_STARTED,WORKER_ENDED_EMPTY} from "../giver/giver-wake"
import {observeNoTurn} from "../../usage/route-limits"
import {interruptedPreflight,interruptedBoundDispatch,dispatchOwner} from '../runs/dispatch-intent'
import { observeWorker, observationFailure, boundedInspection } from '../worker-observation.mjs'
import { terminalStepUpdates } from '../runs/session-lineage'
import { redact } from '../privacy'
import { QuestTracker, runSettlement } from '../runs/tracker'
import { readAllQuests } from '../index'
import { mergedPullRequest, refreshPullRequest, statusReader } from '../runs/run-status'
import { waterfallSources } from '../bench/quest-waterfall'
import type { QuestStore } from '../store'
import type { QuestSession } from '../types'
const unwrap = (value:any) => value?.data ?? value
const HOST_STARTED_AT = Date.now() - (typeof process?.uptime === 'function' ? process.uptime() * 1000 : 0)
export const SETTLED_OBSERVATION = new Set(['completed','failed','interrupted','cancelled','missing','stale'])
const OWNED_RUN = ['planned','executing','waiting','blocked']
export async function confirmWorkerIdle(host:any,sessionID:string):Promise<boolean> {
 try {
  if(typeof host.active==='function'){
   const active=unwrap(await boundedInspection(signal=>host.active({signal})))
   recordHostActivity(host,active)
   if(active&&typeof active==='object')return !Object.hasOwn(active,sessionID)
  }
  const observed=hostExecution(host,sessionID)
  if(observed!==undefined)return observed===false
  if(typeof host.wait!=='function')return false
  await boundedInspection(signal=>host.wait({sessionID},{signal}))
  return hostExecution(host,sessionID)!==true
 }catch{return false}
}
export async function inspectWorker(host:any, run:QuestSession, options:{active?:Record<string,unknown>;messages?:boolean}={}):Promise<any> {
 const sessionID=run.openCodeSessionId??run.openCodeSessionID??run.sessionID
 if(!sessionID) return {state:run.state==='planned'?'launching':run.state==='failed'?'failed':'queued',reason:run.result??'No worker session was confirmed'}
 if(!sessionID.startsWith('ses_')||run.harness)return {state:'external',reason:'External runtime; no native OpenCode session can be confirmed'}
 try {
  const row=unwrap(await boundedInspection(signal=>host.get({sessionID},{signal})))
  if(row?.id!==sessionID)return {state:'missing',reason:'Recorded session was not returned by its owning host; the run is over and the step is free to redispatch'}
  const active=options.active??(typeof host.active==='function'?unwrap(await boundedInspection(signal=>host.active({signal}))):undefined)
  const hostSaysIdle=active!==undefined?!Object.hasOwn(active??{},sessionID):hostExecution(host,sessionID)===false
  const wantsMessages=options.messages===true||options.messages!==false&&hostSaysIdle&&((!row?.outcome&&['executing','waiting'].includes(run.state))||run.permissionDecisions?.some(d=>d.reply==='reject'&&d.state==='acknowledged'))
  const messages=wantsMessages&&typeof host.context==='function'?unwrap(await boundedInspection(signal=>host.context({sessionID},{signal}))):[]
  const permissions=unwrap(await boundedInspection(()=>hostPermissions(host,sessionID)))
  return observeWorker(row,{active:active===undefined?hostExecution(host,sessionID):Object.hasOwn(active,sessionID),messages:Array.isArray(messages)?messages.slice(-3):[],permissions,expected:run})
 }catch(error){return observationFailure(error)}
}
export async function workerAnsweredAt(host:any,run:QuestSession):Promise<string|undefined>{
 const sessionID=run.openCodeSessionId??run.openCodeSessionID??run.sessionID
 if(!sessionID?.startsWith('ses_')||typeof host.context!=='function')return undefined
 try{
  const messages=unwrap(await boundedInspection(signal=>host.context({sessionID},{signal})))
  const times=(Array.isArray(messages)?messages:[]).filter((m:any)=>m?.type==='assistant').map((m:any)=>{const at=m.time?.completed??m.time?.streamed;return typeof at==='number'?at:Date.parse(at??'')}).filter(Number.isFinite)
  return times.length?new Date(Math.max(...times)).toISOString():undefined
 }catch{return undefined}
}
type Sweep={active?:Record<string,unknown>;elsewhere?:Record<string,unknown>}
const observed=new WeakMap<object,Map<string,string>>()
export function forgetWorkerSweeps(host:object){observed.delete(host)}
const ownerState=(runtime:string|undefined,run:QuestSession)=>{const owner=runtime?dispatchOwner(runtime,run.runID??run.callID):undefined;return owner?owner.holding?'held':owner.alive?'alive':'gone':'-'}
function questFingerprint(quest:any,sweep:Sweep,now:number,host:object,runtime?:string){
 const parts=[String(quest.revision)]
 for(const run of quest.sessions as QuestSession[]){
   const refused=run.state==='cancelled'&&run.permissionDecisions?.some(d=>d.reply==='reject'&&d.state==='acknowledged')&&!quest.sessions.some((other:QuestSession)=>other.resumedFrom===run.callID)
   if(!OWNED_RUN.includes(run.state)&&!refused)continue
  const id=run.openCodeSessionId??run.sessionID??''
  const dispatcher=run.state==='planned'&&runtime?(id?interruptedBoundDispatch(runtime,run.runID??run.callID,id):interruptedPreflight(runtime,run.runID??run.callID))?'gone':'held':'-'
  const workspace=run.scope?.worktree??(run as any).worktree
  const lease=run.leaseExpiresAt?Date.parse(run.leaseExpiresAt):NaN
  parts.push([run.callID,run.state,run.updatedAt,id,sweep.active?String(Object.hasOwn(sweep.active,id)):'?',
   typeof workspace==='string'&&workspace?String(existsSync(workspace)):'-',
   Number.isFinite(lease)?String(lease<now):'-',dispatcher,
   sweep.elsewhere?String(Object.hasOwn(sweep.elsewhere,id)):'-',String(hostExecution(host,id)),ownerState(runtime,run),mergedPullRequest(run)?'merged':'-'].join(''))
 }
 return parts.join('')
}
async function reconcile(store:QuestStore,host:any,questID:string,sweep:Sweep={}) {
 const tracker=new QuestTracker(store,host),observations:Record<string,any>={}
 const quest=store.read(questID)
 for(const entry of quest?[{quest}]:[]){
  let current=entry.quest&&store.read(entry.quest.id)
  if(current&&current.state!=='Archived')for(const update of terminalStepUpdates(current)) {
   current=store.apply(current.id,'stage-state',update,'quest:terminal-step-reconcile',{expectedRevision:current.revision})
  }
  for(const run of current?.sessions??[]){
  const refused=run.state==='cancelled'&&run.permissionDecisions?.some(d=>d.reply==='reject'&&d.state==='acknowledged')&&!current?.sessions.some(other=>other.resumedFrom===run.callID)
  if(!OWNED_RUN.includes(run.state)&&!refused)continue
  if(runSettlement(run.runID??run.callID)){observations[run.runID??run.callID]={state:'running',reason:'Collecting and landing its changes'};continue}
  const owner=dispatchOwner(store.runtime,run.runID??run.callID)
  if(owner?.holding&&owner.pid!==process.pid){observations[run.runID??run.callID]={state:'running',reason:'Held by host process '+owner.pid+', which dispatched it and settles it'};continue}
  const ownerGone=!!owner&&!owner.alive
  const plannedBeforeThisHost=!owner&&Date.parse(run.updatedAt)<HOST_STARTED_AT
  const interruption=run.state==='planned'&&!(run.openCodeSessionId??run.sessionID)?interruptedPreflight(store.runtime,run.runID??run.callID):undefined
  if(interruption){
   observations[run.runID??run.callID]={state:'failed',reason:interruption}
    store.apply(entry.quest!.id,'session-state',{callID:run.callID,state:'failed',result:noteReason(interruption),evidence:interruption,preserveTerminal:true},'quest:interrupted-preflight')
   continue
  }
  if(run.state==='planned'&&!(run.openCodeSessionId??run.sessionID)&&(ownerGone||plannedBeforeThisHost)){
   const reason=owner?'Dispatch owner '+owner.pid+' exited during '+owner.phase+', before a worker session was bound. Recorded at '+run.updatedAt+'.':'Planned before this host started and never bound a session, so no admission is still pending for it. Recorded at '+run.updatedAt+'.'
   observations[run.runID??run.callID]={state:'failed',reason}
    store.apply(entry.quest!.id,'session-state',{callID:run.callID,state:'failed',result:run.result?sentence('The worker never started because its launch failed: '+plainWords(run.result))+' Fix that error before starting the step again.':noteReason(reason),evidence:reason,preserveTerminal:true},'quest:unadmitted-plan')
   continue
  }
  const currentRun=store.read(entry.quest!.id)?.sessions.find(s=>s.callID===run.callID)??run
  const boundID=currentRun.openCodeSessionId??currentRun.sessionID
  if(currentRun.state==='planned'&&boundID&&interruptedBoundDispatch(store.runtime,currentRun.runID??currentRun.callID,boundID)){
   try{if(await tracker.settleInterruptedDispatch(entry.quest!.id,currentRun.runID??currentRun.callID,host)){observations[run.runID??run.callID]={state:'failed',reason:'Exited dispatch owner; owning host confirmed an empty idle session'};continue}}catch(error){observations[run.runID??run.callID]=observationFailure(error);continue}
  }
  const workspace=currentRun.scope?.worktree??(currentRun as any).worktree
  if(typeof workspace==='string'&&workspace&&!existsSync(workspace)){
   const reason='Recorded workspace is gone, so this run cannot resume or report again: '+workspace
   observations[run.runID??run.callID]={state:'stale',reason}
    store.apply(entry.quest!.id,'session-state',{callID:currentRun.callID,state:'stale',result:'The worker’s checkout is missing. Find its saved work before starting it again.',evidence:reason,preserveTerminal:true},'quest:missing-workspace')
   continue
  }
  const lease=currentRun.leaseExpiresAt?Date.parse(currentRun.leaseExpiresAt):NaN
  if(currentRun.harness&&Number.isFinite(lease)&&lease<Date.now()){
   const reason='External '+currentRun.harness+' run stopped renewing its lease, which expired at '+currentRun.leaseExpiresAt+'. Nothing outside this host is holding the step any more.'
   observations[run.runID??run.callID]={state:'stale',reason}
    store.apply(entry.quest!.id,'session-state',{callID:currentRun.callID,state:'stale',result:'The worker stopped checking in. Check its saved session before starting it again.',evidence:reason,preserveTerminal:true},'quest:expired-lease')
   continue
  }
  const merged=boundID&&(await refreshPullRequest(currentRun))?.state==='merged'&&(hostExecution(host,boundID)!==true&&!(sweep.active&&Object.hasOwn(sweep.active,boundID))||frozenRun(currentRun))?mergedPullRequest(currentRun):undefined
  if(merged){
   const reason=mergedRunReason(merged.number)
   observations[run.runID??run.callID]={state:'completed',reason}
   await tracker.settleRun(entry.quest!.id,currentRun,'completed',reason,'quest:pull-request-merged')
   continue
  }
  const lostWithHost=owner&&OWNED_RUN.includes(currentRun.state)&&!currentRun.harness&&ownerGone&&hostExecution(host,boundID??'')!==true
  const observation=await inspectWorker(host,currentRun,{active:sweep.active});observations[run.runID??run.callID]=observation
  const finished=['succeeded','failed'].includes(observation.outcome)&&Date.parse(observation.completedAt)>=Date.parse(currentRun.updatedAt)
   if(lostWithHost&&!finished&&observation.state!=='unreachable'){
   const reason='Execution ended with the host process it was running in; recorded '+currentRun.state+' at '+currentRun.updatedAt+', and host process '+owner.pid+' that ran it has exited. The workspace is untouched and the step can be dispatched again.'
   observations[run.runID??run.callID]={state:'failed',reason}
    store.apply(entry.quest!.id,'session-state',{callID:currentRun.callID,state:'failed',result:noteReason(reason),evidence:reason,preserveTerminal:true},'quest:execution-lost-with-host')
   continue
  }
  if(observation.state==='unknown'&&observation.hostIdle&&boundID&&currentRun.permissionDecisions?.at(-1)?.reply!=='reject'&&hostSettledIdleSince(host,boundID,currentRun.updatedAt)){
   const second=await inspectWorker(host,currentRun,{messages:true})
   if(second.state==='missing'||second.state==='unknown'&&second.hostIdle){
    const reason=second.answered?WORKER_ENDED_EMPTY:HOST_NEVER_STARTED
    observeNoTurn(String(currentRun.model??''),second.answered,Date.now())
    observations[run.runID??run.callID]={state:'failed',reason}
    await tracker.settleRun(entry.quest!.id,currentRun,'failed',reason,'quest:unconfirmed-run')
    let settled=store.read(entry.quest!.id)
    if(settled)for(const update of terminalStepUpdates(settled))settled=store.apply(settled.id,'stage-state',update,'quest:unconfirmed-run',{expectedRevision:settled.revision})
    continue
   }
   observations[run.runID??run.callID]=second
  }
  if(observation.state==='missing'){
   const reason=observation.reason??'Owning host no longer holds this session'
    store.apply(entry.quest!.id,'session-state',{callID:currentRun.callID,state:'missing',result:noteReason(reason),evidence:reason,preserveTerminal:true},'quest:missing-session')
   continue
  }
   if(observation.state==='interrupted'&&(OWNED_RUN.includes(currentRun.state)||refused)){
    const reason=observation.reason??'Worker interrupted; no automatic restart is authorized'
    observations[run.runID??run.callID]=observation
     const recorded=currentRun.state==='cancelled'&&currentRun.evidence.includes(redact(reason))
     if(!recorded)store.apply(entry.quest!.id,'session-state',{callID:currentRun.callID,state:'cancelled',result:noteReason(reason),evidence:reason,preserveTerminal:true},'quest:aborted-turn')
   continue
  }
  if(observation.outcome&&observation.completedAt&&Date.parse(observation.completedAt)>=Date.parse(run.updatedAt))tracker.onHostEvent({type:'session.execution.'+observation.outcome,data:{sessionID:run.openCodeSessionId??run.sessionID,observedAt:observation.completedAt}})
  else if(observation.outcome&&observation.state!=='running'&&['executing','waiting'].includes(currentRun.state)){
   const reason='Owning host reports this session idle with a persisted '+observation.outcome+' outcome recorded at '+(observation.completedAt??'an earlier time')+', so the recorded execution is over.'
   observations[run.runID??run.callID]={...observation,reason}
   tracker.settleRun(entry.quest!.id,currentRun,observation.outcome==='succeeded'?'completed':observation.outcome==='failed'?'failed':'cancelled',reason,'quest:idle-host-outcome',observation.completedAt).catch(error=>console.error('[quests] worker settlement failed',error))
  }
 }
 }
 return observations
}

const frozenRun=(run:QuestSession)=>{const reader=statusReader(waterfallSources(process.env).hostDB,{});try{return reader.status({...run,awaiting:undefined}).kind==='frozen'}catch{return false}finally{reader.close()}}
export const mergedRunReason=(number?:number)=>'Its pull request'+(number?' #'+number:'')+' was merged, so the run is finished.'

export function nextLeaseExpiry(store:QuestStore,now=Date.now()){
 let due:number|undefined
 for(const {quest} of readAllQuests(store.projectRoot)){
  if(!quest||quest.state==='Archived')continue
  for(const run of quest.sessions as QuestSession[]){
   if(!OWNED_RUN.includes(run.state)||!run.harness)continue
   const lease=run.leaseExpiresAt?Date.parse(run.leaseExpiresAt):NaN
   if(Number.isFinite(lease)&&lease>=now&&(due===undefined||lease+1<due))due=lease+1
  }
 }
 return due
}
const clients=new WeakMap<object,Map<string,Promise<Record<string,any>>>>()
export function reconcileWorkers(store:QuestStore,host:any,questID?:string):Promise<Record<string,any>>{
 let polls=clients.get(host)
 if(!polls){polls=new Map();clients.set(host,polls)}
 const key=store.runtime+'\0'+(questID??'*')
 const prior=polls.get(key);if(prior)return prior
 const task=questID?reconcile(store,host,questID):sweepAll(store,host)
 const promise=task.finally(()=>{if(polls.get(key)===promise)polls.delete(key)})
 polls.set(key,promise);return promise
}
async function sweepAll(store:QuestStore,host:any){
 const sweep:Sweep={}
 if(typeof host.active==='function')try{const value=unwrap(await boundedInspection(signal=>host.active({signal})));if(value&&typeof value==='object'&&!Array.isArray(value)){sweep.active=value;recordHostActivity(host,value)}}catch{}
  let memo=observed.get(host);if(!memo){memo=new Map();observed.set(host,memo)}
 const now=Date.now(),observations:Record<string,any>={},live=new Set<string>()
 for(const {quest} of readAllQuests(store.projectRoot)){
  if(!quest||quest.state==='Archived')continue
  const key=store.runtime+'\0'+quest.id,fingerprint=questFingerprint(quest,sweep,now,host,store.runtime)
  live.add(key)
  if(memo.get(key)===fingerprint)continue
  Object.assign(observations,await reconcile(store,host,quest.id,sweep))
  const after=store.read(quest.id)
  memo.set(key,after?questFingerprint(after,sweep,now,host,store.runtime):fingerprint)
 }
 for(const key of [...memo.keys()])if(key.startsWith(store.runtime+'\0')&&!live.has(key))memo.delete(key)
 return observations
}
