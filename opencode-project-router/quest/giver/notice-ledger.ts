import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock } from '../locking.mts'
import { readJsonRecord, writeFileDurable } from '../core/durable-file.mjs'
import { plainWords } from '../review/plain-words'
import { LANDING_STEP_ID } from '../landing/landing-step'
import type { Quest } from '../types'

export type NoticeEntry = { key: string; text: string; episode: string; sentAt: string; suppressed?: number; lastSuppressedAt?: string }
type Ledger = { version: 1; questID: string; slots: Record<string, NoticeEntry> }
export type NoticeSlot = { questID: string; stepIDs: string[]; kind: string; episode?: string }
export type NoticeCheck = { send: boolean; key: string; suppressed?: number }

const file = (runtime: string, questID: string) => join(runtime, 'notice-ledger', createHash('sha256').update(questID).digest('hex').slice(0, 32) + '.json')
const read = (runtime: string, questID: string): Ledger => {
  const row = readJsonRecord<Ledger>(file(runtime, questID))
  return row?.version === 1 && row.slots && typeof row.slots === 'object' ? row : { version: 1, questID, slots: {} }
}
const write = (runtime: string, ledger: Ledger) => { mkdirSync(join(runtime, 'notice-ledger'), { recursive: true }); writeFileDurable(file(runtime, ledger.questID), JSON.stringify(ledger)) }
const slotName = (slot: NoticeSlot) => [...new Set(slot.stepIDs)].sort().join(',') + '|' + slot.kind

export const noticeKindOf = (text: string) => /^(?:QUEST|RUN) ([A-Z][A-Z ]*?) "/.exec(text)?.[1] ?? 'NOTICE'
export const normalisedNotice = (text: string) => plainWords(text).toLowerCase().replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim()
export const noticeKey = (slot: NoticeSlot, text: string) => createHash('sha256').update(JSON.stringify([slot.questID, slotName(slot), normalisedNotice(text)])).digest('hex')

export function stepEpisode(quest: Pick<Quest, 'stages' | 'sessions'>, stepIDs: string[]): string {
  return [...new Set(stepIDs)].sort().map(id => {
    const step = quest.stages.find(row => row.id === id)
    return [id, step?.status ?? 'gone', step?.note ?? '', step?.blocker ? JSON.stringify(step.blocker) : ''].join('\u0001')
  }).join('\u0002')
}

function pruned(ledger: Ledger, quest?: Pick<Quest, 'stages' | 'sessions'>) {
  if (!quest) return
  for (const [name, entry] of Object.entries(ledger.slots)) {
    const ids = name.split('|')[0].split(',').filter(Boolean)
    if (!ids.length || ids.some(id => id.startsWith('run:'))) continue
    if (entry.episode !== stepEpisode(quest, ids)) delete ledger.slots[name]
  }
}

function episodeOf(slot: NoticeSlot, quest?: Pick<Quest, 'stages' | 'sessions'>) {
  return slot.episode ?? (quest ? stepEpisode(quest, slot.stepIDs) : '')
}

export function noticeDue(runtime: string, slot: NoticeSlot, text: string, quest?: Pick<Quest, 'stages' | 'sessions'>, now = new Date()): NoticeCheck {
  const key = noticeKey(slot, text), name = slotName(slot), episode = episodeOf(slot, quest)
  const lock = acquireLock(runtime, 'notice-ledger')
  try {
    const ledger = read(runtime, slot.questID)
    const before = JSON.stringify(ledger)
    pruned(ledger, quest)
    const prior = ledger.slots[name]
    if (!prior || prior.key !== key || prior.episode !== episode) { if (JSON.stringify(ledger) !== before) write(runtime, ledger); return { send: true, key } }
    prior.suppressed = (prior.suppressed ?? 0) + 1
    prior.lastSuppressedAt = now.toISOString()
    write(runtime, ledger)
    return { send: false, key, suppressed: prior.suppressed }
  } finally { lock.release() }
}

export function noticeSent(runtime: string, slot: NoticeSlot, text: string, quest?: Pick<Quest, 'stages' | 'sessions'>, now = new Date()) {
  const lock = acquireLock(runtime, 'notice-ledger')
  try {
    const ledger = read(runtime, slot.questID)
    pruned(ledger, quest)
    ledger.slots[slotName(slot)] = { key: noticeKey(slot, text), text: normalisedNotice(text), episode: episodeOf(slot, quest), sentAt: now.toISOString() }
    write(runtime, ledger)
  } finally { lock.release() }
}


