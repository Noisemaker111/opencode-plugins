import type { Quest } from '../types'
import type { StudioDocument, StudioRenderer, StudioVariation, StudioVariationSet, StudioVariationState } from '../../apps/questgiver/protocol/studio'

export const PICK_ACTION = 'Open Design Studio, then Variation Studio, and pick one.'

export type QuestLookup = (id: string) => Quest | undefined

const states = new Set<StudioVariationState>(['queued', 'running', 'ready', 'failed', 'picked', 'discarded'])
const renderers = new Set<StudioRenderer>(['html', 'react', 'rust', 'go', '7dtd'])
const unfinished = new Set<StudioVariationState>(['queued', 'running'])
const activeRun = new Set(['planned', 'executing', 'waiting', 'blocked'])

function documentOf(value: unknown): StudioDocument | undefined {
  const doc = value as StudioDocument | undefined
  if (!doc || typeof doc !== 'object' || typeof doc.renderer !== 'string' || typeof doc.entry !== 'string' || !Array.isArray(doc.files)) return undefined
  const files = doc.files.filter(file => file && typeof file.path === 'string' && typeof file.content === 'string').map(file => ({ path: file.path, content: file.content }))
  return files.length ? { renderer: doc.renderer, entry: doc.entry, files } : undefined
}

function variationOf(value: unknown): StudioVariation | undefined {
  const row = value as StudioVariation | undefined
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || typeof row.prompt !== 'string' || !states.has(row.state)) return undefined
  const document = documentOf(row.document)
  return {
    id: row.id, prompt: row.prompt, state: row.state, updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    ...(typeof row.route === 'string' ? { route: row.route } : {}), ...(typeof row.runID === 'string' ? { runID: row.runID } : {}), ...(typeof row.note === 'string' ? { note: row.note } : {}),
    ...(document ? { document } : {}),
  }
}

export function setOf(value: unknown): StudioVariationSet | undefined {
  const row = value as StudioVariationSet | undefined
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || typeof row.thing !== 'string' || !Array.isArray(row.variations)) return undefined
  const variations = row.variations.map(variationOf).filter((item): item is StudioVariation => !!item)
  const from = row.from && typeof row.from.set === 'string' && Array.isArray(row.from.variations) ? { set: row.from.set, variations: row.from.variations.filter((id): id is string => typeof id === 'string') } : undefined
  return {
    id: row.id, thing: row.thing, count: Number.isSafeInteger(row.count) ? row.count : variations.length, createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    ...(row.askToPick === true ? { askToPick: true, ...(typeof row.askedAt === 'string' ? { askedAt: row.askedAt } : {}) } : {}),
    ...(renderers.has(row.renderer as StudioRenderer) ? { renderer: row.renderer } : {}),
    ...(typeof row.direction === 'string' && row.direction.trim() ? { direction: row.direction } : {}),
    ...(typeof row.questID === 'string' ? { questID: row.questID } : {}), ...(typeof row.questRef === 'string' ? { questRef: row.questRef } : {}),
    ...(from ? { from } : {}), ...(typeof row.startError === 'string' ? { startError: row.startError } : {}),
    variations,
  }
}

export function routeOf(run: Quest['sessions'][number]): string | undefined {
  if (run.providerID && run.modelID) return run.providerID + '/' + run.modelID + (run.reasoningEffort ? '#' + run.reasoningEffort : '')
  return run.model
}

function live(set: StudioVariationSet, row: StudioVariation, worker: Quest | undefined): StudioVariation {
  if (row.state === 'picked' || row.state === 'discarded') return row
  if (set.startError) return { ...row, state: 'failed', note: set.startError }
  if (!worker) return row
  const step = worker.stages.find(stage => stage.id === row.id)
  const run = worker.sessions.findLast(session => session.deliverables.includes(row.id))
  const seen = { ...row, ...(run ? { runID: run.runID ?? run.callID, ...(routeOf(run) ? { route: routeOf(run) } : {}) } : {}) }
  if (row.document) return { ...seen, state: 'ready' }
  if (!step) return seen
  const updatedAt = run?.updatedAt ?? row.updatedAt
  if (step.status === 'blocked') return { ...seen, state: 'failed', updatedAt, note: step.blocker?.requires ?? step.note ?? 'The worker stopped before it saved a preview.' }
  if (step.status === 'done') return { ...seen, state: 'failed', updatedAt, note: step.note ?? 'The worker finished without saving a preview.' }
  if (run && activeRun.has(run.state)) return { ...seen, state: 'running', updatedAt }
  if (run && ['failed', 'cancelled', 'missing', 'stale'].includes(run.state) && step.status !== 'pending') return { ...seen, state: 'failed', updatedAt, note: run.result ?? 'The worker run ended before it saved a preview.' }
  return { ...seen, state: step.status === 'working' ? 'running' : 'queued' }
}

export function variationSets(quest: Quest, lookup: QuestLookup = () => undefined): StudioVariationSet[] {
  const saved = quest.extensions.studioVariations as { sets?: unknown } | undefined
  const sets = Array.isArray(saved?.sets) ? saved.sets.map(setOf).filter((item): item is StudioVariationSet => !!item) : []
  return sets.map(set => {
    const worker = set.questID ? lookup(set.questID) : undefined
    return { ...set, variations: set.variations.map(row => live(set, row, worker)) }
  })
}

export const setFinished = (set: StudioVariationSet) => set.variations.length > 0 && !set.variations.some(row => unfinished.has(row.state))

export function pickWaiting(quest: Quest, lookup?: QuestLookup): StudioVariationSet[] {
  return variationSets(quest, lookup).filter(set => set.askToPick && setFinished(set) && set.variations.some(row => row.state === 'ready') && !set.variations.some(row => row.state === 'picked'))
}

export const lookupIn = (quests: Quest[]): QuestLookup => {
  const byID = new Map(quests.map(quest => [quest.id, quest]))
  return id => byID.get(id)
}
