#!/usr/bin/env node
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveDeliveryPolicy } from '../quest/landing/delivery-policy.mjs'
import { gitRefCandidates } from './channel-migrate.mjs'
import { landsWork, resolveChannel } from '../quest/channel.mjs'
import { SCRATCH, applyReloadResult, firstErrorLine, reloadFailureSummary, reloadInvocation, runRegisteredReload } from './service-reload-result.mjs'
import { clearFailure, recordFailure } from './surface-record.mjs'
import { checkContext, recordCheckSpan } from './check-spans.mjs'
import { webInputs } from './web-inputs.mjs'
import { buildInputs, outsideBuild } from './bundle-inputs.mjs'

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = (command, args, options = {}) => new Promise(done => execFile(command, args, { windowsHide: true, maxBuffer: 1 << 26, timeout: 120_000, ...options },
  (error, stdout, stderr) => done({ ok: !error, code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() || (error && !stdout ? error.message : '') })))
const git = async (cwd, ...args) => { const r = await run('git', ['-C', cwd, ...args]); return r.ok ? r.out : '' }

const pathIdentity = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const containsCheckout = (parent, path) => { const rel = relative(parent, path); return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel) }
const registryGit = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1 << 26 })
  if (result.status !== 0) throw Error(`Service registry Git read failure in ${cwd}: git ${args.join(' ')}: ${result.stderr?.trim() || result.error?.message || 'exit ' + result.status}`)
  return result.stdout
}
const registryRead = file => {
  try { return readFileSync(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw Error(`Service registry read failure at ${file}: ${error.message}`)
  }
}
const registryRealpath = path => {
  try { return realpathSync(path) } catch (error) { throw Error(`Service registry read failure at ${path}: ${error.message}`) }
}
function recordedCommonDirectory(dir) {
  if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_WORK_TREE) return undefined
  for (let at = resolve(dir); ; at = dirname(at)) {
    const dotgit = join(at, '.git')
    try {
      let gitdir = dotgit
      if (statSync(dotgit).isFile()) {
        const own = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'))?.[1]?.trim()
        if (!own) return undefined
        gitdir = resolve(at, own)
      }
      const pointer = join(gitdir, 'commondir')
      return existsSync(pointer) ? resolve(gitdir, readFileSync(pointer, 'utf8').trim()) : gitdir
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return undefined }
    if (dirname(at) === at) return undefined
  }
}
const commonDirectory = dir => registryRealpath(recordedCommonDirectory(dir) ?? registryGit(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim())
function serviceRepository(dir) {
  const common = commonDirectory(dir)
  const worktrees = registryGit(dir, 'worktree', 'list', '--porcelain', '-z').split('\0\0').filter(Boolean).map(block =>
    Object.fromEntries(block.split('\0').filter(Boolean).map(field => { const index = field.indexOf(' '); return index < 0 ? [field, true] : [field.slice(0, index), field.slice(index + 1)] })))
  if (!worktrees[0]?.worktree) throw Error(`Service registry Git read failure in ${dir}: no primary checkout`)
  const top = registryRealpath(worktrees[0].worktree)
  if (pathIdentity(commonDirectory(top)) !== pathIdentity(common))
    throw Error(`Service registry Git read failure in ${dir}: primary checkout belongs to a different repository`)
  return { top, common, worktrees }
}
export async function mainCheckout(dir) { return serviceRepository(dir).top }

function serviceLandedRef(top) {
  let policy
  try { policy = resolveDeliveryPolicy(top).policy } catch (error) { throw Error(`Service registry read failure resolving the landed ref in ${top}: ${error.message}`) }
  const ref = policy.landed === 'remote' ? policy.remote + '/' + policy.into : policy.into
  registryGit(top, 'rev-parse', '--verify', '--quiet', ref + '^{commit}')
  return ref
}
export async function landedRef(top) { return serviceLandedRef(top) }

function landedRegistryFile(top, ref, path) {
  if (ref) {
    const shown = spawnSync('git', ['-C', top, 'show', ref + ':' + path], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1 << 26 })
    if (shown.status === 0) return shown.stdout
    if (registryGit(top, 'ls-tree', '-z', ref, '--', path).trim()) throw Error(`Service registry Git read failure in ${top}: git show ${ref}:${path}: ${shown.stderr?.trim() || shown.error?.message || 'exit ' + shown.status}`)
  }
  return registryRead(join(top, path))
}
function managedCheckouts(registry, repository, source) {
  const paths = new Set(), home = join(repository.top, '.claude', 'worktrees')
  for (const service of registry.services) {
    if (!service || typeof service !== 'object' || Array.isArray(service) || typeof service.name !== 'string' || !service.name.trim())
      throw Error(`Invalid service registration in ${source}: every service needs a name`)
    if (!Object.hasOwn(service, 'managedCheckouts')) continue
    if (!Array.isArray(service.managedCheckouts)) throw Error(`Invalid managedCheckouts for ${service.name} in ${source}: expected an array of checkout paths`)
    for (const value of service.managedCheckouts) {
      if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.includes('\0') || /[{}]/.test(value.replaceAll('{repo}', '')))
        throw Error(`Invalid managed checkout path for ${service.name} in ${source}`)
      const path = resolve(repository.top, value.replaceAll('{repo}', repository.top))
      if (!containsCheckout(home, path)) throw Error(`Invalid managed checkout in ${source}: ${path} is outside ${home}`)
      let actual
      try {
        if (!statSync(path).isDirectory()) throw Error('not a directory')
        actual = realpathSync(path)
      } catch (error) { throw Error(`Invalid managed checkout in ${source}: cannot read ${path}: ${error.message}`) }
      if (pathIdentity(actual) !== pathIdentity(path) || !containsCheckout(home, actual))
        throw Error(`Invalid managed checkout in ${source}: ${path} resolves through an alias or outside its checkout home`)
      const entry = repository.worktrees.find(row => pathIdentity(row.worktree) === pathIdentity(path))
      if (!entry || entry === repository.worktrees[0] || entry.prunable) throw Error(`Invalid managed checkout in ${source}: ${path} is not an existing registered linked checkout`)
      if (pathIdentity(commonDirectory(path)) !== pathIdentity(repository.common))
        throw Error(`Invalid managed checkout in ${source}: ${path} belongs to a different repository`)
      paths.add(path)
    }
  }
  return [...paths]
}
export function readServicesSync(dir, ref, here = dir) {
  const repository = serviceRepository(dir), top = repository.top
  let text = landedRegistryFile(top, ref ?? serviceLandedRef(top), 'services.json'), source = join(top, 'services.json')
  if (text === undefined && pathIdentity(here) !== pathIdentity(top)) {
    if (pathIdentity(serviceRepository(here).common) !== pathIdentity(repository.common)) throw Error(`Service registry read failure: ${here} belongs to a different repository`)
    source = join(registryGit(here, 'rev-parse', '--show-toplevel').trim(), 'services.json'); text = registryRead(source)
  }
  if (text === undefined) {
    const remotes = registryGit(top, 'remote').trim().split(/\r?\n/)
    const url = remotes.includes('origin') ? registryGit(top, 'remote', 'get-url', 'origin').trim() : ''
    const name = url.match(/([^/\\:]+?)(?:\.git)?\/?$/)?.[1] ?? basename(top)
    const hub = serviceRepository(HUB).top, held = join('services', name + '.json')
    text = landedRegistryFile(hub, serviceLandedRef(hub), held.replaceAll('\\', '/')); source = join(hub, held)
  }
  if (text === undefined) return { source: '', services: [], managedCheckouts: [] }
  let registry
  try { registry = JSON.parse(text) } catch (error) { throw Error(`Invalid service registry JSON in ${source}: ${error.message}`) }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) || (registry.schema !== undefined && registry.schema !== 1) || !Array.isArray(registry.services)
    || Object.keys(registry).some(key => !['schema', 'services', 'note'].includes(key)))
    throw Error(`Invalid service registry in ${source}: expected a services array, optional schema 1 and optional note`)
  return { source, services: registry.services, managedCheckouts: managedCheckouts(registry, repository, source) }
}
export async function readServices(top, ref, here = top) { return readServicesSync(top, ref, here) }

