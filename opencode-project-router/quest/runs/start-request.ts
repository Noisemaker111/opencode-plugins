import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { acquireLock } from '../locking.mts'
import { QuestError } from '../api'
import { readContinuations, readCurrentContinuations, v2QueueGeneration } from '../core/runtime-queues'
import { readUserGiver } from '../giver-registry.mjs'
import { adoptQuestGiver, giverContext, verifyGiverBinding } from '../giver/user-giver'
import { questWorkflow } from './workflow'
import { questReference } from '../core/references'
import { attentionNotice, blockerWakeSettled, causeDelivered, causeNotDelivered, stoppedAfterDone, handoffNoticeOf, noticeGate, saveStopCauses } from '../giver/giver-wake'
import { latestSessionAttempts, OWNED_RUN, TERMINAL_RUN } from './session-lineage'
import { giverBlockers, handoffsOf, unhandedBlockers } from '../core/state-machine'
import { heard, recordHandoff } from '../giver/giver-handoff'
import { noticeSent } from '../giver/notice-ledger'
import { readAllQuests } from '../index'
import { landingDone } from '../landing/landing-step'
import {writeFileDurable,readJsonRecord} from '../core/durable-file.mjs'
import { readJsonCached } from '../core/json-cache'
import type { QuestStore } from '../store'
import type { QuestHost } from './runtime'
import type { QuestContinuation } from './continuation'
import type { Quest } from '../types'
import type { AdmissionRecords } from './reachability'
import { now as spanNow, recordSpan, timed } from '../../scripts/plugin-spans'
import { queueHold, readableQueueSettings } from '../workers/quest-queue'
import { updateHold } from '../workers/update-drain'
import { PAUSED_TEXT } from '../workers/trial'

type Request = {
  quest: string; requestID: string; kind?: 'review' | 'attention' | 'handoff' | 'plan'; stepID?: string; runID?: string; reason?: string; generation?: string; createdAt: string
  state: 'queued' | 'admitting' | 'started' | 'failed' | 'unknown'
  authorization?: { at: string; action: 'Start saved Quest'; definition: string; giverID?: string }
  result?: unknown; error?: string
}
const openQuests = (store: QuestStore) => readAllQuests(store.projectRoot).flatMap(({ quest }) => quest ? [store.read(quest.id) ?? quest] : [])
const active = (state: string) => ['planned', 'executing', 'waiting', 'blocked'].includes(state)
const definition = (quest: Quest) => createHash('sha256').update(JSON.stringify([quest.project, quest.description ?? quest.objective, quest.stages.map(step => [step.id, step.title, step.detail, step.needs])])).digest('hex')
const directory = (store: QuestStore) => join(store.runtime, 'start-requests')
const path = (store: QuestStore, id: string) => join(directory(store), id + '.json')
function save(store: QuestStore, row: Request) {
  mkdirSync(directory(store), { recursive: true })
  const file = path(store, row.requestID)
  writeFileDurable(file, JSON.stringify(row))
}
export function startRequests(store: QuestStore, quest?: string): Request[] {
  const dir = directory(store)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.json')).flatMap(name => { const row = readJsonCached<Request>(join(dir, name)); return row ? [row] : [] }).filter(row => !quest || row.quest === quest)
}

