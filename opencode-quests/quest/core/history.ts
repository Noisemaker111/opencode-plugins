import { readFileSync } from 'node:fs'
import { TELEMETRY_BUDGET } from '../../scripts/telemetry-budget.mjs'
import { join } from 'node:path'
import { readEvents, journalPath } from './journal'
import { changedExtensions } from './extension-patch'
import { patchedStages } from './stage-patch'
import { hostHistory, type HistoryItem } from '../host/host-history'
import { waterfallSources } from '../bench/quest-waterfall'
import { readUserGiver } from '../giver-registry.mjs'
import { routingDecisionsDirectory } from '../routing/routing-history'
import { QuestError } from '../api'
import type { QuestStore } from '../store'
import type { QuestSession } from '../types'
import { questReplays, replayView } from '../bench/replay-record'

const callerSources = new Set(['quest:update'])
const runtimeSource = (source: string) => /^(quest|host):/.test(source) && !callerSources.has(source)

export function questHistory(store: QuestStore, id: string, input: { offset?: number; limit?: number } = {}, hostDB = waterfallSources().hostDB) {
  const quest = store.read(id)
  if (!quest) throw new QuestError('NOT_FOUND', 'Quest not found: ' + id)
  const events = readEvents(store.runtime, quest.id), items: HistoryItem[] = []
  const source = journalPath(store.runtime, quest.id)
  const requestIDs = new Set<string>()
  const addRequest = (request: any, fallback: string) => {
    if (!request?.messageID || requestIDs.has(request.messageID)) return
    requestIDs.add(request.messageID)
    items.push({ at: request.at ?? fallback, kind: 'message', from: request.origin?.from ?? 'unknown', source, actor: 'Jon', text: request.text })
  }
  for (const request of quest.request ?? []) addRequest(request, quest.createdAt)
  const steps = new Map<string, string>()
  const historicalRuns = new Map(quest.sessions.map(run => [run.callID, run]))
  for (const event of events) {
    if (!event.type.startsWith('session-') || event.type === 'session-removed') continue
    const p = event.payload as Partial<QuestSession>
    const callID = p.callID ?? [...historicalRuns.values()].find(run => run.sessionID === p.sessionID)?.callID
    if (!callID) continue
    historicalRuns.set(callID, { role: 'worker', state: 'planned', attempt: 1, evidence: [], deliverables: [], updatedAt: event.at, ...historicalRuns.get(callID), ...p, callID })
  }
  for (const event of events) {
    const p = event.payload as any, origin = event.origin
    const base: HistoryItem = { at: event.at, kind: event.type, from: origin?.from ?? (runtimeSource(event.source) ? 'runtime' : 'unknown'), source: source + ':' + event.eventID, actor: origin?.sessionID, directory: origin?.directory }
    if (event.type === 'stage-state') items.push({ ...base, kind: 'step', stepID: p.stageID, state: p.status, text: p.evidence ?? p.note })
    else if (event.type.startsWith('session-')) {
      const run = [...historicalRuns.values()].find(run => run.callID === p.callID || p.sessionID && run.sessionID === p.sessionID), runID = p.runID ?? run?.runID ?? p.callID
      let decision: any
      if (runID) try { decision = JSON.parse(readFileSync(join(routingDecisionsDirectory(store.runtime), runID + '.json'), 'utf8')) } catch {}
      items.push({ ...base, kind: 'run', runID, state: p.state ?? (event.type === 'session-planned' ? 'planned' : undefined), actor: p.parentID ?? run?.parentID ?? base.actor, model: p.model ?? run?.model, route: decision?.route?.id, why: decision?.reason ?? run?.routingNote ?? p.taskDescription ?? run?.taskDescription, directory: p.scope?.worktree ?? run?.scope?.worktree ?? run?.worktree ?? base.directory, text: p.result })
    } else if (event.type === 'patched' || event.type === 'created') {
      if (event.type === 'created') items.push(base)
      for (const step of patchedStages(p)) {
        const signature = JSON.stringify(step)
        if (steps.get(step.id) !== signature) items.push({ ...base, kind: 'step', stepID: step.id, state: step.status, text: step.note ?? step.title })
        steps.set(step.id, signature)
      }
      for (const [runID, landing] of Object.entries(changedExtensions(p).landings ?? {}) as [string, any][]) {
        const key = 'landing:' + runID, signature = JSON.stringify(landing)
        if (steps.get(key) !== signature) items.push({ ...base, at: landing.at ?? event.at, kind: 'landing', runID, state: landing.state, branch: landing.branch, into: landing.into, method: landing.method, why: landing.reason })
        steps.set(key, signature)
      }
      for (const request of p.request ?? []) addRequest(request, event.at)
    } else items.push(base)
  }
  const host = hostHistory({ ...quest, sessions: [...historicalRuns.values()] }, hostDB, readUserGiver(store.runtime)?.sessionID)
  for (const item of host.items) {
    if (item.kind === 'message') {
      const messageID = [...requestIDs].find(id => item.source.endsWith(':' + id))
      const request = (quest.request ?? []).find(request => request.messageID === messageID)
      const existing = request && items.find(row => row.kind === 'message' && row.text === request.text && row.at === request.at)
      if (existing) { existing.from = item.from; existing.source = item.source; continue }
    }
    items.push(item)
  }
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const windowed = input.offset === undefined && input.limit === undefined
  const earlierCount = windowed ? Math.max(0, items.length - TELEMETRY_BUDGET.historyEntries) : 0
  const offset = input.offset ?? earlierCount, end = input.limit === undefined ? items.length : offset + input.limit
  const diagnostics = [...host.diagnostics]
  if (items.some(item => item.from === 'unknown')) diagnostics.push('Some older records do not say where they came from.')
  if (items.some(item => item.kind === 'run' && (!item.actor || !item.route || !item.why))) diagnostics.push('Some runs have no saved dispatch choice, who made it or why.')
  if (items.some(item => item.kind === 'command' && item.exitCode === null)) diagnostics.push('Some commands have no recorded exit code; their result is unknown.')
  return { id: quest.ref ?? quest.id, items: items.slice(offset, end), total: items.length, earlierCount, nextOffset: end < items.length ? end : null, benches: questReplays(store.runtime, quest.id).map(replayView), diagnostics }
}
