import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_RETURNS_DIRECTORY } from '../core/runtime-queues'
import { giverBlockers, handoffsOf, SAVED_BY_GIVER, stepBlockerKey, type Handoff } from '../core/state-machine'
import type { QuestStore } from '../store'
import { readUserGiver } from '../giver-registry.mjs'
import type { QuestSession } from '../types'

export type HandoffVia = 'worker return' | 'attention' | 'hand-off' | 'rewake' | typeof SAVED_BY_GIVER

function boundGiver(runtime: string): string | undefined {
  try { const giver = readUserGiver(runtime); return giver?.state === 'bound' ? giver.sessionID : undefined } catch { return undefined }
}

export function recordHandoff(store: QuestStore, questID: string, keys: string[], via: HandoffVia) {
  if (!keys.length) return
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = store.read(questID)
    if (!current) return
    const prior = handoffsOf(current), at = new Date().toISOString(), giver = boundGiver(store.runtime)
    const giverSaved = current.stages.filter(step => step.status === 'blocked' && prior[stepBlockerKey(step)]?.via === SAVED_BY_GIVER).map(stepBlockerKey)
    const live = new Set([...giverBlockers(current), ...giverSaved, ...keys])
    const next: Record<string, Handoff> = Object.fromEntries(Object.entries(prior).filter(([key]) => live.has(key)))
    for (const key of keys) {
      if (via === 'rewake') next[key] = { at, via, ...(giver ? { giver } : {}), wakes: (prior[key]?.wakes ?? 0) + 1 }
      else if (via === SAVED_BY_GIVER || !next[key]) next[key] = { at, via, ...(giver ? { giver } : {}) }
    }
    if (JSON.stringify(next) === JSON.stringify(prior)) return current
    try { return store.apply(questID, 'patched', { extensions: { ...current.extensions, giverHandoffs: next } }, 'quest:giver-handoff', { expectedRevision: current.revision }) }
    catch (error) { if (attempt === 2) throw error }
  }
}

export function recordGiverSavedBlocks(store: QuestStore, questID: string, stepIDs: string[]) {
  const quest = store.read(questID)
  if (!quest) return
  return recordHandoff(store, questID, quest.stages.filter(step => stepIDs.includes(step.id) && step.status === 'blocked' && !step.needsJon).map(stepBlockerKey), SAVED_BY_GIVER)
}

export function heard(runtime: string, run: QuestSession): 'heard' | 'pending' | 'silent' {
  const name = (run.runID ?? run.callID) + '.json'
  let directories: string[]
  try { directories = readdirSync(runtime).filter(entry => WORKER_RETURNS_DIRECTORY.test(entry)) } catch { return 'silent' }
  for (const directory of directories) {
    const file = join(runtime, directory, name)
    if (!existsSync(file)) continue
    try {
      const receipt = JSON.parse(readFileSync(file, 'utf8')) as { state?: string; settled?: string }
      if (receipt.state !== 'accepted') return 'pending'
      if (!receipt.settled) return 'heard'
    } catch { return 'pending' }
  }
  return 'silent'
}
