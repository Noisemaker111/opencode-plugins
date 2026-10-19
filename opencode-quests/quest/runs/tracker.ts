import { SessionReferences } from '../host/session-references'
import { namedRouteProvider, noteReason } from '../review/plain-words'
import { HOST_STATEMENT_FAILURE, describeHostStatementFailure, hostStatementCause } from '../host/host-statement-failure'
import {boundedInspection} from '../worker-observation.mjs'
import {hostConfirmsRunning} from '../host/host-observation'
import { readSessionRequests } from "../../usage/telemetry-api"
import { aggregateTelemetry } from "../../usage/telemetry-api"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { QuestWorkspaces } from "../workspaces"
import { driveAsync } from "../landing/git-steps"
import { recordLanding } from "../landing/delivery"
import { questWorkflow } from "./workflow"
import { deliveryRefusal } from "../landing/delivery-permission"
import { whileLanding } from "./run-phase"
import { reviewFinishedRun } from "../review/reviewer"
import { isReplayRun } from "../bench/replay-record"
import { askForReport, blockUnreported } from "./report-request"
import { RouteReservations } from "../../models/route-reservations"
import { QuestStore } from "../store"
import { requestFingerprint, redact } from "../privacy"
import type { Quest, QuestSession } from "../types"
import { questMemberships } from "../permissions/shared-guard"
import { releaseWorkspaceLocks } from "../host/host-observation"
import { releaseLockHeldBy, workspaceLockHolder } from "../locking.mts"
import { parseWorkerReport } from "./report"
import { isTerminalSession as terminalSession } from "./session-lineage"
import { deferGoalTerminal } from '../routing/goal-lifecycle'
import {dispatchReservationFile} from '../../models/dispatch-planner'
import {physicalDirectory} from '../core/project'
import { findStep } from "../core/steps"
import { timed } from "../../scripts/plugin-spans"
import { authUnavailable, isClaudeRoute, noteClaudeAuthUnavailable } from "./claude-fallback"
import { workerIdentityFromEvent } from "../../orchestration/dispatch"
import type { CompletionEvidence } from "../../orchestration/orchestration-ledger"

export type QuestDispatch = { questID: string; callID: string; taskID?: string; role: string; deliverables: string[]; model?: string; harness?: string; branch?: string; worktree?: string; agentRole?: string; providerID?: string; modelID?: string; reasoningEffort?: QuestSession["reasoningEffort"]; fast?: boolean; runtime?: "native"; runID?: string; task?: string; parentID?: string; scope?: Record<string, unknown> }

const ACTIVE_SESSION = new Set(["planned", "executing", "waiting", "blocked"])
const SESSION_ID = /^ses_[A-Za-z0-9_-]+$/

const HOST_TERMINAL: Record<string, "completed" | "failed" | "cancelled"> = {
  "session.execution.succeeded": "completed",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "cancelled",
  "session.execution.cancelled": "cancelled",
}

function taskInput(event: unknown): Record<string, unknown> {
  const ev = (event ?? {}) as Record<string, unknown>
  const input = ev.input ?? ev.args
  return input && typeof input === "object" ? input as Record<string, unknown> : {}
}

function taskCallID(event: unknown): string {
  const ev = (event ?? {}) as Record<string, unknown>
  return String(ev.questCallID ?? ev.callID ?? ev.id ?? ev.messageID ?? "")
}

function taskResult(event: unknown, output?: unknown): unknown {
  const ev = (event ?? {}) as Record<string, unknown>
  return output ?? ev.result ?? ev.output ?? {}
}

