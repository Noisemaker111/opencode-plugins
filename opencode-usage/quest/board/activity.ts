import { ownedRuns, nativeRunID, observedRun, TERMINAL_RUN } from '../runs/session-lineage'
import { GIVER_RESOLVING, WAITING_FOR_GIVER, handoffsOf, stepBlockerKey } from '../core/state-machine'
import { hostExecution, hostActivity, hostSessionSeen } from '../host/host-observation'
import { questTruth, type ObservationOf, type AdmissionRecords } from '../runs/reachability'
import type { Quest, QuestSession } from '../types'
import { hostRecords, hostAlive } from '../host/host-role'
import { treeProgressOf } from '../workers/process-progress'
import type { WorkerHostSignals } from './board'

import { farPastFinish, FAR_PAST_FINISH } from '../landing/finish-budget'
import { runPhase, preparingRuns, dispatchingRuns, type RunPhase } from '../runs/run-phase'
import { sharedStatusReader, type StatusReader } from '../runs/run-status'
import { waterfallSources } from '../bench/quest-waterfall'

export { ownedRuns, observedRun }

const phaseFields = (phase: RunPhase | undefined) => phase ? { phase: phase.phase, ...(phase.step ? { phaseStep: phase.step } : {}), ...(phase.waitingOn ? { waitingOn: phase.waitingOn } : {}), phaseSince: phase.since, phaseElapsedMs: phase.elapsedMs } : {}
const farPastFields = (q: Quest, run: QuestSession, now: number) => { const late = farPastFinish(q, run, now); return late ? { farPastFinish: { note: FAR_PAST_FINISH, route: late.route, expectedMs: late.expectedMs, elapsedMs: late.elapsedMs } } : {} }
export type ActivitySnapshot = { active?: Record<string, unknown>; checkedAt: string; reason?: string }
export const UNCONFIRMED = 'Recorded as executing, but the owning host does not confirm an execution for it'

export const HOST_ACTIVITY_NOT_YET_OBSERVED = 'host activity not yet observed'
export function readQuestActivity(host: any, quests: Quest[]): ActivitySnapshot {
 const checkedAt = new Date().toISOString()
 if (!quests.some(q => ownedRuns(q).some(nativeRunID))) return { checkedAt }
 if (typeof host.active !== 'function') {
   const active: Record<string, unknown> = {}
  for (const q of quests) for (const run of ownedRuns(q)) {
   const id = nativeRunID(run)
   if (id && hostExecution(host, id) === true) active[id] = true
  }
  return { active, checkedAt, reason: 'Connected host events do not confirm execution for these assignments; ownership retained' }
 }
 const snapshot = hostActivity(host)
 const active: Record<string, unknown> = { ...snapshot?.active }
 for (const q of quests) for (const run of ownedRuns(q)) {
  const id = nativeRunID(run), seen = id ? hostSessionSeen(host, id) : undefined
  if (!id || !seen || snapshot && seen.at < snapshot.checkedAt) continue
  if (seen.active) active[id] = true
  else delete active[id]
 }
 return snapshot ? { active, checkedAt: snapshot.checkedAt } : { active, checkedAt, reason: HOST_ACTIVITY_NOT_YET_OBSERVED }
}

export function observationFromActivity(snapshot: ActivitySnapshot): ObservationOf {
 return (run: QuestSession) => {
  const id = nativeRunID(run)
  if (id && snapshot.active && Object.hasOwn(snapshot.active, id)) return { state: 'running', checkedAt: snapshot.checkedAt }
  return { state: 'unknown', reason: snapshot.reason ?? UNCONFIRMED, checkedAt: snapshot.checkedAt }
 }
}