const fill = (value, vars) => typeof value === 'string' ? value.replace(/\{(hub|home|repo|landed|channel|branch)\}/g, (_, key) => vars[key])
  : Array.isArray(value) ? value.map(item => fill(item, vars))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, vars)])) : value
const pick = (value, field) => field ? String(field.split('.').reduce((at, key) => at?.[key], value) ?? '') : typeof value === 'string' ? value : JSON.stringify(value)

export async function probe(spec, ctx, said = {}) {
  if (!spec || spec.landed) return ctx.landedSha
  if (spec.git) {
    for (const ref of gitRefCandidates(spec.git)) {
      const out = await git(resolve(ctx.top, spec.cwd ?? '.'), 'rev-parse', '--verify', '--quiet', ref + '^{commit}')
      if (out) return out
    }
    throw Error('git cannot resolve ' + spec.git)
  }
  if (spec.http) {
    try {
      const response = await fetch(spec.http, { headers: spec.headers ?? {}, signal: AbortSignal.timeout(spec.timeoutMs ?? 8000) })
      if (!response.ok) throw Error(spec.http + ' answered HTTP ' + response.status)
      const text = await response.text()
      try { return pick(JSON.parse(text), spec.field) } catch { throw Error(spec.http + ' answered without JSON, so nothing there reports its revision yet') }
    } catch (error) {
      if (/ECONNREFUSED/.test(String(error?.cause?.code ?? error?.cause?.message ?? ''))) return ''
      throw error
    }
  }
  if (spec.file) {
    const path = resolve(ctx.top, spec.file)
    return existsSync(path) ? pick(JSON.parse(readFileSync(path, 'utf8')), spec.field) : ''
  }
  if (spec.command) {
    const [command, ...args] = spec.command
    const result = await run(command, args, { cwd: ctx.top, timeout: spec.timeoutMs ?? 60_000 })
    if (!result.ok) throw Error(spec.command.join(' ') + ': ' + (result.err || result.out || 'exit ' + result.code).split(/\r?\n/).slice(-3).join(' '))
    if (!spec.field) return result.out.split(/\r?\n/).pop()?.trim() ?? ''
    const answer = JSON.parse(result.out)
    if (spec.noteField) said.note = pick(answer, spec.noteField)
    return pick(answer, spec.field)
  }
  throw Error('unknown probe ' + JSON.stringify(spec))
}

