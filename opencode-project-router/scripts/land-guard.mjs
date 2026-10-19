#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'
import { promisify } from 'node:util'
import { retireCheckout } from '../quest/checkouts/cleanup-git.mjs'
import { worktreeRoot } from '../quest/checkouts/worktree-root.mts'
import { liveOwnership } from '../quest/checkouts/folder-owners.mjs'
import { processListing } from './process-evidence.mjs'
import { liveSessionFolders } from '../quest/checkouts/live-sessions.mjs'
import { checkoutTrees, stopCheckoutProcesses, describeProcess } from '../quest/checkouts/checkout-processes.mjs'
import { checkServices, describe, landedRef, mainCheckout, needsAction, readServices, repositoryArgument } from './fresh-services.mjs'
import { SCRATCH } from './service-reload-result.mjs'
import { CHANNELS, branchNames } from './channel-migrate.mjs'

const run = promisify(execFile)
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 1 << 26 }).then(r => r.stdout.trim(), () => '')

export async function unlanded(cwd, openPullRequest = async branch => false, landed = [], known = {}) {
  const top = await git(cwd, 'rev-parse', '--show-toplevel')
  if (!top) return []
  const reuse = known.top && resolve(known.top).toLowerCase() === resolve(top).toLowerCase() ? known : {}
  const remote = reuse.remote ?? (await git(top, 'remote')).split('\n').includes('origin')
  const defaultBranch = remote ? (await git(top, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).replace(/^origin\//, '') : ''
  const target = reuse.target ?? await landedRef(top)
  if (!target) return []
  const landing = remote ? target.replace(/^origin\//, '') : target
  const settled = new Set([landing, defaultBranch, ...CHANNELS.flatMap(branchNames)].filter(Boolean))
  const wanted = [...settled].map(name => (remote ? 'refs/remotes/origin/' : 'refs/heads/') + name)
  const present = new Set((await git(top, 'for-each-ref', '--format=%(refname)', ...wanted)).split('\n').filter(Boolean))
  const pinned = wanted.filter(ref => present.has(ref))
  const worktrees = (await git(top, 'worktree', 'list', '--porcelain')).split(/\n\n+/).map(entry => ({
    path: entry.match(/^worktree (.+)$/m)?.[1], branch: entry.match(/^branch refs\/heads\/(.+)$/m)?.[1],
  })).filter(w => w.path && existsSync(w.path) && !(w.branch && settled.has(w.branch)))
  const results = new Array(worktrees.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < worktrees.length; i = next++) {
      const { path, branch } = worktrees[i]
      const [status, cherry, beyond] = await Promise.all([git(path, 'status', '--porcelain', '--untracked-files=no'), git(path, 'cherry', target, branch ?? 'HEAD'),
        git(path, 'rev-list', branch ?? 'HEAD', '--not', ...pinned)])
      const outside = new Set(beyond.split('\n').filter(Boolean))
      const dirty = status.split('\n').filter(Boolean).length, ahead = cherry.split('\n').filter(line => line.startsWith('+') && outside.has(line.slice(2).trim())).length
      if (!dirty && !ahead) { landed.push({ path, branch }); continue }
      const pull = dirty ? false : await openPullRequest(branch, top, await git(path, 'rev-parse', 'HEAD'))
      if (pull) { if (pull === 'merged') landed.push({ path, branch }); continue }
      results[i] = `${path} (${branch ?? 'detached HEAD'}): ` + [ahead && `${ahead} commit(s) not on ${target}` + ' and no open or merged pull request at this head', dirty && `${dirty} uncommitted tracked file(s)`].filter(Boolean).join(', ')
    }
  }
  await Promise.all(Array.from({ length: Math.max(2, availableParallelism()) }, worker))
  return results.filter(Boolean)
}

const inside = (parent, path) => { const rel = relative(parent, path); return !!rel && !rel.startsWith('..') && !isAbsolute(rel) }
const topFolder = (top, path) => join(top, relative(top, path).split(sep)[0])
const isRepository = path => existsSync(join(path, '.git')) || existsSync(join(path, 'HEAD')) && existsSync(join(path, 'objects')) && existsSync(join(path, 'refs'))

export async function misplacedCheckouts(cwd) {
  const common = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!common) return []
  const top = basename(common).toLowerCase() === '.git' ? dirname(resolve(common)) : resolve(cwd)
  const home = join(top, '.claude', 'worktrees'), sibling = top + '.worktrees', found = new Map()
  const note = (where, path) => found.set(where, [...(found.get(where) ?? []), path])
  for (const entry of (await git(top, 'worktree', 'list', '--porcelain')).split(/\n\n+/)) {
    const path = entry.match(/^worktree (.+)$/m)?.[1]
    if (!path || !existsSync(path)) continue
    const at = resolve(path)
    if (inside(home, at) || at.toLowerCase() === top.toLowerCase()) continue
    if (inside(sibling, at)) note(sibling, at)
    else if (inside(top, at)) note(topFolder(top, at), at)
  }
  const walk = (dir, depth) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (isRepository(path)) candidates.push(path)
      else if (depth > 1) walk(path, depth - 1)
    }
  }
  const candidates = []
  for (const name of SCRATCH) if (existsSync(join(top, name))) walk(join(top, name), 3)
  const tips = await Promise.all(candidates.map(path => run('git', ['-C', path, 'for-each-ref', '--format=%(objectname)'], { windowsHide: true, maxBuffer: 1 << 26 })
    .then(r => r.stdout.split(/\s+/).filter(Boolean), () => [])))
  const known = new Set(await new Promise(done => {
    const all = [...new Set(tips.flat())]
    if (!all.length) return done([])
    const child = execFile('git', ['-C', top, 'cat-file', '--batch-check'], { windowsHide: true, maxBuffer: 1 << 26 }, (error, stdout) =>
      done(error ? [] : stdout.split(/\r?\n/).filter(line => line && !line.endsWith(' missing')).map(line => line.split(' ')[0])))
    child.stdin.end(all.join('\n') + '\n')
  }))
  candidates.forEach((path, i) => { if (tips[i].some(tip => known.has(tip))) note(topFolder(top, path), path) })
  return [...found].map(([where, paths]) => {
    const scratch = SCRATCH.some(name => resolve(where) === join(top, name))
    return `${where}: ${paths.length} checkout(s) outside the one checkout home ${home}` +
      (scratch ? ' (a scratch folder holds files, never checkouts)' : '') + ': ' +
      paths.map(path => relative(where, path) || basename(path)).join(', ') +
      (scratch ? '. Land what each holds, keep its evidence files, then delete the repository.'
        : '. They retire themselves once landed, or move each with git worktree move.')
  })
}

