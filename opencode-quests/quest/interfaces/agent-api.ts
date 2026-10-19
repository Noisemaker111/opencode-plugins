import { questReference } from '../core/references'
import { SessionReferences } from '../host/session-references'
import { hydrateSessionReferences, resolveRunReference } from '../host/session-projection'
import { readAllQuests } from "../index"
import { questRoot } from "../root.mts"
import { QuestStore } from "../store"
import { QuestTracker } from "../runs/tracker"
import { requestFingerprint } from "../privacy"
import { exactFingerprintMatch } from "../runs/duplicates"
import { inferQuestKind } from "../core/schema"
import { questLane, summarizeBoard } from "../board/board"
import { admissionRecords } from "../runs/start-request"
import { runQuestCommand } from "./commands"
import { acquireLock } from "../locking.mts"
import { claimMatches } from "../core/claims"
import { findStep, looksLikeTranscript, stagesFromSteps, stepsFromObjective, type StepInput } from "../core/steps"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { appendLedger } from "../../orchestration/orchestration-ledger"
import { ensureQuestAssetsDir, normalizeArtifact, buildCaptureArtifact, type CaptureInput } from "../artifacts/artifacts"
import type { Quest, QuestStageStatus } from "../types"

export type QuestQuery = { search?: string; state?: string; sessionID?: string; taskID?: string; lane?: string; includeArchived?: boolean; limit?: number }
export type QuestCreateInput = Partial<Quest> & Pick<Quest, "title" | "objective"> & { id?: string; requestFingerprint?: string; steps?: StepInput[] }

const STEP_STATUSES = new Set<QuestStageStatus>(["pending", "working", "blocked", "done"])

function withSteps(input: QuestCreateInput): Omit<QuestCreateInput, "steps"> {
  const { steps, ...rest } = input
  if (looksLikeTranscript(rest.title) || (rest.objective !== rest.title && /^\s*<(?:subagent|task|conversation-checkpoint)\b/i.test(rest.objective))) {
    throw new Error("Refusing to create a Quest from a transcript, tool result or subagent notification; describe the outcome Jk wants instead")
  }
  if (Array.isArray(steps) && steps.length) return { ...rest, stages: stagesFromSteps(steps, rest.scope ? { scope: rest.scope } : undefined) }
  if (rest.stages?.length || rest.deliverables?.length) return rest
  const derived = stepsFromObjective(rest.objective)
  return derived.length ? { ...rest, stages: stagesFromSteps(derived, rest.scope ? { scope: rest.scope } : undefined) } : rest
}

