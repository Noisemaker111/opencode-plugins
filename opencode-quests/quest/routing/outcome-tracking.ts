import type {WorkflowOutcome} from '../../usage/workflow-outcomes'
import {classifyDispatch} from '../../models/task-demand'
import {DEPTH_TAG,WORK_TAG,LEGACY_SIZE_TAG,profileTags,stepProfile,type WorkProfile} from '../../models/work-profile'
import {readContinuations} from '../core/runtime-queues'
import {TERMINAL_RUN} from '../runs/session-lineage'
import {readAllQuests} from '../index'
import {workspaceSettings} from "../checkouts/workspace-settings"
import {mkdirSync} from 'node:fs'
import {writeFileDurable,readJsonRecord} from '../core/durable-file.mjs'
import {join} from 'node:path'
import {acquireLock} from '../locking.mts'
import {QuestStore} from '../store'
import type {StartRun,QuestContext} from '../api'
import {QuestError,questsAPI} from '../api'
import {readSessionLedgerRowsBatch,beginWorkflowRun,observeWorkflowRun,judgeWorkflowRun,attachWorkflowTelemetry,readWorkflowOutcomes,workflowOutcomesFile,type LedgerRow,type WorkflowRoute} from '../../usage/telemetry-api'
import {reviewJudgment} from '../review/review-record'
import {hostEnding} from './run-judgment'
import {readReplay,replayRun} from '../bench/replay-record'
import {WORKER_ENDED_EMPTY} from '../giver/giver-wake'
export const workflowFile=workflowOutcomesFile
const endedWithoutResult=(run:{evidence?:unknown})=>[run.evidence].flat().some(line=>typeof line==='string'&&line.includes(WORKER_ENDED_EMPTY))
type Registration={questID:string;projectID:string;workflowTitle:string;runID:string;stepID:string;taskTags:string[];startedAt:number;replayOf?:string}
type Config={questID:string;tags:Record<string,string[]>;maxConcurrent:number}
type Tracking={version:1;configs:Config[];runs:Registration[]}
const file=(store:QuestStore)=>join(store.runtime,'workflow-tracking.json')
function read(store:QuestStore):Tracking{return readJsonRecord<Tracking>(file(store))??{version:1,configs:[],runs:[]}}
function change<T>(store:QuestStore,fn:(state:Tracking)=>T){const lock=acquireLock(store.runtime,'workflow-tracking');try{const state=read(store);if(state.version!==1||!Array.isArray(state.runs)||!Array.isArray(state.configs))throw Error('Workflow tracking is unreadable');const result=fn(state);mkdirSync(store.runtime,{recursive:true});writeFileDurable(file(store),JSON.stringify(state));return result}finally{lock.release()}}
export function configureLearning(store:QuestStore,context:QuestContext,questID:string,tags:Record<string,string[]>|undefined,maxConcurrent=1){
 const q=questsAPI(store,context,async()=>{throw Error('No launch')}).get(questID)
 if(tags!==undefined&&(!tags||Array.isArray(tags)||Object.entries(tags).some(([id,values])=>!q.steps.some(s=>s.id===id)||!Array.isArray(values)||!values.length||values.length>8||values.some(t=>typeof t!=='string'||!t.trim()||t.length>80))))throw new QuestError('INVALID_INPUT','taskTags must map existing steps to 1–8 short task categories')
 if(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1)throw new QuestError("INVALID_INPUT","Invalid concurrency")
 const active=readContinuations(store.runtime).some((r:any)=>r.questID===questID&&!['done','stopped'].includes(r.state));
 change(store,state=>{const prior=state.configs.find(c=>c.questID===questID);if(active&&prior&&tags!==undefined&&JSON.stringify(prior.tags)!==JSON.stringify(tags))throw new QuestError('REQUEST_CONFLICT','Task labels are fixed while a continuation is active');if(prior){prior.tags=tags??prior.tags;prior.maxConcurrent=maxConcurrent}else state.configs.push({questID,tags:tags??{},maxConcurrent})})
}
const statedTags=(input:{depth?:unknown;workType?:unknown})=>{try{return profileTags(stepProfile(input))}catch{return []}}
export function tagInferredProfile(store:QuestStore,runID:string,profile:WorkProfile){change(store,state=>{const run=state.runs.find(r=>r.runID===runID);if(!run)return;const has=(prefix:string)=>run.taskTags.some(tag=>tag.startsWith(prefix));const add=profileTags(profile).filter(tag=>tag.startsWith(WORK_TAG)?!has(WORK_TAG):!has(DEPTH_TAG)&&!has(LEGACY_SIZE_TAG));run.taskTags=[...run.taskTags,...add]})}
export const trackedRuns=(store:QuestStore)=>read(store).runs
export function trackedStart(store:QuestStore,start:StartRun,settingsFile?:string):StartRun{return async input=>{
 const intents=readContinuations(store.runtime);const parallel=intents.some((r:any)=>r.questID===input.quest.id&&(r.maxConcurrent??1)>1&&(!['done','stopped'].includes(r.state)||r.admissions?.some((a:any)=>a.runID===input.runID)));if(parallel&&workspaceSettings(settingsFile).workspaceMode!=="worktree")throw new QuestError("WORKSPACE_MODE_REQUIRED","Parallel continuation requires isolated worktrees at every admission")
 change(store,state=>{if(state.runs.some(r=>r.runID===input.runID))return;const config=state.configs.find(c=>c.questID===input.quest.id);state.runs.push({questID:input.quest.id,projectID:input.context.project.id,workflowTitle:input.quest.title,runID:input.runID,stepID:input.stepIDs.join(','),taskTags:[...new Set(input.stepIDs.flatMap(id=>[classifyDispatch({task:input.task,readOnly:input.readOnly,questKind:input.quest.kind}).task,...statedTags(input),...(config?.tags[id]??[])]))],startedAt:Date.now()})})
 try{return await start(input)}finally{try{collectWorkflowOutcomes(store)}catch(error){console.error('[quests] workflow measurement failed',error)}}
}}
const keys=['input','cacheRead','cacheWrite','output','reasoning'] as const
const route=(r:LedgerRow):WorkflowRoute=>({accountID:r.accountID??'unknown',providerID:r.route.providerID,modelID:r.route.modelID,reasoning:r.route.reasoning??r.route.variant??'unknown',harness:r.route.harness??'unknown',version:'unknown',planRegime:r.regime??'unknown',serviceTier:r.route.serviceTier??'unknown'})
const questRecords=(store:QuestStore)=>new Map<string,any>(readAllQuests(store.projectRoot,{includeArchived:true}).flatMap(row=>row.quest?[[row.quest.id,row.quest] as const]:[]))
export function collectWorkflowOutcomes(store:QuestStore,options:{file?:string;now?:number;rows?:(sessionID:string)=>LedgerRow[]}={}){
 const target=options.file??workflowFile(),now=options.now??Date.now(),known=new Map(readWorkflowOutcomes(target).runs.map(r=>[r.runID,r])),quests=questRecords(store),diagnostics:string[]=[];let observed=0
 const settled=new Set<string>()
 const pending:{meta:Registration;q:any;run:any;sessionID:string;reports?:Record<string,{state:string;blocker?:{kind:string}}>}[]=[]
 for(const meta of read(store).runs){try{
  const recorded=known.get(meta.runID)?.observation
  if(recorded&&recorded.state!=='running'){settled.add(meta.runID);continue}
  const q=quests.get(meta.questID),replay=meta.replayOf?readReplay(store.runtime,meta.runID):undefined,run=replay?replayRun(replay):q?.sessions.find((s:any)=>s.runID===meta.runID),sessionID=run?.openCodeSessionId??run?.sessionID
  if(!q||!run||!sessionID)continue
  pending.push({meta,q,run,sessionID,reports:replay?replay.reports:q.extensions?.runReports?.[meta.runID]})
 }catch(error){diagnostics.push(meta.runID+': '+(error instanceof Error?error.message:String(error)))}}
 const batched=options.rows?undefined:readSessionLedgerRowsBatch(pending.map(p=>({sessionID:p.sessionID,from:p.meta.startedAt-1000,to:now})))
 for(const [index,{meta,run,sessionID,reports}] of pending.entries()){try{
  const raw=options.rows?options.rows(sessionID):batched![index]
  const records=[...new Map(raw.filter(r=>r.source==='opencode'&&r.sessionID===sessionID&&r.startedAt>=meta.startedAt-1000).map(r=>[r.id,r])).values()]
  if(records.some(r=>!Number.isFinite(r.at)||!Number.isFinite(r.startedAt)||r.at>now||r.at<r.startedAt)||!Number.isFinite(Date.parse(run.updatedAt))||Date.parse(run.updatedAt)>now)throw Error('Invalid or future observation timestamp')
  const prior=known.get(meta.runID),first=records[0]
  const ended=TERMINAL_RUN.has(run.state)?(['completed','failed','cancelled'].includes(run.state)?run.state as 'completed'|'failed'|'cancelled':'cancelled'):undefined
  if(!first&&!ended)continue
  const identity=prior?.route??(first?route(first):{accountID:'unknown',providerID:run.providerID??'unknown',modelID:run.modelID??'unknown',reasoning:run.reasoningEffort??'unknown',harness:run.runtime??'unknown',version:'unknown',serviceTier:'unknown'})
  const mismatch=prior?.observation?.routeConsistent===false||records.some(r=>{const actual=route(r);return Object.keys(identity).some(k=>actual[k as keyof WorkflowRoute]!==identity[k as keyof WorkflowRoute])})
  if(mismatch)diagnostics.push('Changed or mixed route in '+meta.runID+'; token attribution withheld')
  if(!prior)beginWorkflowRun(target,{...meta,workflowID:meta.questID,sessionID,route:identity})
  const hostEnded=ended?hostEnding(run):undefined
  const terminal=!!ended&&(!!hostEnded||records.every(r=>r.state!=='running'))
  const completedAt=prior?.observation?.completedAt??Math.max(meta.startedAt,Date.parse(run.updatedAt),...records.map(r=>r.at))
  const tokens=Object.fromEntries(keys.map(k=>[k,!mismatch&&records.length&&records.every(r=>r.tokens[k]!==null&&Number.isSafeInteger(r.tokens[k])&&r.tokens[k]!>=0)?records.reduce((n,r)=>n+r.tokens[k]!,0):null])) as any
  if(prior?.observation?.state!=='running'&&prior?.observation&&!terminal)continue
  if(prior?.observation&&now<=prior.observation.observedAt)continue
  const previous=prior?.observation;if(previous&&previous.state===(terminal?ended:'running')&&previous.completedAt===(terminal?completedAt:undefined)&&previous.routeConsistent===!mismatch&&previous.outcome===undefined&&keys.every(k=>previous.tokens[k]===tokens[k]))continue
  const assigned=meta.stepID.split(',').map(id=>reports?.[id])
  const delivered=terminal?ended==='completed'&&assigned.every(step=>step?.state==='done'):undefined
  const cause=assigned.find(step=>step?.state==='blocked')?.blocker?.kind
  const outcome:WorkflowOutcome|undefined=!terminal?undefined:ended==='cancelled'?'cancelled':delivered?'delivered':ended==='failed'&&endedWithoutResult(run)?'empty':cause==='work'?'work-failed':cause==='environment'||cause==='dependency'||cause==='permission'?cause:'unverified'
  observeWorkflowRun(target,{runID:meta.runID,observedAt:now,state:terminal?ended!:'running',...(terminal?{completedAt,delivered,outcome,requests:records.length,endedBy:hostEnded?'host' as const:'work' as const,...(hostEnded?{hostEnding:hostEnded}:{})}:{}),routeConsistent:!mismatch,tokens,reviewMilliseconds:prior?.observation?.reviewMilliseconds??null,integrationMilliseconds:prior?.observation?.integrationMilliseconds??null});observed++
  if(terminal)settled.add(meta.runID)
 }catch(error){diagnostics.push(meta.runID+': '+(error instanceof Error?error.message:String(error)))}}
 for(const run of readWorkflowOutcomes(target).runs){
  if(run.judgment||!run.observation||run.observation.state==='running')continue
  const judgment=run.replayOf?readReplay(store.runtime,run.runID)?.review?.judgment:reviewJudgment(quests.get(run.workflowID),run.runID)
  if(judgment)try{judgeWorkflowRun(target,{runID:run.runID,judgedAt:Math.max(now,run.observation.completedAt??run.observation.observedAt),...judgment})}catch(error){diagnostics.push(run.runID+': judgment not saved: '+(error instanceof Error?error.message:String(error)))}
 }
 for(const run of readWorkflowOutcomes(target).runs){
  const telemetry=quests.get(run.workflowID)?.extensions?.runTelemetry?.[run.runID]
  if(telemetry&&!run.telemetry&&run.observation&&run.observation.state!=='running')try{attachWorkflowTelemetry(target,run.runID,telemetry)}catch(error){diagnostics.push(run.runID+': run telemetry not saved: '+(error instanceof Error?error.message:String(error)))}
 }
 if(settled.size)change(store,state=>{state.runs=state.runs.filter(r=>!settled.has(r.runID))})
 return {observed,diagnostics,settled:settled.size}
}