const LONG_RUNNING_WORDS = /\b(dev server|daemon|services?|deploy(?:s|ed|ing|ment)?|workers?)\b/i
const LONG_RUNNING_SCRIPTS = /\b(dev|serve|server|start|daemon|service|deploy|worker)\b/i

export async function longRunningEvidence(top, ref) {
  const tracked = ref ? (await git(top, 'ls-tree', '-r', '--name-only', ref)).split(/\r?\n/)
    : readdirSync(top).filter(name => name === 'AGENTS.md' || name === 'package.json')
  const read = async path => ref ? await git(top, 'show', ref + ':' + path) : existsSync(join(top, path)) ? readFileSync(join(top, path), 'utf8') : ''
  const found = []
  if (tracked.includes('AGENTS.md')) {
    const word = (await read('AGENTS.md')).match(LONG_RUNNING_WORDS)?.[1]
    if (word) found.push(`AGENTS.md mentions "${word}"`)
  }
  for (const path of tracked.filter(path => path === 'package.json' || path.endsWith('/package.json'))) {
    let scripts = {}
    try { scripts = JSON.parse(await read(path)).scripts ?? {} } catch { continue }
    const name = Object.entries(scripts).find(([key, command]) => LONG_RUNNING_SCRIPTS.test(key) || LONG_RUNNING_SCRIPTS.test(String(command)))?.[0]
    if (name) found.push(`${path} script "${name}"`)
  }
  return found
}

export async function unregisteredServices(cwd) {
  const top = await mainCheckout(cwd)
  if (!top) return []
  const ref = await landedRef(top)
  const { source } = await readServices(top, ref, await git(cwd, 'rev-parse', '--show-toplevel') || top)
  if (source) return []
  const evidence = await longRunningEvidence(top, ref)
  if (!evidence.length) return []
  return [`${top}: runs something long-lived (${evidence.slice(0, 3).join('; ')}) but registers no services, so the stale-code check passes it over. ` +
    `Add services.json at its root (format: ${join(dirname(fileURLToPath(import.meta.url)), 'fresh-services.mjs').replaceAll('\\', '/')}), ` +
    'or {"schema": 1, "services": []} when nothing runs.']
}