const HEX = /^[0-9a-f]{7,64}$/
export const sameRevision = (a, b) => {
  a = String(a ?? '').trim().toLowerCase(); b = String(b ?? '').trim().toLowerCase()
  return !!a && !!b && (a === b || HEX.test(a) && HEX.test(b) && (a.startsWith(b) || b.startsWith(a)))
}

async function judge(service, ctx) {
  const row = { name: service.name, serves: service.serves, restartsHost: service.restartsHost === true, running: '', expected: '', state: 'fresh', reload: service.reload ? fill(service.reload, ctx.vars) : undefined, manual: service.manual, ignore: service.ignore, inputs: service.inputs }
  try {
    const spec = fill(service, ctx.vars)
    const said = {}
    ;[row.running, row.expected] = await Promise.all([probe(spec.running, ctx, said), probe(spec.expected, ctx)])
    if (said.note) row.note = said.note
    const addNote = text => { row.note = row.note ? row.note + '; ' + text : text }
    if (!row.running) { row.state = 'not running'; return row }
    if (sameRevision(row.running, row.expected)) {
      if (!sameRevision(row.expected, ctx.landedSha)) addNote(`runs ${String(row.expected).slice(0, 8)}, its own channel's revision; ${ctx.vars.landed} reaches it only by promotion`)
      return row
    }
    if (service.inputs === 'web' && HEX.test(row.running) && HEX.test(row.expected)) {
      const [running, expected] = [webInputs(row.running, ctx.top), webInputs(row.expected, ctx.top)], same = !!running && running === expected
      if (same) { row.state = 'fresh'; addNote('same Quest Web inputs'); return row }
    }
    if (service.buildRoots?.length && HEX.test(row.running) && HEX.test(row.expected)) {
      const names = await run('git', ['-C', ctx.top, 'diff', '--name-only', row.running, row.expected])
      if (names.code === 0 && outsideBuild(names.out.split(/\r?\n/).filter(Boolean), service.buildRoots, buildInputs(ctx.top, service.buildEntries ?? []))) { row.state = 'fresh'; addNote('no changed file is in its build'); return row }
    }
    if (service.ignore?.length && HEX.test(row.running) && HEX.test(row.expected)) {
      const diff = await run('git', ['-C', ctx.top, 'diff', '--quiet', row.running, row.expected, '--', '.', ...service.ignore.map(path => ':(exclude,glob)' + path)])
      if (diff.code === 0) { row.state = 'fresh'; addNote('differs only in ignored paths'); return row }
    }
    row.state = 'stale'
    const bench = spec.held?.command ? await probe({ ...spec.held, command: [...spec.held.command, row.expected] }, ctx).catch(() => '') : ''
    if (bench) { row.state = 'held'; row.bench = bench }
  } catch (error) { row.state = 'unreadable'; row.error = error instanceof Error ? error.message : String(error) }
  return row
}

