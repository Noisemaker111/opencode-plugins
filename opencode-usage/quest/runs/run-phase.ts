import { dispatchingRuns, type DispatchingRun } from './dispatch-intent'
import { TERMINAL_RUN } from './session-lineage'
import type { QuestSession } from '../types'

export type RunPhaseName = 'preparing' | 'launching' | 'running' | 'waiting' | 'landing'
export type RunPhase = { phase: RunPhaseName; step?: string; waitingOn?: { kind: 'permission'; detail: string }; since: string; elapsedMs: number }

const LANDINGS = Symbol.for('questgiver.run-landings')
const landings = (): Map<string, string> => ((globalThis as any)[LANDINGS] ??= new Map())

export async function whileLanding<T>(runID: string, work: () => Promise<T>): Promise<T> {
  landings().set(runID, new Date().toISOString())
  try { return await work() } finally { landings().delete(runID) }
}

const elapsed = (since: string, now: number) => Math.max(0, now - (Date.parse(since) || now))

const STAGE_PHASE: Record<string, RunPhaseName> = {
  'source-binding': 'preparing', 'route-selection': 'preparing', 'workspace-preparation': 'preparing',
  'host-create': 'launching', 'prompt-admission': 'launching',
}

export function dispatchPhase(row: DispatchingRun, now = Date.now()): RunPhase {
  const launching = row.phase === 'creating' || row.phase === 'created' || row.phase === 'prompting'
  const phase: RunPhaseName = launching ? 'launching' : row.stage ? STAGE_PHASE[row.stage] ?? 'preparing' : 'preparing'
  const since = row.stage || launching ? row.stageAt : row.startedAt
  return { phase, ...(row.stage ? { step: row.stage } : {}), since, elapsedMs: elapsed(since, now) }
}

export function runPhase(run: QuestSession, confirmed: boolean, dispatching: DispatchingRun | undefined, now = Date.now()): RunPhase | undefined {
  if (TERMINAL_RUN.has(run.state)) return
  const landing = landings().get(run.runID ?? run.callID)
  if (landing) return { phase: 'landing', since: landing, elapsedMs: elapsed(landing, now) }
  if (run.awaiting) return { phase: 'waiting', waitingOn: { kind: 'permission', detail: run.awaiting.ask }, since: run.awaiting.at, elapsedMs: elapsed(run.awaiting.at, now) }
  if (dispatching && !dispatching.admittedAt) return dispatchPhase(dispatching, now)
  if (!confirmed) return
  const since = dispatching?.admittedAt ?? run.lastHeartbeatAt ?? run.updatedAt
  return { phase: 'running', since, elapsedMs: elapsed(since, now) }
}

export function preparingRuns(questID: string, recorded: Set<string>, now = Date.now()) {
  return dispatchingRuns(questID).filter(row => !recorded.has(row.runID) && !row.admittedAt).map(row => ({ runID: row.runID, ...dispatchPhase(row, now) }))
}

export { dispatchingRuns }
