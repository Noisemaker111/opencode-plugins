import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { modelRouterRuntime, askModelRouter, type ModelRouterHost } from '../quest/routing/model-router-public'
import { redact } from './host'
import { targetKey, poolTarget, type Target } from './resolution'
import type { Storage } from './memory'
import { rankProjects, remoteName, type QuestHistory } from './retrieve'
import { routerQuestHistory } from '../quest/router-public'

export type ProjectCard = { name: string; title?: string; directory: string; remote?: string; about: string; hub?: string }
export type JudgedCandidate = Target & { probability: number }
export type ProjectJudgment = { state: 'judged'; candidates: JudgedCandidate[]; reason: string; model: string }
export type RankedTarget = { target: Target; card: ProjectCard; score: number }
export const MODEL_ROUTER_OPTIONS = 8

const descriptionFiles = ['README.md', 'readme.md', 'README', 'AGENTS.md']
function descriptionFile(directory: string) {
  for (const name of descriptionFiles) {
    const path = join(directory, name)
    try { if (existsSync(path) && statSync(path).isFile()) return { path, mtimeMs: statSync(path).mtimeMs } } catch {}
  }
}
export function projectTitle(text: string) {
  const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1] ?? text.split(/\r?\n/).find(line => line.trim())?.trim()
  return heading && heading.length <= 120 ? redact(heading, heading.length) : undefined
}
export function projectAbout(text: string) {
  const heading = [...text.matchAll(/^#{1,6} .*$/gm)].find(match => text.slice(0, match.index).trim().length > 0)
  const opening = (heading ? text.slice(0, heading.index) : text).trim()
  return redact(opening, opening.length)
}
const isCheckout = (directory: string) => existsSync(join(directory, '.git'))
export function checkoutRemote(directory: string) {
  try {
    const lines = readFileSync(join(directory, '.git', 'config'), 'utf8').split(/\r?\n/)
    const start = lines.findIndex(line => line.trim() === '[remote "origin"]')
    if (start < 0) return undefined
    for (const line of lines.slice(start + 1)) {
      if (line.trim().startsWith('[')) break
      const [key, ...value] = line.split('=')
      if (key.trim() === 'url') { const url = value.join('=').trim(); return redact(url, url.length) }
    }
  } catch {}
  return undefined
}
const hubFiles = (directory: string) => ['AGENTS.md', 'README.md'].map(name => join(dirname(directory), name))
export function hubSection(directory: string) {
  const file = hubFiles(directory).find(existsSync)
  if (!file) return undefined
  const text = readFileSync(file, 'utf8'), name = basename(directory).toLowerCase()
  const headings = [...text.matchAll(/^#{1,6} .*$/gm)]
  const at = headings.findIndex(match => match[0].toLowerCase().includes(name))
  if (at < 0) return undefined
  const section = text.slice(headings[at].index, headings[at + 1]?.index).trim()
  return redact(section, section.length)
}
export function projectCard(target: Target): ProjectCard {
  const file = descriptionFile(target.directory)
  const source = file ? readFileSync(file.path, 'utf8') : ''
  const about = file ? projectAbout(source) : '', title = file ? projectTitle(source) : undefined
  const hub = hubSection(target.directory), remote = target.remote ?? checkoutRemote(target.directory)
  return { name: target.name, ...(title ? { title } : {}), directory: target.directory, ...(remote ? { remote } : {}), about, ...(hub ? { hub } : {}) }
}
const fileStamp = (path: string) => { try { const stat = statSync(path); return stat.isFile() ? path + '@' + stat.mtimeMs : '-' } catch { return '-' } }
export async function cachedProjectCard(storage: Storage, target: Target) {
  const stamp = [descriptionFile(target.directory)?.path, ...hubFiles(target.directory)].map(path => path ? fileStamp(path) : '-').join('|')
  const key = 'card2/' + targetKey(target)
  let saved: any
  try { saved = await storage.get(key) } catch {}
  if (saved?.stamp === stamp && saved.card) return saved.card as ProjectCard
  const card = projectCard(target)
  await storage.set(key, { stamp, card })
  return card
}
const generationFolder = (directory: string) => {
  const path = directory.replace(/\\/g, '/')
  return /(^|\/)\.(channels|worktrees|evidence)(\/|$)/.test(path) || /(^|\/)\.claude\/worktrees(\/|$)/.test(path) || /(^|\/)[^/]+\.worktrees(\/|$)/.test(path) || /\/generations\/gen-/.test(path)
}
export function projectFolderRows(parent: string): { directory: string }[] {
  try { return readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => ({ directory: join(parent, entry.name) })) } catch { return [] }
}
export function expandHubs(targets: Target[], verify: (directory: string) => Target = poolTarget): Target[] {
  return targets.flatMap(target => {
    if (isCheckout(target.directory)) return [target]
    let children: Target[] = []
    try {
      children = readdirSync(target.directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && isCheckout(join(target.directory, entry.name)))
        .flatMap(entry => { try { return [{ ...verify(join(target.directory, entry.name)), ...(target.hostID ? { hostID: target.hostID } : {}) }] } catch { return [] } })
    } catch {}
    return children.length ? children : [target]
  })
}
export function modelRouterTargets(targets: Target[], pinned: Target[] = []): Target[] {
  const pinnedIDs = new Set(pinned.map(target => target.id))
  const isRoot = (target: Target) => targetKey(target) === targetKey({ directory: target.root } as Target)
  const named = (target: Target) => basename(target.directory).toLowerCase() === remoteName(target.remote ?? checkoutRemote(target.directory))?.toLowerCase()
  const byIdentity = new Map<string, Target>()
  for (const target of expandHubs(targets)) {
    if (generationFolder(target.directory)) continue
    const kept = byIdentity.get(target.id)
    if (!kept || (isRoot(target) && !isRoot(kept)) || (isRoot(target) === isRoot(kept) && named(target) && !named(kept))) byIdentity.set(target.id, target)
  }
  const better = (target: Target, kept: Target) => {
    const hubbed = Number(!!hubSection(target.directory)) - Number(!!hubSection(kept.directory))
    return hubbed ? hubbed > 0 : named(target) && !named(kept)
  }
  const byRemote = new Map<string, Target>()
  for (const target of byIdentity.values()) {
    const remote = pinnedIDs.has(target.id) ? 'pinned:' + target.id : (target.remote ?? checkoutRemote(target.directory))?.replace(/\.git$/, '').toLowerCase() ?? 'directory:' + targetKey(target)
    const kept = byRemote.get(remote)
    if (!kept || better(target, kept)) byRemote.set(remote, target)
  }
  return [...byRemote.values()]
}
export type RankContext = { history?: QuestHistory; aliases?: Record<string, Target>; pinned?: Target[]; home?: Target }
export async function rankTargets(storage: Storage, targets: Target[], request: string, context: RankContext = {}): Promise<RankedTarget[]> {
  const history = context.history ?? routerQuestHistory(), aliases = Object.entries(context.aliases ?? {})
  const rows: { id: string; name: string; title?: string; hubName?: string; folder: string; aliases: string[]; remote?: string; about: string; hub?: string; target: Target; card: ProjectCard }[] = []
  for (const target of modelRouterTargets(targets, context.pinned)) {
    const card = await cachedProjectCard(storage, target)
    rows.push({ id: target.id, name: card.name, title: card.title, hubName: hubFiles(target.directory).some(existsSync) ? basename(dirname(target.directory)) : undefined, folder: basename(target.directory), aliases: aliases.flatMap(([alias, named]) => named.id === target.id ? [alias] : []), remote: card.remote, about: card.about, hub: card.hub, target, card })
  }
  return rankProjects(request, rows, history, context.home?.id).map(({ card: row, score }) => ({ target: row.target, card: row.card, score }))
}
export async function modelRouterProjects(
  ctx: { session: ModelRouterHost; storage: Storage },
  sessionDirectory: string,
  request: string,
  targets: Target[],
  dependencies: { ask?: typeof askModelRouter; runtime?: typeof modelRouterRuntime } & RankContext = {},
): Promise<ProjectJudgment | undefined> {
  const ask = dependencies.ask ?? askModelRouter, runtime = dependencies.runtime ?? modelRouterRuntime
  const ranked = (await rankTargets(ctx.storage, targets, request, dependencies)).slice(0, MODEL_ROUTER_OPTIONS)
  const known = new Map(ranked.map((row, index) => ['o' + (index + 1), row.target]))
  const options = ranked.map((row, index) => ({ id: 'o' + (index + 1), facts: { name: row.card.name, about: row.card.about, ...(row.card.hub ? { hub: row.card.hub } : {}) } }))
  const judgment = await ask(ctx.session, { kind: 'project', runtime: runtime(), directory: sessionDirectory, question: request, options })
  if (!judgment) return undefined
  return {
    state: 'judged',
    candidates: judgment.order.flatMap(id => { const target = known.get(id); return target ? [{ ...target, probability: judgment.probabilities[id] }] : [] }),
    reason: judgment.reason,
    model: judgment.model,
  }
}