export async function checkServices(dir, { fetch: refresh = true, channel = resolveChannel().name, home = homedir(), only } = {}) {
  const top = await mainCheckout(dir)
  if (!top) return { top: '', services: [] }
  if (refresh && (await git(top, 'remote')).split(/\r?\n/).includes('origin')) await run('git', ['-C', top, 'fetch', '--quiet', 'origin'], { timeout: 60_000 })
  const landed = await landedRef(top), landedSha = registryGit(top, 'rev-parse', landed).trim()
  const { source, services, managedCheckouts } = await readServices(top, landed, registryGit(dir, 'rev-parse', '--show-toplevel').trim())
  const ctx = { top, landedSha, vars: { hub: HUB, home, repo: top, landed, channel, branch: channel } }
  const selected = services.filter(service => (!service.channel || service.channel === channel) && (!only || only(service)))
  return { top, landed, landedSha, channel, source, managedCheckouts, ctx, services: await Promise.all(selected.map(async service => ({ ...await judge(service, ctx), service }))) }
}

const short = value => String(value)
export const describe = row => row.state === 'stale' ? `${row.name}: runs ${short(row.running)}, should run ${short(row.expected)}` + (row.reload ? '' : ' (' + (row.manual ?? 'no reload declared') + ')') + (row.note ? '; ' + row.note : '')
  : row.state === 'unreadable' ? `${row.name}: ${row.reloaded === undefined ? '' : 'reloaded, but still '}cannot read its revision: ${row.error}`
  : row.state === 'held' && String(row.bench).startsWith('workers:') ? `${row.name}: reload held, ${row.bench.slice(8)} Quest worker(s) running; it reloads when none run`
  : row.state === 'held' ? `${row.name}: activation held for bench ${row.bench}`
  : row.state === 'reload failed' ? `${row.name}: reload failed (now runs ${short(row.running)}): ${row.error}`
  : `${row.name}: ${row.state}${row.note ? ' (' + row.note + ')' : ''}`
export const needsAction = row => row.state === 'stale' || row.state === 'unreadable' || row.state === 'reload failed'
export const heldByWorkers = row => row.state === 'held' && String(row.bench).startsWith('workers:')
export const wantsReload = row => !!row.reload && (row.state === 'stale' || row.state === 'unreadable')
const followsHost = row => !row.reload && !!row.manual
export const blockingRows = rows => { const held = rows.some(heldByWorkers); return rows.filter(row => needsAction(row) && !(held && followsHost(row))) }
export const hostMoved = rows => rows.filter(row => row.restartsHost).every(row => row.state === 'fresh')
const reloadable = row => !!row.reload && ['fresh', 'stale', 'unreadable'].includes(row.state)

export async function hostUpdateNeeded(dir, channel = resolveChannel().name) {
  try {
    const { services } = await checkServices(dir, { channel, only: service => service.restartsHost === true })
    return services.length === 0 || services.some(row => wantsReload(row) || row.state === 'held')
  } catch { return true }
}

const processAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
function lockChanged(directory, name, milliseconds) {
  return new Promise(done => {
    const finish = () => { clearTimeout(timer); watcher.close(); done() }
    const watcher = watch(directory, (_event, changed) => { if (!changed || changed === name) finish() })
    const timer = setTimeout(finish, milliseconds)
    if (!existsSync(join(directory, name))) finish()
  })
}
const LOCK_HELD = new Set(['EEXIST', 'EPERM', 'EBUSY'])
export function tryReloadLock(top, name = 'reload.lock') {
  const directory = reloadDirectory(top), file = join(directory, name)
  mkdirSync(directory, { recursive: true })
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' })
      return () => { try { unlinkSync(file) } catch {} }
    } catch (error) { if (!LOCK_HELD.has(error.code)) throw error }
    let owner
    try { owner = JSON.parse(readFileSync(file, 'utf8')) } catch {}
    if (!owner && !existsSync(file)) continue
    if (owner?.pid && !processAlive(owner.pid)) { try { unlinkSync(file) } catch {}; continue }
    return undefined
  }
}
export async function holdReloadLock(top, waitMs, log = console.log, name = 'reload.lock') {
  const directory = reloadDirectory(top), deadline = Date.now() + waitMs
  for (;;) {
    const release = tryReloadLock(top, name)
    if (release) return release
    let owner
    try { owner = JSON.parse(readFileSync(join(directory, name), 'utf8')) } catch {}
    if (Date.now() >= deadline) throw Error(`Another reload of ${top} (process ${owner?.pid ?? 'unknown'}, started ${owner?.at ?? 'unknown'}) is still running after ${Math.round(waitMs / 60_000)} min`)
    if (owner?.pid) log(`waiting for the reload process ${owner.pid} started at ${owner.at} to finish, then judging again`)
    await lockChanged(directory, name, deadline - Date.now())
  }
}

