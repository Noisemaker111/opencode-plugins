import { questReference } from '../core/references'
import { hydrateSessionReferences, resolveRunReference, agentReferenceProjection } from '../host/session-projection'
import {readAllQuests} from '../index'
import {QuestStore} from '../store'
import {projectIdentityAsync} from '../core/project'
import {workerLedgerProject} from '../checkouts/source-binding'
import {QuestError,type QuestContext} from '../api'
import {questOperations} from '../operations.mjs'
import type {QuestHost} from '../runs/runtime'
import {SessionGuidance} from '../host/session-guidance'
import {giverContext} from '../giver/user-giver'
import {collectWorkflowOutcomes,workflowFile} from '../routing/outcome-tracking'
import {judgeWorkflowRun,readWorkflowOutcomes,reportWorkflowOutcomes,renderWorkflowReport,observeWorkflowRun} from '../../usage/telemetry-api'
import {mkdirSync} from 'node:fs'
import {writeFileDurable} from '../core/durable-file.mjs'
import {join} from 'node:path'
import {readQuestActivity,questActivity,ownedRuns} from '../board/activity'
const text={type:'string',minLength:1},output={type:'object',additionalProperties:true}
const agentResult=(store:QuestStore,quests:any[],value:unknown)=>{hydrateSessionReferences(store,quests);return result(agentReferenceProjection(store,value,quests))}
const result=(value:unknown)=>{const content=JSON.stringify(value);return {content,output:JSON.parse(content)}}
async function caller(store:QuestStore,host:QuestHost,ctx:any,questID?:string):Promise<{context:QuestContext;worker:boolean}>{
 if(!ctx?.sessionID||!(ctx.id??ctx.callID))throw new QuestError('HOST_CONTEXT_REQUIRED','Session and tool call identities required')
 const info=await host.get({sessionID:ctx.sessionID}),session=info?.data??info,directory=session?.location?.directory
 if(questID&&session?.id!==ctx.sessionID)throw new QuestError('HOST_CONTEXT_REQUIRED','Host session identity does not match the caller')
 const workerProject=await workerLedgerProject(store,ctx.sessionID,directory)
 const context=questID&&!workerProject?giverContext(store,session,ctx.id??ctx.callID,questID):{project:workerProject??await projectIdentityAsync(directory),sessionID:ctx.sessionID,requestID:ctx.id??ctx.callID}
 const worker=readAllQuests(store.projectRoot,{includeArchived:true}).some(r=>r.quest?.sessions.some(s=>s.openCodeSessionId===ctx.sessionID||s.sessionID===ctx.sessionID))
 return {context,worker}
}
export function guidanceTool(store:QuestStore,host:QuestHost){const guidance=new SessionGuidance(store,host,{supported:true});return {name:'quest_guidance',description:'Send bounded relevant guidance to an owned Quest worker. queue waits until idle; steer is explicit active-work guidance at a step boundary. Submitted is not acknowledged or completed. Repeated identical guidance is deduplicated; unknown delivery is retained. Workers may acknowledge their exact guidance.',output,input:{type:'object',additionalProperties:false,required:['action','questID'],properties:{action:{enum:['send','status','acknowledge']},questID:text,runID:text,text:{type:'string',minLength:1,maxLength:4000},delivery:{enum:['queue','steer']},guidanceID:text}},execute:async(input:any,ctx:any)=>{const {context}=await caller(store,host,ctx,input.questID);const q=store.read(input.questID);const answer=(value:unknown)=>agentResult(store,q?[q]:[],value);switch(input.action){case 'send':return answer(await guidance.send(context,input));case 'status':return answer({guidance:guidance.status(context,input.questID)});case 'acknowledge':return answer(guidance.acknowledge(context,input));default:throw new QuestError('INVALID_INPUT','Unknown guidance action')}}}}
export function outcomeTool(store:QuestStore,host:QuestHost,options:{file?:string}={}){return {name:'quest_outcome',description:'Inspect automatically recorded Quest workflow outcomes and graphs, or record a separate evaluator judgment with actual verification evidence. Completion is not acceptance; workers cannot judge their own work. Report is scoped to this project and preserves missing token counts.',output,input:{type:'object',additionalProperties:false,required:['action'],properties:{action:{enum:['report','judge']},questID:text,runID:text,days:{type:'integer',enum:[7,28]},exportHTML:{type:'boolean'},accepted:{type:'boolean'},firstPass:{type:['boolean','null']},reviewMilliseconds:{type:['number','null'],minimum:0},integrationMilliseconds:{type:['number','null'],minimum:0},verification:{type:'array',maxItems:30,items:{type:'object',additionalProperties:false,required:['command','exitCode','artifact'],properties:{command:text,exitCode:{type:'integer'},artifact:text}}}}},execute:async(input:any,ctx:any)=>{
 const {context,worker}=await caller(store,host,ctx);const capture=collectWorkflowOutcomes(store,{file:options.file}),file=options.file??workflowFile()
 if(input.action==='judge'){
  if(worker)throw new QuestError('WORKER_JUDGMENT_DENIED','An evaluator must judge worker results')
  const q=store.read(input.questID);if(q)input={...input,questID:q.id,runID:resolveRunReference(store,q,input.runID)};const run=q?.sessions.find(s=>s.runID===input.runID)
  if(!q||q.project?.id!==context.project.id||!run)throw new QuestError('PROJECT_MISMATCH','Run is not owned by this project')
  if(q.integrationOwner!==context.sessionID&&run.parentID!==context.sessionID)throw new QuestError('OWNER_REQUIRED','Only the owning giver evaluates this run')
  const measured=readWorkflowOutcomes(file).runs.find(r=>r.runID===input.runID)
  if(!measured?.observation||measured.observation.state==='running')throw new QuestError('OUTCOME_NOT_SETTLED','Wait for a confirmed terminal outcome and capture')
  if(input.accepted&&run.deliverables.some(id=>q.stages.find(s=>s.id===id)?.status!=='done'))throw new QuestError('UNFINISHED_STEPS','Assigned steps must be done before accepting the result')
  const sameJudgment=(r:typeof measured)=>r.judgment?.accepted===input.accepted&&r.judgment?.reviewer===context.sessionID&&r.judgment?.firstPass===(input.firstPass??null)&&JSON.stringify(r.judgment?.verification.map(v=>[v.command,v.exitCode,v.artifact]))===JSON.stringify((input.verification??[]).map((v:any)=>[v.command,v.exitCode,v.artifact]))&&(input.reviewMilliseconds===undefined||input.reviewMilliseconds===r.observation?.reviewMilliseconds)&&(input.integrationMilliseconds===undefined||input.integrationMilliseconds===r.observation?.integrationMilliseconds)
  if(measured.judgment){if(!sameJudgment(measured))throw new QuestError('REQUEST_CONFLICT','This run already has a different evaluator judgment');return agentResult(store,[q],{run:measured,capture})}
  if(input.reviewMilliseconds!==undefined||input.integrationMilliseconds!==undefined)observeWorkflowRun(file,{...measured.observation,observedAt:Date.now(),reviewMilliseconds:input.reviewMilliseconds??measured.observation.reviewMilliseconds,integrationMilliseconds:input.integrationMilliseconds??measured.observation.integrationMilliseconds})
  const judged=judgeWorkflowRun(file,{runID:input.runID,judgedAt:Date.now(),accepted:input.accepted,firstPass:input.firstPass??null,reviewer:context.sessionID,verification:input.verification??[]})
  return agentResult(store,[q],{run:judged,capture})
 }
 if(input.action!=='report')throw new QuestError('INVALID_INPUT','Unknown outcome action')
 const report=reportWorkflowOutcomes(file,{projectID:context.project.id,days:input.days??28});let reportPath:string|undefined
 if(input.exportHTML){const dir=join(store.runtime,'reports');mkdirSync(dir,{recursive:true});reportPath=join(dir,'workflow-'+context.project.id+'.html');writeFileDurable(reportPath,renderWorkflowReport(report))}
 return agentResult(store,readAllQuests(store.projectRoot,{includeArchived:true}).flatMap(row=>row.quest?.project?.id===context.project.id?[row.quest]:[]),{report,reportPath,capture})
}}}
export function workSupplyTool(store:QuestStore,host:QuestHost){return {name:'quest_work_supply',description:'Bounded inventory of existing pending Quest steps in this project or explicitly across projects. Lists dependency-ready work, active workers and blocking conditions for pacing. Does not invent tasks, dispatch, or count queued work as workers.',output,input:{type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:50},allProjects:{type:'boolean'}}},execute:async(input:{limit?:number;allProjects?:boolean},ctx:any)=>{const {context}=await caller(store,host,ctx);const records=readAllQuests(store.projectRoot),quests=records.flatMap(r=>r.quest&&(input.allProjects||r.quest.project?.id===context.project.id)&&r.quest.state!=='Archived'?[r.quest]:[]);const snapshot=await readQuestActivity(host,quests);let active=0,ready=0,running=0;const items=quests.map(q=>{const workers=ownedRuns(q),activity=questActivity(q,snapshot);active+=workers.length;running+=activity.running;const steps=q.stages.filter(s=>s.status==='pending'&&s.needs.every(id=>q.stages.find(d=>d.id===id)?.status==='done')&&!workers.some(w=>w.deliverables.includes(s.id)));ready+=steps.length;return {questID:questReference(q),title:q.title,project:q.project,readySteps:steps.map(s=>({id:s.id,title:s.title,needs:s.needs})),active:activity.running,unknown:activity.unconfirmed,assigned:activity.assigned,checkedAt:activity.checkedAt}}).filter(q=>q.readySteps.length||q.assigned);return result({projectID:context.project.id,readySteps:ready,activeRuns:running,unconfirmedRuns:active-running,activeOrUncertainRuns:active,items:items.slice(0,input.limit??20),truncated:items.length>(input.limit??20),diagnostics:records.flatMap(r=>r.quest?[]:r.errors),note:'Ready dependency state is not dispatch authorization or capacity; exact route, workspace and pacing checks apply at admission. Cross-project work requires its own verified destination-bound giver.'})}}}
export function reportTool(call:(method:string,args:unknown,context:any)=>Promise<any>){return {name:'quest_report',description:questOperations.report.description+' This direct tool saves the same report when the remote quests namespace is unavailable.',output:{type:'object',additionalProperties:true,required:['id','revision','steps'],properties:{id:text,revision:{type:'integer'},steps:{type:'array',items:{type:'object',additionalProperties:true,required:['id','state'],properties:{id:text,state:text,note:text,checks:{type:'array',items:{type:'object',additionalProperties:true}}}}}}},input:questOperations.report.input,execute:async(input:any,ctx:any)=>result(await call('report',input,{sessionID:ctx?.sessionID,id:ctx?.id??ctx?.callID,native:true}))}}
