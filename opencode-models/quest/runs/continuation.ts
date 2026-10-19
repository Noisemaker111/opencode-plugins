import {giverSettings,questPacingConcurrency} from '../giver/giver-settings'
import {workspaceSettings} from '../checkouts/workspace-settings'
import {questWorkflow} from './workflow'
import {runtimeQueuePath,continuationFiles,readContinuations} from '../core/runtime-queues'
import { mkdirSync } from 'node:fs'
import {writeFileDurable,readJsonRecord} from '../core/durable-file.mjs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { acquireLock } from '../locking.mts'
import { questsAPI, QuestError, type QuestContext, type RunQuest, type StartRun } from '../api'
import { DEFERRED_NOT_STARTED } from '../landing/deferred-steps'
import { QuestStore } from '../store'
import { RouteReservations } from '../../models/route-reservations'
import { GIVER_CHANGED, TERMINAL_RUN, giverChangedAtStart, lostToInfrastructure, noModelTurn, redispatchRetry } from './session-lineage'
import { hostname } from 'node:os'
import { getAccountUsage } from '../../usage-service/on-computer'
import { readAllQuests } from '../index'
import { redact } from '../privacy'
import type { Quest, QuestStage } from '../types'
import {dispatchReservationFile} from '../../models/dispatch-planner'
import { verifySourceBinding } from '../core/project'
import { continuationContext,abortedTurnRun,awaitingRefusalObservation } from './continuation-workspace'
import { workerAssignment } from '../core/steps'
import { activeWorkerSteps, overlapRefusal } from '../core/step-overlap'
import { permissionRetryMs } from '../permissions/backoff'
import { isLandingWork, landingWorkFirst, noWorkerRuns } from '../landing/landing-step'
import {workerHoldReason,workerStartHold} from '../workers/worker-admission'
import {computedPriority} from '../workers/quest-queue'
import { depthOf } from '../../models/work-profile'
import { timed } from '../../scripts/plugin-spans'
import { reworkRequested } from '../review/review-record'
import { resumeExcludedBy } from './resume-exclusion'
function verified(q:Quest,s:QuestStage){const command=(q.extensions.routerVerification as Record<string,string>|undefined)?.[s.id]??s.commandID;return !command||s.proofs.some(p=>p.command===command&&p.verified===true&&(p.result==='passed'||p.verdict==='PASS'))}
const verificationSnapshot=(q:Quest,ids:string[])=>Object.fromEntries(ids.map(id=>[id,(q.extensions.routerVerification as Record<string,string>|undefined)?.[id]??q.stages.find(s=>s.id===id)?.commandID??null]))

