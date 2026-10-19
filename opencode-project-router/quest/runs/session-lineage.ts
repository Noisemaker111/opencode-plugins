import type { Quest, QuestSession } from "../types"
import { plainWords } from '../review/plain-words'
import { reworkRequested } from '../review/review-record'

export const QUOTA_FAILOVER_PATTERN = /usage reached[\s\S]{0,400}?(falling over|no healthy failover|paused until the window resets)/i

export function isSessionQuotaExhausted(session: QuestSession): boolean {
  if (session.quotaExhausted) return true
  if (session.state !== "failed") return false
  return QUOTA_FAILOVER_PATTERN.test(`${session.evidence?.join(" ") ?? ""} ${session.result ?? ""}`)
}

export const OWNED_RUN: ReadonlySet<string> = new Set(["planned", "executing", "waiting", "blocked"])

export const TERMINAL_RUN: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "missing", "stale"])
export const isTerminalSession = (state: string) => TERMINAL_RUN.has(state)

export function latestSessionAttempts(sessions: QuestSession[]): QuestSession[] {
  const latest = new Map<string, QuestSession>()
  for (const session of sessions) {
    const root = session.resumeRoot ?? session.resumedFrom ?? session.callID
    const prior = latest.get(root)
    if (!prior || session.attempt > prior.attempt || (session.attempt === prior.attempt && session.updatedAt > prior.updatedAt)) latest.set(root, session)
  }
  return [...latest.values()]
}

export const RECONCILED_NOTE=/^(Run recorded (missing|stale)|Recorded working with no run|Worker (completed|failed|cancelled) without saving this step|No worker started this step|The worker (stopped|ended) without saving this step)/
export function terminalStepUpdates(q: import('../types').Quest) {
  return q.stages.flatMap((step): { stageID: string; status: 'pending' | 'blocked'; evidence: string; needsJon?: 'choice' }[] => {
    if (step.status !== 'working') return []
    const runs = q.sessions.filter(run => run.deliverables.includes(step.id))
    const latest = runs.at(-1)
    const settled = !!latest && TERMINAL_RUN.has(latest.state) && !runs.some(run => !TERMINAL_RUN.has(run.state))
    if (latest && settled && latest.awaiting && latest.state !== 'completed') return [{ stageID: step.id, status: 'blocked' as const, needsJon: 'choice' as const,
      evidence: `The worker stopped while waiting for the user to allow or reject: ${plainWords(latest.awaiting.ask)}. Its checkout stays in place. Start this step again once the user answers.` }]
    if (!latest) return [{ stageID: step.id, status: 'pending' as const,
      evidence: 'No worker started this step. Start it when its earlier steps are finished.' }]
    if (!settled) return []
    return [{ stageID: step.id, status: 'pending' as const,
      evidence: latest && lostToInfrastructure(latest)
        ? 'The worker ended without saving this step as done after a host or model error. Start this step again.'
        : 'The worker ended without saving this step as done. Read its saved result before trying again.' }]
  })
}

const STOP_KEPT = 'The checkout and its unfinished work are kept.'
const plainStop = (value: string) => value.trim().replace(/:(?=\s|$)/g, '')
export const stopResult = (reason?: string, sender?: string, order?: string) =>
  'Stopped' + (sender?.trim() ? ' by ' + plainStop(sender) + ' under ' + (order?.trim() ? plainStop(order) : 'no named order') : '')
  + ': ' + (reason?.trim() || 'no reason given') + '. ' + STOP_KEPT
const STOPPED_ON_PURPOSE = /^Stopped(?: by .+? under .+?)?: /
export const stoppedOnPurpose = (run: QuestSession) => run.state === 'cancelled'
  && [run.result, run.evidence?.at(-1)].some(text => !!text && STOPPED_ON_PURPOSE.test(text) && text.endsWith(STOP_KEPT))
const STOPPED_BY_GIVER = /^Stopped by the Quest Giver under /
export const stoppedByGiver = (run: QuestSession) => stoppedOnPurpose(run)
  && [run.result, run.evidence?.at(-1)].some(text => !!text && STOPPED_BY_GIVER.test(text))
export const refusedInReply = (run: QuestSession) => run.state === 'failed' && run.refusalReplied === true
export const takenOverBy = (sessions: QuestSession[], run: QuestSession) => sessions.find(other => (other.runID ?? other.callID) !== (run.runID ?? run.callID)
  && OWNED_RUN.has(other.state) && other.deliverables.some(step => run.deliverables.includes(step)))

export const ownedRuns = (q: import('../types').Quest) => latestSessionAttempts(q.sessions).filter(run => OWNED_RUN.has(run.state))

export const observedRun = (run: QuestSession, observation: (run: QuestSession) => any) =>
  run.state && TERMINAL_RUN.has(run.state) ? { state: run.state, reason: run.result ?? 'Recorded outcome' } : observation(run)

export const nativeRunID = (run: QuestSession) => {
  const id = run.openCodeSessionId ?? run.openCodeSessionID ?? run.sessionID
  return id?.startsWith('ses_') && !run.harness ? id : undefined
}

export const FROZEN_RUN_STOP = 'Frozen run stopped by the stall watch'
export const frozenRun = (run: Pick<QuestSession, 'state' | 'result' | 'evidence'>) => run.state === 'failed' && `${run.result ?? ''} ${run.evidence?.at(-1) ?? ''}`.includes(FROZEN_RUN_STOP)
const PASSING_BINDING_CHANGE = /Git repository binding changed during discovery/i
export const GIVER_CHANGED = 'The user giver changed; inspect before dispatch'
export const giverChangedAtStart = (run: QuestSession) => run.state === 'failed' && !run.sessionID && !run.openCodeSessionId && `${run.result ?? ""} ${run.evidence?.at(-1) ?? ""}`.includes(GIVER_CHANGED)
export const passingBindingChange = (run: QuestSession) => run.state === 'failed' && PASSING_BINDING_CHANGE.test(`${run.result ?? ""} ${run.evidence?.at(-1) ?? ""}`)
const LOST = /Frozen run stopped by the stall watch|Dispatch owner \d+ on \S+ exited during|Execution ended with the host process|Planned before this host started|Permission refusal interrupted the worker tool message|Permission ask went unanswered|Git repository binding changed during discovery|cooling down|auth_unavailable|rate[_ ]?limit|server_is_overloaded|servers are currently overloaded/i
export function lostToInfrastructure(run: QuestSession): boolean {
  const text = `${run.result ?? ""} ${run.evidence?.at(-1) ?? ""}`
  if (/Host reported execution interrupted: user/.test(text)) return false
  if (run.state === "stale" || run.state === "missing") return true
  if (run.state === "cancelled" && /Permission refusal interrupted the worker tool message/.test(text)) return true
  return run.state === "failed" && LOST.test(text)
}
const NO_MODEL_TURN = /The host never started this run\.|The worker's session ended without a result\./
export const noModelTurn = (run: QuestSession): boolean => run.state === "failed" && NO_MODEL_TURN.test(`${run.result ?? ""} ${run.evidence?.at(-1) ?? ""}`)
export function redispatchRetry(q: Quest, run: QuestSession): { retry: boolean; tries: number } {
  const tries = q.sessions.filter(row => (noModelTurn(row) || lostToInfrastructure(row) || reworkRequested(q, row)) && row.deliverables.some(id => run.deliverables.includes(id))).length + 1
  return { retry: tries <= 3, tries }
}
