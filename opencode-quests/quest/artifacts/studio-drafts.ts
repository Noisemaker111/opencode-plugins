import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { projectIdentity } from '../core/project'
import { resolveDeliveryPolicy } from '../landing/delivery-policy.mjs'
import { acquireLock, LockBusyError } from '../locking.mts'
import type { QuestStore } from '../store'
import type { Quest } from '../types'
import type { StudioDocument, StudioDraft, StudioTarget, SaveStudioDraft, PromoteStudioDraft } from '../../apps/questgiver/protocol/studio'

const targets = new Set(['quest-card', 'board-row', 'result-card', 'custom'])
const execute = promisify(execFile)
const promotions = new Map<string, Promise<StudioDraft>>()

export class StudioError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

function targetOf(value: unknown): StudioTarget {
  if (typeof value !== 'string' || !targets.has(value)) throw new StudioError('INVALID_STUDIO_TARGET', 'Choose a starting target.')
  return value as StudioTarget
}

export function validateStudioDocument(value: unknown): StudioDocument {
  const doc = value as StudioDocument | undefined
  if (!doc || typeof doc.renderer !== 'string' || !doc.renderer.trim() || !Array.isArray(doc.files) || !doc.files.length)
    throw new StudioError('INVALID_STUDIO_DOCUMENT', 'Choose a renderer and include the preview files.')
  const paths = new Set<string>()
  for (const file of doc.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string' || !file.path || file.path.includes('\\') || file.path.includes(':') || isAbsolute(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
      throw new StudioError('INVALID_STUDIO_PATH', 'Use relative preview file names without parent folders or Git metadata.')
    const key = file.path.toLowerCase()
    if (paths.has(key)) throw new StudioError('INVALID_STUDIO_PATH', 'Each preview file must have a different name.')
    paths.add(key)
  }
  if (typeof doc.entry !== 'string' || !doc.files.some(file => file.path === doc.entry)) throw new StudioError('INVALID_STUDIO_ENTRY', 'Select an entry file included in the draft.')
  return structuredClone(doc)
}

function readQuest(store: QuestStore, id: string) {
  const quest = store.read(id)
  if (!quest) throw new StudioError('QUEST_NOT_FOUND', 'This Quest is unavailable.', 404)
  return quest
}

export function studioDrafts(store: QuestStore, id: string): { drafts: StudioDraft[] } {
  const quest = readQuest(store, id)
  const drafts = quest.extensions.studioDrafts
  return { drafts: structuredClone(Array.isArray(drafts) ? drafts as StudioDraft[] : []) }
}

function persist(store: QuestStore, quest: Quest, draft: StudioDraft) {
  const drafts = studioDrafts(store, quest.id).drafts.filter(item => item.target !== draft.target)
  store.apply(quest.id, 'patched', { extensions: { ...quest.extensions, studioDrafts: [...drafts, draft] } }, 'studio', { expectedRevision: quest.revision })
  return structuredClone(draft)
}

export function saveStudioDraft(store: QuestStore, input: SaveStudioDraft): StudioDraft {
  const target = targetOf(input.target), document = validateStudioDocument(input.document)
  const quest = readQuest(store, input.id), prior = studioDrafts(store, quest.id).drafts.find(item => item.target === target)
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== (prior?.revision ?? 0))
    throw new StudioError('STUDIO_DRAFT_CONFLICT', 'This draft changes on another page. Keep your edits and reopen the saved draft before saving.', 409)
  if (prior && JSON.stringify(prior.document) === JSON.stringify(document)) return prior
  if (prior?.promotion?.state === 'preparing') throw new StudioError('STUDIO_PROMOTION_ACTIVE', 'This saved draft has a promotion in progress. Retry that promotion before changing the draft.', 409)
  return persist(store, quest, { target, revision: (prior?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), document })
}

async function command(cwd: string, name: string, args: string[]) {
  try {
    const result = await execute(name, args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } })
    return result.stdout.trim()
  } catch (error) {
    const failure = error as Error & { stderr?: string }
    throw new StudioError('STUDIO_PROMOTION_FAILED', failure.stderr?.trim() || failure.message, 502)
  }
}

