import { SessionReferences } from "../host/session-references"
import { isReadableReference } from "../core/readable-reference"
import { checkoutLine, siblingQuests, workerPrompt } from '../workers/assignment-context'
import { readAllQuests } from '../index'
import { assignPROwner, deliveryInstructions, handoffInstructions, standingDeliveryAuthorization, questWorkflow } from './workflow'
import {holdDispatch,noteDispatchStage,noteDispatchAdmitted,type DispatchHold} from './dispatch-intent'
import {verifyGiverBinding} from '../giver/user-giver'
import {researchGuardReady,researchPermissions} from "../permissions/shared-guard"
import {assertBurnLaunchAllowed} from "../../usage/telemetry-api"
import {workspaceSettings} from "../checkouts/workspace-settings"
import { normalizeArtifact } from "../artifacts/artifacts"
import { configuredCommand, runKnownCommand } from "../command-runtime"
import { realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { QuestError,type AdmitRun,type StartRun } from "../api"
import { QuestStore } from "../store"
import { QuestWorkspaces, dependencyContributes, type Workspace } from "../workspaces"
import { allocateWorkspace, allocateEditingWorkspace } from "../checkouts/workspace-allocation"
import { blockPushesForNoneDelivery } from "../checkouts/delivery-none-push"
import { admitDispatch, reserveDispatch, dispatchReservationFile, type DispatchAdmission, type Withheld } from "../../models/dispatch-planner"
import { hostClaudeAuth, withClaudeFallback, type ClaudeAuthCheck } from "./claude-fallback"
import { readDispatchPolicy } from "../../models/dispatch-policy"
import { workspaceRunID } from "../board/change-view"
import { verifySourceBinding } from "../core/project"
import { editingSource } from "../checkouts/source-binding"
import { routingSettings } from "../routing/routing-settings"
import { clearRoutingProgress, dispatchHelpers, recordRoutingDecision, routingProgress } from "../routing/routing-history"
import { tagInferredProfile } from "../routing/outcome-tracking"
import { STATED_PROFILE } from "../../models/work-profile"
import { continuationWorkspace, currentLandingBase, serialContinuationContext, workspaceMatchesProject } from "./continuation-workspace"
import { timed, recordSpan } from "../../scripts/plugin-spans"
import { confirmWorkerIdle } from '../workers/worker-inspection'
import { watchWorkerLocation, type ToolsReadiness } from '../workers/worker-location'
import { presentOrServingRelease } from '../host/serving-release'
import { RECONCILED_NOTE, TERMINAL_RUN } from './session-lineage'
import { dependencyInheritance, dependencyNotLandedMessage } from '../landing/dependency-runs'
import { landedRunIDs, unlandedDependency } from '../landing/dependency-landing'
import type { BootstrapDeclaration } from "../checkouts/workspace-bootstrap"
import { driveAsync } from "../landing/git-steps"
import { sentence, noteReason } from '../review/plain-words'
import { rememberSession } from '../host/session-identity'
import { assignmentText, inputFilesInstruction, placeInputFiles } from '../workers/worker-inputs'
import { workerHoldReason } from '../workers/worker-admission'
type QuestHostOptions={signal?:AbortSignal}
export type QuestHost = { create:(input:any)=>Promise<any>;get:(input:any,options?:QuestHostOptions)=>Promise<any>;prompt:(input:any,options?:QuestHostOptions)=>Promise<any>;interrupt?:(input:any)=>Promise<any>;switchModel?:(input:any)=>Promise<any>;move?:(input:any)=>Promise<any>;context?:(input:any,options?:QuestHostOptions)=>Promise<any>;generate?:(input:any)=>Promise<any> }
const unwrap=(value:any)=>value?.data??value
async function dispatchStage<T>(runID:string,stage:string,operation:()=>Promise<T>):Promise<T> {
 const began=performance.now();console.error('[quest-dispatch] '+stage+' begin '+runID)
 noteDispatchStage(runID,stage)
 try{return await timed({plugin:'quests',name:'dispatch.'+stage,op:runID},operation)}
 finally{console.error('[quest-dispatch] '+stage+' end '+runID+' '+Math.round(performance.now()-began)+'ms')}
}
const canonicalPath=(path:string)=>{let real:string;try{real=realpathSync(path)}catch{real=resolve(path)}return process.platform==="win32"?real.toLowerCase():real}
const samePath=(a:string,b:string)=>canonicalPath(a)===canonicalPath(b)
export function stepFiles(files:string[]|undefined,steps:{claim?:{include?:string[]}}[]):string[]|undefined {
 const named=[...(files??[]),...steps.flatMap(step=>step.claim?.include??[])].map(file=>file.trim()).filter(Boolean)
 return named.length?named:undefined
}

export function startQuestRun(store:QuestStore,host:QuestHost,options:{policyFile:string;settingsFile?:string;reserve?:typeof reserveDispatch;admit?:typeof admitDispatch;beforePrompt?:typeof assertBurnLaunchAllowed;spares?:boolean;routing?:typeof routingSettings;toolsReady?:ToolsReadiness;claudeAuth?:ClaudeAuthCheck}):StartRun {
  const workspaces=new QuestWorkspaces(store.runtime)
  const assertCurrentProject=(input:Parameters<StartRun>[0])=>{const current=store.read(input.quest.id);if(current?.project?.id!==input.context.project.id||!samePath(current.project.root,input.context.project.root))throw new QuestError('SOURCE_BINDING_FAILED','The Quest project changed; prepare its current destination before starting a worker')}
 const dispatch=async(input:Parameters<StartRun>[0],intent:DispatchHold)=>{
  const {directory,giverInstructionDirectory,source,allocate,assigned,freshBase}=await dispatchStage(input.runID,'source-binding',async()=>{
  let mode: "worktree"|"shared"
  let directory:string
  let giverInstructionDirectory:string|undefined
  let retainedContext=input.context
  assertCurrentProject(input)
  let original=await continuationWorkspace(store,retainedContext,options.policyFile)
   if(!original&&!retainedContext.resume&&!retainedContext.freshBase){retainedContext=serialContinuationContext(input.quest,retainedContext);original=await continuationWorkspace(store,retainedContext,options.policyFile)}
   if(!original&&retainedContext.resume)console.error('[quests] '+input.runID+': the previous checkout cannot be reused, so this run starts with a fresh checkout from the project as it is now')
  if(input.recoverDependencies&&(!original||input.readOnly||questWorkflow(input.quest).delivery!=='quest-pr'||questWorkflow(input.quest).maxConcurrent!==1))throw new QuestError('DEPENDENCY_RECOVERY_DENIED','Recovery requires a retained writable serial Quest PR attempt')
  const assigned=input.quest.stages.filter(s=>input.stepIDs.includes(s.id))
  if(input.readOnly&&assigned.some(s=>s.commandID))throw new QuestError("RESEARCH_COMMAND_DENIED","Read-only research cannot execute configured commands")
  const dependencies=dependencyInheritance(input.quest,input.stepIDs)
  if('refused' in dependencies)throw new QuestError(dependencies.refused.code,dependencies.refused.message)
  for(const {stepID,run} of dependencies.landedProof){const missing=await unlandedDependency(input.quest,run,workspaces);if(missing)throw new QuestError("DEPENDENCY_UNFINISHED",dependencyNotLandedMessage(input.quest,stepID,run,missing))}
  const inheritableRuns=async()=>{
   const inheritRunIDs:string[]=dependencies.inherit.filter(workspaceRunID)
   const retry=retainedContext.freshBase?undefined:[...input.quest.sessions].reverse().find(s=>["failed","cancelled"].includes(s.state)&&s.runID&&s.deliverables.some(id=>input.stepIDs.includes(id)))
   {const retained=retry?.runID&&workspaceRunID(retry.runID)?workspaces.get(retry.runID):undefined;if(retained&&await workspaceMatchesProject(retained,input.context,options.policyFile)&&!workspaces.checkoutMissing(retained)){if(workspaces.preparedAssignmentLost(retained))console.error('[quests] Prepared spare no longer claims the previous run; starting with a fresh checkout and preserving '+retained.path);else inheritRunIDs.push(retry!.runID!)}}
   return [...new Set(inheritRunIDs)].filter(id=>dependencyContributes(workspaces.get(id)))
  }
  let inherited=await inheritableRuns()
  const missingFromRetained=(retained:Workspace)=>inherited.filter(id=>{const dependency=workspaces.get(id);return dependency&&!samePath(dependency.path,retained.path)&&!retained.inheritedRunIDs?.includes(id)})
  let landedRestart=false
  if(original&&!input.recoverDependencies&&!input.readOnly){
   const missing=missingFromRetained(original)
   const landed=missing.length?await landedRunIDs(input.quest,missing,workspaces):[]
   if(missing.length&&landed.length===missing.length){
    console.error('[quests] '+input.runID+': the retained checkout lacks dependency changes that already landed ('+missing.join(', ')+'), so this run starts a new checkout from the current landing branch')
    original=undefined
    landedRestart=true
    retainedContext={...retainedContext,resume:undefined,freshBase:true}
    inherited=(await inheritableRuns()).filter(id=>!landed.includes(id))
   }
  }
  if(original){
   const prior=input.quest.sessions.find(run=>(run.runID??run.callID)===retainedContext.resume?.runID)
   const sessionID=prior?.openCodeSessionId??prior?.sessionID
   const handoff=prior&&!prior.deliverables.some(id=>input.stepIDs.includes(id))
    if(handoff){const history=input.quest.extensions.prOwnerHistory as {to?:{runID:string}}[]|undefined;const initialID=history?.[0]?.to?.runID;const initial=initialID?workspaces.get(initialID):undefined;if(initialID&&!initial)throw new QuestError('CONTINUATION_WORKSPACE_UNAVAILABLE','The original PR owner workspace receipt is unavailable; restore ownership before handoff');if(initial&&await workspaceMatchesProject(initial,input.context,options.policyFile)&&!samePath(initial.path,original.path)&&!original.inheritedRunIDs?.includes(initialID!))throw new QuestError('CONTINUATION_WORKSPACE_UNAVAILABLE','The current PR owner checkout does not retain the original implementation owner; recover declared dependencies before further handoff')}
   if(handoff&&sessionID){const owner=unwrap(await host.get({sessionID}));if(owner?.id!==sessionID||typeof owner?.location?.directory!=='string'||!samePath(owner.location.directory,original.path))throw new QuestError('CONTINUATION_WORKSPACE_BUSY','The previous native owner is not bound to the retained checkout; no new worker was started.')}
   if(handoff&&(input.quest.sessions.some(run=>(run.runID??run.callID)!==input.runID&&['planned','executing','waiting','blocked'].includes(run.state))||!sessionID||!await confirmWorkerIdle(host,sessionID)))throw new QuestError('CONTINUATION_WORKSPACE_BUSY','The previous workspace owner has not been confirmed idle or another Quest writer remains active; no new worker was started.')
  }
  try{const owner=unwrap(await host.get({sessionID:input.context.sessionID}));directory=original?.path??input.context.directory??owner?.location?.directory;giverInstructionDirectory=presentOrServingRelease(owner?.location?.directory);if(input.context.giverDirectory)await verifyGiverBinding(store,input.context,owner);else if(!original){if(input.context.directory)await verifySourceBinding(input.context,directory);else await verifySourceBinding({...input.context,directory},directory)}}catch(error){throw new QuestError("SOURCE_BINDING_FAILED",error instanceof Error?error.message:String(error))}
  try{mode=workspaceSettings(options.settingsFile).workspaceMode}catch(error){throw new QuestError("WORKSPACE_SETTINGS_INVALID",error instanceof Error?error.message:String(error))}
  if(input.readOnly&&!researchGuardReady(host))throw new QuestError("RESEARCH_GUARD_UNAVAILABLE","The host has no verified read-only research guard; no worker was started")
  let source:Awaited<ReturnType<typeof editingSource>>
   try{source=original?{project:{id:original.projectID,root:original.root},source:directory,files:original.fileScopes??input.files}:await editingSource({project:input.context.project,directory},options.policyFile,input.files,{readOnly:input.readOnly})}catch(error){throw new QuestError("SOURCE_BINDING_FAILED",error instanceof Error?error.message:String(error))}
   if(original&&(original.mode==='research')!==!!input.readOnly)throw new QuestError('CONTINUATION_WORKSPACE_UNAVAILABLE','Continuation access mode differs from its original workspace; no checkout was substituted')
   const freshBase=retainedContext.freshBase&&!input.readOnly&&!original?await currentLandingBase(source.project.root,source.source):undefined
   if(freshBase&&!landedRestart)console.error('[quests] '+input.runID+': the step was sent back twice with the same gaps, so this run starts a new checkout from '+freshBase)
   const allocate=async(bootstrap?:BootstrapDeclaration)=>{
    const workspace=await allocateCheckout(bootstrap)
    if(workspace.mode!=='shared'&&workspace.mode!=='research')await blockPushesForNoneDelivery(workspace.path,input.quest.id,questWorkflow(input.quest).delivery)
    return workspace
   }
   const allocateCheckout=(bootstrap?:BootstrapDeclaration)=>{
    if(original)return allocateWorkspace({runtime:store.runtime,projectRoot:store.projectRoot,mode:"resume",input:{runID:input.runID,questID:input.quest.id,original,files:source.files,bootstrap}})
    if(input.readOnly)return allocateWorkspace({runtime:store.runtime,projectRoot:store.projectRoot,mode:"research",input:{runID:input.runID,questID:input.quest.id,directory:source.source,project:source.project}})
    if(mode==="shared")return allocateWorkspace({runtime:store.runtime,projectRoot:store.projectRoot,mode:"shared",input:{runID:input.runID,questID:input.quest.id,directory:source.source,project:source.project,files:source.files,inheritRunIDs:inherited}})
    return allocateEditingWorkspace({runtime:store.runtime,projectRoot:store.projectRoot,projectID:source.project.id,spares:options.spares===true,input:{runID:input.runID,questID:input.quest.id,directory:source.source,project:source.project,inheritRunIDs:inherited,bootstrap,files:stepFiles(input.files,assigned),branch:questWorkflow(input.quest).branch,...(freshBase?{base:freshBase}:{})}})
   }
  if(original){
   const missing=missingFromRetained(original)
   if(missing.length&&input.recoverDependencies){
    const involved=[original,...missing.map(id=>workspaces.get(id)!)];
    if(input.quest.sessions.some(run=>(run.runID??run.callID)!==input.runID&&['planned','executing','waiting','blocked'].includes(run.state)))throw new QuestError('DEPENDENCY_RECOVERY_DENIED','Reconcile all Quest writers before recovering dependencies')
    for(const workspace of involved){
     const owner=input.quest.sessions.findLast(run=>{const receipt=workspaces.get(run.runID??run.callID);return receipt&&samePath(receipt.path,workspace.path)&&!!(run.openCodeSessionId??run.sessionID)})
     const sessionID=owner?.openCodeSessionId??owner?.sessionID
     if(!owner||!['completed','failed','cancelled'].includes(owner.state)||!sessionID)throw new QuestError('DEPENDENCY_RECOVERY_DENIED','Recovery requires reconciled terminal native owners of every checkout')
     const bound=unwrap(await host.get({sessionID}));if(bound?.id!==sessionID||typeof bound?.location?.directory!=='string'||!samePath(bound.location.directory,workspace.path)||!await confirmWorkerIdle(host,sessionID))throw new QuestError('DEPENDENCY_RECOVERY_DENIED','A dependency or destination native owner is not confirmed idle at its recorded checkout')
    }
    original=await workspaces.recoverDependencies({original,runID:input.runID,questID:input.quest.id,store,inheritRunIDs:missing});
   }else if(missing.length)throw new QuestError('CONTINUATION_DEPENDENCIES_MISSING','The retained checkout does not contain newly required dependency changes: '+missing.join(', ')+'. Reconcile this attempt and prepare the dependency handoff before retrying; no worker was started.')
  }
   return {directory,giverInstructionDirectory,source,allocate,assigned,freshBase}
   })
   const hold=workerHoldReason(store,store.read(input.quest.id)??input.quest)
   if(hold)throw new QuestError('WORKER_HOLD',hold)
   if(assigned.some(s=>s.commandID)) {
   intent.advance('command')
   if(input.model)throw new QuestError("EXPLICIT_MODEL_CONFLICT","Configured command steps do not use a model; the explicit model was not substituted")
   if(assigned.some(s=>!s.commandID))throw new QuestError("MIXED_EXECUTION","Run configured command steps separately from model work")
   let workspace:Awaited<ReturnType<QuestWorkspaces["create"]>>
   const sessionID="command_"+input.runID
   try{const policy=readDispatchPolicy(options.policyFile),commands=assigned.map(s=>configuredCommand(options.policyFile,input.context.project.id,s.commandID!));workspace=await allocate(policy.bootstrapByProject?.[input.context.project.id])
     if(workspace.projectID!==source.project.id||!samePath(workspace.root,source.project.root))throw new QuestError('WORKSPACE_BINDING_FAILED','The prepared checkout does not belong to the selected destination; no command was started')
     assertCurrentProject(input)
     if(!input.readOnly)await workspaces.assertSourceProject(workspace)
    store.apply(input.quest.id,"session-claimed",{callID:input.runID,runID:input.runID,sessionID,parentID:input.context.sessionID,agentRole:"command",role:"command",scope:{repo:workspace.root,worktree:workspace.path,branch:workspace.branch,files:workspace.fileScopes??source?.files??input.files??["."],requestedFiles:input.files??["."],readOnly:input.readOnly===true,workspaceMode:workspace.mode??"worktree"}},"quest:command")
     for(const [index,command] of commands.entries()){
      const step=assigned[index]
      store.apply(input.quest.id,"stage-state",{stageID:step.id,status:"working"},"quest:command")
      const result=await runKnownCommand(command,workspace.path,join(store.runtime,"command-logs",input.runID+"-"+index+".log")),ok=result.exitCode===0&&!result.timedOut
      const summary=sentence(command.description+(ok?' passed':result.timedOut?' took too long and was stopped':' failed'))+(ok?'':' Fix the saved command error before trying again.')
      store.apply(input.quest.id,"stage-state",{stageID:step.id,status:ok?"done":"blocked",evidence:summary},"quest:command")
      const q=store.read(input.quest.id)!
      store.apply(q.id,"patched",{evidence:{...q.evidence,tests:[...q.evidence.tests,{command:command.argv.join(' '),...(result.exitCode===null?{}:{exitCode:result.exitCode}),result:ok?'passed':'failed',at:new Date().toISOString(),stepID:step.id,artifact:result.logFile}],artifacts:[...q.evidence.artifacts,normalizeArtifact({name:command.description,path:result.logFile,verified:true})]}},"quest:command")
      if(!ok)throw new QuestError("COMMAND_FAILED",summary)
     }
     for(const step of assigned)store.apply(input.quest.id,'proof-added',{stageID:step.id,proof:{id:input.runID+':'+step.id,kind:'command',at:new Date().toISOString(),attempt:step.attempt,result:'passed',command:step.commandID,verified:true}},'quest:command')
      await workspaces.collect(input.runID);await workspaces.releaseShared(input.runID,store,"Configured command finished");store.apply(input.quest.id,"session-state",{callID:input.runID,state:"completed",result:"The commands passed and their output was saved."},"quest:command");return {sessionID}
   }catch(e){
    for(const step of assigned){const current=store.read(input.quest.id)?.stages.find(s=>s.id===step.id);if(current?.status==="working")store.apply(input.quest.id,"stage-state",{stageID:step.id,status:"blocked",evidence:e instanceof Error?e.message:String(e)},"quest:command")}
    try{if(workspaces.get(input.runID)){await workspaces.collect(input.runID);await workspaces.releaseShared(input.runID,store,"Configured command terminated")}}catch{}
    if(e instanceof QuestError)throw e;throw new QuestError("COMMAND_FAILED",e instanceof Error?e.message:String(e))
   }
  }
  let selected:Awaited<ReturnType<typeof reserveDispatch>>
  const lines=(parts:(string|undefined)[])=>parts.filter((part):part is string=>typeof part==="string"&&!!part.trim()).join("\n")
  const brief=lines([input.quest.title,input.quest.objective,input.quest.description,...assigned.map(step=>lines([
   "Step: "+step.title,step.detail,
   ...step.todos.map(todo=>"- "+todo.title+(todo.status==="done"?" (done)":"")),
   step.claim.include.length?"Files: "+step.claim.include.join(", "):undefined,
  ]))])
  const setBy=(field:'depth'|'workType')=>!assigned.some(step=>step[field]!==undefined)&&questWorkflow(input.quest)[field]!==undefined?'Quest':'giver'
  const settled=<T,>(work:Promise<T>)=>work.then(value=>({value}),(error:unknown)=>({error}))
  const allocationStarted=Date.now()
  let declared:{bootstrap?:BootstrapDeclaration}|undefined
  try{declared={bootstrap:readDispatchPolicy(options.policyFile).bootstrapByProject?.[input.context.project.id]}}catch{}
  try{const choose=(withheld?:Withheld)=>dispatchStage(input.runID,'route-selection',()=>{const routing=(options.routing??routingSettings)();return (options.reserve??reserveDispatch)({runID:input.runID,model:input.model,...(input.chosenBy?{chosenBy:input.chosenBy}:{}),routing,policyFile:options.policyFile,reservationFile:dispatchReservationFile(store.runtime),task:input.task,depth:input.depth,workType:input.workType,readOnly:input.readOnly,questKind:input.quest.kind,brief,profileSetBy:{depth:setBy('depth'),workType:setBy('workType')},...(withheld?{withheld}:{}),progress:routingProgress(store.runtime,input.runID,{quest:{id:input.quest.id,...(input.quest.ref?{ref:input.quest.ref}:{}),title:input.quest.title},steps:assigned.map(step=>({id:step.id,title:step.title}))}),...dispatchHelpers(host as any,store.runtime,giverInstructionDirectory??directory,routing,input.runID)})});selected=await withClaudeFallback({runID:input.runID,explicit:input.model!==undefined,check:options.claudeAuth??hostClaudeAuth(host as any,giverInstructionDirectory??directory),first:await choose(),choose:withheld=>choose(withheld)})}catch(e){try{clearRoutingProgress(store.runtime,input.runID)}catch{}throw new QuestError("ROUTE_UNAVAILABLE",e instanceof Error?e.message:String(e),false,input.runID)}
  if(selected.record)try{recordRoutingDecision(store.runtime,input.runID,{id:selected.route.id,model:selected.route.providerID+"/"+selected.route.modelID,effort:selected.route.reasoning},selected.record)}catch(error){console.error("[quests] routing decision not recorded "+input.runID,error)}
  if((selected.classification?.depth||selected.classification?.workType)&&selected.classification.profileSource&&selected.classification.profileSource!==STATED_PROFILE)try{tagInferredProfile(store,input.runID,{depth:selected.classification.depth,workType:selected.classification.workType})}catch(error){console.error("[quests] inferred work profile not tagged for outcome learning",error)}
  let sessionID:string|undefined,promptAttempted=false,creationAttempted=false,location:ReturnType<typeof watchWorkerLocation>|undefined
  try{
   const hold=workerHoldReason(store,store.read(input.quest.id)??input.quest)
   if(hold)throw new QuestError('WORKER_HOLD',hold)
   if(selected.route.serviceTier!=="default")throw new QuestError("SERVICE_TIER_UNAVAILABLE","The configured service tier cannot be represented by this host adapter; no default tier was substituted")
    if(selected.route.harness!=="native")throw new QuestError("HARNESS_UNAVAILABLE","This dispatch adapter runs native routes; the requested harness was not substituted")
    await timed({plugin:'quests',name:'dispatch.burn-pacing-check',op:input.runID},()=>(options.beforePrompt??assertBurnLaunchAllowed)(selected.route.accountID))
    const preparing=declared&&!input.readOnly&&settled(dispatchStage(input.runID,'workspace-preparation',()=>allocate(declared!.bootstrap)))
    const chosenBootstrap=selected.bootstrapByProject[input.context.project.id]
   const prepared=preparing&&await preparing
   if(prepared&&JSON.stringify(declared!.bootstrap)!==JSON.stringify(chosenBootstrap))throw new QuestError("WORKSPACE_PREPARATION_FAILED","The project preparation in the dispatch policy changed while the route was chosen; retry the run")
   if(prepared&&"error" in prepared)throw prepared.error
    const workspace=prepared?prepared.value:await dispatchStage(input.runID,'workspace-preparation',()=>allocate(chosenBootstrap))
    if(workspace.projectID!==source.project.id||!samePath(workspace.root,source.project.root))throw new QuestError('WORKSPACE_BINDING_FAILED','The prepared checkout does not belong to the selected destination; no worker was started')
   for(const stage of workspace.preparationTimeline??[])if(stage.start>=allocationStarted)recordSpan({plugin:'quests',name:'dispatch.workspace-preparation: '+stage.stage,op:input.runID,start:stage.start,end:stage.end})
   const landingRead=input.readOnly||workspace.mode==="shared"||questWorkflow(input.quest).delivery==='none'?undefined:settled(driveAsync(workspaces.deliveryPolicySteps(workspace)))
    const sourceCheck=input.readOnly?undefined:settled(driveAsync(workspaces.assertSourceProjectSteps(workspace)))
    {const checked=sourceCheck&&await sourceCheck;if(checked&&'error' in checked)throw checked.error}
   const model={providerID:selected.route.providerID,id:selected.route.modelID,...(selected.route.reasoning!=="unknown"?{variant:selected.route.reasoning}:{})}
    intent.advance('creating')
    assertCurrentProject(input)
   creationAttempted=true
   const created=unwrap(await dispatchStage(input.runID,'host-create',()=>host.create({title:input.runID,agent:selected.route.agent??"worker",model,location:{directory:realpathSync.native(workspace.path)},...(input.readOnly?{permissions:researchPermissions()}:{})})));sessionID=created?.id
   const briefing=Date.now()
   if(!sessionID)throw new QuestError("DISPATCH_OUTCOME_UNKNOWN","Host did not return a worker session identity; workspace and reservation retained")
   intent.advance('created',sessionID)
   new SessionReferences(store.runtime).register({sessionID,runID:input.runID,title:input.quest.sessions.find(s=>s.runID===input.runID)?.sessionTitle??assigned.map(s=>s.title).join(' and ')??input.runID,...(isReadableReference(input.runID)?{ref:input.runID}:{}),source:'opencode'})
   const actual=unwrap(await timed({plugin:'quests',name:'dispatch.prompt-preparation: worker binding',op:input.runID},()=>host.get({sessionID}))),directory=actual?.location?.directory
   if(typeof directory!=="string"||!samePath(directory,workspace.path))throw new QuestError("WORKSPACE_BINDING_FAILED","Worker session is not bound to its owned worktree; no prompt was sent")
   if(actual?.model?.providerID!==model.providerID||actual?.model?.id!==model.id||model.variant!==undefined&&actual?.model?.variant!==model.variant)throw new QuestError("ROUTE_BINDING_FAILED","Host did not bind the selected model/variant; no prompt was sent")
   if(selected.route.agent && actual?.agent!==selected.route.agent)throw new QuestError("AGENT_BINDING_FAILED","Host did not bind the selected worker role; no prompt was sent")
   rememberSession(store.runtime,actual)
   const standing=input.readOnly||questWorkflow(input.quest).delivery==='none'?undefined:standingDeliveryAuthorization(workspace.path)
   const landing=landingRead?await timed({plugin:'quests',name:'dispatch.prompt-preparation: wait for landing policy',op:input.runID},()=>landingRead.then(read=>"value" in read?{into:read.value.policy.into,remote:read.value.policy.remote,method:read.value.policy.method,merge:!!read.value.policy.pullRequest?.merge?.length}:undefined)):undefined
   store.apply(input.quest.id,"session-claimed",{callID:input.runID,runID:input.runID,sessionID,state:"planned",generation:process.env.OPENCODE_PLUGIN_GENERATION,parentID:input.context.sessionID,model:input.model&&!selected.record?.refusedByName?input.model:selected.route.providerID+"/"+selected.route.modelID,agentRole:selected.route.agent??"worker",providerID:selected.route.providerID,modelID:selected.route.modelID,reasoningEffort:selected.route.reasoning,runtime:"native",scope:{repo:workspace.root,giverInstructionDirectory,worktree:workspace.path,branch:workspace.branch,files:workspace.fileScopes??source?.files??input.files??["."],requestedFiles:input.files??["."],readOnly:input.readOnly===true,workspaceMode:workspace.mode??"worktree",...(standing||landing?{delivery:{authorization:standing,...landing}}:{})}},"quest:runtime")
   if(selected.decision)store.apply(input.quest.id,"session-state",{callID:input.runID,state:"planned",routingNote:selected.decision.summary,evidence:selected.decision.summary,...(selected.record?.expectedFinishMs?{expectedFinishMs:selected.record.expectedFinishMs}:{})},"quest:routing")
   const steps=input.quest.stages.filter(s=>input.stepIDs.includes(s.id))
   const role=input.readOnly?"Read-only research: source mutation, shell execution and delegation are denied; inspect with the read, search and web tools and save findings through quest_report.":undefined
   const preparedSteps=(()=>{try{const value=JSON.parse(workspace.preparedBootstrap??"[]");return Array.isArray(value)?(value.length&&typeof value[0]==="string"?1:value.length):0}catch{return 0}})()
   const placedInputs=input.readOnly||workspace.mode==="shared"||workspace.mode==="research"?[]:(()=>{try{return placeInputFiles({root:workspace.root,checkout:workspace.path,text:assignmentText(input.quest,input.stepIDs,input.task)})}catch(error){console.error("[quests] input files not placed in the worker checkout "+input.runID,error);return []}})()
   const workspaceInstruction=[source?.scopePrefix?"Paths named under "+source.scopePrefix+"/ are relative to this workspace; drop that prefix.":"",input.readOnly?"":workspace.mode==="shared"?"Edit only reserved paths: "+workspace.fileScopes!.join(", ")+". Preserve other workers' changes; dependency setup and Git index or branch operations require exclusive ownership.":preparedSteps&&workspace.preparationSkipped?.length?"Project preparation left out: "+workspace.preparationSkipped.join("; ")+".":"",inputFilesInstruction(placedInputs),freshBase?"The checks sent this step back again with the same gaps, so this checkout starts from current "+freshBase.replace(/^refs\/(?:remotes|heads)\//,"")+". Redo the step here; do not reuse the earlier branch.":""].filter(Boolean).join(" ")
    {const checked=sourceCheck&&await timed({plugin:'quests',name:'dispatch.prompt-preparation: wait for source check',op:input.runID},()=>sourceCheck);if(checked&&"error" in checked)throw checked.error}
     const dispatchedQuest=!input.readOnly&&(input.task??'coding')==='coding'?await timed({plugin:'quests',name:'dispatch.prompt-preparation: pull request owner',op:input.runID},()=>assignPROwner(store,input.quest.id,input.runID,sessionID,host)):store.read(input.quest.id)!
    const preserved=[...new Map((await Promise.all(input.quest.sessions.map(async run=>{const receipt=workspaces.get(run.runID??run.callID);return receipt&&!await workspaceMatchesProject(receipt,input.context,options.policyFile)?[[receipt.path,receipt] as const]:[]}))).flat()).values()]
    const preservedInstruction=preserved.length?'The Quest moved projects. Earlier branches and evidence remain in these recorded checkouts: '+preserved.map(receipt=>JSON.stringify({directory:receipt.path,branch:receipt.branch})).join(', ')+'. Relative evidence paths from those attempts belong there, not in the destination project folder. They do not grant access outside this assignment; ask the Quest Giver for evidence needed from them.':''
    const prompt=workerPrompt({quest:dispatchedQuest,stepIDs:input.stepIDs,task:input.task,depth:input.depth,siblings:dispatchedQuest.request?.length?siblingQuests(dispatchedQuest,readAllQuests(store.projectRoot).flatMap(entry=>entry.quest?[entry.quest]:[])):[],readOnly:role,checkout:input.readOnly?undefined:checkoutLine({branch:workspace.mode==="shared"?undefined:workspace.branch,into:landing?.into,merge:landing?.merge,standing}),delivery:deliveryInstructions(dispatchedQuest,sessionID),handoff:handoffInstructions(dispatchedQuest),preserved:preservedInstruction,workspace:workspaceInstruction})
    store.apply(input.quest.id,'patched',{extensions:{...dispatchedQuest.extensions,handoffSizes:{...(dispatchedQuest.extensions.handoffSizes as Record<string,unknown>??{}),[input.runID]:{characters:prompt.length,bytes:Buffer.byteLength(prompt,'utf8')}}}},'quest:handoff-size',{expectedRevision:dispatchedQuest.revision})
   const workerID=sessionID
   location=watchWorkerLocation(realpathSync.native(workspace.path),workerID,reason=>{
     try{store.apply(input.quest.id,"session-state",{callID:input.runID,state:"failed",result:noteReason(reason),evidence:reason},"quest:worker-location")}catch(error){console.error('[quest-dispatch] worker-location failure not recorded '+input.runID,error)}
    void host.interrupt?.({sessionID:workerID})?.catch(error=>console.error('[quest-dispatch] worker-location interrupt failed '+input.runID,error))
   })
   const missing=await timed({plugin:'quests',name:'dispatch.prompt-preparation: wait for worker tools',op:input.runID},()=>location!.ready(options.toolsReady))
   if(missing)throw new QuestError("WORKER_TOOLS_UNAVAILABLE",missing+" No prompt was sent.")
   recordSpan({plugin:'quests',name:'dispatch.prompt-preparation',op:input.runID,start:briefing,end:Date.now()})
   intent.advance('prompting',sessionID)
   promptAttempted=true
   await dispatchStage(input.runID,'prompt-admission',()=>host.prompt({sessionID,text:prompt}))
   if(location.reason)throw new QuestError("WORKER_TOOLS_UNAVAILABLE",location.reason+" The admitted prompt cannot start a turn there.")
   location.dispatched()
   store.apply(input.quest.id,"session-state",{callID:input.runID,state:"executing",preserveTerminal:true},"quest:prompt-admitted")
   let started=false
   for(const step of steps){const current=store.read(input.quest.id)?.stages.find(s=>s.id===step.id);if(current?.status!=="pending")continue;const cleared=RECONCILED_NOTE.test(current.note??"");if(!started||cleared)store.apply(input.quest.id,"stage-state",{stageID:step.id,status:started?"pending":"working",...(cleared?{evidence:""}:{})},"quest:runtime");started=true}
   noteDispatchAdmitted(input.runID)
   console.error('[quest-dispatch] admitted '+input.runID)
   return {sessionID}
  }catch(e){
   if(promptAttempted)location?.dispatched();else location?.stop()
   const unknown=!(e instanceof QuestError&&e.code==="WORKER_TOOLS_UNAVAILABLE")&&(promptAttempted||creationAttempted&&!sessionID||e instanceof QuestError&&e.code==="DISPATCH_OUTCOME_UNKNOWN")
   if(!unknown)try{await workspaces.releaseShared(input.runID,store,"Known preprompt failure")}catch{}
   selected.ledger.settle(input.runID,{state:unknown?"unknown":"cancelled"})
   if(unknown)throw new QuestError("DISPATCH_OUTCOME_UNKNOWN",e instanceof Error?e.message:String(e),false,input.runID)
   if(e instanceof QuestError)throw e
   throw new QuestError(promptAttempted?"DISPATCH_OUTCOME_UNKNOWN":"WORKSPACE_PREPARATION_FAILED",e instanceof Error?e.message:String(e),false,input.runID)
  }
 }
 const admit:AdmitRun=async input=>{
  const assigned=input.quest.stages.filter(step=>input.stepIDs.includes(step.id))
  const setBy=(field:'depth'|'workType')=>!assigned.some(step=>step[field]!==undefined)&&questWorkflow(input.quest)[field]!==undefined?'Quest':'giver'
  let verdict:DispatchAdmission
  try{verdict=await (options.admit??admitDispatch)({model:input.model,...(input.chosenBy?{chosenBy:input.chosenBy}:{}),routing:(options.routing??routingSettings)(),policyFile:options.policyFile,reservationFile:dispatchReservationFile(store.runtime),task:input.task,depth:input.depth,workType:input.workType,readOnly:input.readOnly,questKind:input.quest.kind,profileSetBy:{depth:setBy('depth'),workType:setBy('workType')}})}
  catch(error){throw new QuestError("ROUTE_UNAVAILABLE",error instanceof Error?error.message:String(error))}
  if(!verdict.admitted)throw new QuestError("ROUTE_UNAVAILABLE",verdict.reason)
 }
 return Object.assign(async(input:Parameters<StartRun>[0])=>{
  let intent:DispatchHold
  try{intent=await timed({plugin:'quests',name:'dispatch.host-lease',op:input.runID},()=>holdDispatch(store.runtime,input.quest.id,input.runID))}
  catch(error){throw new QuestError('HOST_DRAINING',error instanceof Error?error.message:String(error),false,input.runID)}
  try{
   const started=await dispatch(input,intent)
   const run=store.read(input.quest.id)?.sessions.find(s=>(s.runID??s.callID)===input.runID)
   if(run&&TERMINAL_RUN.has(run.state))intent.release()
   return started
  }catch(error){intent.release();throw error}
 },options.reserve&&!options.admit?{}:{admit})
}
