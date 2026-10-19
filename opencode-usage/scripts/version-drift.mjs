import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { questRoot } from '../quest/root.mts'
import { LockBusyError, acquireLock } from '../quest/locking.mts'
import { readSettings } from '../quest/config/quest-settings.mjs'
import { writeFileDurable } from '../quest/core/durable-file.mjs'
import { checkServices } from './fresh-services.mjs'
import { webInputs } from './web-inputs.mjs'
import { linkProblem } from './connector-link.mjs'
import { pendingUpdate, reloadRunner } from './landing-quiet.mjs'
import { busyHolder } from './host-busy.mjs'
import { readSurfaces } from './surface-record.mjs'
import { checkContext, recordCheckSpan } from './check-spans.mjs'
import { TELEMETRY_BUDGET, enforceSnapshotBudget } from './telemetry-budget.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(SCRIPT))
const SITE = 'https://quest.jonsoc.com'
const MINUTE = 60_000
const HISTORY = 20

export const DRIFT_DEFAULTS = { deployMinutes: 30, worseBy: 10, recheckMinutes: 10 }

const whole = (value, least) => Number.isInteger(value) && value >= least

export function driftSettingsProblem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'drift settings must be an object with deployMinutes, worseBy and recheckMinutes'
  const extra = Object.keys(value).find(key => !(key in DRIFT_DEFAULTS))
  if (extra) return 'drift settings have no field "' + extra + '"'
  if (!whole(value.deployMinutes ?? DRIFT_DEFAULTS.deployMinutes, 1)) return 'deployMinutes must be a whole number of minutes, 1 or more'
  if (!whole(value.worseBy ?? DRIFT_DEFAULTS.worseBy, 1)) return 'worseBy must be a whole number of commits, 1 or more'
  if (!whole(value.recheckMinutes ?? DRIFT_DEFAULTS.recheckMinutes, 1)) return 'recheckMinutes must be a whole number of minutes, 1 or more'
  return undefined
}

export const DRIFT_SECTION = {
  name: 'drift',
  check(saved) {
    if (saved === undefined) return { ...DRIFT_DEFAULTS }
    const problem = driftSettingsProblem(saved)
    if (problem) throw Error('Invalid drift settings: ' + problem + '; repair the saved values, nothing was substituted')
    return { ...DRIFT_DEFAULTS, ...saved }
  },
}

export const driftSettings = file => readSettings(DRIFT_SECTION, file)

const COMPONENTS = [
  { id: 'host', name: 'Quest host', service: 'Quest host ({channel} channel)' },
  { id: 'site', name: 'Quest Web backend (site Worker questgiver)', service: 'Quest Web backend (quest.jonsoc.com)' },
  { id: 'web', name: 'Quest Web frontend', service: 'Quest Web frontend (quest.jonsoc.com)' },
  { id: 'connector', name: 'connector bundle', surface: 'connector bundle (installed on this computer)', own: ['apps/questgiver/connector'] },
]

export const driftFile = (root = questRoot()) => join(root, '.opencode', '.quest-runtime', 'drift.json')
const dirtyFile = file => join(dirname(file), 'drift.dirty')
const short = sha => sha ? String(sha).slice(0, 8) : 'unknown'
const commitsWord = behind => behind === null ? 'an unknown number of commits' : behind + (behind === 1 ? ' commit' : ' commits')

export function sentence(row) {
  if (row.id === 'connector' && row.installed === row.served) return 'The connector bundle ' + short(row.installed) + ' is the one the site serves, but this computer is not linked to the site'
  if (row.id === 'connector') return 'connector bundle differs from the one the site serves (installed ' + short(row.installed) + ', site ' + short(row.served) + ')'
  return row.name + ' is ' + commitsWord(row.behind) + ' behind v2 (runs ' + short(row.running) + ', v2 is ' + short(row.head) + ')'
}

const git = (cwd, args) => new Promise(done => execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 1 << 24 },
  (error, stdout) => done(error ? undefined : String(stdout).trim())))

export async function commitsBetween(top, from, to, own = []) {
  if (!from || !to) return null
  const out = await git(top, ['rev-list', '--count', from + '..' + to, ...(own.length ? ['--', ...own] : [])])
  return out === undefined || !/^\d+$/.test(out) ? null : Number(out)
}