export const reloadDirectory = top => join(top, SCRATCH.find(name => existsSync(join(top, name))) ?? '.scratch', 'service-reloads')
export function lastReload(top) { try { return JSON.parse(readFileSync(join(reloadDirectory(top), 'last.json'), 'utf8')) } catch { return undefined } }
const takeDirty = directory => { try { unlinkSync(join(directory, 'reload.dirty')); return true } catch { return false } }

async function keepPending(top, why = 'held for running Quest workers') {
  const { markPending, pendingUpdate } = await import('./landing-quiet.mjs')
  if (!pendingUpdate(top)) await markPending(top, why)
  return {}
}

export async function reloadServices(dir, { log = console.log, channel = resolveChannel().name } = {}) {
  const started = Date.now()
  const before = await checkServices(dir, { channel })
  for (const row of before.services) if (row.state === 'fresh') clearFailure(before.top, row.name)
  if (!before.services.some(wantsReload)) {
    const held = before.services.find(heldByWorkers)
    log(held ? `${before.landed} is not reloaded: ${held.bench.slice(8)} Quest worker(s) running; it reloads when none run` : `${before.landed} (${short(before.landedSha).slice(0, 12)}) is already serving; nothing to reload`)
    if (held && !blockingRows(before.services).length) return { ...before, reloadAttempts: [], reloadOutcome: 'held', heldReason: held.bench.slice(8) + ' Quest worker(s) running', ...(await keepPending(before.top)) }
    return { ...before, reloadAttempts: [], reloadOutcome: blockingRows(before.services).length ? 'failed' : 'succeeded', alreadyServing: true }
  }
  const top = before.top, directory = reloadDirectory(top)
  mkdirSync(directory, { recursive: true })
  const waitMs = before.services.reduce((total, row) => total + (row.service?.reload ? row.service.reloadTimeoutMs ?? 1_800_000 : 0), 0)
  const release = await holdReloadLock(top, 0, log).catch(() => undefined)
  if (!release) {
    writeFileSync(join(directory, 'reload.dirty'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), landedSha: before.landedSha }))
    log('another reload is running; it will judge every service once more when it ends, so this one waits for that and reports it instead of reloading again')
    ;(await holdReloadLock(top, waitMs, log))()
    const after = await checkServices(dir, { fetch: false, channel })
    return { ...after, reloadAttempts: [], reloadOutcome: blockingRows(after.services).length ? 'failed' : 'succeeded', coalesced: true, lastReload: lastReload(top) }
  }
  let result, passes = 0
  const attempts = []
  try {
    takeDirty(directory)
    do { result = await reloadHeld(dir, log, channel); attempts.push(...result.reloadAttempts); passes++ } while (takeDirty(directory))
  } finally { release() }
  if (attempts.some(attempt => !attempt.ok) && result.reloadOutcome === 'succeeded') result.reloadOutcome = 'recovered'
  result.reloadAttempts = attempts
  if (result.reloadOutcome === 'held') Object.assign(result, { heldReason: result.services.find(heldByWorkers)?.bench.slice(8) + ' Quest worker(s) running' }, await keepPending(top))
  else if (result.reloadOutcome === 'failed' && !hostMoved(result.services)) await keepPending(top, 'reload failed before the host moved')
  const finished = Date.now()
  const record = { startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), seconds: Math.round((finished - started) / 100) / 10, landedSha: result.landedSha, outcome: result.reloadOutcome, passes,
    services: result.services.filter(row => row.reloaded !== undefined || row.state !== 'fresh').map(row => row.name) }
  try { writeFileSync(join(directory, 'last.json'), JSON.stringify(record, null, 2) + '\n') } catch {}
  recordCheckSpan('reload', started, finished, { ok: result.reloadOutcome !== 'failed', passes }, checkContext(top))
  return { ...result, lastReload: record }
}