export function requestQuestStart(store: QuestStore, id: string, generation = v2QueueGeneration()): Request | { quest: string; state: string; runID?: string; sessionID?: string } {
  const lock = acquireLock(store.runtime, 'start-requests')
  try {
    const quest = store.read(id)
    if (!quest) throw new QuestError('QUEST_NOT_FOUND', 'Quest not found')
    if (quest.archive || quest.state === 'Archived') throw new QuestError('QUEST_ARCHIVED', 'Reopen the Quest before starting it')
    const requests = startRequests(store, id).filter(row=>row.generation===generation), continuations = readCurrentContinuations(store.runtime)
    for (const row of requests.filter(row => !row.kind && ['admitting', 'unknown'].includes(row.state))) {
      const admitted = continuations.find(item => item.questID === id && item.context?.requestID === row.requestID && item.context?.sessionID === row.authorization?.giverID)
      if (!admitted) continue
      row.state = 'started'
      row.result = { continuationID: admitted.id, state: admitted.state, runID: admitted.runID }
      save(store, row)
    }
    const pending = requests.find(row => !row.kind && ['queued', 'admitting', 'unknown'].includes(row.state))
    if (pending) return pending
    const run = quest.sessions.findLast(row => active(row.state))
    if (run) return { quest: id, state: run.state === 'planned' ? 'starting' : run.state, runID: run.runID, sessionID: run.openCodeSessionId ?? run.sessionID }
    if (continuations.some(row => row.questID === id && !['done', 'stopped'].includes(row.state))) return { quest: id, state: 'running' }
    if (!quest.stages.some(step => step.status === 'pending')) {
      const handoff = queueHandoff(store, quest, generation)
      if (handoff) return { quest: id, state: 'handing to the Quest Giver', requestID: handoff }
      throw new QuestError('NO_ELIGIBLE_STEPS', 'No pending steps; inspect the saved result or blocker')
    }
    const createdAt = new Date().toISOString()
    const row: Request = { quest: id, requestID: randomUUID(), generation, createdAt, state: 'queued', authorization: { at: createdAt, action: 'Start saved Quest', definition: definition(quest) } }
    save(store, row)
    return row
  } finally { lock.release() }
}

export function admissionRecords(store: QuestStore, now = Date.now()): AdmissionRecords {
  const settings = readableQueueSettings(), drain = updateHold()
  const paused = settings.mode === 'paused' ? PAUSED_TEXT : undefined
  return { continuations: readCurrentContinuations(store.runtime), starts: startRequests(store).filter(row=>row.generation===v2QueueGeneration()), now, queued: (q: Quest) => paused ?? queueHold(q, id => store.read(id), settings) ?? drain }
}

export function questStartAuthorization(store: QuestStore, questID: string, runID: string, giverID: string) {
  const quest = store.read(questID)
  if (!quest) return
  const continuation = readContinuations(store.runtime).find(row => row.questID === questID && row.context?.sessionID === giverID && (row.runID === runID || row.admissions?.some((admission: any) => admission.runID === runID)))
  if (!continuation) return
  const row = startRequests(store, questID).find(row => row.requestID === continuation.context.requestID && !row.kind && ['admitting', 'started'].includes(row.state))
  if (!row?.authorization || row.authorization.giverID !== giverID || row.authorization.definition !== definition(quest)) return
  return { action: row.authorization.action, at: row.authorization.at, questID, scope: 'Execute the saved Quest steps using its chosen workflow, including necessary project instruction reads and ordinary verification. This does not authorize unrelated access, destructive operations, new spending, publishing or production changes.' }
}

export function requestQuestAttention(store: QuestStore, id: string, runID: string, reason?: string, generation = v2QueueGeneration()): string | undefined {
  const lock = acquireLock(store.runtime, 'start-requests')
  try {
    const quest = store.read(id)
    if (!quest || quest.archive || quest.delivered || reason && landingDone(quest.stages) || !quest.sessions.some(run => (run.runID ?? run.callID) === runID && !blockerWakeSettled(quest, run) && (!!reason || !stoppedAfterDone(quest, run)))) return
    const requestID = createHash('sha256').update(JSON.stringify(['attention', id, quest.lifecycleEpoch, runID])).digest('hex')
    if (existsSync(path(store, requestID))) return
    save(store, { quest: id, requestID, kind: 'attention', runID, ...(reason ? { reason } : {}), generation, createdAt: new Date().toISOString(), state: 'queued' })
    return requestID
  } finally { lock.release() }
}

export function requestQuestPlan(store: QuestStore, id: string, generation = v2QueueGeneration()): { quest: string; state: string; requestID: string } {
  const lock = acquireLock(store.runtime, 'start-requests')
  try {
    const quest = store.read(id)
    if (!quest) throw new QuestError('QUEST_NOT_FOUND', 'Quest not found')
    if (quest.archive || quest.state === 'Archived') throw new QuestError('QUEST_ARCHIVED', 'Reopen the Quest before starting it')
    const open = startRequests(store, id).find(row => row.kind === 'plan' && row.generation === generation && ['queued', 'admitting'].includes(row.state))
    const requestID = open?.requestID ?? randomUUID()
    if (!open) save(store, { quest: id, requestID, kind: 'plan', generation, createdAt: new Date().toISOString(), state: 'queued' })
    return { quest: id, state: 'handing to the Quest Giver', requestID }
  } finally { lock.release() }
}

