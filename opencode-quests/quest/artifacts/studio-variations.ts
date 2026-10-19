import { randomUUID } from 'node:crypto'
import { StudioError, validateStudioDocument } from './studio-drafts'
import { routeOf, setOf, variationSets } from './studio-picks'
import { stagesFromSteps } from '../core/steps'
import { acquireLock } from '../locking.mts'
import { requestQuestPlan } from '../runs/start-request'
import { v2QueueGeneration } from '../core/runtime-queues'
import { questReference } from '../core/references'
import type { QuestStore } from '../store'
import type { Quest } from '../types'
import type { AskToPick, DecideVariation, IterateVariations, StartVariations, StudioDocument, StudioRenderer, StudioVariation, StudioVariationSet, StudioVariations } from '../../apps/questgiver/protocol/studio'

export type QueueStart = (store: QuestStore, id: string) => unknown
export type VariationOf = { quest: string; set: string }

export const RENDERER_LABEL: Record<StudioRenderer, string> = { html: 'HTML', react: 'React', rust: 'Rust', go: 'Go', '7dtd': '7 Days to Die mod' }
const queueStart: QueueStart = (store, id) => requestQuestPlan(store, id, v2QueueGeneration())

function readQuest(store: QuestStore, id: string) {
  const quest = store.read(id)
  if (!quest) throw new StudioError('QUEST_NOT_FOUND', 'This Quest is unavailable.', 404)
  return quest
}

function withSets<T>(store: QuestStore, id: string, change: (sets: unknown[], quest: Quest) => { sets: unknown[]; value: T }): T {
  const lock = acquireLock(store.runtime, 'studio-variations-' + readQuest(store, id).id)
  try {
    const quest = readQuest(store, id)
    const saved = quest.extensions.studioVariations as { sets?: unknown[] } | undefined
    const before = Array.isArray(saved?.sets) ? saved.sets : []
    const { sets, value } = change([...before], quest)
    if (sets !== before) store.apply(quest.id, 'patched', { extensions: { ...quest.extensions, studioVariations: { ...saved, sets } } }, 'studio', { expectedRevision: quest.revision })
    return value
  } finally { lock.release() }
}

function rawSet(sets: unknown[], id: string) {
  const index = sets.findIndex(row => (row as StudioVariationSet | undefined)?.id === id)
  const set = index < 0 ? undefined : setOf(sets[index])
  if (!set) throw new StudioError('STUDIO_SET_NOT_FOUND', 'This variation set is not on the Quest. Reopen Design Studio to see its sets.', 404)
  return { index, set, raw: { ...(sets[index] as Record<string, unknown>) } }
}

export function studioVariations(store: QuestStore, id: string): StudioVariations {
  return { sets: variationSets(readQuest(store, id), other => store.read(other)) }
}

export function setAskToPick(store: QuestStore, input: AskToPick): StudioVariationSet {
  if (typeof input?.set !== 'string' || typeof input.ask !== 'boolean') throw new StudioError('INVALID_STUDIO_PICK', 'Name the variation set and whether to ask you to pick.')
  return withSets(store, input.id, sets => {
    const { index, set, raw } = rawSet(sets, input.set)
    if (!!set.askToPick === input.ask) return { sets, value: set }
    if (input.ask) { raw.askToPick = true; raw.askedAt = new Date().toISOString() } else { delete raw.askToPick; delete raw.askedAt }
    const next = [...sets]
    next[index] = raw
    return { sets: next, value: setOf(raw)! }
  })
}

function count(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new StudioError('INVALID_STUDIO_COUNT', 'Give the number of variations as a whole number, 1 or more.')
  return value as number
}

function renderer(value: unknown): StudioRenderer {
  if (typeof value !== 'string' || !(value in RENDERER_LABEL)) throw new StudioError('INVALID_STUDIO_RENDERER', 'Choose HTML, React, Rust, Go or 7 Days to Die mod.')
  return value as StudioRenderer
}

const words = (value: unknown, what: string) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new StudioError('INVALID_STUDIO_TEXT', what + ' must be text.')
  return value.trim() || undefined
}

