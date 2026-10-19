import { questReference } from "./references"
import { questPullRequests } from '../board/detail-evidence'
import { questWorkflow } from "../runs/workflow"
import { nextQuestStep, questProgress } from "./steps"
import { latestSessionAttempts } from "../runs/session-lineage"
import type { Quest } from "../types"

export function questView(q: Quest) {
  const next = nextQuestStep(q)
  return {
    id: questReference(q), ref: questReference(q), title: q.title, description: q.description ?? q.objective, request: q.request ?? [], workflow: questWorkflow(q),
    project: q.project ?? null,
     steps: q.stages.map(s => ({ id: s.id, title: s.title, commandID: s.commandID, size: s.size, detail: s.detail, state: s.status, needs: s.needs, ...(s.claim?.include?.length ? { include: s.claim.include } : {}), blocker: s.blocker, resolution: s.resolution, note: s.note, checks: q.evidence.tests.filter(check => check.stepID === s.id), ...(s.attempts !== undefined ? { attempts: s.attempts } : {}), ...(s.deferred ? { deferred: s.deferred } : {}), })),
    progress: questProgress(q), nextStepID: next?.id ?? null,
    runs: latestSessionAttempts(q.sessions).map(s => ({ id: s.runID ?? s.callID, sessionRef: s.sessionRef, sessionTitle: s.sessionTitle, kind: s.agentRole === "command" ? "command" : "agent", sessionID: s.openCodeSessionId ?? s.sessionID, state: s.state, model: s.model, reasoning: s.reasoningEffort ?? null, fast: s.fast ?? null, attempt: s.attempt, routingNote:s.routingNote, result: s.result, updatedAt: s.updatedAt, history: q.sessions.filter(a => (a.resumeRoot ?? a.resumedFrom ?? a.callID) === (s.resumeRoot ?? s.resumedFrom ?? s.callID)).map(a => ({ id: a.runID ?? a.callID, state: a.state, result: a.result, model: a.model, attempt: a.attempt })) })),
    artifacts: q.evidence.artifacts, pullRequests: questPullRequests(q), reward: q.reward ?? q.usageInstructions.join("\n\n"),
    archive: q.archive ?? (q.state === "Archived" ? { at: q.updatedAt, reason: q.reason, accepted: false } : null),
  }
}