function taskSessionID(output: unknown, event: unknown): string | undefined {
  const values: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === "string") { values.push(value); return }
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit)
  }
  visit(taskResult(event, output))
  const exact = values.find((value) => SESSION_ID.test(value))
  if (exact) return exact
  for (const value of values) {
    const found = value.match(/(?:Session:\s*|sessionID\s*[:=]\s*"?)(ses_[A-Za-z0-9_-]+)/i)?.[1]
    if (found) return found
  }
  const parentID = String((event as Record<string, unknown> | undefined)?.sessionID ?? "")
  for (const value of values) {
    const found = (value.match(/ses_[A-Za-z0-9_-]+/g) ?? []).find((id) => id !== parentID)
    if (found) return found
  }
}

function toolError(event: unknown, output?: unknown): string | undefined {
  const ev = (event ?? {}) as Record<string, unknown>
  if (ev.status === "error" || ev.error) {
    const error = ev.error as { message?: unknown } | string | undefined
    return typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "Quest dispatch returned an error"
  }
  let found: string | undefined
  const visit = (value: unknown) => {
    if (found || !value || typeof value !== "object") return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const row = value as Record<string, unknown>
    if (row.isError === true || row.error) {
      found = typeof row.error === "string" ? row.error : "Quest dispatch returned an error"
      return
    }
    Object.values(row).forEach(visit)
  }
  visit(taskResult(event, output))
  return found
}

function eventData(event: unknown): { type?: string; data: Record<string, unknown> } {
  const ev = (event ?? {}) as { type?: unknown; data?: unknown; properties?: unknown }
  const data = (ev.data ?? ev.properties ?? {}) as Record<string, unknown>
  return { type: typeof ev.type === "string" ? ev.type : undefined, data }
}

export type SessionRef = { questID: string; session: QuestSession }

const SETTLEMENTS = Symbol.for("questgiver.run-settlements")
const settlements = (): Map<string, Promise<"settled">> => ((globalThis as any)[SETTLEMENTS] ??= new Map())
export function runSettlement(runID: string): Promise<"settled"> | undefined { return settlements().get(runID) }
const SETTLED = Symbol.for("questgiver.run-settled")
const settledListeners = (): Set<(runID: string) => void> => ((globalThis as any)[SETTLED] ??= new Set())
export function onRunSettled(listener: (runID: string) => void): () => void { settledListeners().add(listener); return () => { settledListeners().delete(listener) } }

export class QuestTracker {
  readonly enabled = process.env.OPENCODE_QUEST_MODE !== "off"
  constructor(readonly store: QuestStore, readonly sessionApi?: { get?: Function }, readonly options: { hostLog?: string } = {}) {}

  async identifyFromHost(questID: string, callID: string, sessionID: string): Promise<boolean> {
    const get = this.sessionApi?.get
    if (typeof get !== "function") return false
    try {
      const res = await get({ sessionID })
      const info = ((res as { data?: unknown })?.data ?? res ?? {}) as Record<string, unknown>
      if (typeof info.id === 'string' && typeof info.title === 'string' && info.title.trim()) new SessionReferences(this.store.runtime).register({sessionID:info.id,title:info.title})
      const model = (info.model ?? {}) as Record<string, unknown>
      if (typeof model.providerID !== "string" || typeof model.id !== "string") return false
      const current = this.store.read(questID)?.sessions.find((session) => session.callID === callID)
      if (!current || (current.providerID === model.providerID && current.modelID === model.id)) return false
      this.store.apply(questID, "session-state", { callID, state: current.state, providerID: model.providerID, modelID: model.id, model: `${model.providerID}/${model.id}` }, "host:session")
      return true
    } catch { return false }
  }
  admit(input: { title: string; objective: string; request: unknown; kind?: Quest["kind"]; priority?: Quest["priority"]; scope?: Quest["scope"]; deliverables?: Quest["deliverables"]; acceptanceCriteria?: Quest["acceptanceCriteria"]; owner?: string; integrationOwner?: string; createdAt?: string }): Quest {
    return this.store.admit({ ...input, requestFingerprint: requestFingerprint(input.request) })
  }
  beforeDispatch(input: { questID?: string; callID: string; taskID?: string; description?: string; role?: string; deliverables?: string[]; model?: string; harness?: string; branch?: string; worktree?: string; fingerprint?: string; agentRole?: string; providerID?: string; modelID?: string; reasoningEffort?: QuestSession["reasoningEffort"]; fast?: boolean; runtime?: "native"; runID?: string; task?: string; parentID?: string; scope?: Record<string, unknown> }): QuestDispatch | undefined {
    if (!this.enabled) return
    const questID = input.questID
    if (!questID) throw new Error("Quest dispatch requires a Quest binding; create or select a Quest before spawning work")
    const q = this.store.read(questID); if (!q) throw new Error(`Quest dispatch references unknown Quest ${questID}`)
    this.store.apply(questID, "session-planned", { ...input, callID: input.callID, taskID: input.taskID, role: redact(input.role ?? "worker", 100), deliverables: (input.deliverables ?? []).slice(0, 50), model: redact(input.model ?? "", 150), harness: redact(input.harness ?? "", 100), branch: input.branch, worktree: input.worktree })
    return { ...input, questID, role: input.role ?? input.agentRole ?? "worker", deliverables: input.deliverables ?? [] }
  }
  bind(questID: string, callID: string, sessionID: string) {
    if (!this.enabled) return
    return this.store.apply(questID, "session-bound", { callID, sessionID })
  }
  terminal(questID: string, callID: string, state: "completed" | "failed" | "cancelled", evidence?: string) { if (this.enabled) return this.store.apply(questID, "session-state", { callID, state, evidence }) }
  onTaskBefore(event: unknown): QuestDispatch | undefined {
    const ev = (event ?? {}) as Record<string, unknown>
    const input = taskInput(event)
    if (typeof input.questID !== "string") throw new Error("Quest dispatch requires questID")
    const identity = workerIdentityFromEvent(event)
    const quest = this.store.read(input.questID)
    if (!quest) throw new Error(`Quest dispatch references unknown Quest ${input.questID}`)
    const parentID = String(ev.sessionID ?? identity?.parentID ?? "")
    const continuationID = typeof input.sessionID === "string" ? input.sessionID : undefined
    if (continuationID) {
      const target = quest.sessions.find((session) => session.sessionID === continuationID || session.openCodeSessionId === continuationID)
      if (!target) throw new Error(`Quest dispatch session ${continuationID} is not bound to Quest ${input.questID}`)
      const parentIsLiveWorker = quest.sessions.some((session) => (session.sessionID === parentID || session.openCodeSessionId === parentID) && session.role === "worker" && !terminalSession(session.state))
      if (parentIsLiveWorker) throw new Error(`Quest dispatch continuation ${continuationID} violates Quest lineage: workers cannot spawn`)
      if (parentID && quest.integrationOwner !== parentID) this.store.apply(input.questID, "patched", { integrationOwner: parentID }, "quest:giver-bind")
      ev.questCallID = target.callID
      if (identity) identity.agentRole = "worker"
      this.store.apply(input.questID, "session-state", { callID: target.callID, state: "executing", evidence: "continued through Quest dispatch" }, "quest:dispatch-continuation")
      return { questID: input.questID, callID: target.callID, taskID: target.taskID, role: target.role, deliverables: target.deliverables, model: target.model, agentRole: "worker", providerID: target.providerID, modelID: target.modelID, reasoningEffort: target.reasoningEffort, fast: target.fast, runtime: target.runtime, runID: identity?.runID, task: identity?.task, parentID }
    }
    const parentIsWorker = quest.sessions.some((session) => (session.sessionID === parentID || session.openCodeSessionId === parentID) && session.role === "worker" && !terminalSession(session.state))
    if (parentIsWorker) throw new Error(`Quest ${input.questID} workers cannot spawn; the Quest giver dispatches work`)
    if (identity) identity.agentRole = "worker"
    if (parentID && quest.integrationOwner !== parentID) this.store.apply(input.questID, "patched", { integrationOwner: parentID }, "quest:giver-bind")
    return this.beforeDispatch({
      questID: input.questID,
      callID: taskCallID(event),
      taskID: String(input.taskID ?? ev.id ?? ev.callID ?? ""),
      role: "worker",
      deliverables: undefined,
      model: typeof input.model === "string" ? input.model : undefined,
      harness: typeof input.harness === "string" ? input.harness : undefined,
      branch: typeof input.branch === "string" ? input.branch : undefined,
      worktree: typeof input.worktree === "string" ? input.worktree : undefined,
      agentRole: identity?.agentRole,
      providerID: identity?.providerID,
      modelID: identity?.modelID,
      reasoningEffort: identity?.reasoningEffort,
      fast: identity?.fast,
      runtime: identity?.runtime,
      runID: identity?.runID,
      task: identity?.task ?? (typeof input.task === "string" ? input.task : undefined),
      parentID: identity?.parentID ?? parentID,
      scope: input.scope && typeof input.scope === "object" ? input.scope as Record<string, unknown> : undefined,
    })
  }
  deliversCompletion(completion: CompletionEvidence): boolean {
    if (!completion.questID || completion.questID === "unbound" || !completion.runID) return false
    return Boolean(this.store.read(completion.questID)?.sessions.some((session) => session.runID === completion.runID))
  }
  onCompletion(completion: CompletionEvidence, parkedDeliverySuppressed = false): "recorded" | "duplicate" | "parked" | undefined {
    if (!completion.questID || !this.enabled) return
    const quest = this.store.read(completion.questID)
    if (!quest) return
    const session = quest.sessions.find((candidate) => candidate.callID === completion.callID)
    const keys = Array.isArray(quest.extensions.completionKeys) ? quest.extensions.completionKeys.map(String) : []
    if (keys.includes(completion.idempotencyKey)) return session && ["completed", "failed", "cancelled", "missing", "stale"].includes(session.state) ? "duplicate" : undefined
    if (session?.state === "blocked" && session.dependency && session.dependency.status !== "resumed") {
      if (!parkedDeliverySuppressed) return "parked"
      this.store.apply(completion.questID, "session-state", { callID: completion.callID, state: "blocked", evidence: `Terminal ${completion.state} suppressed while dependency ${session.dependency.sessionID} owns ${session.dependency.file}`, completionKey: completion.idempotencyKey }, "orchestration:completion")
      return "parked"
    }
    const state = completion.state === "completed" ? "completed" : completion.state === "cancelled" ? "cancelled" : completion.state === "missing-result" || completion.state === "stopped" ? "missing" : "failed"
    this.store.apply(completion.questID, "session-state", { callID: completion.callID, state, evidence: completion.summary, result: noteReason(completion.summary), openCodeSessionId: completion.openCodeSessionId, runtimeSessionId: completion.runtimeSessionId, runID: completion.runID, providerID: completion.providerID, modelID: completion.modelID, reasoningEffort: completion.reasoningEffort, fast: completion.fast, completionKey: completion.idempotencyKey }, "orchestration:completion")
    this.applyWorkerReport(completion.questID, completion.summary)
    return "recorded"
  }

  applyWorkerReport(questID: string, text: string | undefined): number {
    if (!text) return 0
    const report = parseWorkerReport(text)
    if (!report.steps.length && !report.tests.length) return 0
    let applied = 0
    for (const step of report.steps) {
      try {
        const quest = this.store.read(questID)
        const target = quest ? findStep(quest, step.ref) : undefined
        if (!target) continue
        this.store.apply(questID, "stage-state", { stageID: target.id, status: step.status, evidence: step.evidence || undefined }, "quest:worker-report")
        applied++
      } catch (error) { console.error(`[quests] worker report step ${step.ref} failed:`, error) }
    }
    for (const test of report.tests) {
      try { this.store.apply(questID, "evidence-added", { kind: "tests", value: { command: test.command, result: test.result, at: new Date().toISOString() } }, "quest:worker-report"); applied++ } catch (error) { console.error("[quests] worker report tests failed:", error) }
    }
    try {
      const quest = this.store.read(questID)
      if (quest) {
        const remaining = quest.stages.filter((stage) => stage.status !== "done")
        const blocked = remaining.find((stage) => stage.status === "blocked")
        const next = remaining.find((stage) => stage.status === "working") ?? remaining[0]
        const nextAction = blocked ? `Unblock step ${blocked.id}` : next ? `Step ${quest.stages.indexOf(next) + 1}/${quest.stages.length}: ${next.title}` : "All steps done; verify evidence and turn in"
        this.store.apply(questID, "patched", { nextAction, ...(blocked ? { reason: `Step ${blocked.id} is blocked` } : {}) }, "quest:worker-report")
      }
    } catch {}
    return applied
  }
  onTaskAfter(event: unknown, output?: unknown) {
    const input = taskInput(event)
    const questID = typeof input.questID === "string" ? input.questID : undefined
    if (!questID) throw new Error("Quest dispatch completion is missing its Quest binding")
    const callID = taskCallID(event)
    const sessionID = taskSessionID(output, event)
    if (sessionID) { this.bind(questID, callID, sessionID); void this.identifyFromHost(questID, callID, sessionID) }
    const error = toolError(event, output)
    if (error) this.terminal(questID, callID, "failed", error)
    else if (this.enabled) this.store.apply(questID, "session-state", { callID, state: "executing", evidence: "subagent session started from canonical Quest" })
  }

  sessionIndex(): { get(sessionID: string): SessionRef | undefined } {
    return { get: (sessionID) => {
      if (!SESSION_ID.test(sessionID)) return
      const member = questMemberships(this.store, sessionID).find(({ quest, run, archived }) => !archived && quest.state !== "Archived" && !isReplayRun(run))
      return member && { questID: member.quest.id, session: member.run }
    } }
  }

  reconcileUnbound(_maxAgeMs = 30 * 60_000, _now = Date.now()): number {
    return 0
  }

  onHostEvent(event: unknown): "identified" | "settled" | undefined {
    if (!this.enabled) return
    const { type, data } = eventData(event)
    if (!type) return
    if (type === "message.updated") {
      const info = (data.info ?? {}) as Record<string, unknown>
      if (info.role !== "assistant" || typeof info.sessionID !== "string" || typeof info.modelID !== "string") return
      const ref = this.sessionIndex().get(info.sessionID)
      if (!ref) return
      const providerID = typeof info.providerID === "string" ? info.providerID : undefined
      const modelID = info.modelID
      if (ref.session.providerID === providerID && ref.session.modelID === modelID) return
      const model = providerID ? `${providerID}/${modelID}` : modelID
      this.store.apply(ref.questID, "session-state", { callID: ref.session.callID, state: ref.session.state, providerID, modelID, model, agentRole: typeof info.agent === "string" ? info.agent : undefined }, "host:message")
      return "identified"
    }
    if (type === "session.updated" || type === "session.created") {
      const info = (data.info ?? {}) as Record<string, unknown>
      const model = (info.model ?? {}) as Record<string, unknown>
      if (typeof info.id !== "string" || typeof model.providerID !== "string" || typeof model.id !== "string") return
      const ref = this.sessionIndex().get(info.id)
      if (!ref || (ref.session.providerID === model.providerID && ref.session.modelID === model.id)) return
      this.store.apply(ref.questID, "session-state", { callID: ref.session.callID, state: ref.session.state, providerID: model.providerID, modelID: model.id, model: `${model.providerID}/${model.id}` }, "host:session")
      return "identified"
    }
    if(type==="session.execution.interrupted"&&data.reason==="shutdown")return
    const terminal = HOST_TERMINAL[type]
    if (terminal && typeof data.sessionID === "string") {
      if(deferGoalTerminal(this.store.runtime,data.sessionID,()=>this.onHostEvent(event),String((event as any).id??data.executionID??'')))return
      const ref = this.sessionIndex().get(data.sessionID)
      if (!ref || !ACTIVE_SESSION.has(ref.session.state)) return
      if (ref.session.state === "blocked" && ref.session.dependency && ref.session.dependency.status !== "resumed") return
      const error = data.error as { message?: unknown; data?: { message?: unknown } } | string | undefined
      const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : typeof error?.data?.message === "string" ? error.data.message : undefined
      const said = message ?? (typeof data.reason === "string" && data.reason ? data.reason : undefined)
      const named = said?.trim() === HOST_STATEMENT_FAILURE ? describeHostStatementFailure(hostStatementCause(data.sessionID, this.options.hostLog)) : said
      const detail = named && namedRouteProvider(named, ref.session.providerID)
      const result = "Host reported execution " + type.split(".").pop() + (detail ? ": " + redact(detail, 2000) : "")
      if (terminal === "failed" && authUnavailable(said) && isClaudeRoute({ providerID: ref.session.providerID ?? "", modelID: ref.session.modelID ?? "" })) noteClaudeAuthUnavailable()
      const settling = this.settleWorker(data.sessionID,terminal,result,"host:execution",typeof data.observedAt==="string"?data.observedAt:undefined)
      if (!settling) return
      settling.catch(error => console.error("[quests] worker settlement failed", error))
      return "settled"
    }
  }
  async settleInterruptedDispatch(questID:string,runID:string,host:any) {
    const run=this.store.read(questID)?.sessions.find(s=>(s.runID??s.callID)===runID)
    const sessionID=run?.openCodeSessionId??run?.sessionID
    if(run?.state!=='planned'||!sessionID||typeof host.wait!=='function'||typeof host.context!=='function'||typeof host.get!=='function')return
    const {interruptedBoundDispatch}=await import('./dispatch-intent')
    const reason=interruptedBoundDispatch(this.store.runtime,runID,sessionID)
    if(!reason)return
    await boundedInspection(signal=>host.wait({sessionID},{signal}))
    const response=await boundedInspection(signal=>host.get({sessionID},{signal})),session=response?.data??response
    const context=await boundedInspection(()=>host.context({sessionID})),messages=context?.data??context
    if(session?.id!==sessionID||session?.outcome||!Array.isArray(messages)||messages.length)return
    if(typeof run.scope?.worktree!=='string'||typeof session.location?.directory!=='string'||physicalDirectory(session.location.directory)!==physicalDirectory(run.scope.worktree))return
    if(session.agent!==run.agentRole||session.model?.providerID!==run.providerID||session.model?.id!==run.modelID||run.reasoningEffort&&session.model?.variant!==run.reasoningEffort)return
    const fresh=this.store.read(questID)?.sessions.find(s=>(s.runID??s.callID)===runID)
    if(fresh?.state!=='planned'||(fresh.openCodeSessionId??fresh.sessionID)!==sessionID||interruptedBoundDispatch(this.store.runtime,runID,sessionID)!==reason)return
    return this.settleWorker(sessionID,'failed',reason+' Owning host confirmed the bound session is idle with no recorded messages. Dispatch did not complete; retained session, workspace and retry lineage.','quest:interrupted-dispatch')
  }
  private async landFinishedWork(questID:string,runID:string,workspaces:QuestWorkspaces) {
    const quest=this.store.read(questID),run=quest?.sessions.find(s=>(s.runID??s.callID)===runID)
    if(!quest||!run?.deliverables.length||run.scope?.readOnly===true)return
    if(run.deliverables.some(id=>quest.stages.find(step=>step.id===id)?.status!=="done"))return
    if(deliveryRefusal({questID,delivery:questWorkflow(quest).delivery,gate:'land'})){await this.landRun(questID,runID,workspaces);return}
    let review
    try{review=await timed({plugin:"quests",name:"return.review",op:runID},()=>reviewFinishedRun(this.store,questID,runID,workspaces))}
    catch(error){console.error("[quests] Could not review completed worker changes; landing them unreviewed",error)}
    if(review?.verdict==="rework")return
    await this.landRun(questID,runID,workspaces)
  }
  private async landRun(questID:string,runID:string,workspaces:QuestWorkspaces) {
    const quest=this.store.read(questID)
    if(!quest)return
    const landing=await whileLanding(runID,()=>workspaces.land(runID,{title:quest.title,body:quest.description,delivery:questWorkflow(quest).delivery}))
    if(!landing)return
    recordLanding(this.store,questID,runID,landing,workspaces.get(runID)?.root)
  }
  private settleWorker(sessionID:string,terminal:'completed'|'failed'|'cancelled',result:string,actor:string,observedAt?:string) {
    const ref=this.sessionIndex().get(sessionID)
    if(!ref||!ACTIVE_SESSION.has(ref.session.state))return
    return this.settleRun(ref.questID,ref.session,terminal,result,actor,observedAt)
  }
  settleRun(questID:string,session:QuestSession,terminal:'completed'|'failed'|'cancelled',result:string,actor:string,observedAt?:string):Promise<"settled"> {
    const key=session.runID??session.callID,pending=settlements()
    const held=pending.get(key)
    const run=()=>this.settle(questID,session,terminal,result,actor,observedAt)
    const settling:Promise<"settled">=(held?held.then(run,run):run()).finally(()=>{
      if(pending.get(key)===settling)pending.delete(key)
      for(const listener of [...settledListeners()])try{listener(key)}catch(error){console.error("[quests] settlement listener failed",error)}
    })
    pending.set(key,settling)
    return settling
  }
  private async settle(questID:string,session:QuestSession,terminal:'completed'|'failed'|'cancelled',result:string,actor:string,observedAt?:string):Promise<"settled"> {
    const runID=session.runID,sessionID=session.openCodeSessionId??session.sessionID
    if(actor==="host:execution"&&terminal!=="completed"&&sessionID&&await hostConfirmsRunning(this.sessionApi,sessionID,boundedInspection))return "settled"
    if(terminal==="completed"&&await timed({plugin:"quests",name:"return.report-check",op:runID},()=>askForReport(this.store,this.sessionApi as any,questID,session)))return "settled"
    const workspaces=new QuestWorkspaces(this.store.runtime)
    if(sessionID)releaseEndedRunLocks(this.store,this.sessionApi,sessionID,runID&&workspaces.lockID(runID))
    let failure:string|undefined
    const unfinished=(what:string,error:unknown)=>{const message=what+': '+(error instanceof Error?error.message:String(error));if(terminal==='completed')failure??=message;return message}
    if(runID){
      try{if(workspaces.get(runID)){await timed({plugin:"quests",name:"return.collect",op:runID},()=>driveAsync(workspaces.collectSteps(runID)));workspaces.releaseCollected(runID,this.store,result)}}
      catch(error){console.error("[quests] Could not collect completed worker changes",unfinished('Could not collect the worker changes',error))}
      if(terminal==="completed")try{blockUnreported(this.store,questID,session,workspaces.get(runID))}catch(error){console.error("[quests] Could not save unreported steps",unfinished('Could not save the unreported steps',error))}
      if(terminal==="completed")try{await timed({plugin:"quests",name:"return.land",op:runID},()=>this.landFinishedWork(questID,runID,workspaces))}catch(error){console.error("[quests] Could not land completed worker changes",unfinished('Could not land the worker changes',error))}
    }
    const current=this.store.read(questID)?.sessions.find(run=>run.callID===session.callID)
    const outcome=failure?'failed':terminal,text=failure??result
    if(!current||ACTIVE_SESSION.has(current.state))this.store.apply(questID, "session-state", { callID: session.callID, state: outcome, evidence: text, result: noteReason(text) }, actor)
    if (runID) {
      const file=dispatchReservationFile(this.store.runtime)
      if(existsSync(file))try{const ledger=new RouteReservations(file),reservation=ledger.get(runID),requests=sessionID?readSessionRequests(sessionID).records:[];const currency=reservation?.cash?.currency;const cash=currency&&requests.length&&requests.every(r=>r.completedAt!==undefined&&r.actualCharge?.currency===currency&&Number.isFinite(r.actualCharge.value)&&r.actualCharge.value>=0)?{currency,value:aggregateTelemetry(requests).actualCharges[currency]}:undefined;ledger.settle(runID,{state:"settled",completedAt:observedAt??new Date().toISOString(),cash})}catch(error){console.error("[quests] Could not settle route reservation",error)}
    }
    return "settled"
  }

}
export function releaseEndedRunLocks(store:QuestStore,host:unknown,sessionID:string,lockID?:string) {
  const inProcess=host&&typeof host==="object"?releaseWorkspaceLocks(host,sessionID):0
  const onDisk=!!lockID&&releaseLockHeldBy(store.runtime,"workspace-"+lockID,workspaceLockHolder(sessionID))
  return inProcess>0||onDisk
}