export function openPullRequests() {
  const listings = new Map()
  return async (branch, cwd, tip) => {
    if (!listings.has(cwd)) listings.set(cwd, Promise.all(['open', 'merged'].map(state =>
      run('gh', ['pr', 'list', '--state', state, '--limit', '1000', '--json', 'headRefName,headRefOid'], { cwd, windowsHide: true, maxBuffer: 1 << 26 })
        .then(r => JSON.parse(r.stdout), () => []))).then(([open, merged]) => ({
      branches: new Set(open.map(row => row.headRefName)), open: new Set(open.map(row => row.headRefOid)), merged: new Set(merged.map(row => row.headRefOid)),
    })))
    const known = await listings.get(cwd)
    return branch && known.branches.has(branch) || tip && known.open.has(tip) ? 'open' : tip && known.merged.has(tip) ? 'merged' : false
  }
}

const settledNames = new Set([...CHANNELS.flatMap(branchNames)])

async function landingTarget(top, remote = undefined) {
  remote ??= (await git(top, 'remote')).split(/\r?\n/).includes('origin')
  const ref = await landedRef(top)
  return { remote, target: ref, tip: ref ? await git(top, 'rev-parse', '--verify', '--quiet', ref + '^{commit}') : '' }
}

const QUEST_LOCK = /^Quest run ([^ ]+)(?: on [^ ]+)? owns this checkout$/

function lockWrittenAt(path) {
  try {
    const pointer = readFileSync(join(path, '.git'), 'utf8').match(/^gitdir: (.+)$/m)?.[1]?.trim()
    return pointer ? statSync(join(resolve(path, pointer), 'locked')).mtimeMs : undefined
  } catch { return undefined }
}

export function lockJudge({ ownership, processes }) {
  return (reason, path) => {
    const quest = QUEST_LOCK.exec(reason)
    if (quest) {
      if (!ownership.run) return 'locked for Quest run ' + quest[1]
      const run = ownership.run(quest[1])
      return run ? `locked for Quest run ${quest[1]}, which is live: ${run.status.why}` : false
    }
    if (!processes) return 'locked, and the running processes could not be listed to check its holder'
    const at = lockWrittenAt(path)
    const holders = checkoutTrees(processes, { checkouts: [path], self: -1 }).flatMap(tree => tree.processes).filter(entry => !at || !entry.createdAt || entry.createdAt <= at)
    return holders.length ? 'locked and held by ' + holders.map(describeProcess).join(', ') : false
  }
}