export function requestGiverHandoff(store: QuestStore, id: string, generation = v2QueueGeneration()): string | undefined {
  const lock = acquireLock(store.runtime, 'start-requests')
  try { return queueHandoff(store, store.read(id), generation) } finally { lock.release() }
}

const STALE_HANDOFF_MS = 30 * 60_000
const REWAKE_SPACING_MS = 5 * 60_000
const REWAKE_LIMIT = 3
const REWAKE = 'rewake'
const lastSweep = new Map<string, number>()
const rewakeAt = new Map<string, number | undefined>()

function quietRuns(store: QuestStore, quest: Quest): boolean {
  const runs = latestSessionAttempts(quest.sessions)
  return !runs.some(run => OWNED_RUN.has(run.state)) && !runs.some(run => TERMINAL_RUN.has(run.state) && heard(store.runtime, run) === 'pending')
}

function orphanedSince(quest: Quest, giverID: string, now: number): string | undefined {
  const keys = giverBlockers(quest), handoffs = handoffsOf(quest)
  if (!keys.length || !keys.every(key => handoffs[key])) return
  const orphaned = keys.filter(key => {
    const handoff = handoffs[key]
    return (handoff.wakes ?? 0) < REWAKE_LIMIT && (!!handoff.giver && handoff.giver !== giverID || now - Date.parse(handoff.at) > STALE_HANDOFF_MS)
  })
  return orphaned.length === keys.length ? keys.map(key => handoffs[key].at).sort().at(-1) : undefined
}

function rewakeRows(store: QuestStore, generation: string | undefined) {
  return startRequests(store).filter(row => row.kind === 'handoff' && row.reason === REWAKE && (!row.generation || row.generation === generation))
}

function unrequestedOrphans(store: QuestStore, giverID: string, now: number) {
  return openQuests(store).flatMap(quest => {
    if (quest.archive || quest.delivered || quest.state === 'Archived' || !quietRuns(store, quest)) return []
    const handedAt = orphanedSince(quest, giverID, now)
    if (!handedAt) return []
    const requestID = createHash('sha256').update(JSON.stringify([REWAKE, quest.id, quest.lifecycleEpoch, giverBlockers(quest), handedAt])).digest('hex')
    return existsSync(path(store, requestID)) ? [] : [{ quest, handedAt, requestID }]
  }).sort((a, b) => a.handedAt.localeCompare(b.handedAt))
}

export function sweepOrphanedHandoffs(store: QuestStore, giverID: string, now = Date.now(), generation = v2QueueGeneration()): string | undefined {
  const lock = acquireLock(store.runtime, 'start-requests')
  try {
    if (rewakeRows(store, generation).some(row => ['queued', 'admitting'].includes(row.state) || now - Date.parse(row.createdAt) < REWAKE_SPACING_MS)) return
    const due = unrequestedOrphans(store, giverID, now)[0]
    if (!due) return
    save(store, { quest: due.quest.id, requestID: due.requestID, kind: 'handoff', reason: REWAKE, generation, createdAt: new Date(now).toISOString(), state: 'queued' })
    return due.requestID
  } finally { lock.release() }
}

export function nextRewakeAt(store: QuestStore, giverID: string, now = Date.now(), generation = v2QueueGeneration()): number | undefined {
  if (!unrequestedOrphans(store, giverID, now).length) return
  const latest = Math.max(0, ...rewakeRows(store, generation).map(row => Date.parse(row.createdAt) || 0))
  return Math.max(now + 1000, latest + REWAKE_SPACING_MS)
}

function sweepDue(store: QuestStore, giverID: string): boolean {
  const key = store.runtime + giverID, now = Date.now()
  if (now - (lastSweep.get(key) ?? 0) < 60_000) return false
  lastSweep.set(key, now)
  return true
}

