import {readAllQuests} from '../index'
import {readCurrentContinuations} from '../core/runtime-queues'
import {OWNED_RUN} from '../runs/session-lineage'
import {isLandingWork} from '../landing/landing-step'
import {checkSpansFile,readCheckMirror} from '../../scripts/check-spans.mjs'
import {gateLoadInputs,workerAdmission,workerAdmissionText} from '../../scripts/gate-load.mjs'
import {workerBoardCounts,type WaitContext} from '../board/board'
import {liveHostSignals,runStatusReader} from '../board/activity'
import {MINIMUM_STALL_SILENCE_MS} from './stall-signal'
import {MEASURED_WINDOW_MS} from '../board/worker-counts'
import {queueHold,readableQueueSettings,unfinishedPredecessor,type QueueLimits,type QueueSettings} from './quest-queue'
import {effectiveLimits,modeLine,PAUSED_TEXT} from './trial'
import {updateHold} from './update-drain'
import type {Quest} from '../types'

type QueueStore={runtime:string;projectRoot:string;read:(id:string)=>Quest|undefined}

export const ADMISSION_WINDOW_MS=7*86_400_000
export const ADMISSION_REFUSAL='Worker admission:'

export type Admission=ReturnType<typeof workerAdmission>

export function measuredAdmission(now=Date.now(),spansFile=checkSpansFile()):Admission {
 const rows=readCheckMirror(spansFile)??[]
 return workerAdmission(gateLoadInputs(rows,{since:now-ADMISSION_WINDOW_MS,now}))
}

const openQuests=(projectRoot:string)=>readAllQuests(projectRoot).flatMap(row=>row.quest&&row.quest.state!=='Archived'?[row.quest]:[])
export const trialQuests=(projectRoot:string,settings:Pick<QueueSettings,'mode'>)=>settings.mode==='trial'?readAllQuests(projectRoot,{includeArchived:true}).flatMap(row=>row.quest?[row.quest]:[]):[]
const workerRun=(run:Quest['sessions'][number])=>OWNED_RUN.has(run.state)&&run.agentRole!=='command'&&run.role!=='command'

export function workersRunning(quests:Quest[]){return quests.reduce((total,q)=>total+q.sessions.filter(workerRun).length,0)}

export type MeasuredThroughput={moving:number;waiting:number;toolCallsPerMinute:number;mergedPerHour:number}

export function measuredThroughput(quests:Quest[],now=Date.now()):MeasuredThroughput|undefined {
 try{
  const reader=runStatusReader()
  const counts=workerBoardCounts(quests,now,{evidence:(run,at)=>reader.evidence?.(run,at)??{tools:0},toolTimes:at=>reader.toolTimes?.(at)??{medianMs:MINIMUM_STALL_SILENCE_MS}},liveHostSignals())
  return {moving:counts.moving,waiting:counts.waiting,toolCallsPerMinute:counts.toolCallsPerMinute,mergedPerHour:counts.mergedPerHour}
 }catch{return undefined}
}

const launchedWithin=(quests:Quest[],now:number)=>quests.reduce((total,q)=>total+q.sessions.filter(run=>workerRun(run)&&now-Date.parse(run.startedAt??run.updatedAt)<MEASURED_WINDOW_MS).length,0)

export function workersOccupying(quests:Quest[],now=Date.now(),throughput=measuredThroughput(quests,now)){
 if(!throughput)return workersRunning(quests)
 return Math.max(throughput.moving+throughput.waiting,launchedWithin(quests,now))
}

export function landingWaiting(quests:Quest[],continuations:{questID:string;state:string}[]){
 const started=new Set(continuations.filter(row=>!['done','stopped'].includes(row.state)).map(row=>row.questID))
 return quests.reduce((total,q)=>total+(started.has(q.id)?q.stages.filter(step=>isLandingWork(step.id)&&step.status==='pending'&&!step.blocker&&step.needs.every(id=>q.stages.find(other=>other.id===id)?.status==='done')&&!q.sessions.some(run=>workerRun(run)&&run.deliverables.includes(step.id))).length:0),0)
}

export function workerHoldReason(store:QueueStore,q:Quest):string|undefined {
 const settings=readableQueueSettings()
 if(settings.mode==='paused')return PAUSED_TEXT
 return queueHold(q,id=>store.read(id),settings)??updateHold()
}

export const SLOT_WAIT='Waiting for a free slot:'

export type SlotUse={workers:number;quests:Set<string>}

