import { existsSync } from 'node:fs'
import { markOf } from "../hygiene/verdict"
import { ledgerKey, onLedgerChange, watchLedger } from '../core/ledger-changes'
import { hydrateSessionReferences } from '../host/session-projection'
import { liveHostSignals, readQuestActivity, runStatusReader, withQuestActivity } from './activity'
import { toolSummary } from './tool-projection'
import { admissionRecords } from '../runs/start-request'
import { slotPicture, waitContext } from '../workers/worker-admission'
import { updateStatus } from '../workers/update-status'
import { driftNow } from '../../scripts/version-drift.mjs'
import type { AdmissionRecords } from '../runs/reachability'
import type { QuestStore } from '../store'
import type { Quest } from '../types'
import { categoryOf, computedPriority } from '../workers/quest-queue'
import { findingsOf } from './findings'
import { MINIMUM_STALL_SILENCE_MS } from '../workers/stall-signal'
import { countsOf, summaryOf, workerCountsOf, workerCountsLine, type BoardSummary } from './board'
import { readBoardSummary, type BoardSnapshot } from './board-summary'
import { warningEmitter, warningLine, warningRow } from './warnings'
import { scopeLabel, strandedDiagnostic } from './board-project'

export type BoardQuery = { text?: string; state?: string; projectID?: string; allProjects?: boolean; archived?: boolean; offset?: number; limit?: number }
type Listing = { diagnostics: string[]; records: Quest[]; page: Quest[]; scope: string; total: number; nextOffset: number | null }
type Lister = { list(query: BoardQuery): Listing }
type Base = { listing: Listing; quests: Quest[]; summaries: ReturnType<typeof toolSummary>[] }

function boardWorkers(summaries: BoardSummary[], now = Date.now()) {
  try {
    const reader = runStatusReader()
    const counts = workerCountsOf(summaries, now, { evidence: run => reader.evidence?.(run, now) ?? { tools: 0 }, toolTimes: at => reader.toolTimes?.(at) ?? { medianMs: MINIMUM_STALL_SILENCE_MS } }, liveHostSignals())
    return { ...counts, text: workerCountsLine(counts) }
  } catch { return undefined }
}

function boardSlots(store: QuestStore) {
  try { return slotPicture(store) } catch { return undefined }
}

function boardUpdate() {
  try { return updateStatus() } catch { return undefined }
}

function boardWarnings() {
  try { const now = Date.now(), raised = warningEmitter().list(); return raised.length ? { warnings: raised.map(warning => warningRow(warning, now)), warningText: warningLine(raised) } : {} } catch { return {} }
}

function boardDrift() {
  try { const { checkedAt, alerts } = driftNow(); return { checkedAt, alerts } } catch { return undefined }
}

function boardWaits(store: QuestStore) {
  try { return waitContext(store, id => store.read(id)) } catch { return undefined }
}

function stateChangedAt(quest: Quest) {
  if (quest.state === 'Complete') return quest.delivered?.at ?? quest.history.findLast(entry => entry.type === 'complete')?.at
  return quest.history.at(-1)?.at
}

export function boardRow(summary: ReturnType<typeof toolSummary>, quest: Quest, activity: ReturnType<typeof readQuestActivity>, records: AdmissionRecords) {
  const shown = withQuestActivity(quest, summary, activity, records)
  const { sessionReferences: _references, checkedAt: _checked, ...live } = shown.activity
  const stateAt = stateChangedAt(quest)
  const blocking = shown.group === 'you' || shown.group === 'queued' || !!live.handoff
  return {
    id: shown.id, title: shown.title, state: shown.state, group: shown.group, running: shown.running,
    priority: computedPriority(quest), ...(categoryOf(quest) ? { category: categoryOf(quest) } : {}),
    ...(shown.reason && blocking ? { reason: shown.reason } : {}),
    ...(markOf(quest) ? { hygiene: { kind: markOf(quest)!.kind, reason: markOf(quest)!.reason } } : {}),
    ...(Number(quest.extensions.sends) > 1 ? { sends: Number(quest.extensions.sends) } : {}),
    ...(findingsOf(quest).length ? { findings: findingsOf(quest).slice(-3) } : {}),
    activity: live, progress: shown.progress, ...(summary.branches ? { branches: summary.branches } : {}), ...(shown.project?.root ? { project: { root: shown.project.root } } : {}),
    ...(shown.branch ? { branch: shown.branch } : {}),
    ...(shown.nextAction ? { nextAction: shown.nextAction } : {}),
    ...(shown.startedAt ? { startedAt: shown.startedAt } : {}),
    updatedAt: shown.updatedAt,
    ...(stateAt ? { stateAt } : {}),
    ...(shown.result ? { result: shown.result } : {}),
  }
}

export function webQuestRow({ id, title, state, progress, priority, category, hygiene, sends, findings }: ReturnType<typeof boardRow>) {
  return { id, title, state, progress, priority, ...(category ? { category } : {}), ...(hygiene ? { hygiene } : {}), ...(sends ? { sends } : {}), ...(findings ? { findings } : {}) }
}