const git = (cwd: string, args: string[]) => command(cwd, 'git', ['-c', 'core.longpaths=true', ...args])

function inside(root: string, file: string) {
  const path = relative(root, file)
  if (!path || path === '..' || path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(path))
    throw new StudioError('INVALID_STUDIO_PATH', 'The exported files must stay in the draft checkout.')
}

function writeExport(checkout: string, path: string, content: string) {
  const destination = resolve(checkout, path)
  inside(checkout, destination)
  for (let folder = dirname(destination); folder !== checkout; folder = dirname(folder)) {
    inside(checkout, folder)
    if (existsSync(folder) && (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory()))
      throw new StudioError('INVALID_STUDIO_PATH', 'A draft export folder is not an ordinary folder.')
  }
  mkdirSync(dirname(destination), { recursive: true })
  inside(realpathSync(checkout), realpathSync(dirname(destination)))
  if (existsSync(destination)) throw new StudioError('STUDIO_EXPORT_EXISTS', 'The exported file already exists. Keep it and save a new draft revision.')
  writeFileSync(destination, content, { encoding: 'utf8', flag: 'wx' })
}

function updatePromotion(store: QuestStore, id: string, target: StudioTarget, revision: number, promotion: StudioDraft['promotion']) {
  const quest = readQuest(store, id), draft = studioDrafts(store, id).drafts.find(item => item.target === target)
  if (!draft || draft.revision !== revision) return draft
  return persist(store, quest, { ...draft, promotion })
}

export async function promoteStudioDraft(store: QuestStore, input: PromoteStudioDraft): Promise<StudioDraft> {
  const target = targetOf(input.target)
  if (input.confirmed !== true) throw new StudioError('STUDIO_CONFIRMATION_REQUIRED', 'Press Promote to pull request to publish this draft.')
  const quest = readQuest(store, input.id), draft = studioDrafts(store, quest.id).drafts.find(item => item.target === target)
  if (!draft || draft.revision !== input.revision) throw new StudioError('STUDIO_DRAFT_CONFLICT', 'Save the current draft before promoting it.', 409)
  if (draft.promotion?.state === 'done') return draft
  const key = store.runtime + ':' + quest.id + ':' + target + ':' + draft.revision
  const pending = promotions.get(key)
  if (pending) return pending
  let lock
  try { lock = acquireLock(store.runtime, 'studio-promotion:' + quest.id + ':' + target, { timeoutMs: 0 }) }
  catch (error) {
    if (error instanceof LockBusyError) throw new StudioError('STUDIO_PROMOTION_ACTIVE', 'This draft has a promotion in progress on another host. Reopen the saved draft when it finishes.', 409)
    throw error
  }
  const run = promote(store, quest, draft)
  promotions.set(key, run)
  try { return await run } finally { promotions.delete(key); lock.release() }
}

