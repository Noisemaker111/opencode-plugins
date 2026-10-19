import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, isAbsolute } from 'node:path'
import { physicalDirectory, projectIdentity, projectIdentityWithoutGit, explicitDirectory, namedDirectories } from '../quest/router-public'
import { RouterError, redact } from './host'
import {repositoryURL} from './remote'

export type Target = { id: string; root: string; directory: string; name: string; hostID?: string; remote?: string }
export function verifyTarget(directory: string): Target {
  if (!isAbsolute(directory)) throw new RouterError('ABSOLUTE_PATH_REQUIRED', 'Choose an absolute project/worktree directory')
  try {
    const real = physicalDirectory(directory)
    return { ...projectIdentity(real), directory: real, name: basename(real) }
  } catch { throw new RouterError('DIRECTORY_UNAVAILABLE', 'Project identity cannot be verified; choose its current absolute directory') }
}
export const targetKey = (t: Target) => process.platform === 'win32' ? t.directory.toLowerCase() : t.directory
export function poolTarget(directory: string): Target {
  if (!isAbsolute(directory)) throw new RouterError('ABSOLUTE_PATH_REQUIRED', 'Choose an absolute project/worktree directory')
  try {
    const real = physicalDirectory(directory), quick = projectIdentityWithoutGit(real)
    if (quick) return { ...quick, directory: real, name: basename(real) }
  } catch { throw new RouterError('DIRECTORY_UNAVAILABLE', 'Project identity cannot be verified; choose its current absolute directory') }
  return verifyTarget(directory)
}
export function revalidate(target: Target) {
  const current = verifyTarget(target.directory)
  if (current.id !== target.id || targetKey(current) !== targetKey(target)) throw new RouterError('IDENTITY_CHANGED', 'Destination identity changed; select it again')
  return { ...target, ...current }
}
export function instructions(target: Target) {
  const paths: string[] = []; let current = target.directory
  for (;;) {
    paths.unshift(join(current, 'AGENTS.md')); const parent = dirname(current); if (parent === current) break; current = parent
  }
  return paths.filter(existsSync).map(path => {
    const text = readFileSync(path, 'utf8')
    return { path, bytes: Buffer.byteLength(text), text: redact(text, null) }
  })
}
export function requestedCheckout(request?: string): Target | undefined {
  if (typeof request !== 'string' || !request.trim()) return undefined
  const checkouts: Target[] = []
  for (const directory of namedDirectories(request)) {
    try { const target = verifyTarget(directory); if (existsSync(join(target.root, '.git'))) checkouts.push(target) } catch {}
  }
  const distinct = [...new Map(checkouts.map(t => [targetKey(t), t])).values()]
  return distinct.length === 1 ? distinct[0] : undefined
}
const NOT_A_PATH = (selector: string) => `"${selector}" is not an existing absolute directory. A Windows path written inside a JavaScript string loses its backslashes; pass it with forward slashes, e.g. C:/Users/you/Projects/app.`
export const RANKED_REASON = 'Ranked by name, README and Quest history'
const NAMED_PATH = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)(?=$|[\s`'"),.:;])/g
export const namedRepoPaths = (request: string) => [...new Set([...request.matchAll(NAMED_PATH)].map(match => match[1]))].filter(path => !/^[a-z]+:/i.test(path) && !path.includes('//'))
export function onlyProjectHolding(request: string, known: Target[], exists: (path: string) => boolean = existsSync) {
  const paths = namedRepoPaths(request)
  if (!paths.length) return
  const holders = [...new Map(known.map(target => [target.directory, target])).values()].filter(target => paths.every(path => exists(join(target.directory, path))))
  return holders.length === 1 ? { target: holders[0], paths } : undefined
}
export const RANKED_CANDIDATES = 4
export const PROJECT_STANDS_OUT = 0.8
export function resolveTargets(aliases: Record<string, Target>, known: Target[], input: { selectors?: string[]; discussion?: boolean; request?: string }, ranked?: Target[]) {
  if (input.discussion) return { state: 'discussion' as const, targets: [] }
  const selectors = input.selectors?.filter(s => s.trim()) ?? []
  const named = selectors.length ? undefined : requestedCheckout(input.request)
  if (named) return { state: 'resolved' as const, targets: [named], reason: 'Checkout named by path in the request', explicit: true }
  const request = typeof input.request === 'string' && input.request.trim() ? input.request : undefined
  if (!selectors.length && request) return { state: 'clarify' as const, targets: [], candidates: (ranked ?? []).slice(0, RANKED_CANDIDATES), reason: RANKED_REASON }
  const targets: Target[] = [], candidates: Target[] = []
  for (const selector of selectors) {
    const directory = explicitDirectory(selector)
    if (directory) { targets.push(verifyTarget(directory)); continue }
    if (isAbsolute(selector)) { targets.push(verifyTarget(selector)); continue }
    if (/^[A-Za-z]:/.test(selector.trim())) throw new RouterError('ABSOLUTE_PATH_REQUIRED', NOT_A_PATH(selector.trim()))
    const remote=/^(https:\/\/|ssh:\/\/|git@)/.test(selector)?repositoryURL(selector).identity:selector
    const exact = known.filter(t => t.id === selector || t.remote === remote)
    const alias = Object.hasOwn(aliases,selector.toLowerCase())?aliases[selector.toLowerCase()]:undefined
    const matches = exact.length ? exact : alias ? [alias] : known.filter(t => t.name.toLowerCase() === selector.toLowerCase())
    if (matches.length === 1) targets.push(revalidate(matches[0])); else candidates.push(...matches)
    if (matches.length !== 1) return { state: 'clarify' as const, targets: [], candidates: [...new Map(candidates.map(t => [targetKey(t), t])).values()].slice(0, 20), reason: 'Choose one full directory for each explicit target; no work has started' }
  }
  if (!targets.length) return { state: 'clarify' as const, targets: [], candidates: known.slice(0, 20), reason: 'Choose a project directory; recent activity alone does not select one' }
  return { state: 'resolved' as const, targets: [...new Map(targets.map(t => [targetKey(t), t])).values()], reason: 'Explicit user selector', explicit: true }
}