export function noticeCleared(runtime: string, slot: NoticeSlot) {
  if (!existsSync(file(runtime, slot.questID))) return
  const lock = acquireLock(runtime, 'notice-ledger')
  try {
    const ledger = read(runtime, slot.questID), name = slotName(slot)
    if (!ledger.slots[name]) return
    delete ledger.slots[name]
    write(runtime, ledger)
  } finally { lock.release() }
}

export const readNoticeLedger = (runtime: string, questID: string) => read(runtime, questID).slots

export type CauseEntry = { text: string; sentAt: string; questIDs: string[] }
type CauseLedger = { version: 1; causes: Record<string, CauseEntry> }

const causeFile = (runtime: string) => join(runtime, 'notice-ledger', 'causes.json')
const readCauses = (runtime: string): CauseLedger => {
  const row = readJsonRecord<CauseLedger>(causeFile(runtime))
  return row?.version === 1 && row.causes && typeof row.causes === 'object' ? row : { version: 1, causes: {} }
}
const writeCauses = (runtime: string, ledger: CauseLedger) => { mkdirSync(join(runtime, 'notice-ledger'), { recursive: true }); writeFileDurable(causeFile(runtime), JSON.stringify(ledger)) }

export const causeKey = (cause: string) => createHash('sha256').update(normalisedNotice(cause)).digest('hex')

export const readCauseLedger = (runtime: string) => readCauses(runtime).causes

export function claimCause(runtime: string, key: string, cause: string, questIDs: string[], now = new Date()): string[] {
  const lock = acquireLock(runtime, 'notice-ledger')
  try {
    const ledger = readCauses(runtime), prior = ledger.causes[key]
    const added = [...new Set(questIDs)].filter(id => !prior?.questIDs.includes(id))
    if (!added.length) return []
    ledger.causes[key] = { text: normalisedNotice(cause), sentAt: now.toISOString(), questIDs: [...(prior?.questIDs ?? []), ...added] }
    writeCauses(runtime, ledger)
    return added
  } finally { lock.release() }
}

export function releaseCause(runtime: string, key: string, questIDs: string[]) {
  const lock = acquireLock(runtime, 'notice-ledger')
  try {
    const ledger = readCauses(runtime), entry = ledger.causes[key]
    if (!entry) return
    entry.questIDs = entry.questIDs.filter(id => !questIDs.includes(id))
    if (!entry.questIDs.length) delete ledger.causes[key]
    writeCauses(runtime, ledger)
  } finally { lock.release() }
}

function dropFromCauses(runtime: string, questID: string) {
  if (!existsSync(causeFile(runtime))) return
  const ledger = readCauses(runtime)
  let changed = false
  for (const [key, entry] of Object.entries(ledger.causes)) {
    if (!entry.questIDs.includes(questID)) continue
    entry.questIDs = entry.questIDs.filter(id => id !== questID)
    if (!entry.questIDs.length) delete ledger.causes[key]
    changed = true
  }
  if (changed) writeCauses(runtime, ledger)
}

export function clearResolvedNotices(runtime: string, before: Pick<Quest, 'id' | 'stages'>, after: Pick<Quest, 'stages'>) {
  const resolved = new Set(before.stages.filter(step => {
    const next = after.stages.find(row => row.id === step.id)
    return step.status === 'blocked' && (!next || next.status !== 'blocked' || next.note !== step.note || JSON.stringify(next.blocker) !== JSON.stringify(step.blocker))
  }).map(step => step.id))
  if (!resolved.size || !existsSync(file(runtime, before.id)) && !(resolved.has(LANDING_STEP_ID) && existsSync(causeFile(runtime)))) return
  const lock = acquireLock(runtime, 'notice-ledger')
  try {
    if (resolved.has(LANDING_STEP_ID)) dropFromCauses(runtime, before.id)
    if (!existsSync(file(runtime, before.id))) return
    const ledger = read(runtime, before.id)
    let changed = false
    for (const name of Object.keys(ledger.slots)) if (name.split('|')[0].split(',').some(id => resolved.has(id))) { delete ledger.slots[name]; changed = true }
    if (changed) write(runtime, ledger)
  } finally { lock.release() }
}