function brief(set: { thing: string; renderer: StudioRenderer; direction?: string; from?: { variations: string[] } }, studio: Quest) {
  const sources = set.from?.variations.length ?? 0
  return [
    'Make variations of ' + set.thing + ' as a ' + RENDERER_LABEL[set.renderer] + ' UI for the Design Studio of Quest ' + questReference(studio) + ' (' + studio.title + ').',
    set.direction ? 'Direction from the user: ' + set.direction : '',
    sources === 2 ? 'Merge the two source variations into one design that keeps the best of both.' : sources ? 'Start from the source variations and iterate on them.' : '',
    'Each step is one variation. Make yours clearly different from the obvious design.',
    'Read the brief and any source variations with the quest_variation tool, action read.',
    'Work in your own checkout. Save the preview with quest_variation, action save, as an HTML entry file that shows the result.',
    set.renderer === 'html' || set.renderer === 'react' ? 'Save self-contained HTML, CSS and JavaScript. Bundle React into the page.' : 'Build it in your checkout. Save an exported HTML view, or an HTML page that shows a screenshot as a data image.',
    'Then save your step done. Do not open a pull request. Nothing from this Quest lands.',
  ].filter(Boolean).join('\n')
}

function launch(store: QuestStore, studio: Quest, set: StudioVariationSet & { renderer: StudioRenderer }, start: QueueStart) {
  const steps = Array.from({ length: set.count }, (_, index) => stagesFromSteps([{
    id: 'variation-' + (index + 1),
    title: 'Make variation ' + (index + 1) + ' of ' + set.count + ' of ' + set.thing,
    detail: 'You are variation ' + (index + 1) + ' of ' + set.count + '. Lean on your number to choose a distinct style.',
  }])[0])
  const worker = store.createNamed({
    title: 'Make ' + set.count + ' variations of ' + set.thing,
    objective: brief(set, studio), description: brief(set, studio), reward: '',
    project: studio.project, priority: studio.priority, stages: steps, contractVersion: 2,
    ...(studio.integrationOwner ? { integrationOwner: studio.integrationOwner } : {}),
    extensions: { workflow: { delivery: 'none', task: 'coding' }, studioVariationOf: { quest: studio.id, set: set.id } satisfies VariationOf },
  })
  const variations: StudioVariation[] = steps.map((step, index) => ({ id: step.id, prompt: set.thing + (set.direction ? ': ' + set.direction : '') + ' (variation ' + (index + 1) + ' of ' + set.count + ')', state: 'queued', updatedAt: new Date().toISOString() }))
  let startError: string | undefined
  try { start(store, worker.id) } catch (error) { startError = 'The workers did not start: ' + (error instanceof Error ? error.message : String(error)) }
  return { ...set, questID: worker.id, ...(worker.ref ? { questRef: worker.ref } : {}), variations, ...(startError ? { startError } : {}) }
}

function newSet(input: { thing: string; count: number; renderer: StudioRenderer; direction?: string; askToPick?: boolean; from?: { set: string; variations: string[] } }) {
  const at = new Date().toISOString()
  return { id: 'set-' + randomUUID().slice(0, 8), thing: input.thing, count: input.count, createdAt: at, renderer: input.renderer, variations: [] as StudioVariation[], ...(input.direction ? { direction: input.direction } : {}), ...(input.askToPick ? { askToPick: true, askedAt: at } : {}), ...(input.from ? { from: input.from } : {}) }
}

export function startVariations(store: QuestStore, input: StartVariations, start: QueueStart = queueStart): StudioVariationSet {
  const thing = words(input?.thing, 'The thing to vary')
  if (!thing) throw new StudioError('INVALID_STUDIO_THING', 'Name the thing to make variations of.')
  const set = newSet({ thing, count: count(input.count), renderer: renderer(input.renderer), direction: words(input.direction, 'Direction'), askToPick: input.askToPick === true })
  const studio = readQuest(store, input.id)
  if (!studio.project) throw new StudioError('STUDIO_PROJECT_REQUIRED', 'Set the Quest project folder before starting variations.')
  const started = launch(store, studio, set, start)
  return withSets(store, studio.id, sets => ({ sets: [...sets, started], value: setOf(started)! }))
}