function queueHandoff(store: QuestStore, quest: Quest | undefined, generation: string | undefined): string | undefined {
  if (!quest || quest.archive || quest.state === 'Archived') return
  const id = quest.id
  const keys = unhandedBlockers(quest)
  if (!keys.length) return
  if (!quietRuns(store, quest)) return
  const waiting = (row: Request) => ['queued', 'admitting'].includes(row.state) && (!row.generation || row.generation === generation)
  if (startRequests(store, id).some(row => row.kind && waiting(row))) return
  const requestID = createHash('sha256').update(JSON.stringify(['handoff', id, quest.lifecycleEpoch, keys])).digest('hex')
  const prior = readJsonRecord<Request>(path(store, requestID))
  if (prior) {
    if (prior.state === 'started' && !(prior.result as { skipped?: string } | undefined)?.skipped) return
    if (waiting(prior)) return
  }
  save(store, { quest: id, requestID, kind: 'handoff', generation, createdAt: new Date().toISOString(), state: 'queued' })
  return requestID
}

const planNoticeOf = (quest: Quest) => `Quest ${questReference(quest)} is ready to start: "${quest.title}". Only you start workers. Plan it now: if the request has separable parts, give each part its own step, with no needs unless it needs another step's output and with include naming the files it touches, then start the Quest. If it is one action, start it as it is.`
const settledRequests = new Map<string, string>()
function requestListing(store: QuestStore): string | undefined {
  try { return statSync(directory(store)).mtimeMs + ':' + readdirSync(directory(store)).filter(name => name.endsWith('.json')).sort().join(',') } catch { return undefined }
}
export async function consumeQuestStarts(store: QuestStore, host: QuestHost, continuation: QuestContinuation): Promise<number | undefined> {
  const generation = v2QueueGeneration()
  const giver = readUserGiver(store.runtime)
  if (giver?.state !== 'bound' || !giver.sessionID) return
  const giverID = giver.sessionID
  const key = store.runtime + giverID
  if (sweepDue(store, giverID)) {
    sweepOrphanedHandoffs(store, giverID, Date.now(), generation)
    rewakeAt.set(key, nextRewakeAt(store, giverID, Date.now(), generation))
  }
  await admitQueuedStarts(store, host, continuation, giverID, generation)
  return rewakeAt.get(key)
}

async function admitQueuedStarts(store: QuestStore, host: QuestHost, continuation: QuestContinuation, giverID: string, generation: string | undefined) {
  const moved = requestListing(store)
  if (moved !== undefined && settledRequests.get(directory(store)) === moved) return
  const requests = startRequests(store).filter(row=>row.generation===generation)
  if (moved !== undefined && !requests.some(row => row.state === 'queued')) settledRequests.set(directory(store), moved); else settledRequests.delete(directory(store))
  const claimed: Request[] = []
  for (const pending of requests.filter(row => row.state === 'queued')) {
    const lock = acquireLock(store.runtime, 'start-requests')
    try {
      const row = readJsonRecord<Request>(path(store, pending.requestID))
      if (row?.state !== 'queued') continue
      row.state = 'admitting'; save(store, row); claimed.push(row)
    } finally { lock.release() }
  }
  await Promise.all(claimed.map(row => admitStart(store, host, continuation, giverID, row)))
}

