import { Database } from 'bun:sqlite'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { FEWEST_GAPS_FOR_A_MEDIAN, FROZEN_SILENCE_MS, MINIMUM_STALL_SILENCE_MS } from '../workers/stall-signal'
import { plainWords } from '../review/plain-words'
import { gitCommonDirectory } from '../checkouts/cleanup-git.mjs'
import { WORK_BRANCH } from '../channel.mjs'
import type { QuestSession } from '../types'

export type PullRequestState = { number?: number; state: 'open' | 'merged' | 'closed' }
export type RunEvidence = {
  tools: number; lastTool?: string; lastToolInput?: string; lastStatus?: string; lastToolAt?: number; lastAt?: number
  commitsAhead?: number; dirtyFiles?: number; pushed?: boolean; pullRequest?: PullRequestState; gate?: 'gate passed' | 'gate running' | 'gate ran'
  toolStarts?: number[]
}
export type RunStatusKind = 'starting' | 'working' | 'waiting' | 'near done' | 'frozen' | 'finished' | 'failed' | 'stopped'
export type RunStatus = { kind: RunStatusKind; text: string; since?: string }

export const STUCK_AFTER_MS = 5 * 60_000
const GATE = /check:affected|check:gate|check:core|bun (run )?test/

export function seconds(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 120 ? s + 's' : s < 7200 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'
}

const iso = (ms: number | undefined) => ms === undefined ? undefined : new Date(ms).toISOString()
const pullRequestLabel = (pr: PullRequestState) => 'pull request' + (pr.number ? ' #' + pr.number : '')

export function runStatus(run: Pick<QuestSession, 'state' | 'result' | 'awaiting' | 'evidence'>, evidence: RunEvidence, now: number, frozenLimitMs: number): RunStatus {
  const pr = evidence.pullRequest
  if (pr?.state === 'merged') return { kind: 'finished', text: 'finished: ' + pullRequestLabel(pr) + ' merged' }
  if (run.state === 'completed') return { kind: 'finished', text: 'finished' + (run.result ? ': ' + plainWords(run.result).slice(0, 160) : '') }
  if (run.state === 'failed' || run.state === 'missing' || run.state === 'stale') return { kind: 'failed', text: 'failed: ' + (plainWords(run.result || run.evidence?.at(-1) || 'no cause was recorded').slice(0, 200)) }
  if (run.state === 'cancelled') return { kind: 'stopped', text: 'stopped: ' + (plainWords(run.result || run.evidence?.at(-1) || 'no cause was recorded').slice(0, 200)) }
  if (run.awaiting) return { kind: 'waiting', text: 'waiting on ' + plainWords(run.awaiting.ask).slice(0, 120) + ' for ' + seconds(now - (Date.parse(run.awaiting.at) || now)), since: run.awaiting.at }
  if (evidence.lastStatus === 'running' && evidence.lastToolAt !== undefined) {
    const quiet = now - Math.max(evidence.lastToolAt, evidence.lastAt ?? 0)
    const limit = Math.min(frozenLimitMs, STUCK_AFTER_MS)
    if (quiet > limit) return { kind: 'frozen', text: 'stuck: ' + evidence.lastTool + ' running with no output for ' + seconds(quiet) + ' (limit ' + seconds(limit) + ')', since: iso(evidence.lastToolAt) }
  }
  if (pr?.state === 'open') return { kind: 'near done', text: 'near done: ' + pullRequestLabel(pr) + ' open' + (evidence.gate === 'gate passed' ? ', gate passed' : '') }
  if (evidence.gate === 'gate passed') return { kind: 'near done', text: 'near done: gate passed' + (evidence.pushed ? ', branch pushed' : '') }
  if (!evidence.tools) return { kind: 'starting', text: 'starting: no tool call yet' }
  const at = evidence.lastToolAt ?? evidence.lastAt
  if (evidence.lastStatus === 'running') return { kind: 'working', text: 'working: ' + evidence.lastTool + ' running for ' + seconds(now - (at ?? now)), since: iso(at) }
  return { kind: 'working', text: 'working: last ' + evidence.lastTool + ' ' + seconds(now - (at ?? now)) + ' ago', since: iso(at) }
}

type Seen = { seq: number; evidence: RunEvidence }
const KEPT_TOOL_STARTS = 200

function readTools(evidence: RunEvidence, rows: { time_created: number; time_updated: number; data: string }[]) {
  for (const row of rows) {
    evidence.lastAt = Math.max(evidence.lastAt ?? 0, row.time_updated ?? row.time_created)
    let data: any
    try { data = JSON.parse(row.data) } catch { continue }
    for (const part of data?.content ?? []) {
      if (part?.type !== 'tool') continue
      evidence.tools++
      const input = JSON.stringify(part.state?.input ?? {})
      evidence.lastTool = String(part.name ?? 'tool')
      evidence.lastToolInput = input.slice(0, 90)
      evidence.lastStatus = String(part.state?.status ?? '')
      const time = part.time ?? {}
      const at = [time.completed, time.ran, time.created].find(value => typeof value === 'number' && Number.isFinite(value))
      if (at !== undefined) evidence.lastToolAt = at
      const started = [time.ran, time.created].find(value => typeof value === 'number' && Number.isFinite(value))
      if (started !== undefined) evidence.toolStarts = [...(evidence.toolStarts ?? []), started].slice(-KEPT_TOOL_STARTS)
      if (GATE.test(input)) evidence.gate = evidence.lastStatus === 'completed' ? 'gate passed' : evidence.lastStatus === 'running' ? 'gate running' : 'gate ran'
    }
  }
  return evidence
}

