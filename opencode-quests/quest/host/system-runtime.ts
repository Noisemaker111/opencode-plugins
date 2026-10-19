import { runningGeneration } from '../../scripts/running-generation.mjs'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processMemory } from '../../apps/questgiver/connector/host-memory'
import { readRun } from '../../apps/questgiver/connector/release-update'
import { CHANNELS, activeChannelRelease, channelHostPool } from '../../scripts/channel-migrate.mjs'
import { WORK_BRANCH } from '../channel.mjs'
import { mainCheckout, sameRevision } from '../../scripts/fresh-services.mjs'
import { SCRATCH } from '../../scripts/service-reload-result.mjs'
import { hostRecords } from './host-role'
import { pendingUpdate } from '../../scripts/landing-quiet.mjs'
import { redactSensitive } from '../privacy'

export type SystemHost = {
  id: string; pid: number; generation: string | null; channel: string | null; role: string
  alive: boolean; memoryBytes: number | null; sessions: string[]; checkedAt: string; activityKnown: boolean
}
export type SystemServing = {
  channel: string | null; generation: string | null; commit: string | null; v2: string | null
  matchesV2: boolean | null; checkedAt: string; repository: string | null
}
export type SystemReload = {
  repository: string; state: string; pid: number | null; startedAt: string | null; alive: boolean | null; source: string
}
export type SystemAsk = { sessionID: string; requestID: string; kind: string; reason: string; ask: string }

const registry = () => join(homedir(), '.config', 'opencode', '.channels')
const unwrap = (value: any) => value?.data ?? value
const reason = (error: unknown) => redactSensitive(error instanceof Error ? error.message : String(error))
const readRecord = <T>(file: string): T | undefined => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw Error('Unreadable record: ' + file)
  }
}
const alive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

export async function readSystemHosts(host: { active?: Function }, signal?: AbortSignal) {
  const diagnostics: string[] = [], records = new Map<string, ReturnType<typeof hostRecords>[number] & { channel?: string }>()
  const directories = new Map<string, string | undefined>([
    ...CHANNELS.map(name => [channelHostPool(registry(), name), name] as [string, string]),
    ...(process.env.OPENCODE_HOST_POOL ? [[process.env.OPENCODE_HOST_POOL, process.env.OPENCODE_RELEASE_CHANNEL] as [string, string | undefined]] : []),
  ])
  for (const [directory, channel] of directories) {
    if (!existsSync(directory)) continue
    try { for (const row of hostRecords(directory, diagnostics)) {
      if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.id !== 'string') { diagnostics.push('Invalid host identity in ' + directory); continue }
      records.set(row.pid + ':' + row.id, { ...row, channel })
    } }
    catch (error) { diagnostics.push('Hosts could not be read: ' + reason(error)) }
  }
  if (![...records.values()].some(row => row.pid === process.pid)) records.set(String(process.pid), {
    id: String(process.pid), pid: process.pid, sessions: [], state: 'active',
    generation: runningGeneration() ?? undefined, channel: process.env.OPENCODE_RELEASE_CHANNEL,
    control: { url: '', authorization: '' },
  })
  const rows = [...records.values()], living = new Set(rows.filter(row => alive(row.pid)).map(row => row.pid))
  let memory = new Map<number, number>()
  try { memory = await processMemory([...living]) } catch (error) { diagnostics.push('Host memory could not be read: ' + reason(error)) }
  memory.set(process.pid, process.memoryUsage().rss)
  const active: Record<string, unknown> = {}, knownSessions = new Set<string>(), asks = new Map<string, SystemAsk>()
  const hosts: SystemHost[] = await Promise.all(rows.map(async row => {
    let sessions: string[] = [], activityKnown = false
    if (living.has(row.pid)) try {
      let result: any
      if (row.pid === process.pid && typeof host.active === 'function') result = unwrap(await host.active({ signal }))
      else {
        if (!row.local || !/^http:\/\/127\.0\.0\.1:\d+$/.test(row.local.url) || !row.local.authorization) throw Error('The host has no local activity endpoint')
        const response = await fetch(row.local.url + '/api/session/active', {
          headers: { authorization: row.local.authorization },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        })
        if (!response.ok) { await response.body?.cancel(); throw Error('The host activity request fails with ' + response.status) }
        result = unwrap(await response.json())
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('The host returns invalid activity')
      sessions = Object.keys(result)
      for (const id of sessions) knownSessions.add(id)
      for (const id of sessions) active[id] = { generation: row.generation, state: row.state }
      activityKnown = true
    } catch (error) { diagnostics.push('Host ' + row.pid + ' activity is unknown: ' + reason(error)) }
    else activityKnown = true
    if (living.has(row.pid)) await Promise.all(['form', 'permission/request'].map(async path => {
      try {
        if (!row.local || !/^http:\/\/127\.0\.0\.1:\d+$/.test(row.local.url) || !row.local.authorization) throw Error('The host has no local asks endpoint')
        const response = await fetch(row.local.url + '/api/' + path, {
          headers: { authorization: row.local.authorization },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        })
        if (!response.ok) { await response.body?.cancel(); throw Error('The host asks request fails with ' + response.status) }
        const pending = unwrap(await response.json())
        if (!Array.isArray(pending)) throw Error('The host returns invalid asks')
        for (const ask of pending) if (typeof ask.id === 'string' && typeof ask.sessionID === 'string') asks.set(ask.sessionID + ':' + ask.id, {
          sessionID: ask.sessionID, requestID: ask.id, kind: path === 'form' ? 'question' : 'permission',
          reason: path === 'form' ? ask.title : [ask.action, ...(ask.resources ?? [])].join(' '),
          ask: path === 'form' ? 'Open the question in Quest Web and answer it.' : 'Open the pending approval in Quest Web and allow or reject the request.',
        })
      } catch (error) { diagnostics.push('Host ' + row.pid + ' ' + path + ' asks are unknown: ' + reason(error)) }
    }))
    return {
      id: row.id, pid: row.pid, generation: row.generation ?? null, channel: row.channel ?? null, role: row.state,
      alive: living.has(row.pid), memoryBytes: memory.get(row.pid) ?? null, sessions,
      checkedAt: new Date().toISOString(), activityKnown,
    }
  }))
  return { hosts, active, knownSessions, asks: [...asks.values()], diagnostics }
}