const differs = (top, from, to, paths) => new Promise(done => execFile('git', ['-C', top, 'diff', '--quiet', from, to, '--', ...paths], { windowsHide: true, timeout: 30_000 },
  error => done(error ? (error.code === 1 ? true : undefined) : false)))

async function measure(def, row, head, top) {
  const base = { id: def.id, name: def.name, head: head ?? null, running: null, behind: null, touching: null, state: 'unknown' }
  if (!row) return { ...base, error: 'not registered in services.json' }
  if (!row.running || !head || row.state === 'not running' || row.state === 'unreadable') return { ...base, running: row.running || null, error: row.error ?? 'not running' }
  if (row.state === 'fresh') return { ...base, running: row.running, behind: 0, touching: 0, state: 'current' }
  const total = await commitsBetween(top, row.running, head)
  if (total === null) return { ...base, running: row.running, error: 'commit ' + short(row.running) + ' is not in this checkout' }
  if (total === 0) return { ...base, running: row.running, behind: 0, touching: 0, state: 'current' }
  if (row.inputs === 'web') {
    const [running, latest] = [webInputs(row.running, top), webInputs(head, top)]
    if (running && running === latest) return { ...base, running: row.running, behind: 0, touching: 0, state: 'current' }
  }
  if (!row.ignore?.length) return { ...base, running: row.running, behind: total, touching: total, state: 'behind' }
  const paths = ['.', ...row.ignore.map(path => ':(exclude,glob)' + path)]
  const differ = await differs(top, row.running, head, paths)
  if (differ === undefined) return { ...base, running: row.running, error: 'cannot compare ' + short(row.running) + ' with ' + short(head) }
  if (!differ) return { ...base, running: row.running, behind: 0, touching: 0, state: 'current' }
  const touching = Math.max(1, (await commitsBetween(top, row.running, head, paths)) ?? 1)
  return { ...base, running: row.running, behind: touching, touching, state: 'behind' }
}

async function connectorOf(top, site, head, bundle) {
  const base = { id: 'connector', name: 'connector bundle', head: head ?? null, running: null, behind: null, touching: null, state: 'unknown', installed: bundle.installed ?? null, served: bundle.served ?? null }
  if (!bundle.installed) return { ...base, error: 'no installed connector at ' + bundle.file }
  if (!bundle.served) return { ...base, error: 'the site did not serve connector.js' }
  if (!site || site.state === 'unknown') return { ...base, error: 'the site version is unknown' }
  base.running = site.running
  if (bundle.installed === bundle.served && !bundle.link) return { ...base, state: 'current', behind: 0, touching: 0 }
  if (bundle.installed === bundle.served) return { ...base, state: 'not linked', behind: 0, touching: 0, failure: { text: bundle.link, hint: 'Run node scripts/connector-bundle.mjs --restart on this computer to link it.', fix: 'Link this computer' } }
  const touching = await commitsBetween(top, site.running, head, COMPONENTS[3].own)
  return { ...base, state: 'behind', behind: Math.max(1, site.behind ?? 0), touching: touching ?? 0 }
}

export async function observeComponents(result, bundle, measured = measure) {
  const head = result.landedSha, top = result.top
  const byName = new Map(result.services.map(row => [row.name, row]))
  const observed = {}
  for (const def of COMPONENTS.filter(def => def.service)) observed[def.id] = await measured(def, byName.get(def.service), head, top)
  observed.connector = await connectorOf(top, observed.site, head, bundle)
  return COMPONENTS.map(def => observed[def.id])
}