export function slotUse(quests:Quest[],continuations:any[],except?:string):SlotUse {
 const known=new Set<string>(),active=new Set<string>()
 let workers=0
 for(const q of quests)for(const run of q.sessions){
  for(const key of [run.runID,run.requestKey,run.callID])if(key)known.add(key)
  if(!OWNED_RUN.has(run.state))continue
  active.add(q.id)
  if(workerRun(run))workers++
 }
 for(const row of continuations){
  if(row.worker||['done','stopped'].includes(row.state))continue
  const claims=[...(row.state==='claiming'?[row]:[]),...(row.admissions??[]).filter((a:any)=>['claiming','unknown'].includes(a.state))]
  for(const claim of claims){
   if(except&&(claim.requestKey===except||claim.runID===except))continue
   if((claim.runID&&known.has(claim.runID))||(claim.requestKey&&known.has(claim.requestKey)))continue
   workers++
   active.add(row.questID)
  }
 }
 return {workers,quests:active}
}

export function slotLine(use:SlotUse,limits:{workers:number|null;quests:number|null}){
 const of=(n:number,max:number|null,noun:string)=>n+(max===null?'':' of '+max)+' '+noun
 return of(use.workers,limits.workers,use.workers===1?'worker':'workers')+', '+of(use.quests.size,limits.quests,use.quests.size===1?'Quest':'Quests')
}

export function slotWait(use:SlotUse,limits:{workers:number|null;quests:number|null},q:Pick<Quest,'id'>):string|undefined {
 if(limits.quests!==null&&!use.quests.has(q.id)&&use.quests.size>=limits.quests)return SLOT_WAIT+' '+use.quests.size+' of '+limits.quests+' Quests are active; this Quest starts when one finishes'
 if(limits.workers!==null&&use.workers>=limits.workers)return SLOT_WAIT+' '+use.workers+' of '+limits.workers+' workers are running; this Quest starts when one ends'
}

export function limitHold(projectRoot:string,runtime:string,q:Pick<Quest,'id'>,except?:string,limits?:QueueLimits):string|undefined {
 const quests=openQuests(projectRoot),settings=readableQueueSettings(),effective=limits??effectiveLimits(trialQuests(projectRoot,settings),settings)
 if(effective.workers===null&&effective.quests===null)return undefined
 return slotWait(slotUse(quests,readCurrentContinuations(runtime),except),effective,q)
}

export function waitContext(store:{projectRoot:string;runtime:string},read:(id:string)=>Quest|undefined):WaitContext {
 const settings=readableQueueSettings(),quests=openQuests(store.projectRoot),use=slotUse(quests,readCurrentContinuations(store.runtime)),drained=updateHold()!==undefined||settings.mode==='paused',limits=effectiveLimits(trialQuests(store.projectRoot,settings),settings)
 return {
  categories:settings.categories,
  slot:id=>drained||slotWait(use,limits,{id})!==undefined,
  unfinished:after=>unfinishedPredecessor({relationships:{dependencies:after}} as Pick<Quest,'relationships'>,read)!==undefined,
 }
}

export function slotPicture(store:{projectRoot:string;runtime:string}){
 const settings=readableQueueSettings(),quests=openQuests(store.projectRoot),trial=trialQuests(store.projectRoot,settings),limits=effectiveLimits(trial,settings),use=slotUse(quests,readCurrentContinuations(store.runtime))
 const mode=modeLine(trial,settings)
 return {workers:{running:use.workers,limit:limits.workers},quests:{active:use.quests.size,limit:limits.quests},mode:settings.mode,...(mode?{modeText:mode}:{}),text:slotLine(use,limits)}
}

export function workerStartHold(store:QueueStore,projectRoot:string,q:Quest,stepIDs:string[],now=Date.now()):string|undefined {
 return workerHoldReason(store,q)??limitHold(projectRoot,store.runtime,q)
}

export function admissionPicture(store:{projectRoot:string;runtime:string},now=Date.now(),spansFile?:string){
 const admission=measuredAdmission(now,spansFile),quests=openQuests(store.projectRoot)
 const hourAgo=now-3_600_000
 let waiting=0
  try{waiting=readCurrentContinuations(store.runtime).filter(row=>!['done','stopped'].includes(row.state)&&((row.admissions??[]).some((a:any)=>a.state==='waiting'&&String(a.reason).startsWith(ADMISSION_REFUSAL))||String(row.reason).startsWith(ADMISSION_REFUSAL))).length}catch{}
 const landed=readAllQuests(store.projectRoot).filter(row=>{const at=row.quest?.delivered?.at?Date.parse(row.quest.delivered.at):NaN;return Number.isFinite(at)&&at>=hourAgo}).length
  const throughput=measuredThroughput(quests,now)
  return {...admission,text:workerAdmissionText(admission),running:workersOccupying(quests,now,throughput),runsRecorded:workersRunning(quests),moving:throughput?.moving??null,waitingOnCommand:throughput?.waiting??null,toolCallsPerMinute:throughput?.toolCallsPerMinute??null,mergedPerHour:throughput?.mergedPerHour??null,landingWaiting:landingWaiting(quests,readCurrentContinuations(store.runtime)),waiting,landedLastHour:landed}
}