const git = (repository: string, args: string[], signal?: AbortSignal) => new Promise<string>((done, fail) => {
  execFile('git', ['-C', repository, ...args], { windowsHide: true, signal, maxBuffer: 1 << 20 }, (error, stdout) => {
    if (error) fail(Error('Git could not read ' + args.join(' ')))
    else done(String(stdout).trim())
  })
})

export async function readSystemServing(signal?: AbortSignal) {
  const diagnostics: string[] = [], root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const deploymentFile = join(root, '.deployment-source.json')
  let deployment: { commit?: string } | undefined
  try { deployment = readRecord(deploymentFile) } catch { diagnostics.push('The serving revision record is unreadable') }
  if (deployment && !deployment.commit) diagnostics.push('The serving revision record has no commit')
  const channel = process.env.OPENCODE_RELEASE_CHANNEL ?? null
  const release = channel ? activeChannelRelease(registry(), channel) : undefined
  let repository = release?.repository ?? root, commit = deployment?.commit ?? null, v2: string | null = null
  if (!commit && !existsSync(deploymentFile)) try { commit = await git(root, ['rev-parse', 'HEAD'], signal) }
  catch (error) { diagnostics.push('The serving revision is unknown: ' + reason(error)) }
  try { repository = await mainCheckout(repository) } catch (error) { diagnostics.push('The source repository is unknown: ' + reason(error)) }
  try {
    const remote = await git(repository, ['ls-remote', 'origin', 'refs/heads/' + WORK_BRANCH], signal)
    v2 = new RegExp(String.raw`^([a-f0-9]{40,64})\s+refs\/heads\/${WORK_BRANCH}$`, 'm').exec(remote)?.[1] ?? null
    if (!v2) diagnostics.push('The remote does not report a v2 revision')
  } catch (error) { diagnostics.push('The v2 revision is unknown: ' + reason(error)) }
  const reloadQueue: SystemReload[] = pendingUpdate(repository) ? [{ repository, state: 'pending', pid: process.pid, startedAt: null, alive: true, source: 'landing' }] : []
  const lock = join(repository, SCRATCH.find((name: string) => existsSync(join(repository, name))) ?? '.scratch', 'service-reloads', 'reload.lock')
  let held: { pid?: number; at?: string } | undefined
  try { held = readRecord(lock) } catch { diagnostics.push('The service reload lock is unreadable') }
  if (held) reloadQueue.push({
    repository, state: held.pid && alive(held.pid) ? 'running' : 'interrupted', pid: held.pid ?? null,
    startedAt: held.at ?? null, alive: held.pid ? alive(held.pid) : null, source: 'service reload',
  })
  const updateFile = join(registry(), 'update-run.json'), update = readRun(updateFile)
  if (!update && existsSync(updateFile)) diagnostics.push('The Update record is unreadable')
  if (update && ['running', 'interrupted'].includes(update.state)) reloadQueue.push({
    repository, state: update.state, pid: update.pid ?? null, startedAt: update.startedAt,
    alive: update.pid ? alive(update.pid) : null, source: 'Update',
  })
  const serving: SystemServing = {
    channel, generation: runningGeneration(), commit, v2,
    matchesV2: commit && v2 ? sameRevision(commit, v2) : null, checkedAt: new Date().toISOString(), repository,
  }
  return { serving, reloadQueue, diagnostics }
}