async function promote(store: QuestStore, quest: Quest, draft: StudioDraft): Promise<StudioDraft> {
  const root = quest.project?.root
  if (!root) throw new StudioError('STUDIO_PROJECT_REQUIRED', 'Set the Quest project folder before creating a pull request.')
  const identity = projectIdentity(root)
  if (quest.project?.id && quest.project.id !== identity.id) throw new StudioError('STUDIO_PROJECT_CHANGED', 'The Quest project no longer matches this folder.')
  const { policy } = resolveDeliveryPolicy(identity.root)
  if (policy.method !== 'pull-request' || !policy.remote) throw new StudioError('STUDIO_PULL_REQUEST_REQUIRED', 'Set a pull request delivery policy for this project.')
  if (policy.pullRequest?.open) throw new StudioError('STUDIO_CUSTOM_DELIVERY', 'This project uses a custom pull request command. Its Design Studio promotion must support that command.')
  const reference = quest.ref ?? quest.id
  const digest = createHash('sha256').update(JSON.stringify(draft.document)).digest('hex').slice(0, 12)
  const branch = `studio/${reference}/${draft.target}-${draft.revision}-${digest}`
  const checkout = join(store.runtime, 'studio', reference, draft.target, String(draft.revision))
  const promotion = { state: 'preparing' as const, revision: draft.revision, branch, checkout }
  updatePromotion(store, quest.id, draft.target, draft.revision, promotion)
  try {
    const remoteURL = await git(identity.root, ['remote', 'get-url', policy.remote])
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[\w.-]+\/[\w.-]+(?:\.git)?$/.test(remoteURL))
      throw new StudioError('STUDIO_GITHUB_REQUIRED', 'This project remote does not support GitHub pull requests.')
    const repository = remoteURL.replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/, '').replace(/\.git$/, '')
    await command(identity.root, 'gh', ['auth', 'status'])
    const existing = await command(identity.root, 'gh', ['pr', 'list', '--repo', repository, '--head', branch, '--state', 'all', '--json', 'url'])
    const found = JSON.parse(existing) as { url: string }[]
    if (found.length) return updatePromotion(store, quest.id, draft.target, draft.revision, { ...promotion, state: 'done', url: found[0].url }) ?? draft
    if (!existsSync(checkout)) {
      await git(identity.root, ['fetch', policy.remote, policy.into])
      mkdirSync(dirname(checkout), { recursive: true })
      await git(identity.root, ['worktree', 'add', '-b', branch, checkout, 'FETCH_HEAD'])
    }
    if (await git(checkout, ['branch', '--show-current']) !== branch) throw new StudioError('STUDIO_CHECKOUT_CHANGED', 'The draft checkout branch changes. Keep it and save a new revision.')
    if (projectIdentity(checkout).id !== identity.id) throw new StudioError('STUDIO_CHECKOUT_CHANGED', 'The draft checkout belongs to a different project.')
    const exportRoot = `design-studio/${reference}/${draft.target}/${draft.revision}-${digest}`
    const commitTitle = `Design Studio: ${quest.title} (${draft.target})`
    const metadata = JSON.stringify({ quest: reference, target: draft.target, revision: draft.revision, document: draft.document }, null, 2) + '\n'
    const savedCommit = await git(checkout, ['log', '-1', '--format=%s'])
    if (savedCommit !== commitTitle) {
      if (await git(checkout, ['status', '--porcelain'])) throw new StudioError('STUDIO_CHECKOUT_CHANGED', 'The draft checkout has unfinished files. Keep them and save a new revision.')
      for (const file of draft.document.files) writeExport(checkout, exportRoot + '/files/' + file.path, file.content)
      writeExport(checkout, exportRoot + '/quest-draft.json', metadata)
      await git(checkout, ['add', '--', exportRoot])
      await git(checkout, ['commit', '-m', commitTitle])
    }
    if (await git(checkout, ['status', '--porcelain'])) throw new StudioError('STUDIO_CHECKOUT_CHANGED', 'The draft checkout has unrelated files. Keep them and save a new revision.')
    const exported = [...draft.document.files.map(file => ({ path: exportRoot + '/files/' + file.path, content: file.content })), { path: exportRoot + '/quest-draft.json', content: metadata }]
    const changed = (await git(checkout, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).split(/\r?\n/).filter(Boolean)
    if (JSON.stringify([...changed].sort()) !== JSON.stringify(exported.map(file => file.path).sort()) || exported.some(file => readFileSync(join(checkout, file.path), 'utf8') !== file.content))
      throw new StudioError('STUDIO_CHECKOUT_CHANGED', 'The committed export no longer matches the saved draft. Keep it and save a new revision.')
    await git(checkout, ['push', '--set-upstream', policy.remote, branch])
    const url = await command(checkout, 'gh', ['pr', 'create', '--repo', repository, '--base', policy.into, '--head', branch, '--title', commitTitle, '--body', `Export the saved Design Studio draft for ${quest.title}.\n\nTarget: ${draft.target}\nRenderer: ${draft.document.renderer}\nEntry: ${exportRoot}/files/${draft.document.entry}\n\nThis pull request exports preview files. It does not replace existing pages or controls. Review and integrate the design before merging.`])
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)) throw new StudioError('STUDIO_PULL_REQUEST_UNKNOWN', 'GitHub does not return a pull request link. Retry to find the existing pull request.')
    return updatePromotion(store, quest.id, draft.target, draft.revision, { ...promotion, state: 'done', url }) ?? draft
  } catch (error) {
    updatePromotion(store, quest.id, draft.target, draft.revision, { ...promotion, state: 'failed', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