export function directorySize(path) {
  let total = 0
  let entries = []
  try { entries = readdirSync(path, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const at = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += directorySize(at)
    else try { total += lstatSync(at).size } catch {}
  }
  return total
}

export const gigabytes = bytes => (bytes / 1024 ** 3).toFixed(2) + ' GB'

const originTips = async top => new Map((await git(top, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin')).split('\n').filter(Boolean).map(row => row.split(' ')))
const mergedRefs = async (top, target, prefix) => new Set((await git(top, 'for-each-ref', '--merged=' + target, '--format=%(refname)', prefix)).split('\n').filter(Boolean))

export async function retire(cwd, landed, { openPullRequest = async () => false, keep = [process.cwd()], ownership = liveOwnership(), sessions = liveSessionFolders(), top, landing, registry, lockHeld = lockJudge({ ownership }), dryRun = false } = {}) {
  const removed = [], kept = []
  top ??= await mainCheckout(cwd)
  if (!top) return { removed, kept, remoteBranches: [] }
  landing ??= await landingTarget(top)
  const { remote, target } = landing
  registry ??= await readServices(top, target, cwd)
  const sibling = top + '.worktrees', configured = worktreeRoot()
  const holds = [cwd, ...keep, ...sessions.map(held => held.path)].map(path => resolve(path).toLowerCase())
  const deleteRemote = []
  let remoteTips, remoteMerged
  for (const { path, branch } of landed) {
    const at = resolve(path)
    if (at.toLowerCase() === top.toLowerCase()) continue
    if (!inside(top, at) && !inside(sibling, at) && !(configured && inside(configured, at))) continue
    let outcome
    try { outcome = retireCheckout({ root: top, path, branch, tagName: branch ?? basename(path), holds, registryHere: cwd, registry, ownership, lockHeld, dryRun }) }
    catch (error) { kept.push([path, 'git refused it: ' + (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]]); continue }
    if (outcome.failure === 'service-registry') throw Error(outcome.reason)
    if (!outcome.retired) { kept.push([path, outcome.reason, outcome.claims]); continue }
    const tip = outcome.tip
    removed.push(path)
    if (!branch) continue
    if (!remote) continue
    remoteTips ??= await originTips(top)
    const remoteTip = remoteTips.get('refs/remotes/origin/' + branch)
    if (!remoteTip) continue
    const pull = await openPullRequest(branch, top, remoteTip)
    if (pull === 'open') continue
    if (remoteTip === tip || pull === 'merged' || target && (await (remoteMerged ??= mergedRefs(top, target, 'refs/remotes/origin'))).has('refs/remotes/origin/' + branch)) deleteRemote.push(branch)
  }
  const remoteBranches = await sweepBranches(top, openPullRequest, deleteRemote, landing, dryRun)
  if (!dryRun && removed.length && remote) await git(top, 'push', '--quiet', 'origin', 'refs/tags/archive/*')
  return { removed, kept, remoteBranches }
}

async function sweepBranches(top, openPullRequest, deleteRemote, { remote, target, tip: targetTip }, dryRun = false) {
  if (!target) return []
  const settled = new Set([...settledNames, target.replace(/^origin\//, '')])
  const checkedOut = new Set((await git(top, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('branch refs/heads/')).map(line => line.slice(18)))
  const behind = async (ref, prefix) => {
    const rows = (await git(top, 'for-each-ref', '--format=%(refname) %(objectname)', ref)).split('\n').filter(Boolean)
    const merged = rows.length ? await mergedRefs(top, target, ref) : new Set()
    const found = []
    for (const row of rows) {
      const [full, tip] = row.split(' '), name = full.slice(prefix.length)
      if (!name || name === 'HEAD' || settled.has(name) || tip === targetTip) continue
      if (checkedOut.has(name)) continue
      if (merged.has(full) && await openPullRequest(name, top, tip) !== 'open') found.push(name)
    }
    return found
  }
  if (!dryRun) for (const name of await behind('refs/heads', 'refs/heads/')) if (!checkedOut.has(name)) await git(top, 'branch', '-D', name)
  if (!remote) return []
  const gone = [...new Set([...deleteRemote, ...await behind('refs/remotes/origin', 'refs/remotes/origin/')])]
  if (dryRun) return gone
  for (let i = 0; i < gone.length; i += 50) await git(top, 'push', '--quiet', 'origin', '--delete', ...gone.slice(i, i + 50))
  await git(top, 'fetch', '--quiet', '--prune', 'origin')
  return gone
}

export async function retireLanded(cwd, { openPullRequest = openPullRequests(), keep = [process.cwd()], ownership = liveOwnership(), sessions, processes, dryRun = false } = {}) {
  const top = await mainCheckout(cwd)
  const remote = top ? (await git(top, 'remote')).split(/\r?\n/).includes('origin') : false
  if (remote) await run('git', ['-C', top, 'fetch', '--quiet', 'origin'], { windowsHide: true, timeout: 60_000 }).catch(() => {})
  const landing = await landingTarget(top, remote)
  const registry = await readServices(top, landing.target, cwd)
  const landed = []
  const problems = await unlanded(cwd, openPullRequest, landed, { top, remote, target: landing.target })
  if (processes === undefined) { const listed = await processListing(); processes = listed.unavailable ? null : listed.processes }
  const lockHeld = lockJudge({ ownership, processes })
  return { problems, landed, registry, ...await retire(cwd, landed, { openPullRequest, keep, top, landing, registry, ownership, lockHeld, dryRun, ...(sessions ? { sessions } : {}) }) }
}

const IN_USE = new Set(['locked', 'in use as a working directory', 'a Quest run still needs it', 'registered managed checkout'])

export async function stopLeftProcesses(cwd, { removed = [], kept = [], landed = [], registry, self = process.pid, listing } = {}) {
  const top = await mainCheckout(cwd)
  if (!top) return { stopped: [], failed: [], inUse: [] }
  registry ??= await readServices(top, await landedRef(top), cwd)
  const key = path => resolve(path).toLowerCase()
  const managed = path => registry.managedCheckouts.some(held => key(held) === key(path) || inside(held, path) || inside(path, held))
  const retired = new Set(removed.map(key)), held = new Map(kept.map(([path, why]) => [key(path), why]))
  const idle = new Set(landed.map(({ path }) => key(path)).filter(path => !IN_USE.has(held.get(path))))
  const left = path => retired.has(key(path)) || idle.has(key(path)) || !existsSync(path)
  const outcome = await stopCheckoutProcesses({ homes: [join(top, '.claude', 'worktrees'), top + '.worktrees', worktreeRoot()].filter(Boolean), self, ...(listing ? { listing } : {}),
    stop: tree => tree.owner === 'none' && !managed(tree.checkout) && left(tree.checkout) })
  if (outcome.unavailable) return { unavailable: outcome.unavailable, stopped: [], failed: [], inUse: [] }
  return { stopped: outcome.stopped, failed: outcome.failed, inUse: outcome.kept.filter(tree => tree.owner === 'none' && !managed(tree.checkout)) }
}

const byCheckout = rows => Object.entries(rows.reduce((groups, row) => ({ ...groups, [row.checkout]: [...(groups[row.checkout] ?? []), row] }), {}))

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/').replace(/^\//, '')}`) {
  const repo = repositoryArgument(process.argv.slice(2).find(arg => !arg.startsWith('--'))) ?? process.cwd()
  const dryRun = process.argv.includes('--dry-run')
  const { problems, removed, kept, remoteBranches, landed, registry } = await retireLanded(repo, { dryRun })
  const left = dryRun ? { stopped: [], failed: [], inUse: [] } : await stopLeftProcesses(repo, { removed, kept, landed, registry })
  if (left.unavailable) console.log('processes left in checkouts were not checked: ' + left.unavailable)
  for (const [checkout, rows] of byCheckout(left.stopped)) console.log(`stopped ${rows.length} process(es) with no live session left running from ${checkout}: ` + rows.map(row => describeProcess(row) + ' (' + row.command + ')').join(', '))
  for (const [checkout, rows] of byCheckout(left.failed)) console.log(`could not stop ${rows.length} process(es) left running from ${checkout}: ` + rows.map(row => describeProcess(row) + ' (' + row.error + ')').join(', '))
  for (const [checkout, trees] of byCheckout(left.inUse)) console.log(`${trees.length} process tree(s) with no live session run from ${checkout}, which is still in use: ` + trees.map(tree => describeProcess(tree.processes[0]) + ' (' + tree.processes[0].command + ')').join(', '))
  const freed = new Set(left.stopped.map(row => resolve(row.checkout).toLowerCase()))
  const retry = landed.filter(({ path }) => freed.has(resolve(path).toLowerCase()) && kept.some(([held, why]) => held === path && why.startsWith('git refused to remove it')))
  if (retry.length && !dryRun) {
    const again = await retire(repo, retry, { openPullRequest: openPullRequests(), registry })
    removed.push(...again.removed)
    for (const path of again.removed) kept.splice(kept.findIndex(([held]) => held === path), 1)
  }
  for (const line of problems) console.log(line)
  const misplaced = await misplacedCheckouts(repo)
  for (const line of misplaced) console.log(line)
  for (const [path, why, claims] of kept) console.log(`${path}: kept, ${claims ?? why}`)
  if (dryRun) {
    const sizes = removed.map(path => [path, directorySize(path)])
    for (const [path, bytes] of sizes) console.log(`would retire ${path} (${gigabytes(bytes)})`)
    console.log(`would retire ${removed.length} landed worktree(s), recovering ${gigabytes(sizes.reduce((sum, [, bytes]) => sum + bytes, 0))}, and delete ${remoteBranches.length} landed remote branch(es); would keep ${kept.length} landed: ` + Object.entries(kept.reduce((n, [, why]) => ({ ...n, [why]: (n[why] ?? 0) + 1 }), {})).map(([why, n]) => `${n} ${why}`).join(', '))
  } else console.log(`retired ${removed.length} landed worktree(s), deleted ${remoteBranches.length} landed remote branch(es); kept ${kept.length} landed: ` + Object.entries(kept.reduce((n, [, why]) => ({ ...n, [why]: (n[why] ?? 0) + 1 }), {})).map(([why, n]) => `${n} ${why}`).join(', '))
  if (problems.length) {
    console.log(`${problems.length} worktree(s) hold work that has not landed. Land each (commit, push, pull request into the landing branch) or record why it stays, before starting new work.`)
    process.exitCode = 1
  }
  if (misplaced.length) process.exitCode = 1
  const unregistered = await unregisteredServices(repo)
  for (const line of unregistered) console.log(line)
  if (unregistered.length) process.exitCode = 1
  const services = await checkServices(repo)
  const stale = services.services.filter(needsAction)
  for (const row of stale) console.log('service ' + describe(row))
  if (stale.length) {
    console.log(`${stale.length} service(s) do not run what landed on ${services.landed}. Reload and verify them: node ${join(dirname(fileURLToPath(import.meta.url)), 'fresh-services.mjs').replaceAll('\\', '/')} ${services.top.replaceAll('\\', '/')} --reload`)
    process.exitCode = 1
  }
}