const BOARD_SHARE_MILLISECONDS = 2_000
const FAST_KEYS = ['allProjects', 'offset', 'limit']
const newest = (a: BoardSummary, b: BoardSummary) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)
const isQuest = (quest: Quest | undefined): quest is Quest => !!quest

function fastBoard(store: QuestStore, host: unknown, board: BoardSnapshot, query: BoardQuery, projectID: string, directory: string | undefined) {
  const now = Date.now()
  const open = Object.values(board.entries).filter(entry => !entry.archived && (query.allProjects === true || entry.project?.id === projectID)).sort(newest)
  const offset = query.offset ?? 0, limit = query.limit ?? 25
  const pageIDs = open.slice(offset, offset + limit).map(entry => entry.id)
  const shown = pageIDs.map(id => store.read(id)).filter(isQuest)
  hydrateSessionReferences(store, shown)
  const activity = readQuestActivity(host, shown)
  const admission = admissionRecords(store)
  const items = shown.map(quest => boardRow(toolSummary(quest), quest, activity, admission))
  const roots = [...new Set(Object.values(board.entries).map(entry => entry.project?.root).filter((value): value is string => !!value && !existsSync(value)))]
  const diagnostics = [...board.diagnostics, strandedDiagnostic(roots)].filter((value): value is string => !!value)
  return {
    value: {
      diagnostics: diagnostics.slice(0, 10), items, ...countsOf(open, now, boardWaits(store)), workers: boardWorkers(open, now), slots: boardSlots(store), update: boardUpdate(), drift: boardDrift(), ...boardWarnings(), scope: scopeLabel(query.allProjects === true, directory),
      total: open.length, nextOffset: offset + limit < open.length ? offset + limit : null,
    },
    quests: shown,
  }
}

export function questBoardLister(store: QuestStore, host: unknown) {
  const root = ledgerKey(store.projectRoot)
  const watched = watchLedger(store.projectRoot)
  const bases = new Map<string, Base>()
  const answers = new Map<string, { at: number; answer: ReturnType<typeof build> }>()
  const stop = onLedgerChange(changed => { if (changed === root) { bases.clear(); answers.clear() } })
  const base = (api: Lister, query: BoardQuery, projectID: string): Base => {
    const key = JSON.stringify([projectID, query])
    const held = watched ? bases.get(key) : undefined
    if (held) return held
    const listing = api.list(query)
    hydrateSessionReferences(store, listing.records)
    const quests = listing.page.map(q => store.read(q.id) ?? q)
    hydrateSessionReferences(store, quests)
    const fresh = { listing, quests, summaries: quests.map(toolSummary) }
    if (watched) bases.set(key, fresh)
    return fresh
  }
  const build = (api: Lister, query: BoardQuery & { withArchived?: number }, projectID: string, directory: string | undefined) => {
    const { withArchived, ...open } = query
    const board = readBoardSummary(store.runtime)
    if (board && withArchived === undefined && Object.keys(open).every(key => FAST_KEYS.includes(key))) return fastBoard(store, host, board, open, projectID, directory)
    const shown = base(api, open, projectID)
    const finished = withArchived ? base(api, { ...open, archived: true, state: undefined, offset: 0, limit: withArchived }, projectID) : undefined
    const listed = new Set(shown.quests.map(q => q.id))
    const extra = finished ? finished.quests.flatMap((q, index) => listed.has(q.id) ? [] : [index]) : []
    const records = finished ? [...shown.listing.records, ...extra.map(index => finished.quests[index])] : shown.listing.records
    const activity = readQuestActivity(host, records)
    const admission = admissionRecords(store)
    const items = [
      ...shown.quests.map((q, index) => boardRow(shown.summaries[index], q, activity, admission)),
      ...extra.map(index => boardRow(finished!.summaries[index], finished!.quests[index], activity, admission)),
    ]
    const { listing } = shown
    const now = Date.now()
    return {
      value: { diagnostics: listing.diagnostics.slice(0, 10), items, ...countsOf(listing.records.map(summaryOf), now, boardWaits(store)), workers: boardWorkers(listing.records.map(summaryOf), now), slots: boardSlots(store), update: boardUpdate(), drift: boardDrift(), ...boardWarnings(), scope: listing.scope, total: listing.total, nextOffset: listing.nextOffset },
      quests: [...shown.quests, ...extra.map(index => finished!.quests[index])],
    }
  }
  return {
    list(api: Lister, query: BoardQuery & { withArchived?: number }, projectID: string, directory?: string) {
      const key = JSON.stringify([projectID, query])
      const held = watched ? answers.get(key) : undefined
      if (held && Date.now() - held.at < BOARD_SHARE_MILLISECONDS) return held.answer
      const answer = build(api, query, projectID, directory)
      if (watched) answers.set(key, { at: Date.now(), answer })
      return answer
    },
    forget() { answers.clear() },
    dispose: stop,
  }
}