export function sessionToolEvidence(db: Database, sessionID: string): RunEvidence {
  return readTools({ tools: 0 }, db.query('select time_created,time_updated,data from session_message where session_id = ? order by seq asc').all(sessionID) as any)
}

export function incrementalToolEvidence(db: Database, sessionID: string, seen: Map<string, Seen>): RunEvidence {
  const held = seen.get(sessionID)
  const from = held ? held.seq : -1
  const rows = db.query('select seq,time_created,time_updated,data from session_message where session_id = ? and seq > ? order by seq asc').all(sessionID, from) as { seq: number; time_created: number; time_updated: number; data: string }[]
  const changed = held ? db.query('select max(time_updated) as at from session_message where session_id = ? and seq <= ?').get(sessionID, from) as { at: number | null } : undefined
  if (held && !rows.length && (changed?.at ?? 0) <= (held.evidence.lastAt ?? 0)) return held.evidence
  if (held && (changed?.at ?? 0) > (held.evidence.lastAt ?? 0)) { seen.delete(sessionID); return incrementalToolEvidence(db, sessionID, seen) }
  const evidence = readTools(held ? { ...held.evidence } : { tools: 0 }, rows)
  const tail = rows.at(-1)?.seq ?? from
  seen.set(sessionID, { seq: tail, evidence })
  if (seen.size > 2000) for (const key of [...seen.keys()].slice(0, seen.size - 2000)) seen.delete(key)
  return evidence
}

export function measuredToolLimitMs(db: Database, now: number): number {
  return measuredToolTimes(db, now).p99Ms
}

export type ToolTimes = { medianMs: number; p99Ms: number; measured: number }
export function measuredToolTimes(db: Database, now: number): ToolTimes {
  const rows = db.query("select data from session_message where type = 'assistant' and time_created >= ?").all(now - 86_400_000) as { data: string }[]
  const durations: number[] = []
  for (const row of rows) {
    let data: any
    try { data = JSON.parse(row.data) } catch { continue }
    for (const part of data?.content ?? []) {
      const time = part?.type === 'tool' ? part.time ?? {} : undefined
      const start = time?.ran ?? time?.created
      if (part?.state?.status === 'completed' && typeof start === 'number' && typeof time.completed === 'number' && time.completed >= start) durations.push(time.completed - start)
    }
  }
  if (durations.length < FEWEST_GAPS_FOR_A_MEDIAN) return { medianMs: MINIMUM_STALL_SILENCE_MS, p99Ms: FROZEN_SILENCE_MS, measured: durations.length }
  durations.sort((a, b) => a - b)
  const at = (fraction: number) => durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))]
  return { medianMs: at(0.5), p99Ms: Math.max(MINIMUM_STALL_SILENCE_MS, at(0.99)), measured: durations.length }
}

const git = (cwd: string, ...args: string[]) => { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() } catch { return '' } }

export type CheckoutOptions = { counts?: boolean; pullRequest?: (branch: string, worktree: string) => PullRequestState | undefined }

export function checkoutEvidence(scope: Record<string, unknown> | undefined, options: CheckoutOptions = {}): Partial<RunEvidence> {
  const worktree = typeof scope?.worktree === 'string' && existsSync(scope.worktree) ? scope.worktree : ''
  const branch = typeof scope?.branch === 'string' ? scope.branch : ''
  if (!worktree) return {}
  const pushed = !!branch && git(worktree, 'rev-parse', '--verify', '--quiet', 'origin/' + branch) !== ''
  const counts = options.counts ? { commitsAhead: Number(git(worktree, 'rev-list', '--count', 'origin/' + WORK_BRANCH + '..HEAD')) || 0, dirtyFiles: git(worktree, 'status', '--porcelain').split('\n').filter(Boolean).length } : {}
  const pullRequest = branch && options.pullRequest ? options.pullRequest(branch, worktree) : undefined
  return { pushed, ...counts, ...(pullRequest ? { pullRequest } : {}) }
}

export function ghPullRequests(cwd?: string): Map<string, PullRequestState> {
  const map = new Map<string, PullRequestState>()
  try {
    const rows = JSON.parse(execFileSync('gh', ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'headRefName,number,state'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...(cwd ? { cwd } : {}) }))
    for (const row of rows) if (!map.has(row.headRefName)) map.set(row.headRefName, { number: row.number, state: String(row.state).toLowerCase() as PullRequestState['state'] })
  } catch {}
  return map
}