export const SETTLE = { ms: 60_000, stepMs: 5_000 }
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds))

async function settledRow(service, ctx, waitWhile) {
  let row = await judge(service, ctx)
  for (let waited = 0; await waitWhile(row) && waited < SETTLE.ms; waited += SETTLE.stepMs) {
    await pause(SETTLE.stepMs)
    row = await judge(service, ctx)
  }
  return row
}

async function rollBack(service, before, ctx, top) {
  if (!service.rollback) return { rolledBack: false, why: 'this surface declares no rollback' }
  if (!before.running) return { rolledBack: false, why: 'nothing ran before the reload' }
  const attempt = await runRegisteredReload(reloadInvocation({ ...before, reload: fill(service.rollback, ctx.vars) }, top, service.reloadTimeoutMs ?? 1_800_000, fill(service.expected ?? { landed: true }, ctx.vars)))
  if (!attempt.ok) return { rolledBack: false, why: 'the rollback command failed: ' + firstErrorLine(reloadFailureSummary(attempt)) }
  const row = await settledRow(service, ctx, found => found.running !== before.running)
  return row.running === before.running ? { rolledBack: true, row } : { rolledBack: false, why: 'it still runs ' + short(row.running) + ' after the rollback', row }
}

async function reachedRevision(asked, found, top) {
  if (!asked || !found.running) return false
  if (sameRevision(found.running, asked)) return true
  if (!HEX.test(String(found.running)) || !HEX.test(String(asked))) return false
  return (await run('git', ['-C', top, 'merge-base', '--is-ancestor', asked, found.running])).ok
}

async function reloadOne(service, before, ctx, top, log) {
  const asked = before.expected
  const shipping = service.shipsRef && /^[0-9a-f]{40}$/.test(String(asked ?? '')) ? { ...before, reload: [...before.reload, '--ref', asked] } : before
  log(`reloading ${before.name}: ${shipping.reload.join(' ')}`)
  const attempt = await runRegisteredReload(reloadInvocation(shipping, top, service.reloadTimeoutMs ?? 1_800_000, fill(service.expected ?? { landed: true }, ctx.vars)))
  const reached = async found => attempt.ok && !!(await reachedRevision(asked, found, top))
  const settled = await settledRow(service, ctx, async found => attempt.ok && found.state === 'stale' && !(await reached(found)))
  const row = settled.state === 'stale' && await reached(settled) ? { ...settled, state: 'fresh' } : settled
  if (row.state === 'fresh') { clearFailure(top, service.name); return { row: applyReloadResult(row, attempt, short), attempt } }
  if (row.state === 'held') return { row: applyReloadResult(row, attempt, short), attempt }
  const back = await rollBack(service, before, ctx, top)
  const final = back.row ?? row
  const cause = attempt.ok ? 'the live revision did not reach it within ' + SETTLE.ms / 1000 + ' s' : 'the reload command failed: ' + firstErrorLine(reloadFailureSummary(attempt))
  const text = `${service.name} did not reach ${short(row.expected)} (runs ${short(final.running) || 'nothing'}): ${row.error ?? cause}.${back.rolledBack ? 'Rolled back to ' + short(before.running) + '.' : 'Not rolled back: ' + back.why + '.'}`
  recordFailure(top, service.name, { text, rolledBack: back.rolledBack, running: final.running, expected: row.expected })
  return { row: applyReloadResult({ ...final, state: 'reload failed', error: text }, attempt, short), attempt }
}

async function reloadHeld(dir, log, channel) {
  const first = await checkServices(dir, { fetch: false, channel })
  const results = [], reloadAttempts = []
  for (const { service } of first.services) {
    const before = await judge(service, first.ctx)
    if (!wantsReload(before)) { results.push(before); continue }
    const { row, attempt } = await reloadOne(service, before, first.ctx, first.top, log)
    results.push(row)
    reloadAttempts.push(attempt)
  }
  const reloadOutcome = blockingRows(results).length ? 'failed' : results.some(heldByWorkers) ? 'held' : reloadAttempts.some(attempt => !attempt.ok) ? 'recovered' : 'succeeded'
  return { ...first, services: results, reloadAttempts, reloadOutcome }
}

