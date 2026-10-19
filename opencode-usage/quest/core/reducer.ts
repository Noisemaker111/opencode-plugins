import { bounded, redact, redactSensitive } from "../privacy"
import { normalizeState } from "./state-machine"
import type { Quest, QuestEvent, QuestSession, SessionState } from "../types"
import { dependentStageIDs } from "./stages"
import { QUOTA_FAILOVER_PATTERN, terminalStepUpdates } from "../runs/session-lineage"
import { applyExtensionPatch } from "./extension-patch"
import { applyStagesPatch } from "./stage-patch"
import { currentActor } from "../config/registry.mts"

const terminalRank: Record<string, number> = { planned: 0, waiting: 1, executing: 2, blocked: 3, completed: 4, cancelled: 5, stale: 6, missing: 7, failed: 8 }
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"])
export { QUOTA_FAILOVER_PATTERN }
function mergeSessionState(oldState: SessionState, next: SessionState): SessionState {
  return terminalRank[next] >= terminalRank[oldState] ? next : oldState
}
const terminalState = (state: SessionState) => terminalRank[state] >= terminalRank.completed
function findSession(q: Quest, payload: any): QuestSession | undefined {
  if (payload.callID) return q.sessions.find((s) => s.callID === payload.callID)
  if (payload.sessionID) return q.sessions.find((s) => s.sessionID === payload.sessionID)
}

function sessionIdentity(payload: any) {
  return {
    parentID: payload.parentID || undefined,
    agentRole: redact(payload.agentRole ?? payload.role ?? "worker", 100),
    providerID: payload.providerID || undefined,
    generation: redactSensitive(payload.generation ?? '') || undefined,
    modelID: payload.modelID || undefined,
    reasoningEffort: REASONING_EFFORTS.has(payload.reasoningEffort) ? payload.reasoningEffort as QuestSession["reasoningEffort"] : undefined,
    fast: typeof payload.fast === "boolean" ? payload.fast : undefined,
    runtime: payload.runtime === "native" ? "native" as const : undefined,
    openCodeSessionId: payload.openCodeSessionId || undefined,
    runtimeSessionId: payload.runtimeSessionId || undefined,
    harnessSessionID: payload.harnessSessionID || undefined,
    runID: payload.runID || undefined,
    sessionRef: payload.sessionRef || undefined,
    sessionTitle: redactSensitive(payload.sessionTitle ?? "") || undefined,
    requestKey: payload.requestKey || undefined,
    task: redact(payload.task ?? "", 500) || undefined,
    scope: payload.scope && typeof payload.scope === "object" ? structuredClone(payload.scope) : undefined,
  }
}