const PULL_REQUEST_FRESH_MS = 60_000
const known = new Map<string, { at: number; state?: PullRequestState }>()
const pullRequestRepository = (worktree: string): NodeJS.ProcessEnv | undefined => {
  try { return { ...process.env, GIT_DIR: gitCommonDirectory(worktree) } } catch { return undefined }
}
export function branchPullRequest(branch: string, worktree: string, now = Date.now()): PullRequestState | undefined {
  const seen = known.get(branch)
  if (seen && (seen.state?.state === 'merged' || now - seen.at < PULL_REQUEST_FRESH_MS)) return seen.state
  let state: PullRequestState | undefined
  try {
    const env = pullRequestRepository(worktree)
    if (!env) return seen?.state
    const [row] = JSON.parse(execFileSync('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15_000 }))
    if (row) state = { number: row.number, state: String(row.state).toLowerCase() as PullRequestState['state'] }
  } catch { return seen?.state }
  known.set(branch, { at: now, state })
  return state
}

export const cachedPullRequest = (branch: string): PullRequestState | undefined => known.get(branch)?.state

export const isLiveRun = (run: Pick<QuestSession, 'state'>) => !['completed', 'failed', 'cancelled', 'missing', 'stale'].includes(run.state)

export function mergedPullRequest(run: Pick<QuestSession, 'scope'>, options: CheckoutOptions = { pullRequest: cachedPullRequest }): PullRequestState | undefined {
  const pr = checkoutEvidence(run.scope, options).pullRequest
  return pr?.state === 'merged' ? pr : undefined
}

export function refreshPullRequest(run: Pick<QuestSession, 'scope'>, now = Date.now()): Promise<PullRequestState | undefined> {
  const worktree = typeof run.scope?.worktree === 'string' && existsSync(run.scope.worktree) ? run.scope.worktree : ''
  const branch = typeof run.scope?.branch === 'string' ? run.scope.branch : ''
  if (!worktree || !branch) return Promise.resolve(undefined)
  const seen = known.get(branch)
  if (seen && (seen.state?.state === 'merged' || now - seen.at < PULL_REQUEST_FRESH_MS)) return Promise.resolve(seen.state)
  const env = pullRequestRepository(worktree)
  if (!env) return Promise.resolve(seen?.state)
  return new Promise(resolve => execFile('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state'], { env, windowsHide: true, timeout: 15_000 }, (error, stdout) => {
    if (error) return resolve(seen?.state)
    try {
      const [row] = JSON.parse(String(stdout))
      const state = row ? { number: row.number, state: String(row.state).toLowerCase() as PullRequestState['state'] } : undefined
      known.set(branch, { at: now, state })
      resolve(state)
    } catch { resolve(seen?.state) }
  }))
}

export type StatusReader = { status(run: QuestSession, now?: number): RunStatus; evidence?(run: QuestSession, now?: number): RunEvidence; toolTimes?(now?: number): ToolTimes; close(): void }

export function statusReader(hostDB: string | undefined, options: CheckoutOptions = { pullRequest: branchPullRequest }, holdOpen = true): StatusReader {
  const held = holdOpen && hostDB && existsSync(hostDB) ? new Database(hostDB, { readonly: true }) : undefined
  const reading = <T>(read: (db: Database | undefined) => T): T => {
    if (held || !hostDB || !existsSync(hostDB)) return read(held)
    const db = new Database(hostDB, { readonly: true })
    try { return read(db) } finally { db.close() }
  }
  const seen = new Map<string, Seen>()
  const evidence = (run: QuestSession): RunEvidence => {
    const sessionID = run.openCodeSessionId ?? run.sessionID
    const tools = sessionID ? reading(db => db ? incrementalToolEvidence(db, sessionID, seen) : { tools: 0 }) : { tools: 0 }
    const checkout = isLiveRun(run) ? checkoutEvidence(run.scope, options) : {}
    return { ...tools, ...checkout }
  }
  const toolTimes = (now: number): ToolTimes => reading(db => db ? measuredTimesFor(db, hostDB!, now) : { medianMs: MINIMUM_STALL_SILENCE_MS, p99Ms: FROZEN_SILENCE_MS, measured: 0 })
  return {
    status(run, now = Date.now()) {
      return runStatus(run, evidence(run), now, toolTimes(now).p99Ms)
    },
    evidence(run) { return evidence(run) },
    toolTimes(now = Date.now()) { return toolTimes(now) },
    close() { held?.close() },
  }
}

const shared = new Map<string, StatusReader>()
export function sharedStatusReader(hostDB: string | undefined): StatusReader {
  const key = hostDB && existsSync(hostDB) ? hostDB : ''
  let reader = shared.get(key)
  if (!reader) { reader = statusReader(key || undefined, { pullRequest: cachedPullRequest }, false); shared.set(key, reader) }
  return reader
}

const limits = new Map<string, { hour: number; times: ToolTimes }>()
function measuredTimesFor(db: Database, file: string, now: number) {
  const hour = Math.floor(now / 3_600_000), held = limits.get(file)
  if (held?.hour === hour) return held.times
  const times = measuredToolTimes(db, now)
  limits.set(file, { hour, times })
  return times
}