export function questHistory(q: Quest) {
 const ended = q.sessions.filter(run => TERMINAL_RUN.has(run.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
 const last = ended.at(-1)
 return { runs: ended.length + (q.earlierSessions ?? 0), ...(q.earlierCount ? { earlierCount: q.earlierCount } : {}), ...(last ? { last: { state: last.state, at: last.updatedAt, ...(last.sessionTitle ? { title: last.sessionTitle } : {}) } } : {}) }
}

export function questHandoff(q: Quest) {
 if (q.reason?.startsWith(WAITING_FOR_GIVER)) return { state: 'waiting' as const }
 if (!q.reason?.startsWith(GIVER_RESOLVING)) return undefined
 const at = Object.values(handoffsOf(q)).map(handoff => handoff.at).sort().at(-1)
 return { state: 'handed' as const, ...(at ? { at } : {}) }
}

export const runStatusReader = (): StatusReader => sharedStatusReader(waterfallSources(process.env).hostDB)
export function liveHostSignals(): WorkerHostSignals {
 let live: boolean | undefined
 try {
  const records = hostRecords()
   if (records.length) live = records.some(hostAlive)
 } catch {}
 return { hostLive: () => live, tree: treeProgressOf }
}
const statusFields = (reader: StatusReader, run: QuestSession, now: number) => { try { const status = reader.status(run, now); return { status: status.text, statusKind: status.kind } } catch { return {} } }

export function questActivity(q: Quest, snapshot: ActivitySnapshot, now = Date.now(), reader: StatusReader = runStatusReader()) {
 const truth = questTruth(q, observationFromActivity(snapshot))
 const handoffs = handoffsOf(q), handoff = questHandoff(q)
 const assigned = truth.runs.length, running = truth.runs.filter(run => run.confirmed).length
 const dispatching = new Map(dispatchingRuns(q.id).map(row => [row.runID, row]))
 const recorded = new Set(q.sessions.map(run => run.runID ?? run.callID))
 return { running, unconfirmed: assigned - running, assigned, checkedAt: snapshot.checkedAt,
  runs: truth.runs.map(({ run, state, confirmed, reason, lastActivityAt }) => ({
   runID: run.sessionRef ?? run.runID ?? run.callID, sessionRef: run.sessionRef, sessionTitle: run.sessionTitle, sessionID: nativeRunID(run),
   role: run.agentRole ?? run.role, provider: run.providerID, model: run.modelID ?? run.model,
   reasoning: run.reasoningEffort, fast: run.fast === true, generation: run.generation, state, confirmed,
   stepIDs: run.deliverables, updatedAt: lastActivityAt ?? run.lastHeartbeatAt ?? run.updatedAt,
   activity: run.commandSummary, reason, ...(run.harness ?? run.runtime ? { harness: run.harness ?? run.runtime } : {}),
   ...phaseFields(runPhase(run, confirmed, dispatching.get(run.runID ?? run.callID), now)),
   ...farPastFields(q, run, now),
   ...statusFields(reader, run, now),
  })),
  preparing: preparingRuns(q.id, recorded, now),
  currentSteps: q.stages.filter(step => step.status === 'working' || step.status === 'blocked').map(step => ({
   id: step.id, title: step.title, state: step.status,
   ...(step.status === 'blocked' ? { blocker: step.note, ...(step.needsJon ? { needsJon: step.needsJon } : handoffs[stepBlockerKey(step)] ? { handedOff: handoffs[stepBlockerKey(step)] } : {}) } : {}),
  })),
  history: questHistory(q),
  ...(handoff ? { handoff } : {}),
  sessionReferences: q.sessions.flatMap(run => { const sessionID = nativeRunID(run); return sessionID && run.sessionRef ? [{sessionID,ref:run.sessionRef,title:run.sessionTitle}] : [] }),
  sessions: [...new Set(q.sessions.map(nativeRunID).filter((id): id is string => !!id))],
  ...(assigned > running ? { reason: snapshot.reason ?? UNCONFIRMED } : {}) }
}

export function withQuestActivity(q: Quest, result: any, snapshot: ActivitySnapshot, records?: AdmissionRecords) {
 const truth = questTruth(q, observationFromActivity(snapshot), records)
 return { ...result, state: truth.state, lane: truth.lane, reason: truth.reason, group: truth.group,
  recordedState: truth.recordedState, recordedExecuting: truth.recordedExecuting,
  running: truth.runs.filter(run => run.confirmed).length, activity: questActivity(q, snapshot) }
}