export function reduceQuest(input: Quest, event: QuestEvent): Quest {
  if (event.questID !== input.id || input.appliedEventIDs.includes(event.eventID)) return input
  if (event.lifecycleEpoch !== input.lifecycleEpoch && !["reopen", "archive"].includes(event.type)) return input
  const cursor = input.eventCursors[event.source] ?? -1
  if (event.sourceSequence <= cursor) return input
  if (event.type === "snapshot") return structuredClone((event.payload as { quest: Quest }).quest)
  const q: Quest = { ...input, unresolvedWork: [...input.unresolvedWork] }
  const owned = new Set<keyof Quest>()
  const own = (key: keyof Quest) => { if (!owned.has(key)) { owned.add(key); (q as any)[key] = structuredClone(q[key]) } }
  const p: any = event.payload
  switch (event.type) {
    case "created": break
    case "patched": {
      const allowed = ["contractVersion","description","reward","request","project","archive","result","delivered","evidence","title","objective","priority","reason","nextAction","owner","integrationOwner","scope","relationships","deliverables","acceptanceCriteria","usageInstructions","stages","setbacks","claims","unresolvedWork","completionPolicy"]
      for (const key of allowed) if (key in p) (q as any)[key] = structuredClone(p[key])
      if (p.stagesPatch) q.stages = applyStagesPatch(q.stages, p.stagesPatch)
      if (p.evidencePatch) q.evidence = { ...q.evidence, ...structuredClone(p.evidencePatch) }
      if ("extensions" in p) q.extensions = structuredClone(p.extensions)
      if (p.extensionsPatch || p.extensionsRemoved) { own("extensions"); applyExtensionPatch(q.extensions, p.extensionsPatch ?? {}, p.extensionsRemoved) }
      for (const key of ["result", "delivered"] as const) if (p[key] === null) delete q[key]
      if ("archive" in p) {
        q.state = p.archive ? "Archived" : "Waiting"
        if (p.archive?.reason) q.reason = p.archive.reason
      }
      break
    }
    case "session-planned": {
      own("sessions")
      if (!q.sessions.some((s) => s.callID === p.callID)) q.sessions.push({ ...sessionIdentity(p), callID: p.callID, taskID: p.taskID, role: redact(p.role ?? p.agentRole ?? "worker", 100), model: p.model || undefined, harness: p.harness || undefined, branch: p.branch || undefined, worktree: p.worktree || undefined, state: "planned", evidence: [], deliverables: p.deliverables ?? [], attempt: p.attempt ?? 1, resumedFrom: p.resumedFrom, resumeRoot: p.resumeRoot ?? p.resumedFrom, updatedAt: event.at })
      break
    }
    case "session-claimed": {
      own("sessions")
      const existing = findSession(q, p)
      if (existing) { for (const [key, value] of Object.entries(sessionIdentity(p))) if (value !== undefined && (!["sessionRef","runID","requestKey"].includes(key) || !(existing as any)[key])) (existing as any)[key] = value; existing.taskID = p.taskID ?? existing.taskID; existing.harness = p.harness || existing.harness; existing.sessionID = p.sessionID ?? existing.sessionID; existing.model = p.model ?? existing.model; existing.state = mergeSessionState(existing.state, p.state === "planned" ? "planned" : "executing"); existing.updatedAt = event.at }
      else q.sessions.push({ ...sessionIdentity(p), callID: p.callID, taskID: p.taskID, sessionID: p.sessionID, role: redact(p.role ?? p.agentRole ?? "worker", 100), model: p.model || undefined, harness: p.harness || undefined, branch: p.branch || undefined, worktree: p.worktree || undefined, state: p.state === "planned" ? "planned" : "executing", evidence: [], deliverables: p.deliverables ?? [], attempt: p.attempt ?? 1, resumedFrom: p.resumedFrom, resumeRoot: p.resumeRoot, updatedAt: event.at })
      break
    }
    case "session-bound": {
      own("sessions")
      const s = findSession(q, p)
      if (s && (!s.sessionID || s.sessionID === p.sessionID)) { s.sessionID = p.sessionID; s.openCodeSessionId = p.openCodeSessionId ?? p.sessionID ?? s.openCodeSessionId; s.runtimeSessionId = p.runtimeSessionId ?? s.runtimeSessionId; if (s.state === "planned") s.state = "executing"; s.updatedAt = event.at }
      else if (s) { q.unresolvedWork.push(`conflicting exact bind for call ${s.callID}`) }
      break
    }
    case "session-state": {
      if (p.extensionsPatch) { own("extensions"); applyExtensionPatch(q.extensions, p.extensionsPatch, p.extensionsRemoved) }
      own("sessions")
      const s = findSession(q, p)
      if(s&&p.permissionDecision){const decision=p.permissionDecision;const actor=currentActor(decision.actor);if(['once','reject'].includes(decision.reply)&&['sending','acknowledged','unknown'].includes(decision.state)&&actor&&typeof decision.requestID==='string')s.permissionDecisions=bounded([...(s.permissionDecisions??[]).filter(d=>d.requestID!==decision.requestID),{...decision,actor,reason:redact(String(decision.reason??''),1500)}])}
      if(s && p.refusalReplied === true && s.state === "failed") s.refusalReplied = true
      if(s && p.preserveTerminal && ["completed","failed","cancelled"].includes(s.state)){if(p.evidence){const line=redact(p.evidence);if(!s.evidence.includes(line))s.evidence=bounded([...s.evidence,line])}break}
      if (!s) q.unresolvedWork.push(`missing exact session link for ${p.callID ?? p.sessionID ?? "unknown"}`)
      else {
        s.state = p.state === "waiting" && !terminalState(s.state) ? "waiting" : mergeSessionState(s.state, p.state)
        if(typeof p.routingNote==="string")s.routingNote=redact(p.routingNote,1000)
        if(typeof p.expectedFinishMs==="number"&&Number.isFinite(p.expectedFinishMs)&&p.expectedFinishMs>0)s.expectedFinishMs=p.expectedFinishMs
        if (p.state === "failed" && QUOTA_FAILOVER_PATTERN.test(`${p.evidence ?? ""} ${p.result ?? ""}`)) s.quotaExhausted = true
        if (typeof p.providerID === "string" && p.providerID) s.providerID = p.providerID
        if (typeof p.modelID === "string" && p.modelID) s.modelID = p.modelID
        if (typeof p.model === "string" && p.model) s.model = p.model
        if (REASONING_EFFORTS.has(p.reasoningEffort)) s.reasoningEffort = p.reasoningEffort
        if (typeof p.fast === "boolean") s.fast = p.fast
        if (typeof p.agentRole === "string" && p.agentRole && !s.agentRole) s.agentRole = redact(p.agentRole, 100)
        if (typeof p.task === "string" && p.task && !s.task) s.task = redact(p.task, 500)
        if (p.awaiting === null) delete s.awaiting
        else if (p.awaiting && typeof p.awaiting.requestID === "string" && typeof p.awaiting.ask === "string") s.awaiting = { requestID: p.awaiting.requestID, ask: redact(p.awaiting.ask, 2000), ...(p.awaiting.reason ? { reason: redact(String(p.awaiting.reason), 1000) } : {}), at: event.at }
        if (p.evidence && !s.evidence.includes(redact(p.evidence))) s.evidence = bounded([...s.evidence, redact(p.evidence)]); if (p.heartbeatAt) s.lastHeartbeatAt = p.heartbeatAt; if (p.leaseExpiresAt) s.leaseExpiresAt = p.leaseExpiresAt; if (p.commandSummary) s.commandSummary = redact(p.commandSummary); if (p.result) s.result = redact(p.result); if (p.openCodeSessionId) { s.openCodeSessionId = p.openCodeSessionId; s.sessionID = s.openCodeSessionId }; if (p.runtimeSessionId) s.runtimeSessionId = p.runtimeSessionId; if (p.runID && !s.runID) s.runID = p.runID; if (p.dependency) s.dependency = structuredClone(p.dependency); s.updatedAt = event.at
      }
      const updates = terminalStepUpdates(q)
      if (updates.length) own("stages")
      for (const update of updates) {
        const step = q.stages.find(step => step.id === update.stageID)!
        step.status = update.status; step.note = update.evidence
        if (update.status !== "blocked") delete step.needsJon; else if (update.needsJon) step.needsJon = update.needsJon
      }
      break
    }
    case "session-removed": {
      const session = findSession(q, p)
      if (session) q.sessions = q.sessions.filter((candidate) => candidate.callID !== session.callID)
      break
    }
    case "deliverable-state": {
      own("deliverables")
      const d = q.deliverables.find((x) => x.id === p.id); if (d) { d.status = p.status; if (p.evidence) d.evidence = bounded([...(d.evidence ?? []), redact(p.evidence)]) }
      else q.unresolvedWork.push(`unknown deliverable ${p.id}`)
      break
    }
    case "stage-state": {
      own("stages")
      const stage = q.stages.find((candidate) => candidate.id === p.stageID)
      const todo = stage?.todos.find((candidate) => candidate.id === p.todoID)
      if (!stage) q.unresolvedWork.push(`unknown stage ${p.stageID}`)
      else if (p.todoID && !todo) q.unresolvedWork.push(`unknown stage todo ${p.stageID}/${p.todoID}`)
      else if (todo) { todo.status = p.status; if (p.evidence) todo.evidence = bounded([...(todo.evidence ?? []), redact(p.evidence)]) }
      else { stage.status = p.status; if (typeof p.evidence === "string") stage.note = redact(p.evidence, 20000); if (p.status !== "blocked") delete stage.needsJon; else if (p.needsJon) stage.needsJon = p.needsJon }
      break
    }
    case "proof-added": {
      own("stages"); own("setbacks")
      const stage = q.stages.find((candidate) => candidate.id === p.stageID)
      if (!stage) { q.unresolvedWork.push(`unknown stage ${p.stageID}`); break }
      const proof = structuredClone(p.proof)
      stage.proofs = [...stage.proofs.filter((candidate) => candidate.id !== proof.id), proof]
      if (proof.kind === "judgment" && proof.verdict === "FAIL") {
        const rewindID = q.stages.some((candidate) => candidate.id === proof.rewindTo) ? proof.rewindTo : stage.id
        const reset = dependentStageIDs(q.stages, rewindID)
        q.setbacks.push({ stageID: stage.id, proofID: proof.id, verdict: "FAIL", reason: redact(proof.reason || "Judgment failed"), attempt: proof.attempt, at: proof.at, rewindTo: proof.rewindTo })
        for (const candidate of q.stages) if (reset.has(candidate.id)) {
          candidate.status = "pending"
          candidate.attempt = Math.max(candidate.attempt + 1, proof.attempt + 1)
          for (const todo of candidate.todos) todo.status = "pending"
        }
        q.reason = `Stage ${stage.id} failed judgment: ${redact(proof.reason || "No reason supplied", 300)}`
        q.nextAction = `Retry ${rewindID}; attempt ${q.stages.find((candidate) => candidate.id === rewindID)?.attempt ?? proof.attempt + 1} includes the setback reason`
      }
      break
    }
    case "evidence-added": {
      own("evidence")
      if (p.kind === "review") q.evidence.review = p.value
      else if (["commits","tests","builds","artifacts","publish"].includes(p.kind)) (q.evidence as any)[p.kind] = bounded([...(q.evidence as any)[p.kind], p.value])
      break
    }
    case "complete": q.state = "Complete"; q.reason = "Explicitly completed after atomic policy recheck"; q.nextAction = "Archive when no longer active"; break
    case "archive": q.state = "Archived"; q.reason = p.reason ?? "Archived"; q.nextAction = "Reopen to resume work"; break
    case "reopen": q.lifecycleEpoch++; q.abandoned = false; q.state = "Waiting"; q.reason = p.reason ?? "Reopened for additional work"; q.nextAction = p.nextAction ?? "Assign an exact execution session"; break
    case "abandon": q.abandoned = true; q.state = "Archived"; q.reason = p.reason ?? "Abandoned"; q.nextAction = "Reopen only if work should resume"; break
    case "delete": q.state = "Archived"; q.reason = p.reason ?? "Deleted"; q.nextAction = "Deleted records cannot be reopened"; break
  }
  if (p.completionKey) {
    own("extensions")
    const prior = Array.isArray(q.extensions.completionKeys) ? q.extensions.completionKeys.map(String) : []
    q.extensions.completionKeys = bounded([...new Set([...prior, p.completionKey])], 2000)
    q.notificationCursor = p.completionKey
  }
  q.eventCursors = { ...input.eventCursors, [event.source]: event.sourceSequence }
  q.appliedEventIDs = bounded([...q.appliedEventIDs, event.eventID], 2000)
  if (["session-claimed", "session-bound", "session-state"].includes(event.type)) {
    const session = findSession(q, p)
    if (session?.state === "executing" && !session.startedAt && findSession(input, p)?.state !== "executing") session.startedAt = event.at
  }
  q.history = bounded([...q.history, { eventID: event.eventID, at: event.at, type: event.type, lifecycleEpoch: q.lifecycleEpoch, summary: redact(p.summary ?? event.type, 200) }], 1000)
  q.revision++; q.updatedAt = event.at
  return normalizeState(q)
}