export async function connectorBundle(file = connectorFile(), request = fetch, link = () => linkProblem(file)) {
  const installed = existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : undefined
  const served = await request(SITE + '/connector.js', { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
    .then(answer => answer.ok ? answer.arrayBuffer() : undefined).then(bytes => bytes && createHash('sha256').update(Buffer.from(bytes)).digest('hex')).catch(() => undefined)
  return { file, installed, served, link: link() }
}

export const connectorFile = (env = process.env) => join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'QuestGiver', 'connector.js')

export function decideAlerts(memory, components, settings, now) {
  const next = {}, events = []
  for (const row of components) {
    const before = memory[row.id] ?? {}
    const failure = row.failure ?? null
    if (row.state === 'unknown' && !failure) { next[row.id] = { ...before }; continue }
    if (row.behind === 0 && !failure) {
      if (before.alerted) events.push({ id: row.id, type: 'cleared', at: now })
      next[row.id] = {}
      continue
    }
    const overdue = !!row.pendingSince && Date.parse(now) - Date.parse(row.pendingSince) > settings.deployMinutes * MINUTE
    const breach = !!failure || row.behind === null || !row.pendingSince || overdue
    if (!before.alerted && !breach) { next[row.id] = {}; continue }
    const worse = !!before.alerted && row.behind !== null && before.alertedBehind !== null && row.behind >= before.alertedBehind + settings.worseBy
    const changed = !!before.alerted && (before.failure ?? null) !== (failure?.text ?? null)
    if (!before.alerted || changed || worse) events.push({ id: row.id, type: 'raised', behind: row.behind, ...(worse ? { worse: true } : {}), at: now })
    const reason = failure ? failure.text : row.waitingOn ? 'host update waiting on ' + row.waitingOn + ' for ' + minutesSince(row.pendingSince, now) + ' min; the update is not forced and applies when it ends'
      : row.pendingSince ? 'behind v2 for longer than a deploy takes (' + settings.deployMinutes + ' min)' : 'behind v2 with no update pending, so nothing is moving it'
    const view = { id: row.id, name: row.name, behind: row.behind, running: row.running, head: row.head, text: sentence(row) + '. ' + reason + '. ' + (failure?.hint ?? 'Say "Update" to fix it.'), fix: failure?.fix ?? 'Update' }
    next[row.id] = { alerted: true, alertedBehind: !before.alerted || worse ? row.behind : before.alertedBehind, failure: failure?.text ?? null, raisedAt: before.raisedAt ?? now, view }
  }
  return { next, events }
}

export async function statusSection(name, build) {
  try { return await build() } catch (error) { return ['status section failed: ' + name + ': ' + (error instanceof Error ? error.message : String(error))] }
}

export function statusLines(state) {
  const lines = (state.components ?? []).map(row => {
    const runs = row.id === 'connector' ? 'installed ' + short(row.installed) + ', served ' + short(row.served) : 'runs ' + short(row.running) + ', v2 ' + short(row.head)
    const waiting = row.waitingOn ? '; host update waiting on ' + row.waitingOn + ' (' + minutesSince(row.pendingSince, state.checkedAt) + ' min)' : ''
    return `${row.name}: ${row.alerted ? 'ALERT' : row.state}; ${runs}${row.behind ? '; ' + commitsWord(row.behind) + ' behind' : ''}${waiting}${row.failure ? '; ' + row.failure.text : ''}`
  })
  if (state.error) lines.push('drift check failed: ' + state.error)
  return lines
}

const surfaceOf = def => def.surface ?? def.service
const offV2 = (branch, top) => branch === undefined || branch === 'v2' ? undefined
  : { text: 'The hub checkout is on ' + (branch || 'a detached HEAD') + ', not v2, so the host cannot follow v2', hint: 'Run git -C "' + top + '" switch v2 to put it back.' }
const tracked = (result, rows, branch, waiting) => {
  const pending = pendingUpdate(result.top, 'v2'), failures = readSurfaces(result.top).failures
  return rows.map((row, index) => {
    const def = COMPONENTS[index]
    return { ...row, pendingSince: pending?.first ?? null, ...(def.id === 'host' && waiting ? { waitingOn: waiting } : {}), failure: failures[surfaceOf(def)] ?? row.failure ?? (def.id === 'host' ? offV2(branch, result.top) : undefined) }
  })
}
const minutesSince = (since, now) => Math.max(0, Math.round((Date.parse(now) - Date.parse(since)) / MINUTE))

export function readDrift(file = driftFile()) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    return { ...state, alerts: state.alerts ?? [] }
  } catch { return { checkedAt: null, components: [], alerts: [], events: [] } }
}

const alertsOf = memory => COMPONENTS.map(def => memory[def.id]?.alerted ? memory[def.id].view : undefined).filter(Boolean)

