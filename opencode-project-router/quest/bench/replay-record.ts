import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {readJsonRecord} from '../core/durable-file.mjs'
import { isSafeReference } from '../core/readable-reference'
import type { RunReview } from '../review/review-record'
import type { QuestResult, QuestSession, StepBlocker } from '../types'

export const REPLAY_ROLE = 'bench'
export const REPLAY_AGENT = 'bench'
export type ReplayState = 'starting' | 'running' | 'reviewing' | 'done' | 'failed'
export type ReplayEnd = 'completed' | 'failed' | 'cancelled'
export type ReplayRoute = { id: string; providerID: string; modelID: string; reasoning: string; accountID: string; why: string }
export type AttemptReport = { state: string; note?: string; blocker?: StepBlocker; result?: QuestResult }
export type ReplayCheck = { stepID: string; command: string; exitCode: number; artifact?: string; at: string }
export type ReplayCost = { currency: string; estimate: number | null; actual: number | null }
export type Replay = {
  version: 1; id: string; questID: string; of: string; stepIDs: string[]; at: string
  base: string; depth: string; workType?: string; taskTags: string[]
  state: ReplayState; route: ReplayRoute; parentID?: string
  sessionID?: string; workspace?: { path: string; branch: string }
  reports: Record<string, AttemptReport>; checks: ReplayCheck[]
  ended?: ReplayEnd; endedAt?: string; result?: string
  review?: RunReview; cost?: ReplayCost[]; requests?: number
  retired?: { at: string; removed: boolean; reason: string }
}

const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
const parsed = new Map<string, { stamp: string; value: Replay }>()
export const replaysDirectory = (runtime: string) => join(runtime, 'replays')
const replayFile = (runtime: string, id: string) => {
  if (!isSafeReference(id)) throw Error('Invalid bench identity')
  return join(replaysDirectory(runtime), id + '.json')
}

export function readReplay(runtime: string, id: string): Replay | undefined {
  if (!isSafeReference(id)) return
  const file = replayFile(runtime, id), final = parsed.get(file)
  if (final && (final.value.state === 'done' || final.value.state === 'failed')) return structuredClone(final.value)
  const stat = statSync(file, { throwIfNoEntry: false })
  if (!stat) { parsed.delete(file); return }
  const stamp = stat.mtimeMs + ':' + stat.size, held = parsed.get(file)
  if (held?.stamp === stamp) return structuredClone(held.value)
  const value = readJsonRecord<Replay>(file)
  if (value?.version !== 1 || value.id !== id) return
  parsed.set(file, { stamp, value })
  return structuredClone(value)
}
export function allReplays(runtime: string): Replay[] {
  const directory = replaysDirectory(runtime)
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => name.endsWith('.json')).flatMap(name => { try { const replay = readReplay(runtime, name.slice(0, -5)); return replay ? [replay] : [] } catch { return [] } })
}
export const questReplays = (runtime: string, questID: string) => allReplays(runtime).filter(replay => replay.questID === questID).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
export const replayBySession = (runtime: string, sessionID: string) => allReplays(runtime).find(replay => replay.sessionID === sessionID)
export const isReplayRun = (run: Pick<QuestSession, 'role'> | undefined) => run?.role === REPLAY_ROLE

export function replayRun(replay: Replay): QuestSession {
  const state = replay.state === 'starting' ? 'planned' : replay.state === 'running' ? 'executing' : replay.ended ?? 'failed'
  const effort = EFFORTS.has(replay.route.reasoning) ? replay.route.reasoning as QuestSession['reasoningEffort'] : undefined
  return {
    callID: replay.id, runID: replay.id, sessionRef: replay.id, sessionTitle: 'Bench of ' + replay.of, role: REPLAY_ROLE, agentRole: REPLAY_AGENT,
    ...(replay.sessionID ? { sessionID: replay.sessionID, openCodeSessionId: replay.sessionID } : {}), ...(replay.parentID ? { parentID: replay.parentID } : {}),
    providerID: replay.route.providerID, modelID: replay.route.modelID, model: replay.route.providerID + '/' + replay.route.modelID, ...(effort ? { reasoningEffort: effort } : {}), runtime: 'native',
    state, evidence: [], deliverables: replay.stepIDs, attempt: 1, startedAt: replay.at, updatedAt: replay.endedAt ?? replay.at,
    scope: { readOnly: false, workspaceMode: 'worktree', files: ['.'], requestedFiles: ['.'], ...(replay.workspace ? { worktree: replay.workspace.path, branch: replay.workspace.branch } : {}) },
  }
}

const routeOf = (replay: Replay) => replay.route.providerID + '/' + replay.route.modelID + (replay.route.reasoning && replay.route.reasoning !== 'unknown' ? '#' + replay.route.reasoning : '')
export function replayView(replay: Replay) {
  return {
    id: replay.id, of: replay.of, stepIDs: replay.stepIDs, route: routeOf(replay), why: replay.route.why, state: replay.state, at: replay.at,
    ...(replay.endedAt ? { endedAt: replay.endedAt } : {}), ...(replay.result ? { result: replay.result } : {}),
    verdict: replay.review?.verdict ?? null, reasons: replay.review?.reasons ?? [], accepted: replay.review?.judgment ? replay.review.judgment.accepted : null,
    cost: replay.cost ?? [], requests: replay.requests ?? null, ...(replay.retired ? { retired: replay.retired.removed, retiredBecause: replay.retired.reason } : {}),
  }
}