export function createQuestAgentAPI(projectRoot = questRoot(), sessionApi?: { synthetic?: Function }, ledgerFile?: string) {
  const store = new QuestStore(projectRoot)
  const sessionIdentity = (ref: string) => ['opencode','codex'].map(source=>new SessionReferences(store.runtime).get(ref,source)?.sessionID).find(Boolean) ?? ref
  const list = (query: QuestQuery = {}) => readAllQuests(projectRoot, { includeArchived: true }).flatMap(({ quest }) => quest ? [quest] : []).filter((q) => {
    const text = `${q.id} ${questReference(q)} ${q.title} ${q.objective} ${q.reason} ${q.nextAction}`.toLowerCase()
    return (!query.search || text.includes(query.search.toLowerCase())) && (!query.state || q.state === query.state) && (!query.sessionID || q.sessions.some((s) => s.sessionID === sessionIdentity(query.sessionID) || s.openCodeSessionId === query.sessionID || s.runtimeSessionId === query.sessionID)) && (!query.taskID || q.sessions.some((s) => s.taskID === query.taskID)) && (!query.lane || questLane(q) === query.lane)
  })
  const get = (id: string) => store.read(id)
  const require = (id: string): Quest => {
    const current = store.read(id)
    if (!current) throw new Error(`Quest not found: ${id}`)
    return current
  }
  const admit = (input: QuestCreateInput) => {
    const prepared = withSteps(input)
    return store.admit({ ...prepared, kind: prepared.kind ?? inferQuestKind(prepared.title, prepared.objective), requestFingerprint: prepared.requestFingerprint ?? requestFingerprint({ title: prepared.title, objective: prepared.objective }) })
  }
  const create = (input: QuestCreateInput) =>
    input.id ? store.create(withSteps(input) as Partial<Quest> & Pick<Quest, "id" | "title" | "objective">) : admit(input)
  const admitIntake = (input: QuestCreateInput): { outcome: "created" | "existing"; quest: Quest } => {
    const prepared = withSteps(input)
    const fingerprint = prepared.requestFingerprint ?? requestFingerprint({ title: prepared.title, objective: prepared.objective })
    const priorMatch = exactFingerprintMatch(list(), fingerprint)
    const quest = store.admit({ ...prepared, kind: prepared.kind ?? inferQuestKind(prepared.title, prepared.objective), requestFingerprint: fingerprint })
    return { outcome: priorMatch?.id === quest.id ? "existing" : "created", quest }
  }
  const update = (id: string, patch: Record<string, unknown>) => {
    const { steps, ...rest } = patch
    if (Array.isArray(steps)) rest.stages = stagesFromSteps(steps as StepInput[], require(id))
    return store.apply(id, "patched", rest)
  }
  const plan = (id: string, steps: StepInput[], mode: "replace" | "append" = "replace") => {
    const current = require(id)
    if (!Array.isArray(steps) || !steps.length) throw new Error("plan requires input.steps: a non-empty list of step titles or { title, todos }")
    const fresh = stagesFromSteps(steps, current)
    const stages = mode === "append"
      ? [...current.stages, ...fresh.filter((stage) => !current.stages.some((prior) => prior.id === stage.id))]
      : fresh.map((stage) => {
        const prior = current.stages.find((candidate) => candidate.id === stage.id)
        return prior ? { ...stage, status: prior.status, proofs: prior.proofs, attempt: prior.attempt, todos: stage.todos.length ? stage.todos : prior.todos } : stage
      })
    const next = stages.find((stage) => stage.status !== "done")
    return store.apply(id, "patched", { stages, nextAction: next ? `Step ${stages.indexOf(next) + 1}/${stages.length}: ${next.title}` : current.nextAction })
  }
  const step = (id: string, ref: string | number, status: string, value?: string) => {
    const current = require(id)
    if (!STEP_STATUSES.has(status as QuestStageStatus)) throw new Error(`step state must be one of pending, working, blocked, done (got ${String(status)})`)
    const target = findStep(current, ref)
    if (!target) throw new Error(`Quest step not found: ${String(ref)}. Steps: ${current.stages.map((stage, index) => `${index + 1}=${stage.id}`).join(", ") || "none (call plan first)"}`)
    const updated = store.apply(id, "stage-state", { stageID: target.id, status, evidence: value })
    const remaining = updated.stages.filter((stage) => stage.status !== "done")
    const next = remaining.find((stage) => stage.status === "working") ?? remaining[0]
    const nextAction = status === "blocked" ? `Unblock step ${target.id}: ${value ?? "see step evidence"}` : next ? `Step ${updated.stages.indexOf(next) + 1}/${updated.stages.length}: ${next.title}` : "All steps done; verify evidence and turn in"
    return store.apply(id, "patched", { nextAction, ...(status === "blocked" ? { reason: `Step ${target.id} is blocked` } : {}) })
  }
  const claim = (id: string, input: { callID: string; taskID: string; sessionID?: string; parentID?: string; role: string; model?: string; scope?: Record<string, unknown>; deliverables?: string[]; resumeRoot?: string }) => {
    require(id)
    return store.apply(id, "session-claimed", input)
  }
  const assign = (id: string, input: Parameters<typeof claim>[1]) => claim(id, input)
  const unassign = (id: string, callID: string) => store.apply(id, "session-state", { callID, state: "waiting", evidence: "assignment released explicitly" })
  const accept = (id: string, args: Record<string, unknown> = {}) => runQuestCommand(store, "accept", id, args)
  const execute = (id: string, args: Record<string, unknown> = {}) => runQuestCommand(store, "execute", id, args)
  const startSession = (id: string, args: Record<string, unknown>) => runQuestCommand(store, "start-session", id, args)
  const complete = (id: string) => runQuestCommand(store, "complete", id)
  const turnIn = (id: string, reason?: string) => runQuestCommand(store, "turn-in", id, { reason })
  const abandon = (id: string, reason?: string) => runQuestCommand(store, "abandon", id, { reason })
  const archive = (id: string, reason?: string) => runQuestCommand(store, "archive", id, { reason })
  const reopen = (id: string, reason?: string) => runQuestCommand(store, "reopen", id, { reason })
  const deleteQuest = (id: string, confirmed = false) => store.delete(id, confirmed)
  const view = (id: string) => runQuestCommand(store, "view", id)
  const status = (id: string) => get(id)
  const history = (id: string) => get(id)?.history ?? []
  const evidence = (id: string, kind: "commits" | "tests" | "builds" | "artifacts" | "publish" | "review", value: unknown) => {
    if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
      try { value = JSON.parse(value) } catch {}
    }
    id = require(id).id
    if (kind === "artifacts") {
      ensureQuestAssetsDir(projectRoot, id)
      value = normalizeArtifact(value)
    }
    return store.apply(id, "evidence-added", { kind, value })
  }
  const report = (id: string, text: string | undefined) => {
    id = require(id).id
    const applied = new QuestTracker(store).applyWorkerReport(id, text)
    return { applied, quest: get(id) }
  }
  const progress = (id: string, callID: string, value: string, state: "executing" | "waiting" | "blocked" | "completed" | "failed" | "cancelled" = "executing", commandSummary?: string) => store.apply(id, "session-state", { callID, state, evidence: value, heartbeatAt: new Date().toISOString(), commandSummary })
  const heartbeat = (id: string, callID: string, leaseMs = 60_000) => store.apply(id, "session-state", { callID, state: "executing", heartbeatAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString() })
  const stage = (id: string, stageID: string, status: string, todoID?: string, value?: string) => store.apply(id, "stage-state", { stageID, todoID, status, evidence: value })
  const proof = (id: string, stageID: string, value: Record<string, unknown>) => {
    const current = store.read(id)
    const target = current?.stages.find((candidate) => candidate.id === stageID)
    if (!target) throw new Error(`Quest stage not found: ${id}/${stageID}`)
    const at = typeof value.at === "string" ? value.at : new Date().toISOString()
    const attempt = Number.isSafeInteger(value.attempt) ? Number(value.attempt) : target.attempt
    const proofID = typeof value.id === "string" && value.id ? value.id : `${stageID}:${String(value.kind)}:${attempt}:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12)}`
    return store.apply(id, "proof-added", { stageID, proof: { ...value, id: proofID, at, attempt } })
  }
  const park = (id: string, input: { callID: string; blockerSessionID: string; file: string; reason: string }) => {
    const current = require(id)
    id = current.id
    input = { ...input, blockerSessionID: sessionIdentity(input.blockerSessionID), callID: current.sessions.find(run => (run.runID ?? run.callID) === resolveRunReference(store, current, input.callID))?.callID ?? input.callID }
    const session = current.sessions.find((candidate) => candidate.callID === input.callID)
    if (!current || !session) throw new Error(`Quest session not found: ${id}/${input.callID}`)
    const sessionID = session.openCodeSessionId ?? session.sessionID
    if (!sessionID || !(session.parentID ?? session.parentSessionID) || !session.model || !session.scope) throw new Error("Parking requires the exact sessionID, parentID, model, and scope to be persisted")
    const blockerOwnsFile = list().some((quest) => quest.claims.some((claim) => claim.state === "active" && claim.sessionID === input.blockerSessionID && claimMatches(claim, resolve(claim.repo, input.file))))
    if (!blockerOwnsFile) throw new Error(`No active claim for ${input.blockerSessionID} owns ${input.file}`)
    const resumeKey = `${id}:${input.callID}:${input.blockerSessionID}:${input.file}`
    if (session.dependency?.resumeKey === resumeKey && session.dependency.status !== "failed") return current
    const dependency = { sessionID: input.blockerSessionID, file: input.file, reason: input.reason, status: "blocked" as const, resumeKey, resumeCount: session.dependency?.resumeCount ?? 0 }
    store.apply(id, "session-state", { callID: input.callID, state: "blocked", dependency, heartbeatAt: new Date().toISOString(), evidence: `Blocked by ${input.blockerSessionID} owning ${input.file}: ${input.reason}` }, "quest:dependency")
    return store.apply(id, "patched", { reason: 'Another worker still owns the file this step needs.', nextAction: `Wait for ${input.file} to be handed back, then continue this worker.` }, "quest:dependency")
  }
  const handoff = async (input: { sessionID: string; reason?: string }) => {
    input = { ...input, sessionID: sessionIdentity(input.sessionID) }
    for (const quest of list()) {
      const claims = quest.claims.map((claim) => claim.sessionID === input.sessionID && claim.state === "active" ? { ...claim, state: "released" as const } : claim)
      if (claims.some((claim, index) => claim !== quest.claims[index])) store.apply(quest.id, "patched", { claims }, "quest:handoff")
    }
    const resumed: Quest[] = []
    for (const quest of list()) for (const candidate of quest.sessions) {
      if (candidate.state !== "blocked" || candidate.dependency?.sessionID !== input.sessionID || candidate.dependency.status === "resumed") continue
      const lock = acquireLock(store.runtime, `resume-${quest.id}-${candidate.callID}`)
      let session = candidate
      let resumeCallID = ""
      let resumeParentID = ""
      let resumeMessageID = ""
      try {
        const fresh = store.read(quest.id)?.sessions.find((entry) => entry.callID === candidate.callID)
        if (!fresh || fresh.state !== "blocked" || fresh.dependency?.sessionID !== input.sessionID || fresh.dependency.status === "resumed") continue
        session = fresh
        const token = createHash("sha256").update(fresh.dependency.resumeKey).digest("hex").slice(0, 24)
        resumeMessageID = `msg_${token}`
        const allSessions = store.read(quest.id)?.sessions ?? []
        const priorAttempts = allSessions.filter((entry) => entry.resumedFrom === fresh.callID)
        const inFlight = fresh.dependency.status === "resuming" ? priorAttempts.findLast((entry) => !["completed", "failed", "cancelled", "missing", "stale"].includes(entry.state)) : undefined
        if (inFlight && fresh.dependency.resumeLeaseExpiresAt && Date.parse(fresh.dependency.resumeLeaseExpiresAt) > Date.now()) continue
        resumeCallID = inFlight?.callID ?? `resume-${token}${priorAttempts.length ? `-${priorAttempts.length + 1}` : ""}`
        const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString()
        const dependency = { ...fresh.dependency, status: "resuming" as const, resumeLeaseExpiresAt: leaseExpiresAt }
        store.apply(quest.id, "session-state", { callID: fresh.callID, state: "blocked", dependency, evidence: `Dependency handoff received from ${input.sessionID}` }, "quest:handoff")
        const exactSessionID = fresh.openCodeSessionId ?? fresh.sessionID!
        resumeParentID = fresh.parentID ?? fresh.parentSessionID!
        if (!inFlight) {
          appendLedger({ kind: "spawn", parentID: resumeParentID, callID: resumeCallID, childID: exactSessionID, agent: fresh.agentRole, agentRole: fresh.agentRole, providerID: fresh.providerID, modelID: fresh.modelID, reasoningEffort: fresh.reasoningEffort, fast: fresh.fast, runtime: fresh.runtime ?? "native", runID: resumeCallID, task: fresh.task, questID: quest.id, role: fresh.role, deliverables: fresh.deliverables }, ledgerFile)
          appendLedger({ kind: "bound", parentID: resumeParentID, callID: resumeCallID, childID: exactSessionID, runtime: fresh.runtime ?? "native", openCodeSessionId: exactSessionID, runID: resumeCallID }, ledgerFile)
          store.apply(quest.id, "session-claimed", { callID: resumeCallID, taskID: fresh.taskID, sessionID: exactSessionID, openCodeSessionId: fresh.openCodeSessionId, runtimeSessionId: fresh.runtimeSessionId, parentID: fresh.parentID ?? fresh.parentSessionID, role: fresh.role, model: fresh.model, scope: fresh.scope, harness: fresh.harness, agentRole: fresh.agentRole, providerID: fresh.providerID, modelID: fresh.modelID, reasoningEffort: fresh.reasoningEffort, fast: fresh.fast, runtime: fresh.runtime, runID: resumeCallID, task: fresh.task, deliverables: fresh.deliverables, resumedFrom: fresh.callID, resumeRoot: fresh.resumeRoot ?? fresh.callID, attempt: fresh.attempt + priorAttempts.length + 1 }, "quest:handoff")
        }
      } finally { lock.release() }
      const exactSessionID = session.openCodeSessionId ?? session.sessionID
      try {
        if (!exactSessionID || typeof sessionApi?.synthetic !== "function") throw new Error("session.synthetic unavailable for exact-session resume")
        await sessionApi.synthetic({
          sessionID: exactSessionID,
          messageID: resumeMessageID,
          text: `${session.dependency!.file} has been handed back. ${input.reason ?? 'Continue the same assigned work from where you stopped.'}`,
          metadata: { kind: "quest.dependency-resume", idempotencyKey: resumeMessageID, questID: quest.id, callID: resumeCallID, resumedFrom: session.callID, model: session.model, scope: session.scope, dependency: session.dependency },
        })
        const dependency = { ...session.dependency!, status: "resumed" as const, resumedAt: new Date().toISOString(), resumeCount: session.dependency!.resumeCount + 1, resumeLeaseExpiresAt: undefined }
        store.apply(quest.id, "session-state", { callID: session.callID, state: "waiting", dependency, evidence: `Continued as ${resumeCallID} in exact session ${exactSessionID}` }, "quest:handoff")
        store.apply(quest.id, "session-state", { callID: resumeCallID, state: "executing", heartbeatAt: new Date().toISOString(), evidence: `Automatically resumed exact session ${exactSessionID}` }, "quest:handoff")
        resumed.push(store.apply(quest.id, "patched", { reason: 'The other worker handed the file back.', nextAction: 'Continue the same assigned work.' }, "quest:handoff"))
      } catch (error) {
        const dependency = { ...session.dependency!, status: "failed" as const, resumeLeaseExpiresAt: undefined }
        if (resumeCallID && resumeParentID && exactSessionID) appendLedger({ kind: "terminal", parentID: resumeParentID, callID: resumeCallID, childID: exactSessionID, state: "failed" }, ledgerFile)
        if (resumeCallID) try { store.apply(quest.id, "session-state", { callID: resumeCallID, state: "failed", evidence: `Automatic continuation delivery failed: ${String(error)}` }, "quest:handoff") } catch {}
        store.apply(quest.id, "session-state", { callID: session.callID, state: "blocked", dependency, evidence: `Automatic resume failed: ${String(error)}` }, "quest:handoff")
      }
    }
    return resumed
  }
  const mappings = (query: { questID?: string; paths?: string[]; verbose?: boolean } = {}) => {
    const questID = query.questID ? require(query.questID).id : undefined
    const quests = list().filter((q) => !questID || q.id === questID)
    hydrateSessionReferences(store, quests)
    const claimQuests = query.paths?.length ? list() : quests
    hydrateSessionReferences(store, claimQuests)
    const sessionQuests = query.paths?.length && !query.questID ? [] : quests
    return {
      sessions: sessionQuests.flatMap((q) => q.sessions.filter((s) => query.verbose || ["planned", "executing", "waiting", "blocked"].includes(s.state)).map((s) => ({ questID: questReference(q), callID: s.callID, sessionID: s.sessionRef ?? s.openCodeSessionId ?? s.sessionID, model: s.model, state: s.state, ...(query.verbose ? { taskID: s.taskID, scope: s.scope, heartbeat: s.lastHeartbeatAt, dependency: s.dependency, nextAction: q.nextAction } : {}) }))),
      activeClaims: claimQuests.flatMap((q) => q.claims.filter((claim) => claim.state === "active" && (!query.paths?.length || query.paths.some((path) => claimMatches(claim, resolve(claim.repo, path))))).map((claim) => query.verbose || query.paths?.length
        ? { questID: questReference(q), sessionID: new SessionReferences(store.runtime).get(claim.sessionID)?.ref ?? claim.sessionID, repo: claim.repo, include: claim.include, exclude: claim.exclude, state: claim.state }
        : { questID: questReference(q), sessionID: new SessionReferences(store.runtime).get(claim.sessionID)?.ref ?? claim.sessionID, repo: claim.repo, patterns: claim.include.slice(0, 2), more: Math.max(0, claim.include.length - 2), state: claim.state })),
    }
  }
  const board = (query: QuestQuery = {}) => summarizeBoard(list(query), query.lane, query.includeArchived === true, Math.max(1, Math.min(query.limit ?? 12, 100)), admissionRecords(store))
  const captureArtifact = (id: string, input: CaptureInput) => {
    id = require(id).id
    const artifact = buildCaptureArtifact(projectRoot, id, input)
    return store.apply(id, "evidence-added", { kind: "artifacts", value: artifact })
  }
  return { store, list, search: list, get, view, create, admit, admitIntake, prepend: admit, update, plan, step, report, claim, assign, unassign, accept, execute, startSession, complete, turnIn, abandon, archive, reopen, delete: deleteQuest, status, history, evidence, captureArtifact, progress, heartbeat, stage, proof, park, handoff, mappings, board }
}