export function amendContinuationStep(runtime:string,questID:string,stepID:string,detail:string|undefined){
 const lock=acquireLock(runtime,'continuations')
 try{for(const file of continuationFiles(runtime)){
  const rows:Intent[]=readJsonRecord(file)??[];let changed=false
  for(const row of rows.filter(x=>x.questID===questID&&!['done','stopped'].includes(x.state)))for(const step of row.steps.filter(s=>s.id===stepID)){if(detail===undefined)delete step.detail;else step.detail=detail;changed=true}
  if(changed){writeFileDurable(file,JSON.stringify(rows))}
 }}finally{lock.release()}
}
export type ContinuationRunOptions = RunQuest & { maxConcurrent?:number; stepModels?:Record<string,string> }
const rowFallback=(row:{depth?:string;workType?:string;size?:string})=>{try{return {depth:depthOf(row.depth??row.size),workType:row.workType}}catch{return {workType:row.workType}}}
const rowRun=(row:{depth?:string;workType?:string;size?:string})=>{const fallback=rowFallback(row);return {...(fallback.depth?{depth:fallback.depth}:{}),...(fallback.workType?{workType:fallback.workType}:{})}}
type Owner = { host:string; pid:number }
type ScheduledOwner = { owner?: Owner }
type Admission = { resumeAt?:number; stepID:string; stepIDs?:string[]; requestID:string; requestKey?:string; runID?:string; state:'waiting'|'claiming'|'running'|'unknown'|'stopped'|'done'; attempt:number; refreshes:number; nextAt:number; reason:string; claimedBy?:Owner; abortResume?:{runID:string;sessionID:string;workspace?:string} }
export type GoalRoute = { routeID:string;accountID:string;providerID:string;modelID:string;reasoning:string;serviceTier:string }
type Intent = { resumeAt?:number; requestKey?:string; readOnly?:boolean; task?:string; depth?:string; workType?:string; size?:string; requestFingerprint?:string; inheritsPacing?:boolean; maxConcurrent?:number; stepModels?:Record<string,string>; admissions?:Admission[]; id:string; goal?:boolean; worker?:boolean; unknown?:boolean; verification?:Record<string,string|null>; route?:GoalRoute; epoch?:number; eventIDs?:string[]; questID:string; description:string; context:QuestContext; model?:string; files?:string[]; steps:{id:string;title:string;detail?:string;needs:string[]}[]; state:'waiting'|'claiming'|'running'|'stopped'|'done'; runID?:string; attempt:number; refreshes:number; nextAt:number; reason:string; claimedBy?:Owner; abortResume?:{runID:string;sessionID:string;workspace?:string} }
type SchedulingSnapshot = { runs:Map<string,Quest['sessions'][number]>; terminal:Quest['sessions'][number][] }
const WAITS_FOR_EVENT=new Set(['WORKER_HOLD','DEPENDENCY_RUNNING','WORKER_ADMISSION','WORKER_LIMIT'])
const active = (state:string)=>['planned','executing','waiting','blocked'].includes(state)
const assigned = (a:Admission)=>a.stepIDs??[a.stepID]
const self=():Owner=>({host:hostname(),pid:process.pid})
function ownerGone(owner:Owner|undefined){
 if(!owner)return true
 if(owner.host!==hostname())return false
 if(owner.pid===process.pid)return false
 try{process.kill(owner.pid,0);return false}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'}
}
export const RESUME_SPACING_MS=15_000
function resumeSlot(rows:Intent[],at:number,except:object){
 let latest=-Infinity
 for(const row of rows){
  if(row!==except&&row.resumeAt!==undefined)latest=Math.max(latest,row.resumeAt)
  for(const a of row.admissions??[])if(a!==except&&a.resumeAt!==undefined)latest=Math.max(latest,a.resumeAt)
 }
 return Math.max(at,latest+RESUME_SPACING_MS)
}
function allowanceReset(reason:string,now:number){
 const times=[...reason.split(' | candidates:')[0].matchAll(/resets (\d{4}-\d\d-\d\dT[\d:.]+Z)/g)].map(m=>Date.parse(m[1])).filter(t=>Number.isFinite(t)&&t>now)
 return times.length?Math.min(...times):undefined
}
export class QuestContinuation {
  readonly file:string
  private liveGoals=new Set<string>()
  constructor(readonly store:QuestStore,readonly start:StartRun,readonly options:{settingsFile?:string;runtimeGeneration?:string;goalMode?:boolean;routeBinding?:(selector:string)=>GoalRoute|Promise<GoalRoute>;workerPrompt?:(context:QuestContext,text:string,id:string,eventID?:string)=>Promise<void>;resumeExact?:(input:{questID:string;runID:string;sessionID:string;workspace?:string;text:string;id:string})=>Promise<false|{callID:string}>;refresh?:typeof getAccountUsage;now?:()=>number;verifyContext?:(context:QuestContext)=>Promise<void>;handOver?:(context:QuestContext,questID:string)=>Promise<QuestContext|undefined>;readQuests?:typeof readAllQuests}={}) {this.file=runtimeQueuePath(store.runtime,'continuations',options.runtimeGeneration,'.json')}
 private concurrency(row:Intent){if(!row.inheritsPacing)return row.maxConcurrent??1;const workflow=questWorkflow(this.store.read(row.questID)!);return questPacingConcurrency(giverSettings(),this.now(),{maxConcurrent:workflow.maxConcurrent,delivery:workflow.delivery,workspaceMode:workspaceSettings(this.options.settingsFile).workspaceMode})}
 private now(){return this.options.now?.()??Date.now()}
 private read():(Intent & ScheduledOwner)[]{return readJsonRecord(this.file)??[]}
  private change<T>(fn:(rows:Intent[])=>T):T {const lock=acquireLock(this.store.runtime,'continuations');try{const rows=this.read(),before=JSON.stringify(rows),result=fn(rows);for(const row of rows)if(!['done','stopped'].includes(row.state))Object.assign(row,{owner:self()});const after=JSON.stringify(rows);if(after!==before){mkdirSync(this.store.runtime,{recursive:true});writeFileDurable(this.file,after)}return result}finally{lock.release()}}
 private changeIfNeeded<T>(fn:(rows:Intent[])=>T):T {
  const rows=this.read(),before=JSON.stringify(rows),result=fn(rows)
  for(const row of rows)if(!['done','stopped'].includes(row.state))Object.assign(row,{owner:self()})
  return JSON.stringify(rows)===before?result:this.change(fn)
 }
 status(questID:string){const all=readContinuations(this.store.runtime).filter(x=>x.questID===questID),open=all.filter(x=>!['done','stopped'].includes(x.state));return (open.length?open:all.slice(-1)).map(row=>({...row,...(row.admissions?{desired:this.concurrency(row),admitted:row.admissions.filter(a=>['claiming','running','unknown'].includes(a.state)).length,waiting:row.steps.filter(s=>!row.admissions!.some(a=>assigned(a).includes(s.id)&&['claiming','running','unknown','done','stopped'].includes(a.state))).length}:{} )}))}
  goalStatus(sessionID:string){return this.read().filter(x=>x.goal&&x.context.sessionID===sessionID).map(x=>({...x,live:this.liveGoals.has(x.id),resumeRequired:!this.liveGoals.has(x.id)&&x.state!=='done'}))}
  async resumeGoal(context:QuestContext){
   const row=this.read().findLast(x=>x.goal&&x.context.sessionID===context.sessionID)
   if(!row)throw new QuestError('GOAL_NOT_FOUND','Start an explicitly authorized goal first')
    if(row.context.project.id!==context.project.id)throw new QuestError('PROJECT_MISMATCH','Goal binding changed; return to the authorized destination')
    const q=this.store.read(row.questID)
    if(row.worker)await verifySourceBinding(row.context,context.directory!)
    const pending=row.steps.find(s=>q?.stages.find(a=>a.id===s.id)?.status==='pending')
    await this.options.verifyContext?.(!row.worker&&q&&pending?continuationContext(q,[pending.id],row.context):context)
   if(!q||q.sessions.some(s=>['planned','executing','waiting','blocked'].includes(s.state)&&!(row.worker&&(s.openCodeSessionId===context.sessionID||s.sessionID===context.sessionID))))throw new QuestError('ACTIVE_OR_UNKNOWN_RUN','Reconcile the existing run before resuming; no launch was retried')
   if(row.unknown||row.state==='claiming'||row.reason.startsWith('UNKNOWN_LAUNCH'))throw new QuestError('UNKNOWN_LAUNCH','Interrupted admission requires inspection before resume')
   this.change(rows=>{const current=rows.find(x=>x.id===row.id)!;if(current.state!=='done'){current.state='waiting';current.nextAt=0;if(current.worker){current.attempt=0;current.epoch=(current.epoch??0)+1}current.reason='Explicit verified resume'}})
   this.liveGoals.add(row.id);if(row.worker)await this.advanceWorker(row.id,'resume:'+context.requestID);else await this.tick();return this.goalStatus(context.sessionID)
  }
  startWorkerGoal(questID:string,stepIDs:string[],context:QuestContext,model:string,route?:GoalRoute){
   const q=this.store.read(questID),run=q?.sessions.findLast(s=>s.openCodeSessionId===context.sessionID||s.sessionID===context.sessionID)
   if(!q||q.project?.id!==context.project.id||!run||!['executing','waiting'].includes(run.state)||!stepIDs.length||stepIDs.some(id=>!run.deliverables.includes(id)||q.sessions.findLast(s=>s.deliverables.includes(id))!==run))throw new QuestError('WORKER_ASSIGNMENT_DENIED','Only the current active assigned steps may enter a worker goal')
   const id=createHash('sha256').update(questID+':'+context.sessionID+':'+context.requestID).digest('hex').slice(0,26)
    this.change(rows=>{if(rows.some(r=>r.id===id))return;if(rows.some(r=>r.goal&&r.context.sessionID===context.sessionID&&!['stopped','done'].includes(r.state)))throw new QuestError('GOAL_EXISTS','Pause the existing session goal first');rows.push({id,goal:true,worker:true,runID:run.runID??run.callID,route,verification:verificationSnapshot(q,stepIDs),questID,description:q.description??q.objective,context,model,steps:q.stages.filter(s=>stepIDs.includes(s.id)).map(s=>({id:s.id,title:s.title,detail:s.detail,needs:s.needs})),state:'running',attempt:0,refreshes:0,nextAt:0,reason:'Pursue only current assigned steps; successful execution events recheck actual results'})})
   this.liveGoals.add(id);return this.goalStatus(context.sessionID)
  }
  async workerEvent(sessionID:string,eventID:string,success:boolean){
   for(const row of this.goalStatus(sessionID).filter(r=>r.worker&&r.live&&r.state==='running')){
    if(!success){this.pauseGoal(row.context);continue}
    await this.advanceWorker(row.id,eventID)
   }
  }
  private async advanceWorker(id:string,eventID:string){
   let claimed:Intent|undefined
   this.change(rows=>{const row=rows.find(r=>r.id===id);if(!row||!row.worker||!this.liveGoals.has(id)||!['running','waiting'].includes(row.state)||row.eventIDs?.includes(eventID))return
    row.eventIDs=[...(row.eventIDs??[]),eventID].slice(-20)
    const q=this.store.read(row.questID),run=q?.sessions.findLast(s=>s.openCodeSessionId===row.context.sessionID||s.sessionID===row.context.sessionID)
    const stop=(reason:string)=>{row.state='stopped';row.reason=reason}
     if(!q||q.project?.id!==row.context.project.id||!run||!['executing','waiting'].includes(run.state)||(row.runID!==undefined&&row.runID!==(run.runID??run.callID))||row.steps.some(s=>!run.deliverables.includes(s.id)||q.sessions.findLast(r=>r.deliverables.includes(s.id))!==run)){stop('Worker assignment/ownership changed or run retired/blocked');return}
     row.runID=run.runID??run.callID
    if(q.description!==row.description||row.steps.some(s=>{const a=q.stages.find(x=>x.id===s.id);return !a||a.title!==s.title||a.detail!==s.detail||JSON.stringify(a.needs)!==JSON.stringify(s.needs)})){stop('Authorized step definitions changed');return}
    const steps=q.stages.filter(s=>row.steps.some(r=>r.id===s.id))
    if(row.verification&&JSON.stringify(row.verification)!==JSON.stringify(verificationSnapshot(q,row.steps.map(s=>s.id)))){stop('Verification contract changed; explicitly start a newly authorized goal');return}
    if(steps.some(s=>s.status==='blocked')){stop('Assigned step blocked; inspect its result');return}
    if(steps.some(s=>s.status==='done'&&!verified(q,s))){stop('Assigned result lacks a verified passing proof for its verification contract');return}
    if(steps.every(s=>s.status==='done')){row.state='done';row.reason='Assigned steps completed';return}
    if(row.attempt>=3){stop('Bounded worker goal turn budget exhausted; explicit resume after review required');return}
    row.state='claiming';claimed=structuredClone(row)
   })
   if(!claimed)return
   const row=claimed
   let promptAttempted=false
   try{
     await this.options.verifyContext?.(row.context)
    const usage=await(this.options.refresh??getAccountUsage)({refresh:true})
    const account=usage.accounts.find(a=>a.id===row.route?.accountID)
    if(!account||account.state!=='available'||account.freshness.stale)throw new QuestError('ACCOUNT_HOLD','Worker goal requires its exact reserved account with fresh available quota')
     const proceed=this.change(rows=>{const current=rows.find(r=>r.id===id)!;if(current.state!=='claiming')return false;const q=this.store.read(row.questID),run=q?.sessions.find(s=>(s.runID??s.callID)===row.runID);if(!run||!['executing','waiting'].includes(run.state)||(run.openCodeSessionId??run.sessionID)!==row.context.sessionID||row.steps.some(s=>q!.sessions.findLast(r=>r.deliverables.includes(s.id))!==run)){current.state='stopped';current.reason='Worker ownership changed during readiness recovery';return false}current.attempt++;row.attempt=current.attempt;current.requestKey=createHash('sha256').update(row.context.project.id+':'+row.context.sessionID+':continue:'+id+':'+row.attempt+':run:'+row.runID).digest('hex').slice(0,26);return true});if(!proceed)return
    if(!this.options.workerPrompt)throw new QuestError('HOST_CAPABILITY_MISSING','Worker prompt continuation is unavailable')
    promptAttempted=true
    this.change(rows=>{rows.find(r=>r.id===id)!.unknown=true})
    await this.options.workerPrompt(row.context,`Continue only assigned Quest ${row.questID} steps ${row.steps.map(s=>s.id).join(', ')}. Inspect actual checks/results; record verified proof before completion. Do not create Quests or dispatch workers, expand to unrelated work, or repair shared environment setup; report missing prerequisites to the parent. Stop on user steering, blockers, holds, or budget.`,id+':'+(row.epoch??0)+':'+row.attempt,eventID)
    this.change(rows=>{const current=rows.find(r=>r.id===id)!;current.unknown=false;if(current.state==='claiming'){current.state='running';current.reason='Same-session assigned-step continuation admitted'}})
   }catch(error){this.change(rows=>{const current=rows.find(r=>r.id===id)!;if(current.state!=='stopped'){current.state='stopped';current.reason=(promptAttempted?'UNKNOWN_LAUNCH: ':'')+redact(error instanceof Error?error.message:String(error),1000)}})}
  }
  pauseGoal(context:QuestContext){this.change(rows=>{for(const row of rows.filter(r=>r.goal&&r.context.sessionID===context.sessionID)){if(row.context.project.id!==context.project.id)throw new QuestError('PROJECT_MISMATCH','Goal destination changed');this.liveGoals.delete(row.id);if(row.state!=='done'){row.state='stopped';row.reason='Explicit session goal pause; current ownership retained until resume or cancel'}}});return this.goalStatus(context.sessionID)}
 cancel(questID:string,context:QuestContext){
  questsAPI(this.store,context,this.start).get(questID)
  const lock=acquireLock(this.store.runtime,'continuations')
  try{for(const file of continuationFiles(this.store.runtime)){
   const rows:Intent[]=readJsonRecord(file)??[];let changed=false
   for(const row of rows.filter(x=>x.questID===questID&&!['done','stopped'].includes(x.state))){row.state='stopped';row.reason='Continuation cancelled; an already launched worker must be reconciled separately';changed=true}
   if(changed){writeFileDurable(file,JSON.stringify(rows))}
  }return this.status(questID)}finally{lock.release()}
 }
 async run(questID:string,input:ContinuationRunOptions,context:QuestContext){
  if(input.readOnly!==undefined&&typeof input.readOnly!=="boolean")throw new QuestError("INVALID_INPUT","readOnly must be a boolean")
  if(input.maxConcurrent!==undefined&&(!Number.isSafeInteger(input.maxConcurrent)||input.maxConcurrent<1))throw new QuestError('INVALID_INPUT','maxConcurrent must be a positive safe integer')
  const q=questsAPI(this.store,context,this.start).get(questID)
  const workflow=questWorkflow(this.store.read(questID)!)
  const explicitConcurrency=input.maxConcurrent??workflow.maxConcurrent
  const desired=questPacingConcurrency(giverSettings(),this.now(),{maxConcurrent:explicitConcurrency,delivery:workflow.delivery,workspaceMode:workspaceSettings(this.options.settingsFile).workspaceMode})
  const inheritsPacing=explicitConcurrency===undefined&&desired>1
  if(explicitConcurrency!==undefined)input={...input,maxConcurrent:explicitConcurrency}
  const id=createHash('sha256').update(questID+':'+context.sessionID+':'+context.requestID).digest('hex').slice(0,26)
  const requestFingerprint=createHash('sha256').update(JSON.stringify({readOnly:input.readOnly===true,task:input.task??null,depth:input.depth??null,workType:input.workType??null,model:input.model??null,files:input.files??null,stepIDs:input.stepIDs??null,maxConcurrent:input.maxConcurrent??1,stepModels:input.stepModels?Object.fromEntries(Object.entries(input.stepModels).sort(([a],[b])=>a.localeCompare(b))):null})).digest('hex')
  const sameRequest=(row:Intent)=>row.requestFingerprint?row.requestFingerprint===requestFingerprint:(row.readOnly===true)===(input.readOnly===true)&&row.model===input.model&&JSON.stringify(row.files??['.'])===JSON.stringify(input.files??['.'])&&(row.maxConcurrent??1)===(input.maxConcurrent??1)&&JSON.stringify(row.stepModels??{})===JSON.stringify(input.stepModels??{})&&JSON.stringify(row.steps.map(s=>s.id))===JSON.stringify(input.stepIDs??row.steps.map(s=>s.id))
  const existing=this.read().find(row=>row.id===id)
  if(existing){if(!sameRequest(existing))throw new QuestError('REQUEST_CONFLICT','This continuation request already authorized different work; use a new request identity');return {continuation:this.status(questID).find(row=>row.id===id)}}
  const ids=input.stepIDs??q.steps.filter(s=>s.state==='pending'&&!noWorkerRuns(s)&&!s.deferred).map(s=>s.id)
   if(ids.some(id=>q.steps.find(s=>s.id===id)?.deferred))throw new QuestError('STEP_DEFERRED',DEFERRED_NOT_STARTED)
  if(!ids.length||ids.some(id=>!q.steps.some(s=>s.id===id&&s.state==='pending')))throw new QuestError('NO_ELIGIBLE_STEPS','Continuation requires pending authorized steps')
  if(input.stepModels!==undefined&&(!input.stepModels||typeof input.stepModels!=='object'||Array.isArray(input.stepModels)||Object.entries(input.stepModels).some(([id,model])=>!ids.includes(id)||typeof model!=='string'||!model.trim())))throw new QuestError('INVALID_INPUT','stepModels must map authorized step IDs to explicit models')
  if(this.options.goalMode&&ids.some(id=>!this.store.read(questID)!.stages.find(s=>s.id===id)?.commandID&&!input.stepModels?.[id])&&!input.model)throw new QuestError('EXPLICIT_MODEL_REQUIRED','Continuation requires an explicit model for worker steps')
  const route=this.options.goalMode&&input.model?await this.options.routeBinding?.(input.model):undefined
  this.change(rows=>{const prior=rows.find(x=>x.id===id);if(prior){if(!sameRequest(prior))throw new QuestError('REQUEST_CONFLICT','This continuation request already authorized different work');return;}if(this.options.goalMode&&readContinuations(this.store.runtime).some(x=>x.goal&&x.context.sessionID===context.sessionID&&!['done','stopped'].includes(x.state)))throw new QuestError('CONTINUATION_EXISTS','Pause the existing session goal before replacing its authorization')
   for(const prior of rows)if(prior.questID===questID&&!prior.goal&&!['done','stopped'].includes(prior.state)){prior.state='stopped';prior.reason='Replaced by a newer authorization for this Quest'}
   rows.push({requestFingerprint,...(input.maxConcurrent!==undefined||input.stepModels||inheritsPacing?{maxConcurrent:input.maxConcurrent??1,...(inheritsPacing?{inheritsPacing:true}:{}),stepModels:input.stepModels,admissions:[]}:{}),id,goal:this.options.goalMode===true,route,verification:this.options.goalMode?verificationSnapshot(this.store.read(questID)!,ids):undefined,questID,description:q.description,context,readOnly:input.readOnly,task:input.task,depth:input.depth,workType:input.workType,model:input.model,files:input.files,steps:q.steps.filter(s=>ids.includes(s.id)).map(s=>({id:s.id,title:s.title,detail:s.detail,needs:s.needs})),state:'waiting',attempt:0,refreshes:0,nextAt:0,reason:'Explicitly authorized continuation'})})
  if(this.options.goalMode)this.liveGoals.add(id)
  await this.tick();return {continuation:this.status(questID).find(x=>x.id===id)}
 }
   private settleDeliveredContinuations(){
    const lock=acquireLock(this.store.runtime,'continuations')
    try{for(const file of continuationFiles(this.store.runtime)){
     let rows:Intent[]
     try{rows=readJsonRecord(file)}catch{continue}
     if(!Array.isArray(rows))continue
     let changed=false
     for(const row of rows){
      if(!['waiting','running'].includes(row.state))continue
      let q:Quest|undefined
      try{q=this.store.read(row.questID)}catch{continue}
      if(!q||!(q.delivered||q.archive?.automatic===true)||q.project?.id!==row.context.project.id||q.project.root!==row.context.project.root||!row.steps.length)continue
      if(!row.steps.every(s=>{const actual=q.stages.find(x=>x.id===s.id);return actual?.status==='done'&&(!row.goal||verified(q,actual))}))continue
      if(row.verification&&JSON.stringify(row.verification)!==JSON.stringify(verificationSnapshot(q,row.steps.map(s=>s.id))))continue
      if(q.sessions.some(s=>active(s.state)&&s.deliverables.some(id=>row.steps.some(step=>step.id===id))))continue
      const claims=row.admissions??[row]
      if(!claims.length||claims.some(a=>{const run=q.sessions.find(s=>(!!a.runID&&s.runID===a.runID)||(!!a.requestKey&&(s.requestKey===a.requestKey||s.runID===a.requestKey)));return !run||!TERMINAL_RUN.has(run.state)||awaitingRefusalObservation(run)}))continue
      for(const a of row.admissions??[]){a.state='done';a.reason='Terminal worker completed its step'}
      row.state='done';row.reason='Delivered authorized steps completed with terminal outcomes';changed=true
     }
     if(changed)writeFileDurable(file,JSON.stringify(rows))
    }}finally{lock.release()}
   }
   private stopOrphanedContinuations(){
    const lock=acquireLock(this.store.runtime,'continuations')
    try{for(const file of continuationFiles(this.store.runtime)){
     if(file===this.file)continue
     let rows:Intent[]
     try{rows=readJsonRecord(file)}catch{continue}
     if(!Array.isArray(rows))continue
     let changed=false
     for(const row of rows){
      if(row.worker||row.goal||!['waiting','claiming','running'].includes(row.state)||!(row as ScheduledOwner).owner||!ownerGone((row as ScheduledOwner).owner))continue
      for(const a of row.admissions??[])if(!['done','stopped'].includes(a.state)){a.state='stopped';a.reason='The host that owned this continuation exited'}
      row.state='stopped';row.reason='The host that owned this continuation exited; the Quest Giver decides whether to start the Quest again';changed=true
     }
     if(changed)writeFileDurable(file,JSON.stringify(rows))
    }}finally{lock.release()}
   }
  async tick(){
   this.settleDeliveredContinuations()
   this.stopOrphanedContinuations()
   this.changeIfNeeded(rows=>{for(const row of rows){
    if(row.worker||row.goal)continue
    const abandoned=row.state==='claiming'&&ownerGone(row.claimedBy)
    if(!abandoned&&!row.admissions?.some(a=>a.state==='claiming'&&ownerGone(a.claimedBy)))continue
    const quest=this.store.read(row.questID)
    const recorded=(key:string|undefined)=>key?quest?.sessions.find(s=>s.requestKey===key||s.runID===key):undefined
    if(row.state==='claiming'&&ownerGone(row.claimedBy)){const run=recorded(row.requestKey);if(run){row.runID=run.runID;row.state='running'}}
    for(const a of row.admissions??[])if(a.state==='claiming'&&ownerGone(a.claimedBy)){const run=recorded(a.requestKey);if(run){a.runID=run.runID;a.state='running'}}
    if(row.state==='claiming'&&ownerGone(row.claimedBy)){row.state='waiting';row.nextAt=0;row.claimedBy=undefined;row.reason='Its dispatching process exited mid-claim; claiming it again'}
    for(const a of row.admissions??[])if(a.state==='claiming'&&ownerGone(a.claimedBy)){a.state='waiting';a.nextAt=0;a.claimedBy=undefined;a.reason='Its dispatching process exited mid-claim; claiming it again';if(row.state==='stopped'&&/requires reconciliation/.test(row.reason))row.state='running'}
   }})
   await this.followHandedOverGiver()
   let snapshot:SchedulingSnapshot|undefined
   const scheduling=()=>snapshot??=this.schedulingSnapshot()
   const ready=landingWorkFirst(this.read().filter(x=>!x.worker&&(x.goal?this.options.goalMode&&this.liveGoals.has(x.id):!this.options.goalMode)&&['waiting','running'].includes(x.state)&&x.nextAt<=this.now()).sort((a,b)=>this.priorityScore(b)-this.priorityScore(a)),row=>this.waitingLandingWork(row))
   const settled=await Promise.allSettled(ready.map(intent=>intent.admissions?this.advanceParallel(intent.id,scheduling):this.advance(intent.id,scheduling)))
   const failures=settled.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason)
   if(failures.length===1)throw failures[0]
   if(failures.length)throw new AggregateError(failures,'Independent continuation advances failed')
  }
  private priorityScore(row:Intent){
   try{const q=this.store.read(row.questID);return q?computedPriority(q,this.now()).score:0}catch{return 0}
  }
  private waitingLandingWork(row:Intent){
   const landing=row.steps.filter(s=>isLandingWork(s.id))
   if(!landing.length)return []
   let q:Quest|undefined
   try{q=this.store.read(row.questID)}catch{return []}
   return landing.filter(s=>q?.stages.find(x=>x.id===s.id)?.status==='pending').map(s=>s.id)
  }
  private async handedOver(error:unknown,row:Intent){
   if(!this.options.handOver||row.goal||row.worker||!(error instanceof QuestError)||!(error.code==='GIVER_BINDING_CHANGED'||error.message.includes(GIVER_CHANGED)))return undefined
   if(error.runID){const run=this.store.read(row.questID)?.sessions.find(s=>(s.runID??s.callID)===error.runID);if(!run||!giverChangedAtStart(run))return undefined}
   try{const next=await this.options.handOver(row.context,row.questID);return next&&next.sessionID!==row.context.sessionID?next:undefined}catch{return undefined}
  }
  private async followHandedOverGiver(){
   if(!this.options.handOver)return
   const moved=new Map<string,QuestContext>()
   for(const row of this.read()){
    if(row.goal||row.worker||!['waiting','running'].includes(row.state))continue
    try{const next=await this.options.handOver(row.context,row.questID);if(next&&next.sessionID!==row.context.sessionID)moved.set(row.id,next)}
    catch(error){console.error('[quests] continuation not handed to the current Quest Giver',row.questID,error instanceof Error?error.message:error)}
   }
   if(!moved.size)return
   this.change(rows=>{for(const row of rows){const next=moved.get(row.id);if(!next||!['waiting','running'].includes(row.state))continue;row.context=next;row.reason='Handed over to the current Quest Giver'}})
  }
  nextDue(){
   const now=this.now();let due:number|undefined
   const note=(at:number)=>{if(Number.isFinite(at)&&at>now&&(due===undefined||at<due))due=at}
   for(const row of this.read()){
    if(row.worker||!(row.goal?this.options.goalMode&&this.liveGoals.has(row.id):!this.options.goalMode)||!['waiting','running'].includes(row.state))continue
    note(row.nextAt)
    for(const a of row.admissions??[])if(a.state==='waiting')note(a.nextAt)
   }
   return due
  }
 private schedulingSnapshot():SchedulingSnapshot{
  const runs=new Map<string,Quest['sessions'][number]>(),terminal:Quest['sessions'][number][]= []
  for(const entry of (this.options.readQuests??readAllQuests)(this.store.projectRoot,{includeArchived:true}))for(const run of entry.quest?.sessions??[]){if(run.runID)runs.set(run.runID,run);if(run.runID&&TERMINAL_RUN.has(run.state))terminal.push(run)}
  return {runs,terminal}
 }
 private async advanceParallel(id:string,scheduling:()=>SchedulingSnapshot){
  for(let turn=0;turn<16;turn++){
   let claim:{row:Intent;admission:Admission}|undefined
   this.changeIfNeeded(rows=>{
    claim=undefined
    const row=rows.find(x=>x.id===id)
    if(!row||!['waiting','running'].includes(row.state))return
    const q=this.store.read(row.questID)
    if(!q||q.project?.id!==row.context.project.id||q.project.root!==row.context.project.root||q.state==='Archived'||q.description!==row.description||row.steps.some(s=>{const actual=q.stages.find(x=>x.id===s.id);return !actual||actual.title!==s.title||actual.detail!==s.detail||JSON.stringify(actual.needs)!==JSON.stringify(s.needs)})){
     row.state='stopped';row.reason='Quest ownership or authorized step definition changed';return
    }
     const admissions=row.admissions!
     if(row.verification&&JSON.stringify(row.verification)!==JSON.stringify(verificationSnapshot(q,row.steps.map(s=>s.id)))){row.state='stopped';row.reason='Verification contract changed; explicitly start a newly authorized goal';return}
     if(row.goal&&row.steps.some(s=>{const actual=q.stages.find(x=>x.id===s.id);return actual?.status==='done'&&!verified(q,actual)})){row.state='stopped';row.reason='Completed step has no verified passing proof for its contract; inspect results before continuing';return}
    for(const a of admissions){
     const found=q.sessions.find(s=>s.runID===a.runID||(!!a.requestKey&&(s.requestKey===a.requestKey||s.runID===a.requestKey)))
     if(found&&!a.runID){a.runID=found.runID;a.state='running'}
     const run=found
     if(run&&TERMINAL_RUN.has(run.state)&&['running','unknown','claiming'].includes(a.state)){
      if(awaitingRefusalObservation(run)){a.reason='Awaiting refusal outcome reconciliation';return}
      const finished=(run.state==='completed'||assigned(a).length>0)&&assigned(a).every(id=>q.stages.find(s=>s.id===id)?.status==='done')
      const excludedBy=!finished&&abortedTurnRun(run)?resumeExcludedBy(q,run):undefined
      if(excludedBy){a.state='waiting';a.nextAt=0;a.abortResume=undefined;a.reason='Its route is excluded by routing settings ('+excludedBy+'), so the step starts again on an allowed route';continue}
      if(!finished&&abortedTurnRun(run)){
       const sessionID=run.openCodeSessionId??run.sessionID
       if(!this.options.resumeExact||!sessionID||a.abortResume){a.state='stopped';a.reason='Exact-session refusal continuation unavailable or uncertain; retained original worker';continue}
       if(q.sessions.filter(s=>active(s.state)).length>=(row.maxConcurrent??1))return
       a.abortResume={runID:run.runID??run.callID,sessionID,workspace:run.scope?.worktree};a.state='claiming';a.claimedBy=self()
       claim={row:structuredClone(row),admission:structuredClone(a)};return
      }
      if(!finished&&(noModelTurn(run)||lostToInfrastructure(run)||reworkRequested(q,run))){const retry=redispatchRetry(q,run);if(!retry.retry){a.state='stopped';a.reason='The step ended '+retry.tries+' times without finishing; not dispatched again: '+(run.result??run.state);continue}a.refreshes++;a.state='waiting';a.resumeAt=a.nextAt=resumeSlot(rows,this.now()+permissionRetryMs(a.refreshes),a);a.reason=noModelTurn(run)?'The run ended with no model turn; dispatching it again on the next route':reworkRequested(q,run)?'The checks sent the step back; dispatching it again':'The last run was lost before it could finish; dispatching it again';continue}
      a.state=finished?'done':'stopped'
      a.reason=a.state==='done'?'Terminal worker completed its step':'Worker terminal outcome did not complete its step'
     }
    }
    if(admissions.every(a=>a.state==='done')&&row.steps.every(s=>q.stages.find(x=>x.id===s.id)?.status==='done')&&!q.sessions.some(s=>active(s.state)&&s.deliverables.some(d=>row.steps.some(x=>x.id===d)))){row.state='done';row.reason='Authorized steps completed with terminal outcomes';return}
     const startHold=workerHoldReason(this.store,q)
     if(startHold){row.reason=startHold;return}
    const occupied=q.sessions.filter(s=>active(s.state)).length+admissions.filter(a=>['claiming','unknown'].includes(a.state)&&!q.sessions.some(s=>s.runID===a.runID)).length
    if(occupied>=this.concurrency(row)){row.state='running';row.reason='Desired concurrency reached; awaiting terminal outcomes';return}
    const owner=(stepID:string)=>admissions.findLast(x=>assigned(x).includes(stepID))
    const open=(stepID:string)=>!noWorkerRuns(q.stages.find(x=>x.id===stepID))&&q.stages.find(x=>x.id===stepID)?.status==='pending'&&!q.sessions.some(x=>active(x.state)&&x.deliverables.includes(stepID))
    const met=(n:string)=>{const held=owner(n);return q.stages.find(x=>x.id===n)?.status==='done'&&!q.sessions.some(x=>active(x.state)&&x.deliverables.includes(n))&&!['claiming','unknown'].includes(held?.state??'')}
    const ready=(ids:string[])=>ids.length>0&&ids.every(id=>row.steps.find(s=>s.id===id)?.needs.every(n=>ids.includes(n)||met(n)))
    const command=(stepID:string)=>!!q.stages.find(x=>x.id===stepID)?.commandID
    const busy=[...activeWorkerSteps(q),...admissions.filter(x=>['claiming','unknown'].includes(x.state)&&!q.sessions.some(s=>s.runID===x.runID)).flatMap(assigned)]
    let pick:{a?:Admission;ids:string[]}|undefined
    for(const held of landingWorkFirst(admissions,assigned)){
     if(held.state!=='waiting'||held.nextAt>this.now())continue
     if(/Uncalibrated worker hold:/.test(held.reason)){
      const blockerID=/Uncalibrated worker hold: ([a-zA-Z0-9_-]+)/.exec(held.reason)?.[1]
      const blocker=blockerID?scheduling().runs.get(blockerID):undefined
      if(blocker&&active(blocker.state))continue
     }
     const ids=assigned(held).filter(open)
     if(ready(ids)&&!overlapRefusal(q,ids,busy)){pick={a:held,ids};break}
    }
    if(!pick)for(const s of landingWorkFirst(row.steps,s=>[s.id])){
     if(owner(s.id)||!open(s.id)||!s.needs.every(met))continue
     const model=row.stepModels?.[s.id]
     const ids=command(s.id)?[s.id]:workerAssignment(q.stages,s.id,other=>row.steps.some(x=>x.id===other)&&!owner(other)&&!command(other)&&row.stepModels?.[other]===model,this.concurrency(row)===1)
     if(overlapRefusal(q,ids,busy))continue
     pick={ids};break
    }
    if(!pick){
     const pending=admissions.some(a=>['waiting','claiming','running','unknown'].includes(a.state))||q.sessions.some(s=>active(s.state))
     row.state=pending?'running':'stopped';row.reason=pending?'Awaiting dependencies, held admissions or worker outcomes':'No eligible authorized steps; inspect incomplete outcomes';return
    }
    let a=pick.a
    if(!a){a={stepID:pick.ids[0],requestID:'',state:'waiting',attempt:0,refreshes:0,nextAt:0,reason:'Authorized independent step'};admissions.push(a)}
     const full=workerStartHold(this.store,this.store.projectRoot,q,pick.ids,this.now())
     if(full){a.stepID=pick.ids[0];a.stepIDs=pick.ids;a.state='waiting';a.nextAt=0;a.reason=full;row.state='running';row.reason=full;return}
    a.stepID=pick.ids[0];a.stepIDs=pick.ids
    a.attempt++;a.requestID='continue:'+id+':step:'+a.stepID+':'+a.attempt
    a.runID=undefined
    a.requestKey=createHash('sha256').update(row.context.project.id+':'+row.context.sessionID+':'+a.requestID+':run:'+q.id).digest('hex').slice(0,26)
    a.state='claiming';a.claimedBy=self();a.reason='Durable admission reserved; an interrupted launch must be reconciled'
    row.state='running';claim={row:structuredClone(row),admission:structuredClone(a)}
   })
   if(!claim)return
   const {row,admission}=claim
   try{
      await timed({plugin:'quests',name:'continuation: verify giver',op:row.questID},()=>this.options.verifyContext?.(continuationContext(this.store.read(row.questID)!,assigned(admission),row.context)))
     if(admission.abortResume&&this.options.resumeExact){
      if(this.read().find(x=>x.id===id)?.state==='stopped')return
      const target=admission.abortResume
      const resumed=await this.options.resumeExact({questID:row.questID,...target,text:`Continue only assigned Quest ${row.questID} step ${admission.stepID}. A permission refusal interrupted the previous tool message. The refusal still stands: continue without that action and adjust your approach. Record actual checks. Do not create Quests or dispatch workers.`,id:'abort-resume:'+target.runID})
      this.change(rows=>{const current=rows.find(x=>x.id===id)!,a=current.admissions!.find(x=>x.stepID===admission.stepID)!;if(current.state==='stopped')return;a.state=resumed?'running':'stopped';if(resumed){a.runID=resumed.callID;a.abortResume=undefined}a.reason=resumed?'Resumed refusal in its exact session and workspace':'Exact-session refusal continuation could not be confirmed; original worker retained'})
      continue
     }
     const reservations=new RouteReservations(dispatchReservationFile(this.store.runtime))
    {const held=new Map(reservations.list().map(reservation=>[reservation.runID,reservation]));for(const run of scheduling().terminal){const reservation=held.get(run.runID!);if(reservation&&reservation.state!=='settled')reservations.settle(run.runID!,{state:'settled',completedAt:run.updatedAt})}}
    const proceed=this.change(rows=>{
     const current=rows.find(x=>x.id===id)!,a=current.admissions!.find(x=>x.stepID===admission.stepID)!
     if(current.state==='stopped'||a.state!=='claiming'||a.requestID!==admission.requestID)return false
     const q=this.store.read(row.questID)
     if(!q||q.state==='Archived'||q.project?.id!==row.context.project.id||q.project.root!==row.context.project.root||q.description!==row.description||row.steps.some(s=>{const actual=q.stages.find(x=>x.id===s.id);return !actual||actual.title!==s.title||actual.detail!==s.detail||JSON.stringify(actual.needs)!==JSON.stringify(s.needs)})){current.state='stopped';current.reason='Authorization changed before launch';return false}
     const occupied=q.sessions.filter(s=>active(s.state)).length+current.admissions!.filter(other=>other!==a&&['claiming','unknown'].includes(other.state)&&!q.sessions.some(s=>s.runID===other.runID)).length
     if(occupied>=this.concurrency(current)){a.state='waiting';a.reason='Temporary pace expired or concurrency changed before launch';return false}
     const ids=assigned(admission)
     if(ids.some(id=>row.steps.find(s=>s.id===id)!.needs.some(n=>!ids.includes(n)&&(q.stages.find(s=>s.id===n)?.status!=='done'||q.sessions.some(s=>active(s.state)&&s.deliverables.includes(n)))))){a.state='stopped';a.reason='Dependency changed before launch';return false}
     return true
    })
    if(!proceed)continue
    const q=this.store.read(row.questID)!
    const result=await questsAPI(this.store,{...row.context,requestID:admission.requestID},this.start).run(row.questID,{stepIDs:assigned(admission),files:row.files,readOnly:row.readOnly,task:row.task,...rowRun(row),...(q.stages.find(s=>s.id===admission.stepID)?.commandID?{}:{model:row.stepModels?.[admission.stepID]??row.model})})
    this.change(rows=>{const current=rows.find(x=>x.id===id)!,a=current.admissions!.find(x=>x.stepID===admission.stepID)!;a.runID=result.runID;a.state='running';a.refreshes=0;a.reason='Confirmed worker/command launch'})
   }catch(error){
    const handed=await this.handedOver(error,row)
    this.change(rows=>{
     const current=rows.find(x=>x.id===id)!,a=current.admissions!.find(x=>x.stepID===admission.stepID)!
     if(current.state==='stopped')return
     if(handed&&a.state==='claiming'&&a.requestID===admission.requestID){current.context=handed;a.runID=undefined;a.requestKey=undefined;a.state='waiting';a.nextAt=0;a.claimedBy=undefined;a.reason='Handed over to the current Quest Giver; starting it again';return}
     const reason=redact(error instanceof Error?error.message:String(error),2000)
     if(error instanceof QuestError&&WAITS_FOR_EVENT.has(error.code)){a.state='waiting';a.nextAt=0;a.claimedBy=undefined;a.reason=reason;return}
     if(error instanceof QuestError&&error.runID)a.runID=error.runID
     a.reason=reason;a.refreshes++
     const routeHold=error instanceof QuestError&&error.code==='ROUTE_UNAVAILABLE'
     if(routeHold&&/Burn pacing stopped:/.test(reason)){current.state='stopped';current.reason=reason;a.state='stopped';return}
     if(!current.goal&&routeHold&&(/Burn pacing hold:/.test(reason)||/Uncalibrated worker hold:/.test(reason)&&a.refreshes<3)){a.state='waiting';a.nextAt=this.now()+(/Burn pacing hold:/.test(reason)?30000:10000);return}
     a.state=!(error instanceof QuestError)||error.code==='DISPATCH_OUTCOME_UNKNOWN'?'unknown':'stopped'
     current.reason='An admission requires reconciliation; independent active workers are preserved'
    })
    const settled=this.read().find(x=>x.id===id)?.admissions?.find(x=>x.stepID===admission.stepID)
    if(settled?.state==='stopped')for(const stepID of assigned(settled)){
     if(this.store.read(row.questID)?.stages.find(s=>s.id===stepID)?.status==='done')continue
     try{this.store.apply(row.questID,'stage-state',{stageID:stepID,status:'blocked',evidence:'The worker did not start: '+settled.reason},'quest:continuation')}
     catch(failure){console.error('[quests] stopped start not recorded on Quest',row.questID,stepID,failure instanceof Error?failure.message:failure)}
    }
   }
  }
 }
 private async advance(id:string,scheduling:()=>SchedulingSnapshot){
  let claimed:Intent|undefined
  this.changeIfNeeded(rows=>{claimed=undefined;const row=rows.find(x=>x.id===id);if(!row||!['waiting','running'].includes(row.state)||row.nextAt>this.now())return
   const q=this.store.read(row.questID)
   if(!q||q.project?.id!==row.context.project.id||q.project.root!==row.context.project.root||q.state==='Archived'){row.state='stopped';row.reason='Quest ownership changed or Quest archived';return}
    if(q.description!==row.description||row.steps.some(s=>{const actual=q.stages.find(x=>x.id===s.id);return !actual||actual.title!==s.title||actual.detail!==s.detail||JSON.stringify(actual.needs)!==JSON.stringify(s.needs)})){row.state='stopped';row.reason='Authorized step definition changed; inspect before continuing';return}
    if(row.verification&&JSON.stringify(row.verification)!==JSON.stringify(verificationSnapshot(q,row.steps.map(s=>s.id)))){row.state='stopped';row.reason='Verification contract changed; explicitly start a newly authorized goal';return}
   if(row.state==='waiting'&&row.refreshes>0){
    const blockerID=/Uncalibrated worker hold: ([a-zA-Z0-9_-]+)/.exec(row.reason)?.[1]
    const blocker=blockerID?scheduling().runs.get(blockerID):undefined
    if(blocker&&['planned','waiting','blocked'].includes(blocker.state)){row.state='stopped';row.reason='Blocking launch is unknown or blocked; reconcile before continuing';return}
    if(blocker?.state==='executing'){row.nextAt=this.now()+10000;return}
   }
   const found=q.sessions.find(s=>s.runID===row.runID||(!!row.requestKey&&(s.requestKey===row.requestKey||s.runID===row.requestKey)))
   if(found&&!row.runID)row.runID=found.runID
   const run=found
   if(run&&active(run.state))return
   if(run&&awaitingRefusalObservation(run)){row.reason='Awaiting refusal outcome reconciliation';return}
   const stopped=run&&abortedTurnRun(run)&&run.deliverables.some(id=>q.stages.find(s=>s.id===id)?.status!=='done')?run:undefined
   const excludedBy=stopped?resumeExcludedBy(q,stopped):undefined
   const aborted=excludedBy?undefined:stopped
   if(excludedBy){row.runID=undefined;row.requestKey=undefined;row.abortResume=undefined;row.reason='Its route is excluded by routing settings ('+excludedBy+'), so the step starts again on an allowed route'}
   if(aborted){
    const sessionID=aborted.openCodeSessionId??aborted.sessionID
    const runID=aborted.runID??aborted.callID
    if(this.options.resumeExact&&sessionID&&row.abortResume?.runID!==runID){row.abortResume={runID,sessionID,workspace:aborted.scope?.worktree};row.state='claiming';row.claimedBy=self();claimed=structuredClone(row);return}
    row.state='stopped';row.reason='Exact-session refusal continuation is unavailable; the original session and workspace are retained';return
   }
   if(run&&lostToInfrastructure(run)&&run.deliverables.some(id=>q.stages.find(s=>s.id===id)?.status!=='done')){
    const retry=redispatchRetry(q,run)
    if(!retry.retry){row.state='stopped';row.reason='The step ended '+retry.tries+' times without finishing; not dispatched again: '+(run.result??run.state);return}
    row.runID=undefined;row.requestKey=undefined;row.state='waiting';row.resumeAt=row.nextAt=resumeSlot(rows,this.now()+permissionRetryMs(retry.tries-1),row)
    row.reason='The last run was lost before it could finish ('+(run.result??run.state).split(' | candidates:')[0].slice(0,300)+'); dispatching it again';return
   }
    if(row.goal&&row.steps.some(s=>{const actual=q.stages.find(x=>x.id===s.id);return actual?.status==='done'&&!verified(q,actual)})){row.state='stopped';row.reason='Completed step has no verified passing proof for its contract; inspect results before continuing';return}
    if(row.steps.every(s=>q.stages.find(x=>x.id===s.id)?.status==='done')){row.state='done';row.reason='Authorized steps completed';return}
   const rework=!!run&&reworkRequested(q,run)&&run.deliverables.some(id=>q.stages.find(s=>s.id===id)?.status!=='done')
   if(rework){const retry=redispatchRetry(q,run);if(!retry.retry){row.state='stopped';row.reason='The step ended '+retry.tries+' times without finishing; not dispatched again: '+(run.result??run.state);return}row.runID=undefined;row.requestKey=undefined;row.reason='The checks sent the step back; dispatching it again'}
   else if(!excludedBy&&run&&(['failed','cancelled'].includes(run.state)||run.deliverables.some(id=>q.stages.find(s=>s.id===id)?.status!=='done'))){row.state='stopped';row.reason='Worker terminal outcome did not complete the assigned steps; inspect its result';return}
   if(q.sessions.some(s=>active(s.state)))return
   if(!row.steps.some(s=>q.stages.find(x=>x.id===s.id)?.status==='pending'&&s.needs.every(n=>q.stages.find(x=>x.id===n)?.status==='done'))){row.state='stopped';row.reason='No eligible authorized steps';return}
    const full=workerStartHold(this.store,this.store.projectRoot,q,row.steps.map(s=>s.id),this.now())
   if(full){row.state='waiting';row.nextAt=0;row.reason=full;return}
   row.state='claiming';row.claimedBy=self();claimed=structuredClone(row)
  })
  if(!claimed)return
  const row=claimed
  try{
    const quest=this.store.read(row.questID)!,next=row.steps.find(s=>quest.stages.find(x=>x.id===s.id)?.status==='pending'&&s.needs.every(n=>quest.stages.find(x=>x.id===n)?.status==='done'))!
    if(row.abortResume&&this.options.resumeExact){
     const target=row.abortResume
     await this.options.verifyContext?.(continuationContext(quest,row.steps.map(s=>s.id),row.context))
     if(this.read().find(x=>x.id===id)?.state!=='claiming')return
     const resumed=await this.options.resumeExact({questID:row.questID,runID:target.runID,sessionID:target.sessionID,workspace:target.workspace,text:`Continue only assigned Quest ${row.questID} steps ${row.steps.map(s=>s.id).join(', ')}. A permission refusal interrupted the previous tool message. The refusal still stands: continue without the refused action and adjust your approach. Inspect actual checks/results and record verified proof before completion. Do not create Quests or dispatch workers, expand to unrelated work, or repair shared environment setup; report missing prerequisites to the parent.`,id:'abort-resume:'+target.runID})
     if(resumed){
      this.change(rows=>{const current=rows.find(x=>x.id===id)!;current.runID=resumed.callID;current.abortResume=undefined;if(current.state==='stopped')return;current.state='running';current.refreshes=0;current.reason='Resumed the aborted turn in its exact session and worktree'})
      return
     }
     this.change(rows=>{const current=rows.find(x=>x.id===id)!;current.state='stopped';current.reason='Exact-session refusal continuation could not be confirmed; original session and workspace retained'})
     return
    }
    await timed({plugin:'quests',name:'continuation: verify giver',op:row.questID},()=>this.options.verifyContext?.(continuationContext(quest,[next.id],row.context)))
    const reservations=new RouteReservations(dispatchReservationFile(this.store.runtime))
   {const held=new Map(reservations.list().map(reservation=>[reservation.runID,reservation]));for(const run of scheduling().terminal){const reservation=held.get(run.runID!);if(reservation&&reservation.state!=='settled')reservations.settle(run.runID!,{state:'settled',completedAt:run.updatedAt})}}
   const proceed=this.change(rows=>{const current=rows.find(x=>x.id===id)!;if(current.state!=='claiming')return false;current.attempt++;row.attempt=current.attempt;current.runID=undefined;current.requestKey=createHash('sha256').update(row.context.project.id+':'+row.context.sessionID+':continue:'+id+':'+row.attempt+':run:'+this.store.read(row.questID)!.id).digest('hex').slice(0,26);return true})
   if(!proceed)return
   const q=this.store.read(row.questID)!,step=row.steps.find(s=>q.stages.find(x=>x.id===s.id)?.status==='pending'&&s.needs.every(n=>q.stages.find(x=>x.id===n)?.status==='done'))!
   const requestID='continue:'+id+':'+row.attempt
   const command=(stepID:string)=>!!q.stages.find(x=>x.id===stepID)?.commandID
   const stepIDs=command(step.id)?[step.id]:workerAssignment(q.stages,step.id,other=>row.steps.some(x=>x.id===other)&&!command(other))
   const result=await questsAPI(this.store,{...row.context,requestID},this.start).run(row.questID,{stepIDs,files:row.files,readOnly:row.readOnly,task:row.task,...rowRun(row),...(q.stages.find(s=>s.id===step.id)?.commandID?{}:{model:row.model})})
   this.change(rows=>{const current=rows.find(x=>x.id===id)!;current.runID=result.runID;if(current.state!=='stopped'){current.state='running';current.refreshes=0;current.reason='Confirmed worker/command launch'}})
  }catch(error){const handed=await this.handedOver(error,row);this.change(rows=>{const current=rows.find(x=>x.id===id)!;if(error instanceof QuestError&&error.runID)current.runID=error.runID;if(current.state==='stopped')return;if(handed&&current.state==='claiming'){current.context=handed;current.runID=undefined;current.requestKey=undefined;current.state='waiting';current.nextAt=0;current.claimedBy=undefined;current.reason='Handed over to the current Quest Giver; starting it again';return}const reason=redact(error instanceof Error?error.message:String(error),2000)
    if(error instanceof QuestError&&WAITS_FOR_EVENT.has(error.code)){current.state='waiting';current.nextAt=0;current.claimedBy=undefined;current.reason=reason;return}
    if(error instanceof QuestError&&error.code==='ROUTE_UNAVAILABLE'&&/Burn pacing stopped:/.test(reason)){current.state='stopped';current.reason=reason;return}
    if(!current.goal&&error instanceof QuestError&&error.code==='ROUTE_UNAVAILABLE'&&/Burn pacing hold:/.test(reason)){current.state='waiting';current.nextAt=this.now()+30000;current.reason=reason;return}
     const hold=!current.goal&&error instanceof QuestError&&error.code==='ROUTE_UNAVAILABLE'&&/Uncalibrated worker hold:/.test(reason)
    const reset=!current.goal&&error instanceof QuestError&&error.code==='ROUTE_UNAVAILABLE'?allowanceReset(reason,this.now()):undefined
    if(reset){current.state='waiting';current.nextAt=reset;current.reason=reason.split(' | candidates:')[0];return}
    current.refreshes++;current.state=hold&&current.refreshes<3?'waiting':'stopped';current.nextAt=this.now()+10000;current.reason=reason
   })}
 }
}
