import "../../usage/host-hooks"
import {noticeDue,noticeSent} from '../giver/notice-ledger'
import {projectNotChosen} from '../giver/project-choice'
import { SessionReferences } from './session-references'
import { questReference } from '../core/references'
import { hydrateSessionReferences, resolveRunReference, agentReferenceProjection, workspaceReferenceProjection } from './session-projection'
import { moveLegacyHold } from '../workers/trial'
import { admissionRecords, consumeQuestStarts, requestQuestPlan, requestQuestStart, startRequests } from '../runs/start-request'
import { recordGiverSavedBlocks } from '../giver/giver-handoff'
import { v2QueueGeneration, readContinuations } from '../core/runtime-queues'
import { questOperations, coordinatorInput, describeOperation } from '../operations.mjs'
import { operationValidator } from '../interfaces/operation-validation.mjs'
import { compactQuestAnswer, pieceInput } from '../interfaces/compact-answers'
import {readUserGiver,releaseUserGiver,saveUserGiver} from '../giver-registry.mjs'
import {createHash} from 'node:crypto'
import {scheduleQuestCleanup,cleanupStatus,installQuestCleanup} from "../checkouts/cleanup"
import {bindUserGiver,refuseRetiredGiver,userGiverID,giverContext,adoptQuestGiver,verifyGiverBinding,refreshUserGiverLocation,handedOverContext,moveGiver} from '../giver/user-giver'
import { reconcileWorkers, inspectWorker, nextLeaseExpiry, forgetWorkerSweeps, SETTLED_OBSERVATION, workerAnsweredAt } from "../workers/worker-inspection"
import {configureLearning,collectWorkflowOutcomes} from "../routing/outcome-tracking"
import {workspaceSettings} from "../checkouts/workspace-settings"
import { QuestContinuation } from '../runs/continuation'
import { questMemberships } from '../permissions/shared-guard'
import { GIVER_REACHING_ACTIONS, withinWorkerLineage, workerCannotReachGiver } from '../workers/worker-reach'
import { onRunSettled, runSettlement } from '../runs/tracker'
import { releaseSettledRuns } from '../runs/dispatch-intent'
import { stopEndedRunProcesses } from '../checkouts/run-processes'
import { configuredDispatchPolicyFile } from "../../models/dispatch-planner"
import { UnregisteredPolicyRouteError, readDispatchPolicy } from "../../models/dispatch-policy"
import { basename, dirname, isAbsolute, join } from "node:path"
import { mkdirSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { questsAPI,QuestError,tracesToJon,type StartRun } from "../api"
import { isRuntimeProject,selfFixEnabled } from '../giver/giver-settings'
import { recordRefusalReplied } from "../giver/giver-wake"
import { assertFullRoute } from "../runs/workflow"
import { QuestStore, backfillQuestSnapshots } from "../store"
import { foldSpans } from "../board/span-aggregate"
import { SPANS_FILE } from "../../scripts/span-store"
import { projectIdentityAsync, physicalDirectory, physicalDirectoryIfPresent, verifySourceBinding } from "../core/project"
import {leftServingRelease,giverFolder,servingReleaseRoot} from './serving-release'
import { workerLedgerProject } from "../checkouts/source-binding"
import { questDispatch } from "../runs/dispatch"
import { QuestWorkspaces } from "../workspaces"
import { questChanges } from "../board/change-view"
import type { QuestHost } from "../runs/runtime"
import {toolSummary,toolDetail,toolSection,toolStatus,toolPlan,toolMutation,toolAdmission,leanAdmission,dispatchConfirmation,questListResult,agentView} from '../board/tool-projection'
import {activeRuns,awaitQuestChange,isRun,waitStart,waitVerdict,waitRuns,waitSteering,DEFAULT_WAIT_SECONDS,type WaitCondition} from '../runs/wait'
import {attributeRequest,automaticQuestPrompt,giverInstruction,handoffTurn,noticeQuestIDs,type Attribution} from '../giver/giver-instruction'
import {recordFinding,warningFindingKind} from '../board/findings'
import {readAllQuests} from '../index'
import type {Quest,QuestRequest} from '../types'
import {liveHostSignals,readQuestActivity,runStatusReader,withQuestActivity} from '../board/activity'
import {WARNING_SWEEP_MS,onProcessQuiet,sweepWarnings} from '../board/warnings'
import {onQuietProcess} from '../workers/process-ledger'
import {FROZEN_SILENCE_MS,MINIMUM_STALL_SILENCE_MS} from '../workers/stall-signal'
import {questBoardLister} from '../board/board-list'
import {onHostEvent,HOST_CONNECTED,hostConfirmsRunning} from './host-observation'
import {boundedInspection} from '../worker-observation.mjs'
import {eventStep,coalesce,watchQuestLedger,watchQuestJournal,watchEntries} from './coordinator-events'
import {sessionForRequest,cachedLineageHost,rememberSessionFromEvent} from './session-identity'
import {giverCompaction} from '../giver/giver-compaction'
import {refusalContinuation} from '../runs/refusal-continuation'
import {stopQuestRuns,stopFrozenRun,stopRepeatingRun} from '../runs/stop-run'
import {NoProgressWatch} from '../workers/no-progress'
import {answerWorkerAsk,clearAnsweredAsk} from '../workers/worker-ask-answer'
import {resolveDeliveryPolicyAsync,setDeliveryPolicy,projectMainCheckoutAsync} from '../landing/delivery-policy.mjs'
import {waterfallAnswer,waterfallSources} from '../bench/quest-waterfall'
import {questSettingsFile} from '../config/quest-settings.mjs'
import {routingSettings,setRoutingSettings} from '../routing/routing-settings'
import {servedRoutes,servedRouteNames} from '../interfaces/served-routes'
import {FinishWatch,farPastFinishesText} from '../landing/finish-budget'
import {patternMatchReport} from '../../models/routing-settings'
import {setRoleSettings} from '../routing/role-settings'
import {readRoles} from '../routing/role-view'
import {recordHandoffSent,recordHandoffRefusal,reportAnsweredHandoffs,routineHandoff} from '../giver/handoff-outcome'
import {measureHandoffs} from '../giver/handoff-cost'
import {ownersPicture} from '../board/pictures'
import {StallWatch,ACTIVITY_EVENT,ENDED_EVENT} from '../workers/stall-signal'
import {ShellRuns,resumeLostCall,sessionExecutingOnAnyHost} from '../workers/lost-tool-call'
import {onFrozenRun} from '../workers/stall-watch-mode'
import {sampleProgress,sessionToolCalls} from '../workers/process-progress'
import {TELEMETRY_FILE} from '../../usage/telemetry-store'
import {questCard,usageCard,htmlCard} from '../artifacts/artifact-views'
import {showJonCard} from '../artifacts/jon-card'
import {getUsageStatus} from '../../usage/status-api'
import {getUsagePacing} from '../../usage/portfolio-pacing'
import {backfillCheckMirror} from '../../scripts/check-spans.mjs'
import {OWNED_RUN,nativeRunID} from '../runs/session-lineage'
import {isReplayRun} from '../bench/replay-record'
import {routingHistory,simulateRouting} from '../routing/routing-history'
import { questHistory } from '../core/history'
import { historyOrigin, withHistoryOrigin } from '../core/history-origin'
import type {reserveDispatch} from '../../models/dispatch-planner'
import {routingMap} from '../routing/routing-map'
import {RoleRouteWatch,resetWatch,endedQuestWatch,handOffGiver,probeRoute} from '../giver/giver-api'
import {checkBalanceHolds,nextProbeAt,openRouterRemainingUSD,probeProbingRoutes} from '../../models/route-probes'
import {onRouteHealthChange} from '../../usage/route-limits'
import { onAccountsChanged, readAccountUsage } from '../../usage-service/on-computer'
import {migrateLongRunRecords} from '../core/run-record-migration'
import {readSpendGoals,addSpendItems,assertSpendLink,endSpendGoal,linkSpendQuest,settleSpendGoals,spendView,startSpendGoal} from './spend-mode'
import {readSystemState,systemStateFor} from './system-state'
import {dataView} from '../board/data-view'
const spendAccounts=()=>{try{return readAccountUsage().accounts}catch{return []}}
const validators=new Map(Object.entries(questOperations).map(([name,op])=>[name,operationValidator(op.input)]))
const unwrap=(value:any)=>value?.data??value
async function giverTurn(host:QuestHost,sessionID:string,messageID:unknown):Promise<{messages:any[];index:number}>{
 if(typeof host.context!=='function')throw new QuestError('GIVER_TURN_REQUIRED','No Quest was created. The host did not provide the message history needed to identify this giver instruction.')
 let messages:any
 try{messages=unwrap(await host.context({sessionID}))}catch(error){throw new QuestError('GIVER_TURN_REQUIRED','No Quest was created. The giver instruction boundary could not be read: '+String(error))}
 if(!Array.isArray(messages))throw new QuestError('GIVER_TURN_REQUIRED','No Quest was created. The host returned no message history for this giver instruction.')
 const index=typeof messageID==='string'?messages.findIndex(message=>message?.id===messageID):messages.findLastIndex(message=>message?.type==='assistant')
 if(index<0)throw new QuestError('GIVER_TURN_REQUIRED','No Quest was created. The current assistant message is absent from the persisted giver history.')
 return {messages,index}
}
export const GIVER_HANDOFF_ON_QUESTS='No Quest was created. This turn answers a Quest Giver hand-off, not a message from the user. The follow-ups of a replaced Quest Giver go onto the Quests they concern: save each one there with update, as a step note, or as a new step with deferred "parent-done" or "jon".'
async function originatingUserTurn(store:QuestStore,host:QuestHost,sessionID:string,messageID:unknown,fromMessage:unknown):Promise<Attribution&{stepID?:string}>{
 const {messages,index}=await giverTurn(host,sessionID,messageID)
 const stepID=typeof messages[index]?.id==='string'?messages[index].id:undefined
 if(handoffTurn(messages,index))throw new QuestError('HANDOFF_ON_QUESTS',GIVER_HANDOFF_ON_QUESTS)
 const answeredElsewhere=new Set(readAllQuests(store.projectRoot).flatMap(entry=>entry.quest&&entry.quest.extensions?.giverStepID!==stepID?(entry.quest.request??[]).map(row=>row.messageID):[]))
 const attribution=giverInstruction(store.runtime,sessionID,messages,index,fromMessage,id=>answeredElsewhere.has(id))
 if(attribution)return {...attribution,stepID}
 throw new QuestError('GIVER_TURN_REQUIRED','No Quest was created. Neither the current host context nor delivered inbox evidence identifies the originating giver instruction. Inspect the host event connection before retrying.')
}
async function recordCreateRefusal(store:QuestStore,host:QuestHost,sessionID:string,messageID:unknown,title:string,reason:string){
 try{
  const {messages,index}=await giverTurn(host,sessionID,messageID)
  for(const id of noticeQuestIDs(messages,index))recordFinding(store,id,'refused-create','The Quest Giver tried to open "'+title+'" from a notice that is not from the user. '+reason.replace(/^No Quest was created\.\s*/,''))
 }catch(error){console.error('[quests] create refusal not recorded as a finding',error)}
}
async function refiningUserMessages(host:QuestHost,sessionID:string,messageID:unknown,fromMessage:unknown):Promise<QuestRequest[]>{
 let turn:{messages:any[];index:number}
 try{turn=await giverTurn(host,sessionID,messageID)}catch{return []}
 return attributeRequest(turn.messages,turn.index,fromMessage,false)?.request??[]
}
const GIVER_PLANS=['steps','workflow','after','projectRoot'] as const
const refinesDefinition=(update:any)=>['title','description','reward','fromMessage'].some(key=>update?.[key]!==undefined)||Array.isArray(update?.steps)&&update.steps.some((step:any)=>step?.title!==undefined||step?.detail!==undefined)
function appendUserRequests(store:QuestStore,questID:string,requests:QuestRequest[]){
 const q=store.read(questID)
 if(!q)return
 const others=readAllQuests(store.projectRoot).flatMap(entry=>entry.quest&&entry.quest.id!==q.id?entry.quest.request??[]:[])
 const added=requests.filter(request=>!q.request?.some(row=>row.messageID===request.messageID)&&!others.some(row=>row.messageID===request.messageID))
 if(added.length)store.apply(q.id,'patched',{request:[...(q.request??[]),...added]},'quest:user-request')
}
const IMAGE_SIGNATURES:[string,(bytes:Buffer)=>boolean][]=[
 ['image/png',bytes=>bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))],
 ['image/jpeg',bytes=>bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff],
 ['image/gif',bytes=>/^GIF8[79]a/.test(bytes.subarray(0,6).toString('latin1'))],
 ['image/webp',bytes=>bytes.subarray(0,4).toString('latin1')==='RIFF'&&bytes.subarray(8,12).toString('latin1')==='WEBP'],
]
function imageAttachment(path:string){
 if(!isAbsolute(path))throw new QuestError('INVALID_INPUT','images: give the absolute path of each image; '+path+' is relative')
 let bytes:Buffer
 try{bytes=readFileSync(path)}catch(error){throw new QuestError('INVALID_INPUT','images: cannot read '+path+' ('+(error instanceof Error?error.message:String(error))+')')}
 if(!IMAGE_SIGNATURES.some(([,matches])=>matches(bytes)))throw new QuestError('INVALID_INPUT','images: '+path+' is not a PNG, JPEG, GIF or WebP image, so the Quest Giver model could not see it')
 return {uri:pathToFileURL(path).href,name:basename(path),digest:createHash('sha256').update(bytes).digest('hex')}
}
export const HANDOFF_WITHOUT_JON='Nothing was sent. Self-fix is off, so the Quest Giver gets work only when it carries the user\'s words. Quote one of the user\'s messages exactly in quote, or record this as a finding on the Quest it concerns.'
const spaced=(text:string)=>text.toLowerCase().replace(/\s+/g,' ').trim()
async function assertHandoffQuotesJon(store:QuestStore,host:QuestHost,sessionID:string,quest:Quest|undefined,quote:unknown,text:string){
 if(selfFixEnabled()||!isRuntimeProject(store.projectRoot))return
 const sender=historyOrigin()
 if(sender&&tracesToJon({origin:sender}))return
 const refuse=(why:string)=>{if(quest)try{recordFinding(store,quest.id,'refused-handoff','A hand-off to the Quest Giver from '+(sender?.from??'an unknown sender')+' was refused because it quotes no message from the user: "'+text.slice(0,120)+'"')}catch(error){console.error('[quests] hand-off refusal not recorded as a finding',error)};throw new QuestError('SELF_FIX_OFF',why)}
 if(typeof quote!=='string'||!/\w/.test(quote))return refuse(HANDOFF_WITHOUT_JON)
 let messages:any
 try{messages=unwrap(await host.context?.({sessionID}))}catch{messages=undefined}
 const wanted=spaced(quote)
 const found=Array.isArray(messages)&&messages.some(message=>message?.type==='user'&&!automaticQuestPrompt(message.metadata)&&typeof message.text==='string'&&tracesToJon({origin:message.metadata?.questHistoryOrigin})&&spaced(message.text).includes(wanted))
 if(!found)return refuse('Nothing was sent. Those words are not in a message from the user in this conversation. Quote the user\'s message exactly, or record this as a finding on the Quest it concerns.')
}
async function deliverGiverMessage(store:QuestStore,host:QuestHost,trusted:any,questID:string|undefined,input:{text:string;images?:string[];quote?:string}|undefined){
 const text=typeof input?.text==='string'?input.text.trim():''
 if(!text)throw new QuestError('INVALID_INPUT','Provide nonempty message text')
 const giverID=userGiverID(store)
 if(!giverID||giverID!==trusted.sessionID)throw new QuestError('SINGLE_GIVER_REQUIRED','Continue in your one Quest Giver: '+(giverID??'none is bound'))
 const quest=questID?store.read(questID):undefined
 if(questID&&!quest)throw new QuestError('NOT_FOUND','Quest not found: '+questID)
 await assertHandoffQuotesJon(store,host,giverID,quest,input?.quote,text)
 const files=(input?.images??[]).map(imageAttachment)
 const label=quest?questReference(quest):undefined
 const messageID='msg_terminal_'+createHash('sha256').update(JSON.stringify([giverID,trusted.requestID,label??'',text,...files.map(file=>file.digest)])).digest('hex').slice(0,26)
 const body=(label?'The terminal session sent this about '+label+':\n':'')+text
 const images=files.length?{images:files.map(file=>file.name)}:{}
 let receipt:any
 try{receipt=unwrap(await host.prompt({sessionID:giverID,id:messageID,text:body,metadata:{questHistoryOrigin:historyOrigin(),...(quest?{questID:quest.id}:{})},...(files.length?{files:files.map(({uri,name})=>({uri,name}))}:{})}))}catch(error){
  return {state:'unknown',sessionID:giverID,...(label?{questID:label}:{}),messageID,...images,note:'The host did not confirm the queue ('+(error instanceof Error?error.message:String(error))+'). The message may still be queued; do not resend blindly. A queued giver turn is not worker execution.'}
 }
 const accepted=receipt?.id===messageID&&receipt?.sessionID===giverID
 return {state:accepted?'accepted':'unknown',sessionID:giverID,...(label?{questID:label}:{}),messageID,...images,
  note:accepted
   ?'The host accepted the message into the Quest Giver conversation. It is a giver turn, not worker execution, and it does not complete a step.'
   :'The host returned no matching receipt for the message. Delivery remains unknown; do not resend blindly. A queued giver turn is not worker execution.'}
}
function questChangeEvents(store:QuestStore,host:QuestHost,questID:string,listener:()=>void,starts=false){
 const journal=watchQuestJournal(store,questID,listener)
 const stops=[store.subscribe(questID,listener),()=>journal.dispose(),onHostEvent(host,event=>{
  const type=String(event?.type??'')
  if(type===HOST_CONNECTED||type==='session.status'||type.startsWith('session.execution.'))listener()
 })]
 if(starts)for(const [directory,matches] of [[join(store.runtime,'start-requests'),(name:string)=>name.endsWith('.json')],[store.runtime,(name:string)=>/^continuations(?:-[a-f0-9]{24})?\.json$/.test(name)]] as const){
  try{mkdirSync(directory,{recursive:true});const watcher=watchEntries(directory,{matches},()=>listener());watcher.on('error',()=>{try{watcher.close()}catch{}});stops.push(()=>watcher.close())}catch{}
 }
 return ()=>{for(const stop of stops)try{stop()}catch{}}
}
function pendingStart(store:QuestStore,questID:string):string|undefined{
 const start=startRequests(store,questID).find(row=>!row.kind&&['queued','admitting'].includes(row.state))
 if(start)return 'Its start is '+start.state+' and no run has been planned yet.'
 const open=readContinuations(store.runtime).find(row=>row.questID===questID&&!['done','stopped'].includes(row.state))
 if(open)return 'Its continuation is '+open.state+(open.reason?': '+open.reason:'')+'.'
}
type CoordinatorSlot={owner?:object;waiting:Set<()=>void>}
const COORDINATORS=Symbol.for('questgiver.quest-coordinators')
function coordinatorSlot(runtime:string):CoordinatorSlot{
 const slots=(globalThis as any)[COORDINATORS]??=new Map<string,CoordinatorSlot>()
 let slot=slots.get(runtime);if(!slot)slots.set(runtime,slot={waiting:new Set()})
 return slot
}
export function createQuestService(store:QuestStore,host:QuestHost,options:{policyFile?:string;settingsFile?:string;startRun?:StartRun;reserve?:typeof reserveDispatch;directory?:string;location?:string;telemetryFile?:string;onDispose?:(dispose:()=>void)=>void}={}) {
 try{const {kept}=migrateLongRunRecords(store.runtime);if(kept.length)console.error('[quests] long run records kept under their old names: '+kept.join(', '))}catch(error){console.error('[quests] run record names not shortened',error)}
 try{readDispatchPolicy(options.policyFile??configuredDispatchPolicyFile())}catch(error){if(error instanceof UnregisteredPolicyRouteError)throw error}
 const {start,returns}=questDispatch(store,host,options)
 const readQuestSafely=(id:string)=>{try{return store.read(id)}catch{return undefined}}
 void backfillCheckMirror().catch(error=>console.error('[quests] check mirror not built',error))
 const continuation=new QuestContinuation(store,start,{
  settingsFile:options.settingsFile,
  verifyContext:async(context)=>{await verifyGiverBinding(store,context,await sessionForRequest(store,host,context.sessionID))},
  handOver:(context,questID)=>handedOverContext(store,host,context,questID),resumeExact:refusalContinuation(store,host),
 })
   const startAdmission=eventStep('start admission',async()=>{return consumeQuestStarts(store,host,continuation).catch(error=>{console.error('[quests] start admission failed',error)})})
 const finishes=new FinishWatch({
  quests:()=>readAllQuests(store.projectRoot).flatMap(row=>row.quest&&row.quest.state!=='Archived'?[row.quest]:[]),
  active:(questID,runID)=>{const run=store.read(questID)?.sessions.find(row=>(row.runID??row.callID)===runID);return !!run&&OWNED_RUN.has(run.state)},lastActivity:async(_quest,run)=>{const at=Math.max(...[run.lastHeartbeatAt,await workerAnsweredAt(host,run)].map(value=>Date.parse(value??'')).filter(Number.isFinite));return Number.isFinite(at)?at:undefined},
  notify:async(quest,_run,_late,rows)=>{try{const runIDs=rows.map(row=>row.late.runID),text=farPastFinishesText(quest,await Promise.all(rows.map(async row=>({...row,hostActivityAt:await workerAnsweredAt(host,row.run)})))),slot={questID:quest.id,stepIDs:runIDs.map(runID=>'run:'+runID),kind:'FAR PAST FINISH',episode:runIDs.join(',')};if(!noticeDue(store.runtime,slot,text).send)return;const giver=readUserGiver(store.runtime);if(giver?.state!=='bound'||!giver.sessionID)return;await host.prompt({sessionID:giver.sessionID,id:'msg_questlate'+createHash('sha256').update(runIDs.join(',')).digest('hex').slice(0,22),delivery:'queue',resume:true,text});noticeSent(store.runtime,slot,text)}catch(error){console.error('[quests] far past finish notice not delivered',error instanceof Error?error.message:error)}},
 })
 const inspection=eventStep('inspection',async()=>{try{finishes.sync()}catch(error){console.error('[quests] finish budgets not armed',error)};const observations=await reconcileWorkers(store,host);if(Object.values(observations).some((o:any)=>SETTLED_OBSERVATION.has(o?.state)))collectWorkflowOutcomes(store);return nextLeaseExpiry(store)})
 const advance=eventStep('continuation',async()=>{await continuation.tick().catch(error=>console.error('[quests] continuation failed',error));return continuation.nextDue()})
 const delivery=eventStep('return delivery',async()=>{await returns.tick();return returns.nextDue})
 const routeProbes=eventStep('route probes',async()=>{const directory=options.directory??options.location??process.cwd();try{await checkBalanceHolds(openRouterRemainingUSD);await probeProbingRoutes(key=>probeRoute(host,directory,{model:key}))}catch(error){console.error('[quests] route probes not recorded',error)};const due=nextProbeAt();return due===undefined?undefined:Math.max(due,Date.now()+5_000)})
 const processes=eventStep('ended run processes',async()=>{await stopEndedRunProcesses(store)})
 const recordedWarnings=new Set<string>()
 const warnings=eventStep('warnings',async()=>{
  const now=Date.now(),reader=runStatusReader()
  try{
   const raised=sweepWarnings(store,readAllQuests(store.projectRoot).flatMap(row=>row.quest?[row.quest]:[]),now,{evidence:(run,at)=>reader.evidence?.(run,at)??{tools:0},toolTimes:at=>reader.toolTimes?.(at)??{medianMs:MINIMUM_STALL_SILENCE_MS,p99Ms:FROZEN_SILENCE_MS}},liveHostSignals())
   for(const warning of raised){
    if(!warning.quest||recordedWarnings.has(warning.key))continue
    recordedWarnings.add(warning.key)
    try{recordFinding(store,warning.quest,warningFindingKind(warning.type),warning.text)}catch(error){console.error('[quests] warning not recorded as a finding',warning.quest,error)}
   }
  }finally{reader.close()}
  return now+WARNING_SWEEP_MS
 })
 const roleRoutes=new RoleRouteWatch(store,host,options.directory??options.location??process.cwd(),{telemetryFile:options.telemetryFile})
 const unlistenRouteHealth=onRouteHealthChange(()=>{if(coordinating())void roleRoutes.settle().catch(error=>console.error('[quests] role route not settled',error instanceof Error?error.message:error))})
 const usageResets=resetWatch(),questEnds=endedQuestWatch(store)
  const giverGeneration=eventStep('giver generation',async()=>{
   const giver=registered()
   if(giver?.state!=='bound'||!giver.sessionID||directory&&giver.directory!==directory||!coordinating())return
   try{
    const generation=process.env.OPENCODE_PLUGIN_GENERATION
    if(generation&&giver.generation!==generation)saveUserGiver(store.runtime,{...giver,generation})
   }catch(error){console.error('[quests] Quest Giver generation not handed over',error instanceof Error?error.message:error)}
  })
  const shells=new ShellRuns()
  const startedThisRuntime=(run:Quest['sessions'][number])=>Date.parse(run.startedAt??'')>=performance.timeOrigin
 const stalls=new StallWatch({
  ledgerFile:options.telemetryFile,
   runOf:sessionID=>{const member=questMemberships(store,sessionID).find(({quest,run,archived})=>!archived&&quest.state!=='Archived'&&startedThisRuntime(run)&&!isReplayRun(run)&&OWNED_RUN.has(run.state)&&nativeRunID(run)===sessionID);if(!member)return undefined;const {quest,run}=member;const worktree=typeof run.scope?.worktree==='string'?run.scope.worktree:run.worktree;return {questID:quest.id,runID:run.runID??run.callID,questTitle:quest.title,stepTitles:run.deliverables.map(id=>quest.stages.find(step=>step.id===id)?.title??id),...(worktree?{worktree}:{})}},
  tree:{calls:sessionID=>{try{return sessionToolCalls(waterfallSources(process.env).hostDB,sessionID)}catch{return {}}},sample:(run,sessionID,call,now)=>sampleProgress({worktree:run.worktree,hostPID:process.pid,callStart:call.start,outputBytes:call.outputBytes,now}),executing:sessionID=>sessionExecutingOnAnyHost(sessionID)},
  lost:async notice=>{await resumeLostCall(store.runtime,host,notice,notice.command!==undefined&&notice.callStart!==undefined?shells.find(notice.sessionID,notice.command,notice.callStart):undefined)},
  held:notice=>console.error('[quests] frozen run not stopped',notice.run.runID,notice.text),
   frozen:notice=>onFrozenRun(store.runtime,notice,async(notice,attempt)=>{try{const outcome=await stopFrozenRun(store,host,notice.run.questID,notice.run.runID,notice.text,attempt===1,attempt===0);if(outcome)console.error('[quests] frozen run recovery finished',notice.run.runID,outcome.restart);return outcome}catch(error){console.error('[quests] frozen run not stopped',error instanceof Error?error.message:error);return {restart:'resume acknowledgment unknown'}}},(notice,reason)=>{try{const quest=store.read(notice.run.questID),run=quest?.sessions.find(row=>(row.runID??row.callID)===notice.run.runID);for(const stageID of run?.deliverables??[])store.apply(notice.run.questID,'stage-state',{stageID,status:quest!.stages.find(step=>step.id===stageID)?.status??'working',evidence:reason},'quest:stall-watch')}catch(error){console.error('[quests] stall stop limit not saved on the board',error instanceof Error?error.message:error)}}),
 })
  const repeats=new NoProgressWatch({hostDB:()=>waterfallSources(process.env).hostDB,runOf:sessionID=>stalls.options.runOf(sessionID),stop:async(run,reason)=>{const outcome=await stopRepeatingRun(store,host,run.questID,run.runID,reason);if(outcome)console.error('[quests] run repeating itself stopped',run.runID,reason)}})
  const ownedRunSessions=()=>readAllQuests(store.projectRoot).flatMap(row=>row.quest&&row.quest.state!=='Archived'?row.quest.sessions.flatMap(run=>startedThisRuntime(run)&&OWNED_RUN.has(run.state)&&!isReplayRun(run)&&nativeRunID(run)?[nativeRunID(run)!]:[]):[])
 const eventTime=(event:any)=>{const at=typeof event?.created==='number'?event.created:Date.parse(event?.created);return Number.isFinite(at)?at:Date.now()}
 const frontWatchers:(()=>void)[]=[]
 const telemetryFile=options.telemetryFile??TELEMETRY_FILE
 for(const [folder,name,changed] of [[dirname(questSettingsFile()),basename(questSettingsFile()),()=>{void giverGeneration.trigger();if(coordinating())void roleRoutes.settingsChanged().catch(error=>console.error('[quests] role change not applied',error instanceof Error?error.message:error))}],[dirname(telemetryFile),basename(telemetryFile),()=>stalls.refresh()]] as const){
  try{mkdirSync(folder,{recursive:true});const watcher=watchEntries(folder,{names:[name]},()=>changed());watcher.on('error',()=>{try{watcher.close()}catch{}});frontWatchers.push(()=>watcher.close())}catch{}
 }
 try{frontWatchers.push(onAccountsChanged(()=>{const reset=usageResets.seen();if(reset&&coordinating())void roleRoutes.settle(true).catch(()=>{})}))}catch{}
  const steps={admission:startAdmission,inspection,continuation:advance,delivery,routeProbes,processes,warnings,generation:giverGeneration}
 type Step=keyof typeof steps
 const EVERY=Object.keys(steps) as Step[],SETTLING:Step[]=['inspection','continuation','delivery']
 let disposeCleanup:(()=>void)|undefined
 const directory=options.directory?physicalDirectory(options.directory):undefined
 const location=options.location?physicalDirectoryIfPresent(options.location)??options.location:directory
 const workerPermissions=eventStep('worker permission decision',async()=>{await returns.tick(location);return returns.nextDue})
 const slot=coordinatorSlot(store.runtime),self={},handOver=()=>board.kick(...EVERY)
 const coordinating=()=>{if(slot.owner&&slot.owner!==self){slot.waiting.add(handOver);return false};slot.owner=self;slot.waiting.delete(handOver);return true}
 const registered=()=>readUserGiver(store.runtime)
 let rehomed:string|undefined,stayed=''
 console.error('[quests] Quest service directory '+(options.directory??'none')+', location '+(options.location??'none')+', serving '+(servingReleaseRoot()??'none'))
  const rehomeGiver=eventStep('giver re-home',async()=>{const giver=registered();const left=!!giver&&leftServingRelease(giver.directory);const target=left?servingReleaseRoot()??directory:directory;const stay=!target?'no serving folder':giver?.state!=='bound'||!giver.sessionID?'no bound Quest Giver':physicalDirectoryIfPresent(giver.directory)&&!left?'':!coordinating()?'another service coordinates':'';if(stay||!target||!giver?.sessionID||physicalDirectoryIfPresent(giver.directory)&&!left){if(stay&&stay!==stayed&&stay!=='another service coordinates')console.error('[quests] Quest Giver stays in '+giver?.directory+': '+stay);stayed=stay;return}const key=giver.sessionID+'|'+giver.directory;if(rehomed===key){if(stayed!=='tried')console.error('[quests] Quest Giver move already tried for '+key);stayed='tried';return}rehomed=key;try{if(await moveGiver(store,host,giver,target)){board.kick(...EVERY);return}if(physicalDirectoryIfPresent(giver.directory))return;await handOffGiver(store,host,target,left?'a reload completed and this release now serves, so the Quest Giver moved here from the draining release':'its release folder was retired, so the Quest Giver moved to the serving release',{notify:false});board.kick(...EVERY)}catch(error){console.error('[quests] Quest Giver not re-homed',error instanceof Error?error.message:error)}})
 const giverLocation=eventStep('giver location',async()=>{const before=registered()?.directory;await refreshUserGiverLocation(store,host);if(registered()?.directory!==before)board.kick(...EVERY)})
 const compaction=giverCompaction(store.runtime,host,{telemetryFile:options.telemetryFile})
 const compactGiver=eventStep('giver compaction',async()=>{const giver=registered();if(giver?.state!=='bound'||!giver.sessionID||directory&&giver.directory!==directory||!coordinating())return;await compaction.evaluate(giver.sessionID)})
 const handoffCost=eventStep('hand-off cost',async()=>{if(!coordinating())return;await measureHandoffs({runtime:store.runtime,projectRoot:store.projectRoot,hostDB:waterfallSources(process.env).hostDB,telemetryFile})})
const ledger=watchQuestLedger(store,(change,name)=>{if(change==='ledger'){releaseSettledRuns(store,runSettlement);void handoffCost.trigger();if(questEnds.seen(name)&&coordinating())void roleRoutes.questEnded().catch(()=>{})};if(change!=='starts')returns.wake();board.kick(...(change==='starts'?['admission' as const]:change==='giver'?EVERY:change==='ledger'?[...SETTLING,'processes' as const,'warnings' as const,'admission' as const]:SETTLING))})
 ledger.ensure()
 const board=coalesce<Step>(due=>{
  let giver
  try{giver=registered()}catch(error){console.error('[quests] giver registration unreadable',error);return}
   if(giver?.state==='bound'&&giver.sessionID&&leftServingRelease(giver.directory))void rehomeGiver.trigger()
   if(directory&&giver?.directory!==directory){if(slot.owner===self){slot.owner=undefined;for(const next of [...slot.waiting])next()};if(giver?.state==='bound'&&(!physicalDirectoryIfPresent(giver.directory)||leftServingRelease(giver.directory)))void rehomeGiver.trigger();else{void giverLocation.trigger();void workerPermissions.trigger()};return}
  if(!coordinating()){if(location&&due.has('delivery'))void workerPermissions.trigger();return}
  disposeCleanup??=installQuestCleanup(store,host)
  for(const name of due)void steps[name].trigger()
 })
 const statuses=new Map<string,unknown>()
 const stopListening=onHostEvent(host,event=>{
  const type=String(event?.type??'')
  rememberSessionFromEvent(store.runtime,event)
  compaction.observe(event)
  if(/^session\.(execution\.(succeeded|failed)|error)$/.test(type)&&coordinating())void roleRoutes.observe(event).catch(error=>console.error('[quests] role route not updated',error instanceof Error?error.message:error))
  if(/^session\.execution\.(succeeded|failed)$/.test(type)&&event?.data?.model&&coordinating())void roleRoutes.healthChange(event.data.model,type==='session.execution.succeeded').catch(()=>{})
  const activityID=event?.data?.sessionID
  shells.observe(event)
  repeats.observe(event)
  if(typeof activityID==='string'){if(ACTIVITY_EVENT.test(type))stalls.observe(activityID,eventTime(event));else if(ENDED_EVENT.test(type)){stalls.forget(activityID);shells.forget(activityID);repeats.forget(activityID)}}
   if(type===HOST_CONNECTED){statuses.clear();stalls.watch(ownedRunSessions());forgetWorkerSweeps(host);returns.wake();if(coordinating())void roleRoutes.settle(true).catch(error=>console.error('[quests] role route not settled at host start',error instanceof Error?error.message:error));board.kick(...EVERY)}
  else if(type==='permission.asked'||type==='permission.replied'){if(type==='permission.replied')try{clearAnsweredAsk(store,event?.data?.sessionID,event?.data?.requestID)}catch(error){console.error('[quests] answered ask not cleared',error)};returns.wake(event?.data?.sessionID);board.kick(...(type==='permission.replied'?[...SETTLING,'warnings' as const]:['delivery' as const,'warnings' as const]))}
  else if(type==='session.status'||type.startsWith('session.execution.')){
   const sessionID=event?.data?.sessionID,status=event?.data?.status?.type
   const repeated=type==='session.status'&&typeof sessionID==='string'&&statuses.has(sessionID)&&statuses.get(sessionID)===status
   if(typeof sessionID==='string'){if(type==='session.status')statuses.set(sessionID,status);else statuses.delete(sessionID)}
   if(type.startsWith('session.execution.')&&typeof sessionID==='string')returns.wake(sessionID)
   if(!repeated){boards.forget();board.kick(...SETTLING)}
   if((type==='session.execution.succeeded'||event?.data?.status?.type==='idle')&&event?.data?.sessionID&&event.data.sessionID===registered()?.sessionID){void compactGiver.trigger()}
  }
  else if(/^session\.(updated|.*moved)$/.test(type)){const giver=registered();if(giver?.sessionID&&[event?.data?.sessionID,event?.data?.info?.id].includes(giver.sessionID)){returns.wake(giver.sessionID);board.kick('delivery');void giverLocation.trigger()}}
 })
  void giverLocation.trigger()
  const announceQuiet=onProcessQuiet()
  onQuietProcess(process=>{if(!coordinating())return;announceQuiet(process);void warnings.trigger()})
  const stopSettled = onRunSettled(() => { releaseSettledRuns(store,runSettlement);returns.wake();board.kick(...SETTLING,'processes') })
 board.kick(...EVERY)
  options.onDispose?.(()=>{onQuietProcess(undefined);stopSettled();board.dispose();ledger.dispose();for(const step of [...Object.values(steps),workerPermissions,giverLocation,compactGiver,handoffCost])step.dispose();stopListening();unlistenRouteHealth();roleRoutes.dispose();returns.dispose();disposeCleanup?.();boards.dispose();stalls.dispose();finishes.dispose();roleRoutes.dispose();for(const stop of frontWatchers)try{stop()}catch{}
   slot.waiting.delete(handOver);if(slot.owner===self){slot.owner=undefined;for(const next of [...slot.waiting])next()}})
 const workspaces=new QuestWorkspaces(store.runtime)
 const boards=questBoardLister(store,host)
 backfillQuestSnapshots(store)
 setImmediate(() => { try { moveLegacyHold(store.runtime) } catch (error) { console.error('[quests] old worker hold not moved to the run mode', error) } })
 setImmediate(() => { try { admissionRecords(store) } catch (error) { console.error('[quests] admission not read', error) } })
 setImmediate(() => { try { foldSpans(process.env.OPENCODE_SPANS_FILE ?? SPANS_FILE) } catch (error) { console.error('[quests] span aggregate not folded', error) } })
 const handle=async(method:string,args:unknown,context:any,mutating:()=>void)=>{
  const validate=validators.get(method)
  if(!validate)throw new QuestError('INVALID_OPERATION','Unknown Quest operation: '+method)
  const problem=validate(args)
  if(problem)throw new QuestError('INVALID_INPUT',method+': '+problem)
  let input:any=coordinatorInput(method,args)
  if(['create','update','run','start','stop'].includes(input.action))mutating()
  if(method==='report'&&typeof input.id==='string'&&context?.sessionID&&!(()=>{try{return store.read(input.id)}catch{return undefined}})()){const own=questMemberships(store,context.sessionID).filter(({quest})=>[quest.id,questReference(quest)].some(id=>id.startsWith(input.id+'-')));if(new Set(own.map(({quest})=>quest.id)).size===1)input={...input,id:own[0].quest.id}}
  if(input.id){const q=store.read(input.id);if(q){input={...input,id:q.id};if(input.wait?.runID)input.wait={...input.wait,runID:resolveRunReference(store,q,input.wait.runID)};if(input.stop?.runID)input.stop={...input.stop,runID:resolveRunReference(store,q,input.stop.runID)}}}
  const respond=(value:unknown,quests:any[])=>{hydrateSessionReferences(store,quests);return JSON.parse(JSON.stringify((context.audience==='web'||(context.audience===undefined&&context.external===true))?value:agentView(agentReferenceProjection(store,value,quests))))}

  const waitRequest=input.action==='wait'?(input.wait??{}):undefined
  const messageRequest=input.action==='message'?input.message:undefined
  if(waitRequest){if(!input.id)throw new QuestError('INVALID_INPUT','wait needs the Quest id to block on');input={...input,action:'get'}}
  if(input.action==='run'||waitRequest||input.inspect?.section==='runs')await reconcileWorkers(store,host,input.id)
  const requestID=context?.id??context?.callID
  if(!context?.sessionID||!requestID)throw new QuestError("HOST_CONTEXT_REQUIRED","Host must supply a session and tool call identity")
  const session=await sessionForRequest(store,host,context.sessionID),directory=session?.location?.directory
  const origin=historyOrigin();if(origin&&typeof directory==='string')origin.directory=directory
   const memberships=questMemberships(store,context.sessionID).map(({quest,run:s})=>({questID:quest.id,stepIDs:['planned','executing','waiting'].includes(s.state)?s.deliverables.filter(id=>quest.sessions.findLast(other=>other.deliverables.includes(id))===s):[]}))
   const isWorker=memberships.length>0
   const giverCaller=!isWorker&&context.external!==true&&context.sessionID===userGiverID(store)
   const workerChild=!isWorker&&await withinWorkerLineage(store,cachedLineageHost(store,host),{...session,id:context.sessionID})
   if((isWorker||workerChild)&&GIVER_REACHING_ACTIONS.has(input.action))throw workerCannotReachGiver()
   if(workerChild&&['update','run','stop'].includes(input.action))throw workerCannotReachGiver()
    if(input.action==='system_state'){
     if(isWorker||workerChild)throw new QuestError('WORKER_ASSIGNMENT_DENIED','Workers cannot read system-wide state; read only assigned Quest steps.')
     const named=input.system_state?.questID?store.read(input.system_state.questID):undefined
     if(input.system_state?.questID&&!named)throw new QuestError('NOT_FOUND','Quest not found: '+input.system_state.questID)
     return systemStateFor(await readSystemState(store,host,{signal:context.signal,telemetryFile:options.telemetryFile}),named?.id)
    }
   if(input.action==='show_artifact'){
    if(isWorker)throw new QuestError('WORKER_DELEGATION_DENIED','Workers cannot show cards; the Quest Giver can')
    const ask=input.show_artifact
    if(ask.view==='quest'){if(!ask.questID)throw new QuestError('INVALID_INPUT','show_artifact: view quest needs questID');const q=store.read(ask.questID);if(!q)throw new QuestError('NOT_FOUND','Quest not found: '+ask.questID);return {...questCard(q,store.runtime),...(ask.title?{title:ask.title}:{})}}
    if(ask.view==='html'){if(!ask.html?.trim())throw new QuestError('INVALID_INPUT','show_artifact: view html needs html');return htmlCard(ask.title,ask.html)}
    if(ask.view==='needs_you')return showJonCard(store,readAllQuests(store.projectRoot).flatMap(entry=>entry.quest?[entry.quest]:[]),true)
    const diagnostics:string[]=[]
    let status:any,pacing:any
    try{status=await getUsageStatus({allSessions:true},{readOnly:true})}catch(error){diagnostics.push('usage status could not be read: '+(error instanceof Error?error.message:String(error)))}
    try{pacing=await getUsagePacing()}catch(error){diagnostics.push('pacing could not be read: '+(error instanceof Error?error.message:String(error)))}
    const card=usageCard({at:Date.now(),accounts:pacing?.accounts??status?.pacing?.accounts??[],inFlight:pacing?.sharedAcrossChannels?.inFlight,session:status?.session,diagnostics:[...diagnostics,...(status?.diagnostics??[])]})
    return ask.title?{...card,title:ask.title}:card
   }
   const nativeInfo=session, sessionNames=new SessionReferences(store.runtime)
   if(!isWorker&&!sessionNames.get(context.sessionID)){
    const title=typeof nativeInfo?.title==='string'&&nativeInfo.title.trim()?nativeInfo.title:(nativeInfo?.agent==='quest-giver'||userGiverID(store)===context.sessionID)?'Quest giver':undefined
    if(title)sessionNames.register({sessionID:context.sessionID,title})
   }
   if(isWorker&&(input.action==='run'||input.action==='start'||input.action==='create'||input.action==='stop'||input.update?.cancelContinuation===true))throw new QuestError('WORKER_DELEGATION_DENIED','Workers update assigned work; only givers create Quests, dispatch or stop workers')
   if(isWorker&&input.action==='update'){
    const allowed=new Set(memberships.filter(m=>m.questID===input.id).flatMap(m=>m.stepIDs))
    if(!allowed.size||Object.keys(input.update??{}).some(k=>k!=='steps')||input.update?.steps?.some((s:any)=>!allowed.has(s.id)||Object.keys(s).some(k=>!['id','state','note','verification','result','blocker','resolution','branches'].includes(k))))throw new QuestError('WORKER_ASSIGNMENT_DENIED','No Quest changes were saved. Workers may report only current assigned step states using report with id, stepID, state, note, an optional verification {command, exitCode, artifact} from a check actually run in any state and, with the last step done, result {summary, howToUse, where}. Remove artifacts, reward, detail and all other keys; put artifact paths in note. Retry the corrected report; its returned revision, step and checks confirm persistence. The giver attaches global artifacts/reward and changes definitions.')
   }
   if(input.action==='data'){
    if(isWorker)throw new QuestError('WORKER_DELEGATION_DENIED','Workers cannot read Data')
    return dataView(input.data??{})
   }
   if(input.action==='waterfall'){
    if(isWorker)throw new QuestError('WORKER_DELEGATION_DENIED','Workers cannot read waterfalls; the giver and the terminal can')
    const sources={...waterfallSources(process.env),questDir:dirname(store.runtime)},known=(id:string)=>{try{return store.read(id)}catch{return undefined}}
    try{return JSON.parse(JSON.stringify(await waterfallAnswer(input.waterfall??{},{sources,resolveQuest:id=>known(id)?.id,titleOf:id=>known(id)?.title})))}
    catch(error){throw new QuestError('INVALID_INPUT','waterfall: '+(error instanceof Error?error.message:String(error)))}
   }
  if(input.action==='routing'||input.action==='routingHistory'||input.action==='routingMap'||input.action==='routingSimulate'){
   if(isWorker)throw new QuestError('WORKER_DELEGATION_DENIED','Workers cannot read or change routing')
   try{
    if(input.action==='routingHistory')return routingHistory(store,input.routingHistory??{})
    if(input.action==='routingSimulate')return JSON.parse(JSON.stringify(await simulateRouting(store,host as any,input.routingSimulate,{policyFile:options.policyFile??configuredDispatchPolicyFile(),directory:typeof directory==='string'?directory:options.directory??store.projectRoot,reserve:options.reserve})))
    if(input.action==='routingMap')return JSON.parse(JSON.stringify(await routingMap({policyFile:options.policyFile??configuredDispatchPolicyFile(),settings:routingSettings()})))
    const policyFile=options.policyFile??configuredDispatchPolicyFile()
    if(input.routing?.set!==undefined){const served=await servedRoutes(policyFile);const settings=setRoutingSettings(input.routing.set,{served,allowUnserved:input.routing.allowUnserved});return {settingsFile:questSettingsFile(),settings,served:servedRouteNames(served),patterns:patternMatchReport(settings,served)}}
    const settings=routingSettings()
    try{const served=await servedRoutes(policyFile);return {settingsFile:questSettingsFile(),settings,served:servedRouteNames(served),patterns:patternMatchReport(settings,served)}}
    catch(error){return {settingsFile:questSettingsFile(),settings,servedError:'Served routes could not be read: '+(error instanceof Error?error.message:String(error))}}
   }catch(error){throw new QuestError('INVALID_INPUT',input.action+': '+(error instanceof Error?error.message:String(error)))}
  }
  if(input.action==='roles'){
   if(isWorker)throw new QuestError('WORKER_DELEGATION_DENIED','Workers cannot read or change role models')
   try{
    if(input.roles?.set!==undefined)setRoleSettings(input.roles.set)
    return readRoles()
   }catch(error){throw new QuestError('INVALID_INPUT','roles: '+(error instanceof Error?error.message:String(error)))}
  }
  if(input.action==='describe'){
   const found=describeOperation(String(input.describe?.operation??''))
   if(!found)throw new QuestError('INVALID_INPUT','describe: no Quest operation is named '+String(input.describe?.operation??'')+'; the operation list names each one')
   return found
  }
  if(input.action==='owners'){
   if(isWorker)throw new QuestError('WORKER_DELEGATION_DENIED','Workers cannot read who owns each Quest')
   return ownersPicture(store)
  }
  if(input.action==='spend'){
   if(isWorker)throw new QuestError('WORKER_DELEGATION_DENIED','Workers cannot read or change spend goals')
   const {start:begin,goalID:id,addItems,end}=input.spend??{}
   if([begin,end,addItems].filter(value=>value!==undefined).length>1)throw new QuestError('INVALID_INPUT','spend: use one of start, addItems or end')
   if((addItems!==undefined||end!==undefined)&&!id)throw new QuestError('INVALID_INPUT','spend: addItems and end need goalID')
   const shown=begin?startSpendGoal(store.runtime,{...begin,projectRoot:await projectMainCheckoutAsync(begin.projectRoot)}).id:id
   if(addItems)addSpendItems(store.runtime,id,addItems)
   if(end)endSpendGoal(store.runtime,id,end.state,end.reason)
   const accounts=spendAccounts(),goals=settleSpendGoals(store.runtime,readQuestSafely,accounts)
   return {goals:goals.filter(goal=>!shown||goal.id===shown).map(goal=>spendView(goal,readQuestSafely,accounts))}
  }
  if(input.action==='delivery'){
   if(isWorker)throw new QuestError('WORKER_DELEGATION_DENIED','Workers cannot read or change delivery policy')
   const {set,clear,projectRoot}=input.delivery
   if(set!==undefined&&clear===true)throw new QuestError('INVALID_INPUT','delivery: use set or clear, not both')
   const settingsFile=questSettingsFile()
   try{
    const project=await projectMainCheckoutAsync(projectRoot)
    if(set!==undefined)setDeliveryPolicy(project,set)
    if(clear===true)setDeliveryPolicy(project,null)
    const {file:_file,...resolved}=await resolveDeliveryPolicyAsync(project)
    return {project,settingsFile,...resolved}
   }catch(error){throw new QuestError('INVALID_INPUT','delivery: '+(error instanceof Error?error.message:String(error)))}
  }
  if(!isWorker)refuseRetiredGiver(store,context.sessionID)
  if(input.action==='succeed_giver'){
   if(isWorker)throw new QuestError('WORKER_DELEGATION_DENIED','Workers cannot hand on the Quest Giver role')
   const bound=userGiverID(store)
   if(bound&&bound!==context.sessionID)throw new QuestError('SINGLE_GIVER_REQUIRED','Only your Quest Giver can hand on its role: '+bound)
   const released=releaseUserGiver(store.runtime)
   return {released:released??null,next:released?'Released. Start a new session and it becomes your Quest Giver; the old conversation and its Quests are untouched.':'No giver was bound; the next session becomes your Quest Giver.'}
  }
  if(!isWorker&&session?.agent==='quest-giver'&&!readUserGiver(store.runtime))await bindUserGiver(store,host,context.sessionID)
  if(!isWorker&&userGiverID(store)&&userGiverID(store)!==context.sessionID&&['create','update','run','start','stop'].includes(input.action))throw new QuestError('SINGLE_GIVER_REQUIRED','Continue in your one Quest Giver: '+userGiverID(store))
  const hostTurn=context.native===true||typeof context.messageID==='string'
  const fromMessage=input.action==='create'?input.create?.fromMessage:input.action==='update'?input.update?.fromMessage:undefined
  const spendTarget=input.action==='create'&&input.create?.spendGoal&&input.create.projectRoot===undefined?readSpendGoals(store.runtime).find(goal=>goal.id===input.create.spendGoal.id):undefined
  if(spendTarget)input={...input,create:{...input.create,projectRoot:spendTarget.projectRoot}}
  if(input.create?.fromMessage!==undefined){const {fromMessage:_quote,...create}=input.create;input={...input,create}}
  if(input.update?.fromMessage!==undefined){const {fromMessage:_quote,...update}=input.update;input={...input,update}}
  let turn:Awaited<ReturnType<typeof originatingUserTurn>>|undefined
  try{turn=!isWorker&&input.action==='create'&&hostTurn?await originatingUserTurn(store,host,context.sessionID,context.messageID,fromMessage):undefined}
  catch(error){if(!isWorker&&!selfFixEnabled()&&['GIVER_TURN_REQUIRED','HANDOFF_ON_QUESTS'].includes((error as any)?.code))await recordCreateRefusal(store,host,context.sessionID,context.messageID,String(input.create?.title??'a new Quest'),(error as Error).message);throw error}
  const refinement=!isWorker&&input.action==='update'&&hostTurn&&refinesDefinition({...input.update,fromMessage})?await refiningUserMessages(host,context.sessionID,context.messageID,fromMessage):[]
  const deliveryAsk=!isWorker&&input.action==='update'&&hostTurn&&input.update?.workflow?.delivery!==undefined?await refiningUserMessages(host,context.sessionID,context.messageID,fromMessage):[]
  const chosenRoot=input.action==='create'?input.create?.projectRoot:input.action==='update'?input.update?.projectRoot:undefined
  if(!isWorker&&hostTurn&&!spendTarget&&typeof chosenRoot==='string'&&userGiverID(store)===context.sessionID){
   const {messages,index}=await giverTurn(host,context.sessionID,context.messageID)
   let giverRoot:string|undefined
   try{giverRoot=(await projectIdentityAsync(giverFolder(session))).root}catch{}
   const refusal=projectNotChosen(messages,index,chosenRoot,giverRoot)
   if(refusal)throw new QuestError('PROJECT_NOT_CHOSEN',refusal)
  }
  const trusted=isWorker?{project:await workerLedgerProject(store,context.sessionID,directory)??await projectIdentityAsync(directory),directory:physicalDirectory(directory),sessionID:context.sessionID,requestID}:{...giverContext(store,{...session,id:context.sessionID},requestID,input.id,input.action==='create'?{projectRoot:input.create?.projectRoot}:false,turn?.turnID),...(turn?.request.length?{request:turn.request}:deliveryAsk.length?{request:deliveryAsk}:{}),...(turn?.stepID?{giverStepID:turn.stepID}:{}),...(turn?.laterTurn?{laterTurn:true as const}:{})}
   if(!isWorker&&trusted.giverDirectory&&input.id&&input.action!=='history')adoptQuestGiver(store,input.id)
  if(trusted.missingDirectory&&['run','start'].includes(input.action))throw new QuestError('PROJECT_FOLDER_GONE','This Quest is recorded against '+trusted.missingDirectory+', which is no longer on disk, so no worker can be started in it. Move it to a folder that exists with update projectRoot, then start it.')
  if(input.action==='answer'){if(isWorker)throw new QuestError('WORKER_DELEGATION_DENIED','Workers cannot answer permission asks');return respond(await answerWorkerAsk(store,host,context.sessionID,{id:input.id,...input.answer}),[])}
  if(input.action==='stop'){questsAPI(store,trusted,start).get(input.id);const stopper=context.sessionID===userGiverID(store)?'the Quest Giver':context.external===true?'the '+(context.historyFrom??'outside caller')+' caller':'session '+context.sessionID;const outcome=await stopQuestRuns(store,host,input.id,{...input.stop,sender:input.stop?.sender??stopper});const q=store.read(input.id)!;hydrateSessionReferences(store,[q]);return respond({...toolStatus(q),...outcome},[q])}
  if(!giverCaller&&input.action==='run')throw new QuestError('GIVER_STARTS_WORKERS','No worker was started. The Quest Giver starts workers: start this Quest so it plans and runs it, or send the Quest Giver a message with quest message.')
  if(!giverCaller&&method==='update'&&(context.outside===true||context.audience==='agent')&&GIVER_PLANS.some(field=>input.update?.[field]!==undefined))throw new QuestError('GIVER_PLANS','Only the Quest Giver plans steps, workflow, dependencies or the checkout of a Quest. Start it so the Quest Giver plans it, or send the Quest Giver a message with quest message.')
  if(input.action==='start'){
   questsAPI(store,trusted,start).get(input.id)
   const requested=giverCaller?requestQuestStart(store,input.id,v2QueueGeneration()):requestQuestPlan(store,input.id,v2QueueGeneration())
   void startAdmission.trigger()
   const q=store.read(input.id)!
   hydrateSessionReferences(store,[q])
   const lean=leanAdmission('requestID'in requested&&['queued','admitting'].includes(requested.state)?{...requested,state:'starting'}:requested)
   const launched=q.sessions.find(run=>(run.runID??run.callID)===lean.runID)
   const sessionID=launched&&nativeRunID(launched)
   if(sessionID)await hostConfirmsRunning(host,sessionID,boundedInspection)
   return respond(toolAdmission(q,lean,dispatchConfirmation(q,await readQuestActivity(host,[q]),lean?.runID)),[q])
  }
  if(input.action==='run'){
   if((input.run?.maxConcurrent!==undefined||input.run?.stepModels!==undefined)&&input.run?.continue!==true)throw new QuestError('INVALID_INPUT','Parallel options require run.continue')
   if(typeof input.run?.model==='string')assertFullRoute(input.run.model,'run.model')
   if(input.run?.stepModels&&typeof input.run.stepModels==='object')for(const [stepID,model] of Object.entries(input.run.stepModels))if(typeof model==='string')assertFullRoute(model,'run.stepModels.'+stepID)
   if((input.run?.maxConcurrent??1)>1&&workspaceSettings(options.settingsFile).workspaceMode!=='worktree')throw new QuestError('WORKSPACE_MODE_REQUIRED','Parallel continuation requires isolated worktrees')
   configureLearning(store,trusted,input.id,input.run?.taskTags,input.run?.maxConcurrent??1)
  }
  if(input.action==='run'&&input.run?.recoverDependencies&&input.run?.continue)throw new QuestError('INVALID_INPUT','Dependency recovery requires a single explicit run, not continued dispatch')
  const continued=async()=>{const run=input.run??{};const admitted=await continuation.run(input.id,{readOnly:run.readOnly,task:run.task,depth:run.depth,workType:run.workType,model:run.model,stepIDs:run.stepIDs,files:run.files,maxConcurrent:run.maxConcurrent,stepModels:run.stepModels},trusted);const q=store.read(input.id)!;hydrateSessionReferences(store,[q]);const lean=leanAdmission(admitted);return respond(toolAdmission(q,lean,dispatchConfirmation(q,await readQuestActivity(host,[q]),lean?.runID)),[q])}
  if(input.action==='run'&&input.run?.continue===true)return continued()
  if(input.action==='update'&&input.update?.cancelContinuation===true){continuation.cancel(input.id,trusted);input={...input,update:{...input.update}};delete input.update.cancelContinuation}
  const api=questsAPI(store,trusted,start)
  if(input.action==='history'){api.get(input.id);return questHistory(store,input.id,input.history)}
  const listView=input.query?.view,withArchived=input.query?.withArchived
  if(input.query){delete input.query.view;delete input.query.withArchived}
  if(withArchived!==undefined&&listView!=='board')throw new QuestError('INVALID_INPUT','withArchived needs view board')
  if(input.action==='list'&&listView==='board'){const shown=boards.list(api,{...(trusted.giverDirectory?{allProjects:true}:{}),...input.query,...(withArchived?{withArchived}:{})},trusted.project.id);return respond(shown.value,shown.quests)}
  let result:any,admission:any
   switch(input.action){case "list":result=api.list({...(trusted.giverDirectory?{allProjects:true}:{}),...input.query});break;case "get":result=api.get(input.id);break;case "create":{const starting=input.create?.start===true;const {start:_starting,spendGoal,...creating}=input.create??{};const spending=spendGoal?assertSpendLink(store.runtime,spendGoal.id,spendGoal.item,readQuestSafely):undefined;try{result=api.create(creating)}catch(error){if(!isWorker)try{recordHandoffRefusal(store.runtime,(trusted.request??[]).map((row:any)=>row.messageID),error)}catch(failure){console.error("[quests] hand-off refusal not recorded",failure)};if(!isWorker&&(error as any)?.code==='SELF_FIX_OFF')await recordCreateRefusal(store,host,context.sessionID,context.messageID,creating.title,(error as Error).message);throw error};if(spending)linkSpendQuest(store.runtime,spending.id,result.id,spendGoal.item);
    if(trusted.giverDirectory&&(!result.project||result.project.id===trusted.project.id)){const q=store.read(result.id)!;store.apply(q.id,'patched',{extensions:{...q.extensions,giverSourceDirectory:trusted.directory}},'quest:user-giver-source')}
    if(starting)admission=giverCaller?requestQuestStart(store,store.read(result.id)!.id,v2QueueGeneration()):requestQuestPlan(store,store.read(result.id)!.id,v2QueueGeneration());break}case "update":result=api.update(input.id,input.update);if(!isWorker&&context.sessionID===userGiverID(store))try{recordGiverSavedBlocks(store,input.id,(input.update?.steps??[]).filter((step:any)=>step?.state==='blocked').map((step:any)=>step.id))}catch(error){console.error('[quests] Quest Giver block not recorded',input.id,error)};if(refinement.length)appendUserRequests(store,input.id,refinement);scheduleQuestCleanup(store,host,input.id);break;case "run":try{result=await api.run(input.id,input.run?{recoverDependencies:input.run.recoverDependencies,readOnly:input.run.readOnly,task:input.run.task,depth:input.run.depth,workType:input.run.workType,model:input.run.model,stepIDs:input.run.stepIDs,files:input.run.files}:undefined)}catch(error){if(error instanceof QuestError&&error.code==='WORKER_ADMISSION'&&!input.run?.recoverDependencies)return continued();recordRefusalReplied(store,input.id,error);throw error};break;case "message":result=await deliverGiverMessage(store,host,trusted,input.id,messageRequest);break;default:throw new QuestError("INVALID_OPERATION","Use list, get, create, update, run, wait, stop, message, waterfall, benches or succeed_giver")}
   let waited:any
   if(waitRequest&&input.id){
    const runID=waitRequest?.runID,until:WaitCondition=waitRequest?.until??'changed'
    const before=store.read(input.id)
    if(before){
     if(activeRuns(before,runID).some(run=>(run.openCodeSessionId??run.sessionID)===context.sessionID))throw new QuestError('WORKER_SELF_WAIT','A worker cannot wait for its own run to finish. Continue the assigned work, or inspect quest_guidance status and end this turn if queued guidance is pending. Report and get the saved step result when ready; the giver receives the terminal update automatically.')
     if(runID&&until!=='changed'&&!before.sessions.some(run=>isRun(run,runID)))throw new QuestError('RUN_NOT_FOUND','No run '+runID+' on Quest '+input.id+'; read its runs with inspect section runs.')
     const start=waitStart(before,runID),startsMatter=!runID&&until!=='changed'
     const verdict=(quest:any)=>waitVerdict(until,quest,start,runID,startsMatter?pendingStart(store,input.id):undefined)
     const blocking=until==='changed'?activeRuns(before,runID).length>0:!verdict(before).satisfied
     const requested=waitRequest?.timeoutSeconds
     const seconds=requested!==undefined?Math.max(Math.round(requested),1):until==='changed'?DEFAULT_WAIT_SECONDS:undefined
     let outcome={changed:false,satisfied:!blocking,quest:before as any,milliseconds:0}
     if(blocking){
      outcome=await awaitQuestChange({signal:context.signal,read:()=>store.read(input.id),fingerprint:start.fingerprint,runID,deadline:seconds===undefined?Infinity:Date.now()+seconds*1000,
       satisfied:until==='changed'?undefined:quest=>verdict(quest).satisfied,
       reconcile:()=>reconcileWorkers(store,host,input.id),
       events:listener=>questChangeEvents(store,host,input.id,listener,startsMatter),
       onWaiting:ms=>{try{void Promise.resolve(context?.progress?.({questID:input.id,runID,waitingSeconds:Math.round(ms/1000)})).catch(()=>{})}catch{}}})
     }
     const after=outcome.quest??store.read(input.id)
     if(!after)throw new QuestError('QUEST_REMOVED','The Quest was removed while waiting: '+input.id)
     if(blocking)result=api.get(input.id)
     const settled=until==='changed'&&!blocking
     const now=verdict(after)
     const reason=settled?'No active run to wait for; this is the settled saved state.':outcome.satisfied?now.reason:'Timed out after '+Math.round(outcome.milliseconds/1000)+' s. '+now.reason
     waited={until,satisfied:outcome.satisfied,reason,runs:waitRuns(after,start,runID),milliseconds:outcome.milliseconds,changed:outcome.changed,
      ...(until==='changed'&&blocking&&!outcome.changed?{steering:waitSteering(after,runID,outcome.milliseconds)}:{})}
    }
   }
   const listed=new Map<string,any>()
   const record=(id:string)=>{if(listed.has(id))return listed.get(id);const q=store.read(id);if(!q)return;hydrateSessionReferences(store,[q]);listed.set(q.id,q);listed.set(questReference(q),q);return q}
   if(['get','update'].includes(input.action)){
    const q=record(input.id)!
    if(input.inspect){
     const section=input.inspect.section
     const values:Record<string,()=>unknown>={cleanup:()=>cleanupStatus(store,q),description:()=>q.description,reward:()=>q.reward,steps:()=>q.stages,runs:()=>q.sessions,reviews:()=>Object.values(q.extensions.reviews??{}),artifacts:()=>q.evidence,changes:()=>questChanges(q,workspaces),continuation:()=>continuation.status(q.id)}
     if(!values[section])throw new QuestError('INVALID_INPUT','Unknown inspect section')
     const page=toolSection(await values[section](),section,input.inspect.offset,input.inspect.limit)
     if(section==='runs'&&Array.isArray(page.data))page.data=await Promise.all(page.data.map(async(run:any)=>({...run,observation:['planned','executing','waiting','blocked'].includes(run.state)?await inspectWorker(host,run):undefined})))
     result={id:questReference(q),project:q.project,...page}
    }else if(method==='status'||method==='archive'||method==='reopen')result=toolStatus(q)
    else if(method==='plan')result=toolPlan(q,continuation.status(q.id))
    else if(method==='report'){const steps=q.stages.filter(s=>s.id===(args as any).stepID).map(s=>({id:s.id,state:s.status,note:s.note,blocker:s.blocker,resolution:s.resolution,checks:q.evidence.tests.filter(check=>check.stepID===s.id)}));result=isWorker?{id:questReference(q),revision:q.revision,steps}:{...toolSummary(q),steps}}
    else if(method==='update')result=toolMutation(q,(input as any).update)
    else result=toolDetail(q,continuation.status(q.id))
   }
   if(input.action==='create'||input.action==='run'){
    const q=record(input.action==='create'?result.id:input.id)
    if(q){const lean=input.action==='run'?leanAdmission(result):admission?leanAdmission(admission):undefined;result=toolAdmission(q,lean,dispatchConfirmation(q,await readQuestActivity(host,[q]),lean?.runID))}
   }
   if(input.action==='list'){
    hydrateSessionReferences(store,result.records)
    const workspaceReferences=listView==='report'&&(context.audience==='web'||(context.audience===undefined&&context.external===true))?workspaceReferenceProjection(store,result.allRecords,workspaces):undefined
    result=questListResult(result,await readQuestActivity(host,result.records),(item:any)=>listView==='plan'?toolPlan(record(item.id)!,continuation.status(record(item.id)!.id)):toolSummary(record(item.id)!),listView,admissionRecords(store))
    if(workspaceReferences)result.workspaceReferences=workspaceReferences
   }else if(!input.inspect&&result?.id&&result.state){
    const q=record(result.id)
    if(q)result=withQuestActivity(q,result,await readQuestActivity(host,[q]),admissionRecords(store))
   }
   if(waited)result={waited,...result}
   return respond(result,[...new Set(listed.values())])
 }
 return {call:async(method:string,args:unknown,context:any)=>withHistoryOrigin({from:context?.historyFrom??(context?.external?'unknown':'runtime'),sessionID:context?.sessionID,requestID:context?.id??context?.callID},async()=>{let changed=false;try{const asked=args&&typeof args==='object'&&!Array.isArray(args)?args as any:undefined,{full,...rest}=asked??{};const value=await handle(method,asked?pieceInput(method,rest):args,context,()=>{changed=true});return full===true?value:compactQuestAnswer(method,rest,value,context?.audience==='web'||(context?.audience===undefined&&context?.external===true))}finally{if(changed)board.kick(...EVERY)}})}
}