async function admitStart(store: QuestStore, host: QuestHost, continuation: QuestContinuation, giverID: string, row: Request) {
  const start = spanNow()
  try {
    const { context } = await timed({ plugin: 'quests', name: 'start admission: giver binding', op: row.quest }, async () => {
      const response = await host.get({ sessionID: giverID }), session = response?.data ?? response
      const context = giverContext(store, session, row.requestID, row.quest)
      await verifyGiverBinding(store, context, session)
      return { session, context }
    })
    adoptQuestGiver(store, row.quest)
    const read = store.read(row.quest)!
    const quest = row.kind === 'attention' || row.kind === 'handoff' ? saveStopCauses(store, read) : read
    if (row.kind === 'plan') {
      if (quest.archive || quest.state === 'Archived') { row.state = 'started'; row.result = { skipped: 'archived' }; save(store, row); return }
      await host.prompt({ sessionID: giverID, id: 'msg_questplan' + row.requestID, delivery: 'queue', resume: true, text: planNoticeOf(quest), metadata: { questPlan: true, questID: quest.id } })
      row.state = 'started'; save(store, row)
      return
    }
    if (row.kind === 'attention') {
      const run = quest.sessions.find(run => (run.runID ?? run.callID) === row.runID)
      if (quest.archive || quest.delivered || !run || row.reason && landingDone(quest.stages) || blockerWakeSettled(quest, run) || !row.reason && stoppedAfterDone(quest, run) || latestSessionAttempts(quest.sessions).some(other => OWNED_RUN.has(other.state))) { row.state = 'started'; row.result = { skipped: 'no unowned run requires attention' }; save(store, row); return }
      const own = attentionNotice(quest, run, row.reason), gate = noticeGate(store.runtime, quest, run.deliverables, own, run, () => openQuests(store))
      if (!gate.send) { row.state = 'started'; row.result = { skipped: gate.settled }; save(store, row); recordHandoff(store, quest.id, giverBlockers(quest), 'attention'); return }
      const text = gate.text ?? own
      try { await host.prompt({ sessionID: giverID, id: 'msg_questattention' + row.requestID, delivery: 'queue', resume: true, text, metadata: { questAttention: true, questID: quest.id, runID: row.runID, ...(gate.cause ? { questIDs: gate.cause.questIDs } : {}) } }) }
      catch (error) { causeNotDelivered(store.runtime, gate); throw error }
      noticeSent(store.runtime, gate.slot, own, quest)
      row.state = 'started'; save(store, row)
      recordHandoff(store, quest.id, giverBlockers(quest), 'attention')
      causeDelivered(store, gate, 'attention')
      return
    }
    if (row.kind === 'handoff') {
      const again = row.reason === REWAKE, via = again ? REWAKE : 'hand-off'
      const skipped = quest.archive ? 'archived' : !again && !unhandedBlockers(quest).length ? 'already handed over' : again && !giverBlockers(quest).length ? 'nothing is waiting on the Quest Giver' : latestSessionAttempts(quest.sessions).some(other => OWNED_RUN.has(other.state)) ? 'a run owns it again' : undefined
      if (skipped) { row.state = 'started'; row.result = { skipped }; save(store, row); return }
      const { text: own, stepIDs } = handoffNoticeOf(quest, again), gate = noticeGate(store.runtime, quest, stepIDs, own, undefined, () => openQuests(store), again)
      if (!gate.send) { row.state = 'started'; row.result = { skipped: gate.settled }; save(store, row); recordHandoff(store, quest.id, giverBlockers(quest), via); return }
      const text = gate.text ?? own
      try { await host.prompt({ sessionID: giverID, id: 'msg_questhandoff' + row.requestID, delivery: 'queue', resume: true, text, metadata: { questHandoff: true, questID: quest.id, ...(gate.cause ? { questIDs: gate.cause.questIDs } : {}) } }) }
      catch (error) { causeNotDelivered(store.runtime, gate); throw error }
      noticeSent(store.runtime, gate.slot, own, quest)
      row.state = 'started'; save(store, row)
      recordHandoff(store, quest.id, giverBlockers(quest), via)
      causeDelivered(store, gate, 'hand-off')
      return
    }
    if (row.kind === 'review') {
      row.state = 'started'
      row.result = { skipped: 'the worker result stands' }
      save(store, row)
      return
    }
    if (!row.authorization || row.authorization.definition !== definition(quest)) throw new QuestError('QUEST_CHANGED', 'Quest definition changed after Start; review its saved settings and start again')
    row.authorization.giverID = giverID
    save(store, row)
    const { readOnly, task, size, model, maxConcurrent } = questWorkflow(quest)
    const result = await timed({ plugin: 'quests', name: 'start admission: continuation', op: row.quest }, () => continuation.run(row.quest, { readOnly, task, size, model, maxConcurrent }, context))
    const current=result.continuation
    const deferred=current?.admissions?.find(item=>['waiting','stopped','unknown'].includes(item.state))
    const outcome=deferred?.state==='stopped'&&deferred.runID?store.read(row.quest)?.sessions.find(run=>(run.runID??run.callID)===deferred.runID)?.result:undefined
    row.result = { continuationID: current?.id, state: current?.admitted===0&&current?.waiting>0?'waiting':current?.state, runID: current?.runID??current?.admissions?.find(item=>item.state==='running')?.runID, reason:outcome??deferred?.reason??current?.reason }
    row.state = 'started'
  } catch (error) {
    row.state = error instanceof QuestError ? 'failed' : 'unknown'
    row.error = error instanceof Error ? error.message : String(error)
  } finally {
    recordSpan({ plugin: 'quests', name: 'admission', op: row.kind ?? 'start', sessionID: giverID, route: 'quests/start', start, end: spanNow(), outcome: row.state, ...(row.error ? { error: row.error } : {}) })
  }
  save(store, row)
}