async function runOnce({ root, file, reason, settings, services, bundle, now, started }) {
  const previous = readDrift(file)
  let state
  try {
    const result = await services(root, { channel: 'v2' })
    const branch = await git(result.top, ['branch', '--show-current'])
    const pending = pendingUpdate(result.top, 'v2')
    const waiting = pending && pending.host !== false ? await busyHolder() : undefined
    const observed = tracked(result, await observeComponents(result, await bundle(), undefined), branch, waiting)
    const { next, events } = decideAlerts(previous.memory ?? {}, observed, settings, now)
    state = {
      checkedAt: now, reason, head: result.landedSha, deployMinutes: settings.deployMinutes,
      components: observed.map(row => ({ id: row.id, name: row.name, state: row.state, running: row.running, head: row.head, behind: row.behind, touching: row.touching, alerted: !!next[row.id]?.alerted, failure: row.failure, installed: row.installed, served: row.served, pendingSince: row.pendingSince, waitingOn: row.waitingOn, error: row.error })),
      alerts: alertsOf(next), events: [...(previous.events ?? []), ...events].slice(-HISTORY), memory: next,
    }
  } catch (error) {
    state = { ...previous, checkedAt: now, reason, error: error instanceof Error ? error.message : String(error) }
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileDurable(file, enforceSnapshotBudget(state, TELEMETRY_BUDGET.driftBytes))
  try { recordCheckSpan('drift', started, Date.now(), { ok: !state.error, reason, alerts: state.alerts.length, events: state.events?.length ?? 0 }, checkContext(root)) } catch {}
  return state
}

export async function checkDrift({ root = ROOT, file = driftFile(), reason = 'check', settings, services = checkServices, bundle = connectorBundle, now = () => new Date().toISOString() } = {}) {
  const started = Date.now()
  const resolved = settings ?? driftSettings()
  mkdirSync(dirname(file), { recursive: true })
  let lock
  try { lock = acquireLock(dirname(file), 'drift', { timeoutMs: 0 }) } catch (error) {
    if (!(error instanceof LockBusyError)) throw error
    writeFileSync(dirtyFile(file), reason)
    return readDrift(file)
  }
  try {
    let state = await runOnce({ root, file, reason, settings: resolved, services, bundle, now: now(), started })
    while (existsSync(dirtyFile(file))) {
      unlinkSync(dirtyFile(file))
      state = await runOnce({ root, file, reason: 'landed', settings: resolved, services, bundle, now: now(), started: Date.now() })
    }
    return state
  } finally { lock.release() }
}

let refreshing

export function driftNow(options = {}) {
  const state = readDrift(options.file)
  const checked = state.checkedAt ? Date.parse(state.checkedAt) : NaN
  let minutes = DRIFT_DEFAULTS.recheckMinutes
  try { minutes = (options.settings ?? driftSettings()).recheckMinutes } catch {}
  const stale = !(Date.now() - checked < minutes * MINUTE)
  if (stale && !refreshing) refreshing = checkDrift({ ...options, reason: 'read' }).catch(() => {}).finally(() => { refreshing = undefined })
  return state
}

export const settleDrift = () => refreshing ?? Promise.resolve()

export function startDriftWatch(options = {}) {
  checkDrift({ ...options, reason: 'host start' }).catch(() => {})
}

export function startDriftCheck(spawnChild = spawn) {
  try {
    const child = spawnChild(reloadRunner(), [SCRIPT, '--check', 'landed'], { cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore' })
    child.once('error', () => {})
    child.unref()
    return child.pid
  } catch { return undefined }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args[0] === '--check') await checkDrift({ reason: args[1] ?? 'check' }).catch(() => {})
  else if (args[0] === '--status') {
    const sections = await Promise.all([
      statusSection('drift', async () => statusLines(await checkDrift({ reason: 'status' }))),
      statusSection('routes', async () => (await import('../usage/route-limits.ts')).routeStatusLines()),
      statusSection('latest run', async () => {
        const { latestRunLine, readWorkflowOutcomes, workflowOutcomesFile } = await import('../usage/workflow-outcomes.ts')
        return [latestRunLine(readWorkflowOutcomes(workflowOutcomesFile()))]
      }),
    ])
    console.log(sections.flat().join('\n'))
  }
  else console.log(JSON.stringify(readDrift(), null, 2))
}
