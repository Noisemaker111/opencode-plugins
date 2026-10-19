import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import {writeFileDurable} from '../../../quest/core/durable-file.mjs'
import { dirname, join } from 'node:path'
import { branchNames } from '../../../scripts/channel-migrate.mjs'

type Channel = 'v2' | 'main'
export type ServiceRow = { name: string; serves?: string; running?: string; expected?: string; state: string; note?: string; error?: string; manual?: string; reload?: string[] }
export type UpdateRun = { state: 'running' | 'updated' | 'failed' | 'interrupted'; channel?: Channel; pid?: number; startedAt: string; finishedAt?: string; services?: ServiceRow[]; message?: string }
type Revision = { sha: string | null; build: number | null }
export type LastReload = { startedAt: string; finishedAt: string; seconds: number; landedSha?: string; outcome: string; passes: number }

const exec = (command: string, args: string[], cwd: string, env = process.env) => new Promise<{ code: number; out: string; err: string }>(done =>
  execFile(command, args, { cwd, env, windowsHide: true, maxBuffer: 1 << 26, timeout: 180_000 }, (error, stdout, stderr) =>
    done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: String(stdout ?? ''), err: String(stderr ?? '') })))
const environmentFor = (channel: Channel) => ({ ...process.env, QUEST_CHANNEL: channel, OPENCODE_RELEASE_CHANNEL: channel })

export function lastJSON(out: string) {
  const at = out.search(/^\{/m)
  if (at < 0) throw Error('no result: ' + out.trim().split(/\r?\n/).slice(-3).join(' '))
  return JSON.parse(out.slice(at)) as { landed?: string; landedSha?: string; reloadOutcome?: string; services?: ServiceRow[]; lastReload?: LastReload }
}

const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }

export function readRun(file: string, channel?: Channel): UpdateRun | undefined {
  try {
    const run = JSON.parse(readFileSync(file, 'utf8')) as UpdateRun
    if (channel && run.channel !== channel) return undefined
    return run.state === 'running' && !alive(run.pid) ? { ...run, state: 'interrupted', message: 'The update stopped before it reported a result.' } : run
  } catch { return undefined }
}
const save = (file: string, run: UpdateRun) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileDurable(file, JSON.stringify(run, null, 2) + '\n')
}

const script = (repository: string) => join(repository, 'scripts', 'fresh-services.mjs')
const describe = (row: ServiceRow) => row.state === 'reload failed' ? `${row.name}: reload failed: ${row.error}` : row.state === 'unreadable' ? `${row.name}: ${row.error}` : `${row.name}: ${row.state}`

export async function releaseStatus(repository: string, channels: { v2?: string; main?: string }, file: string, channel: Channel) {
  if (!existsSync(script(repository))) throw Error('This computer has no stale-code check at ' + script(repository))
  const env = environmentFor(channel)
  const checked = await exec('node', [script(repository), repository, '--json'], repository, env)
  const result = lastJSON(checked.out || checked.err)
  const git = async (...args: string[]) => { const answer = await exec('git', ['-C', repository, ...args], repository, env); return answer.code ? '' : answer.out.trim() }
  const revision = async (ref?: string): Promise<Revision> => {
    const sha = ref ? await git('rev-parse', '--verify', '--quiet', ref + '^{commit}') : ''
    const build = sha ? Number(await git('rev-list', '--count', '--no-merges', sha)) : NaN
    return { sha: sha || null, build: Number.isSafeInteger(build) && build > 0 ? build : null }
  }
  const branch = async (channel: 'v2' | 'main') => { for (const name of branchNames(channel)) { const found = await revision('origin/' + name); if (found.sha) return found } return revision() }
  const [v2Branch, mainBranch, v2, main] = await Promise.all([branch('v2'), branch('main'), revision(channels.v2), revision(channels.main)])
  const behind = async (from: string | null, to: string | null) => from && to ? Number(await git('rev-list', '--count', from + '..' + to)) : null
  return {
    checkedAt: new Date().toISOString(),
    channel,
    landed: result.landed,
    services: (result.services ?? []).map(({ reload, ...row }) => ({ ...row, reloadable: !!reload })),
    branches: { v2: v2Branch, main: mainBranch },
    channels: { v2: { ...v2, behind: await behind(v2.sha, v2Branch.sha) }, main: { ...main, behind: await behind(main.sha, mainBranch.sha) } },
    ...(result.lastReload ? { lastReload: result.lastReload } : {}),
    run: readRun(file, channel),
  }
}

export function startUpdate(repository: string, file: string, done: (run: UpdateRun) => void, channel: Channel): UpdateRun {
  const previous = readRun(file)
  if (previous?.state === 'running') throw Error('An update is already running.')
  if (!existsSync(script(repository))) throw Error('This computer has no stale-code check at ' + script(repository))
  const child = spawn('node', [script(repository), repository, '--reload', '--json'], { cwd: repository, env: environmentFor(channel), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const started: UpdateRun = { state: 'running', channel, pid: child.pid, startedAt: new Date().toISOString() }
  save(file, started)
  let out = '', err = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  let finished = false
  const finish = (code: number | null, failure?: Error) => {
    if (finished) return
    finished = true
    let services: ServiceRow[] | undefined
    let checker: ReturnType<typeof lastJSON> | undefined
    try { checker = lastJSON(out + '\n' + err); services = checker.services } catch {}
    const failed = services?.filter(row => !row.name || row.state !== 'fresh') ?? []
    const unproven = !services?.length || services.some(row => !row.name || !row.state)
    const unsuccessful = !!failure || code !== 0 || unproven || failed.length > 0 || checker?.reloadOutcome === 'failed'
    const ended: UpdateRun = {
      ...started, finishedAt: new Date().toISOString(), services,
      state: unsuccessful ? 'failed' : 'updated',
      message: failure?.message ?? (failed.length ? failed.map(describe).join('; ') : unproven ? 'The update check did not prove every required service revision.' : code ? (err || out).trim().split(/\r?\n/).slice(-3).join(' ') : undefined),
    }
    save(file, ended)
    done(ended)
  }
  child.once('error', error => finish(null, error))
  child.once('close', code => finish(code))
  return started
}