export const repositoryArgument = value => value === undefined || isAbsolute(value) || /[\\/]/.test(value) || existsSync(value) ? value : join(homedir(), 'Projects', value)

export async function commandDirectory(command, cwd) {
  const cd = command.match(/(?:^|[;&|]\s*)(?:cd|Set-Location|pushd)\s+("([^"]+)"|'([^']+)'|(\S+))/)
  const chained = cd ? resolve(cwd, cd[2] ?? cd[3] ?? cd[4]) : cwd
  const gitC = command.match(/\bgit\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))/)
  if (gitC) return resolve(chained, gitC[2] ?? gitC[3] ?? gitC[4])
  const repo = command.match(/\bgh\b[^\n;&|]*?\s(?:-R|--repo)[\s=]+(\S+)/)?.[1]?.replace(/^["']|["']$/g, '')
  if (repo) {
    const name = repo.split('/').pop()?.toLowerCase()
    const projects = join(homedir(), 'Projects')
    const candidates = [projects, join(projects, 'btg-hub')].flatMap(root => { try { return (existsSync(root) ? readdirOf(root) : []).map(entry => join(root, entry)) } catch { return [] } })
    for (const path of candidates) {
      const url = existsSync(join(path, '.git')) ? await git(path, 'remote', 'get-url', 'origin') : ''
      if (url && url.toLowerCase().replace(/\.git$/, '').endsWith('/' + name)) return path
    }
  }
  return chained
}
const readdirOf = root => readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)

export { landsWork }

export const reloadReport = result => ({ top: result.top, landed: result.landed, landedSha: result.landedSha, channel: result.channel, source: result.source, managedCheckouts: result.managedCheckouts, services: result.services.map(({ service, ...row }) => row), reloadAttempts: result.reloadAttempts, reloadOutcome: result.reloadOutcome, heldReason: result.heldReason, alreadyServing: result.alreadyServing, coalesced: result.coalesced, lastReload: result.lastReload ?? (result.top ? lastReload(result.top) : undefined) })

export function staleReport(result, reloadCommand) {
  const rows = result.services.filter(needsAction)
  if (!rows.length) return ''
  return [`Merged is not finished until it runs. ${rows.length} of ${result.services.length} service(s) of ${result.top} do not run ${result.landed} (${short(result.landedSha)}):`,
    ...rows.map(row => '- ' + describe(row)),
    rows.some(row => row.reload) ? `Reload them and verify: ${reloadCommand}` : ''].filter(Boolean).join('\n')
}

export const readInput = async () => { let input = ''; for await (const chunk of process.stdin) input += chunk; return input }

export async function hook(input) {
  let event = {}
  try { event = JSON.parse(input) } catch { return }
  const command = String(event.tool_input?.command ?? '')
  if (!landsWork(command)) return
  const dir = await commandDirectory(command, event.cwd || process.cwd())
  const { retireLanded } = await import('./land-guard.mjs')
  await retireLanded(dir, { keep: [event.cwd || process.cwd(), process.cwd()] }).catch(error => process.stderr.write('retire landed worktrees: ' + error.message + '\n'))
  const result = await checkServices(dir)
  const report = staleReport(result, `node ${join(HUB, 'scripts', 'fresh-services.mjs').replaceAll('\\', '/')} ${result.top.replaceAll('\\', '/')} --reload`)
  if (!report) return
  process.stdout.write(JSON.stringify({ systemMessage: report.split('\n').slice(0, 1 + result.services.filter(needsAction).length).join('\n'), hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: report } }))
}

if (import.meta.main ?? (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
  const args = process.argv.slice(2)
  if (args.includes('--hook')) await readInput().then(hook).catch(error => process.stderr.write('fresh-services hook: ' + error.message + '\n'))
  else {
    const dir = repositoryArgument(args.find(arg => !arg.startsWith('--'))) ?? process.cwd()
    const result = args.includes('--reload') ? await reloadServices(dir) : await checkServices(dir, { fetch: !args.includes('--no-fetch') })
    if (args.includes('--json')) console.log(JSON.stringify(reloadReport(result), null, 2))
    else if (!result.services.length) console.log(`${result.top || dir}: no services registered`)
    else for (const row of result.services) console.log(describe(row))
    if (result.services.some(needsAction)) process.exitCode = 1
  }
}