export function iterateVariations(store: QuestStore, input: IterateVariations, start: QueueStart = queueStart): StudioVariationSet {
  if (!Array.isArray(input?.variations) || !input.variations.length || input.variations.some(id => typeof id !== 'string') || new Set(input.variations).size !== input.variations.length)
    throw new StudioError('INVALID_STUDIO_SOURCES', 'Select one or more different variations to iterate on.')
  const studio = readQuest(store, input.id)
  const source = variationSets(studio, other => store.read(other)).find(set => set.id === input.set)
  if (!source) throw new StudioError('STUDIO_SET_NOT_FOUND', 'This variation set is not on the Quest. Reopen Design Studio to see its sets.', 404)
  const missing = input.variations.filter(id => !source.variations.find(row => row.id === id)?.document)
  if (missing.length) throw new StudioError('STUDIO_SOURCE_NOT_READY', 'Iterate only on variations that show a preview.', 409)
  const set = newSet({ thing: source.thing, count: count(input.count), renderer: source.renderer ?? 'html', direction: words(input.direction, 'Direction'), askToPick: input.askToPick === true, from: { set: source.id, variations: input.variations } })
  const started = launch(store, studio, set, start)
  return withSets(store, studio.id, sets => ({ sets: [...sets, started], value: setOf(started)! }))
}

export function decideVariation(store: QuestStore, input: DecideVariation): StudioVariationSet {
  if (typeof input?.set !== 'string' || typeof input.variation !== 'string' || ![null, 'picked', 'discarded'].includes(input.decision as never))
    throw new StudioError('INVALID_STUDIO_DECISION', 'Name the variation and whether to pick it, discard it or undo that.')
  return withSets(store, input.id, sets => {
    const { index, raw } = rawSet(sets, input.set)
    const rows = (raw.variations as Record<string, unknown>[]).map(row => ({ ...row }))
    const row = rows.find(item => item.id === input.variation)
    if (!row) throw new StudioError('STUDIO_VARIATION_NOT_FOUND', 'This variation is not in the set. Reopen Design Studio to see it.', 404)
    if (input.decision === 'picked' && !row.document) throw new StudioError('STUDIO_VARIATION_NOT_READY', 'Pick a variation after it shows a preview.', 409)
    const at = new Date().toISOString()
    if (input.decision === 'picked') for (const other of rows) if (other !== row && other.state === 'picked') { other.state = 'ready'; other.updatedAt = at }
    row.state = input.decision ?? (row.document ? 'ready' : 'queued')
    row.updatedAt = at
    raw.variations = rows
    const next = [...sets]
    next[index] = raw
    return { sets: next, value: variationSets({ ...readQuest(store, input.id), extensions: { studioVariations: { sets: [raw] } } } as Quest, other => store.read(other))[0] }
  })
}

export function variationBrief(store: QuestStore, worker: Quest) {
  const of = worker.extensions.studioVariationOf as VariationOf | undefined
  if (!of) throw new StudioError('NOT_A_VARIATION_QUEST', 'This Quest makes no Design Studio variations.')
  const studio = readQuest(store, of.quest)
  const set = variationSets(studio).find(row => row.id === of.set)
  if (!set) throw new StudioError('STUDIO_SET_NOT_FOUND', 'The variation set of this Quest is gone.', 404)
  const from = set.from ? variationSets(studio).find(row => row.id === set.from!.set) : undefined
  return {
    studio, set,
    view: {
      thing: set.thing, renderer: set.renderer ?? 'html', direction: set.direction ?? null, count: set.count,
      sources: (set.from?.variations ?? []).flatMap(id => { const row = from?.variations.find(item => item.id === id); return row ? [{ id: row.id, prompt: row.prompt, route: row.route ?? null, document: row.document ?? null }] : [] }),
    },
  }
}

export function saveVariation(store: QuestStore, worker: Quest, stepID: string, document: StudioDocument, note?: string) {
  const { studio, set } = variationBrief(store, worker)
  const checked = validateStudioDocument(document)
  const run = worker.sessions.findLast(session => session.deliverables.includes(stepID))
  return withSets(store, studio.id, sets => {
    const { index, raw } = rawSet(sets, set.id)
    const rows = (raw.variations as Record<string, unknown>[]).map(row => ({ ...row }))
    const row = rows.find(item => item.id === stepID)
    if (!row) throw new StudioError('STUDIO_VARIATION_NOT_FOUND', 'Your step is not a variation of this set.', 404)
    Object.assign(row, { document: checked, state: row.state === 'picked' || row.state === 'discarded' ? row.state : 'ready', updatedAt: new Date().toISOString(), ...(note?.trim() ? { note: note.trim() } : {}), ...(run ? { runID: run.runID ?? run.callID, ...(routeOf(run) ? { route: routeOf(run) } : {}) } : {}) })
    raw.variations = rows
    const next = [...sets]
    next[index] = raw
    return { sets: next, value: { set: set.id, variation: stepID, state: row.state as string } }
  })
}
