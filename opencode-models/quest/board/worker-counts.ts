import type { RunEvidence, ToolTimes } from '../runs/run-status'

export const WORKER_STATES = ['moving', 'waiting', 'idle', 'no live host', 'finished unsettled'] as const
export type WorkerState = typeof WORKER_STATES[number]
export const MEASURED_WINDOW_MS = 10 * 60_000

export type TreeProgress = { at: number; moving: boolean }
export type WorkerSignals = {
  evidence: Pick<RunEvidence, 'toolStarts' | 'lastStatus' | 'lastToolAt' | 'lastTool' | 'lastToolInput' | 'pullRequest'>
  landed?: boolean
  hostLive?: boolean
  tree?: TreeProgress
}
export type WorkerReading = { state: WorkerState; toolCalls: number; waitingMs?: number; command?: string }
export type WorkerCounts = Record<WorkerState, number> & {
  workers: number
  waitingOn: { command: string; ms: number }[]
  toolCallsPerMinute: number
  mergedPerHour: number
  windowMinutes: number
}

const commandOf = (evidence: WorkerSignals['evidence']) => [evidence.lastTool, evidence.lastToolInput].filter(Boolean).join(' ').slice(0, 120)

export function classifyWorker(signals: WorkerSignals, now: number, times: Pick<ToolTimes, 'medianMs'> & Partial<Pick<ToolTimes, 'p99Ms'>>, windowMs = MEASURED_WINDOW_MS): WorkerReading {
  const { evidence } = signals
  const toolCalls = (evidence.toolStarts ?? []).filter(at => at > now - windowMs && at <= now).length
  if (signals.landed || evidence.pullRequest?.state === 'merged') return { state: 'finished unsettled', toolCalls }
  if (signals.hostLive === false) return { state: 'no live host', toolCalls }
  if (evidence.lastStatus === 'running' && evidence.lastToolAt !== undefined) {
    const runningMs = Math.max(0, now - evidence.lastToolAt)
    const treeFresh = signals.tree && signals.tree.at >= evidence.lastToolAt
    if (treeFresh && signals.tree!.moving) return { state: 'moving', toolCalls }
    if (runningMs > times.medianMs || (treeFresh && !signals.tree!.moving)) return { state: 'waiting', toolCalls, waitingMs: runningMs, command: commandOf(evidence) }
    return { state: 'moving', toolCalls }
  }
  return { state: toolCalls ? 'moving' : 'idle', toolCalls }
}

export function landedWithin(landings: Iterable<{ state?: string; at?: string }>, now: number, windowMs = 3_600_000) {
  let count = 0
  for (const landing of landings) {
    const at = Date.parse(landing.at ?? '')
    if (landing.state === 'landed' && at > now - windowMs && at <= now) count++
  }
  return count
}

export function workerCounts(readings: WorkerReading[], mergedLastHour: number, windowMs = MEASURED_WINDOW_MS): WorkerCounts {
  const counts = Object.fromEntries(WORKER_STATES.map(state => [state, 0])) as Record<WorkerState, number>
  for (const reading of readings) counts[reading.state]++
  const calls = readings.reduce((total, reading) => total + reading.toolCalls, 0)
  const windowMinutes = windowMs / 60_000
  return {
    ...counts,
    workers: readings.length,
    waitingOn: readings.filter(reading => reading.state === 'waiting').map(reading => ({ command: reading.command ?? '', ms: reading.waitingMs ?? 0 })).sort((a, b) => b.ms - a.ms),
    toolCallsPerMinute: Math.round(calls / windowMinutes * 10) / 10,
    mergedPerHour: mergedLastHour,
    windowMinutes,
  }
}

const minutesText = (ms: number) => Math.max(1, Math.round(ms / 60_000)) + ' min'

export function workerCountsLine(counts: WorkerCounts): string {
  if (!counts.workers) return 'No worker has a run recorded as running. ' + counts.mergedPerHour + ' merged in the last hour.'
  const waits = counts.waitingOn.map(row => row.ms)
  const waiting = counts.waiting ? counts.waiting + ' waiting on a command (' + (waits.length > 1 ? minutesText(Math.min(...waits)) + ' to ' + minutesText(Math.max(...waits)) : minutesText(waits[0] ?? 0)) + ')' : '0 waiting on a command'
  const parts = [counts.moving + ' moving', waiting, counts.idle + ' idle', counts['no live host'] + ' with no live host', counts['finished unsettled'] + ' finished but not settled']
  return 'Workers: ' + parts.join(', ') + '. ' + counts.toolCallsPerMinute + ' tool calls a minute over the last ' + counts.windowMinutes + ' min, ' + counts.mergedPerHour + ' merged in the last hour.'
}
