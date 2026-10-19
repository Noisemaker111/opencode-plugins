import {giverContext,verifyGiverBinding} from './giver/user-giver'
import { QuestContinuation } from './runs/continuation'
import { QuestStore } from './store'
import { questRoot } from './root.mts'
import { projectIdentity, physicalDirectory, verifySourceBinding } from './core/project'
import type { QuestHost } from './runs/runtime'
import { questDispatch } from './runs/dispatch'
import { configuredDispatchPolicyFile, dispatchReservationFile } from '../models/dispatch-planner'
import { QuestError } from './api'
import { routerWorker } from './router-public'
import { configuredCommand, runKnownCommand } from './command-runtime'
import { join } from 'node:path'
import { goalRoute } from './routing/goal-route'
import { RouteReservations } from '../models/route-reservations'
import { retainGoalTerminal, finishGoalTerminal, consumeGoalTerminal } from './routing/goal-lifecycle'
import { eventStep, coalesce, watchQuestLedger } from './host/coordinator-events'
import {refusalContinuation} from './runs/refusal-continuation'

export function createGoalFacade(host: QuestHost) {
  const store = new QuestStore(questRoot())
  const binding=goalRoute
  const { start } = questDispatch(store, host)
  const continuation = new QuestContinuation(store, start, { goalMode: true, routeBinding:binding, resumeExact:refusalContinuation(store,host), verifyContext: async context => {
    const result = await host.get({ sessionID: context.sessionID }), session = result?.data ?? result
    await verifyGiverBinding(store,context,session)
    const row=continuation.goalStatus(context.sessionID).at(-1)
    if(row?.model){const route=await binding(row.route?'route:'+row.route.routeID:row.model,row.route)
      if(row.route&&JSON.stringify(route)!==JSON.stringify(row.route))throw new QuestError('GOAL_ROUTE_CHANGED','Authorized account/service route changed')
      if(row.worker&&(session.model?.providerID!==route.providerID||session.model?.id!==route.modelID||session.model?.variant!==route.reasoning))throw new QuestError('GOAL_ROUTE_CHANGED','Explicit model/reasoning changed; inspect before resuming')
      if(row.worker){const run=store.read(row.questID)?.sessions.findLast(s=>s.openCodeSessionId===context.sessionID||s.sessionID===context.sessionID),reservation=run?.runID?new RouteReservations(dispatchReservationFile(store.runtime)).get(run.runID):undefined;if(!reservation||reservation.state!=='active'||reservation.accountID!==route.accountID||reservation.routeID!==route.routeID)throw new QuestError('GOAL_RESERVATION_CHANGED','Worker account ownership is no longer active')}
    }
  },workerPrompt:async(context,text,id,eventID)=>{consumeGoalTerminal(store.runtime,context.sessionID,eventID);await host.prompt({sessionID:context.sessionID,id:'msg_'+id.replace(/[^A-Za-z0-9]/g,'').slice(0,30),text,metadata:{projectRouterGoal:true}})} })
  const advance = eventStep('goal continuation', async () => { await continuation.tick().catch(() => {}); return continuation.nextDue() })
  const changes = coalesce<true>(() => { ledger.ensure(); void advance.trigger() })
  const ledger = watchQuestLedger(store, change => { if (change === 'ledger') changes.kick(true) })
  changes.kick(true)
  let trigger='not-connected'
  return {
    trigger(state:string){trigger=state},
    dispose() { changes.dispose(); ledger.dispose(); advance.dispose() },
    tick: () => continuation.tick(),
    async event(sessionID:string,eventID:string,success:boolean){changes.kick(true);const owned=continuation.goalStatus(sessionID).findLast(r=>r.worker&&r.live);if(!owned)return;await continuation.workerEvent(sessionID,eventID,success);const row=continuation.goalStatus(sessionID).at(-1);if(row?.live&&row.state==='running')consumeGoalTerminal(store.runtime,sessionID,eventID);else if(!success||row?.state==='done')finishGoalTerminal(store.runtime,sessionID)},
    async steer(sessionID:string){const rows=continuation.goalStatus(sessionID);for(const row of rows)continuation.pauseGoal(row.context)},
    async verify(input:{questID:string;stepID:string;commandID:string;action?:'bind'|'run'},trusted:{sessionID:string;requestID:string}){
      const result=await host.get({sessionID:trusted.sessionID}),session=result?.data??result,context=giverContext(store,{...session,id:trusted.sessionID},trusted.requestID,input.questID),project=context.project,q=store.read(input.questID)
      if(!q||q.project?.id!==project.id)throw new QuestError('PROJECT_MISMATCH','Select the owning destination session before verification')
      const assignments=routerWorker(trusted.sessionID),run=q.sessions.findLast(s=>s.openCodeSessionId===trusted.sessionID||s.sessionID===trusted.sessionID)
      if(assignments.length&&(!run||q.sessions.findLast(s=>s.deliverables.includes(input.stepID))!==run||!['executing','waiting'].includes(run.state)))throw new QuestError('WORKER_ASSIGNMENT_DENIED','Verification requires current assigned step ownership')
      const step=q.stages.find(s=>s.id===input.stepID);if(!step)throw new QuestError('STEP_NOT_FOUND','Select an existing assigned step')
      const command=configuredCommand(configuredDispatchPolicyFile(),project.id,input.commandID)
      const contracts=(q.extensions.routerVerification??{}) as Record<string,string>
      if(input.action==='bind'){if(assignments.length)throw new QuestError('WORKER_ASSIGNMENT_DENIED','Only the giver defines the assigned verification contract');store.apply(q.id,'patched',{extensions:{...q.extensions,routerVerification:{...contracts,[step.id]:input.commandID}}},'quest:verification-contract');return {questID:q.id,stepID:step.id,commandID:input.commandID,bound:true}}
      if((contracts[step.id]??step.commandID)!==input.commandID)throw new QuestError('VERIFICATION_CONTRACT_REQUIRED','The giver must project_verify action=bind this configured command to the assigned step before running it')
      const outcome=await runKnownCommand(command,context.directory!,join(store.runtime,'command-logs','verify-'+trusted.requestID.replace(/[^a-zA-Z0-9_-]/g,'')+'.log'))
      const passed=outcome.exitCode===0&&!outcome.timedOut
      store.apply(q.id,'proof-added',{stageID:step.id,proof:{id:'verify:'+trusted.requestID,kind:'command',at:new Date().toISOString(),attempt:step.attempt,result:passed?'passed':'failed',command:input.commandID,artifact:outcome.logFile,verified:true}},'quest:goal-verify')
       return {questID:q.id,stepID:step.id,result:passed?'passed':'failed',log:outcome.logFile,milliseconds:outcome.milliseconds,exitCode:outcome.exitCode,signal:outcome.signal,timedOut:outcome.timedOut,output:outcome.output,outputTruncated:outcome.outputTruncated,logTruncated:outcome.truncated,evidence:'Inspect this returned command output for the assigned check; the log is a durable artifact, not a required external-file read.'}
    },
    async control(input: { action: 'start' | 'status' | 'pause' | 'cancel' | 'resume'; questID?: string; stepIDs?: string[];model?:string }, trusted: { sessionID: string; requestID: string }) {
      const result = await host.get({ sessionID: trusted.sessionID }), session = result?.data ?? result
      const context = giverContext(store,{...session,id:trusted.sessionID},trusted.requestID,input.questID??(input.action==='resume'||input.action==='pause'||input.action==='cancel'?continuation.goalStatus(trusted.sessionID).at(-1)?.questID:undefined))
      const worker = routerWorker(trusted.sessionID)
      if(input.action==='start'||input.action==='resume'){if(trigger!=='live')throw new QuestError('GOAL_TRIGGER_UNAVAILABLE','Live execution subscription is '+trigger+'; open a fresh verified session before pursuit')}
      if (worker.length && input.action === 'start') {
        if (input.questID && !worker.some(w => w.questID === input.questID) || input.stepIDs?.some(id => !worker.some(w => w.stepIDs.includes(id)))) throw new QuestError('WORKER_ASSIGNMENT_DENIED', 'Goal may reference only the current assigned Quest steps')
        const model=`${session.model?.providerID}/${session.model?.id}#${session.model?.variant}`
        if(!session.model?.variant)throw new QuestError('EXPLICIT_MODEL_REQUIRED','Select an explicit model/reasoning route')
        const q=store.read(input.questID??worker[0].questID),run=q?.sessions.findLast(s=>s.openCodeSessionId===trusted.sessionID||s.sessionID===trusted.sessionID),reservation=run?.runID?new RouteReservations(dispatchReservationFile(store.runtime)).get(run.runID):undefined
        if(!reservation||reservation.state!=='active')throw new QuestError('GOAL_RESERVATION_REQUIRED','Worker goal requires its live canonical route/account reservation')
        const route=await binding(model)
        if(route.accountID!==reservation.accountID||route.routeID!==reservation.routeID)throw new QuestError('GOAL_ROUTE_CHANGED','Reserved account/service route differs from authorized route')
        const result=continuation.startWorkerGoal(input.questID??worker[0].questID,input.stepIDs??worker[0].stepIDs,context,model,route);retainGoalTerminal(store.runtime,trusted.sessionID);return result
      }
      if (input.action === 'status') return {trigger,goals:continuation.goalStatus(trusted.sessionID),pauseSemantics:'Worker pause retains its current workspace/account ownership for verified same-session resume; cancel releases after the observed terminal event. No new turns while paused.'}
      if (input.action === 'pause' || input.action === 'cancel') {const result=continuation.pauseGoal(context);if(input.action==='cancel')finishGoalTerminal(store.runtime,trusted.sessionID);return {goals:result,ownership:worker.length&&input.action==='pause'?'retained for same-session resume; cancel to finalize':'finalize observed terminal outcome'}}
      if (input.action === 'resume') {if(worker.length)retainGoalTerminal(store.runtime,trusted.sessionID);const result=await continuation.resumeGoal(context);if(worker.length){const row=continuation.goalStatus(trusted.sessionID).at(-1);if(row?.state==='running')consumeGoalTerminal(store.runtime,trusted.sessionID);else if(row?.state==='done')finishGoalTerminal(store.runtime,trusted.sessionID)}return result}
      if (!input.questID || !input.stepIDs?.length) throw new QuestError('GOAL_AUTHORIZATION_REQUIRED', 'Name a Quest and explicit authorized step IDs')
      const q=store.read(input.questID)
      if(q&&input.stepIDs.every(id=>q.stages.find(s=>s.id===id)?.commandID)){if(input.model)throw new QuestError('EXPLICIT_MODEL_CONFLICT','Configured command goals do not substitute an inference route');return continuation.run(input.questID,{stepIDs:input.stepIDs},context)}
      const model=input.model??(session.model?.providerID&&session.model?.id&&session.model?.variant?`${session.model.providerID}/${session.model.id}#${session.model.variant}`:undefined)
      if(!model)throw new QuestError('EXPLICIT_MODEL_REQUIRED','Select an explicit authorized model/reasoning route')
      return continuation.run(input.questID, { stepIDs: input.stepIDs, model }, context)
    },
  }
}
