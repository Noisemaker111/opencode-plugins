import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileDurable } from '../quest/core/durable-file.mjs'
import { createInterface } from 'node:readline'
import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { v2StateDirectory } from './channel-migrate.mjs'
import { enforceJsonlBudget, TELEMETRY_BUDGET } from './telemetry-budget.mjs'

const realHome = () => { try { return userInfo().homedir } catch { return process.env.USERPROFILE ?? process.env.HOME ?? '' } }

export function checkSpansFile(env = process.env) {
  if (env.QUESTGIVER_CHECK_SPANS_FILE) return env.QUESTGIVER_CHECK_SPANS_FILE
  if (env.QUESTGIVER_TEST_HOME || env.NODE_ENV === 'test') return join(env.QUESTGIVER_TEST_HOME ?? env.HOME ?? '.', 'check-spans.jsonl')
  if (env.OPENCODE_TELEMETRY_FILE) return env.OPENCODE_TELEMETRY_FILE + '.spans.jsonl'
  return join(v2StateDirectory(join(realHome(), '.config', 'opencode', '.channels')), 'requests.jsonl.spans.jsonl')
}

const gitLine = (cwd, ...args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.trim() : '' }

export function checkContext(cwd, env = process.env) {
  const root = gitLine(cwd, 'rev-parse', '--show-toplevel') || cwd
  return { root, branch: gitLine(root, 'rev-parse', '--abbrev-ref', 'HEAD'), revision: gitLine(root, 'rev-parse', 'HEAD'), sessionID: env.OPENCODE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || undefined }
}

export function recordCheckSpan(kind, start, end, details = {}, context = checkContext(process.cwd()), file = checkSpansFile()) {
  const row = { v: 1, pid: process.pid, kind: 'span', plugin: 'checks', name: kind, op: context.branch || 'detached', location: context.root, ...(context.sessionID ? { sessionID: context.sessionID } : {}),
    start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, revision: context.revision, ...details }
  try {
    mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 })
    if (existsSync(checkMirrorFile(file))) { appendFileSync(checkMirrorFile(file), JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 }); enforceJsonlBudget(checkMirrorFile(file), TELEMETRY_BUDGET.checksBytes) }
  } catch {}
  return row
}

export const checkMirrorFile = file => file + '.checks'

export function readCheckMirror(file = checkSpansFile()) {
  let text
  try { text = readFileSync(checkMirrorFile(file), 'utf8') } catch { return undefined }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { rows.push(JSON.parse(line)) } catch {}
  }
  return rows
}

export async function backfillCheckMirror(file = checkSpansFile()) {
  const mirror = checkMirrorFile(file)
  if (existsSync(mirror) || !existsSync(file)) return false
  const rows = await readCheckSpans(file)
  writeFileDurable(mirror, rows.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 })
  return true
}

export async function readCheckSpans(file = checkSpansFile()) {
  if (!existsSync(file)) return []
  const rows = []
  for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
    if (!line.includes('"plugin":"checks"')) continue
    try { rows.push(JSON.parse(line)) } catch {}
  }
  return rows
}

export function checkMinutes(rows, by = row => row.op) {
  const totals = new Map()
  for (const row of rows) {
    const key = by(row) ?? 'unknown', entry = totals.get(key) ?? totals.set(key, { key, minutes: 0, runs: 0, kinds: {} }).get(key)
    const minutes = (row.end - row.start) / 60000
    entry.minutes += minutes; entry.runs++; entry.kinds[row.name] = (entry.kinds[row.name] ?? 0) + minutes
  }
  return [...totals.values()].sort((a, b) => b.minutes - a.minutes)
}
