import { runningGeneration } from '../../scripts/running-generation.mjs'
import "../../usage/host-hooks"
import { configuredAccess } from '../../models/access-policy'
import { getAccountUsage, readAccountUsage } from '../../usage-service/on-computer'
import { primeSessionRequests, readSessionRequests, TELEMETRY_FILE } from '../../usage/telemetry-store'
import { hostToolCalls } from '../../usage/worker-time'
import { observationFromActivity } from '../board/activity'
import { readAllQuests } from '../index'
import { hostModelIdentities, hostPermissions } from './host-observation'
import { readEvents } from '../core/journal'
import { changedExtensions } from '../core/extension-patch'
import { patchedStages } from '../core/stage-patch'
import { redactSensitive } from '../privacy'
import { driftNow } from '../../scripts/version-drift.mjs'
import { routeAlerts } from '../../usage/route-limits'
import { questCounts, questTruth } from '../runs/reachability'
import { reportBullet } from '../board/quest-report'
import { nativeRunID, ownedRuns } from '../runs/session-lineage'
import { activitySpans, stallAssessment, type StallAssessment } from '../workers/stall-signal'
import { admissionRecords } from '../runs/start-request'
import { readSystemHosts, readSystemServing, type SystemHost, type SystemReload, type SystemServing } from './system-runtime'
import { waterfallSources } from '../bench/quest-waterfall'
import { PICK_ACTION, lookupIn, pickWaiting } from '../artifacts/studio-picks'
import { observeWorker, observationFailure, boundedInspection } from '../worker-observation.mjs'
import type { AccountUsage } from '../../usage-service/on-computer'
import type { QuestStore } from '../store'
import type { Quest, QuestSession, QuestEvent } from '../types'

export type SystemRun = {
  questID: string; questTitle: string; runID: string; sessionID: string | null; role: string
  route: string | null; recordedRoute: string | null; stepIDs: string[]; state: string; recordedState: string; confirmed: boolean; reason: string
  startedAt: string | null; lastSavedStepAt: string | null; minutesSinceLastSavedStep: number | null
  lastActivityAt: string | null; stall: StallAssessment | null
}
export type SystemState = {
  at: string; completedAt: string
  board: { counts: ReturnType<typeof questCounts>; queued: { questID: string; title: string; reason: string; nextAction: string }[] }
  runs: SystemRun[]; hosts: SystemHost[]; serving: SystemServing; reloadQueue: SystemReload[]
  accounts: { updatedAt: string | null; items: AccountUsage[] }
  blockedSteps: { questID: string; questTitle: string; stepID: string; title: string; kind: string; owner: string | null; requires: string; note: string | null }[]
  needsYou: { questID?: string; title: string; sessionID?: string; stepID?: string; runID?: string; requestID?: string; kind: string; reason: string; ask: string }[]
  routes: { providerID: string; modelPattern: string; matches: string[] | null; reason: string | null }[]
  diagnostics: string[]
}

export function systemStateFor(state: SystemState, questID?: string): SystemState & { questID?: string } {
  if (!questID) return state
  return {
    ...state, questID,
    board: { ...state.board, queued: state.board.queued.filter(row => row.questID === questID) },
    runs: state.runs.filter(row => row.questID === questID),
    blockedSteps: state.blockedSteps.filter(row => row.questID === questID),
    needsYou: state.needsYou.filter(row => row.questID === questID),
  }
}

const unwrap = (value: any) => value?.data ?? value
const why = (error: unknown) => redactSensitive(error instanceof Error ? error.message : String(error))
const signature = (step: any) => JSON.stringify([step.status, step.note, step.blocker, step.resolution, step.result, step.proofs, step.todos])

export function lastSavedRunStep(quest: Quest, run: QuestSession, events: QuestEvent[]): string | null {
  const assigned = new Set(run.deliverables), prior = new Map<string, string>(), runID = run.runID ?? run.callID
  const planned = events.find(event => event.type === 'session-planned' && (event.payload.callID === run.callID || event.payload.runID === runID))?.at
  const started = Date.parse(run.startedAt ?? planned ?? ''), marks: string[] = []
  const saved = (quest.extensions.runStepSavedAt ?? {}) as Record<string, Record<string, string>>
  for (const [stepID, at] of Object.entries(saved[runID] ?? {})) if (assigned.has(stepID)) marks.push(at)
  let previousReport: string | undefined
  for (const event of events) {
    const payload = event.payload as any
    if (event.type === 'created' || event.type === 'patched') {
      for (const step of patchedStages(payload)) {
        const fresh = signature(step), changed = prior.has(step.id) && prior.get(step.id) !== fresh
        if (event.type === 'patched' && changed && assigned.has(step.id) && event.source === 'quest:update') marks.push(event.at)
        prior.set(step.id, fresh)
      }
      const report = changedExtensions(payload).runReports?.[runID]
      if (report) {
        const fresh = JSON.stringify(report)
        if (event.type === 'patched' && previousReport !== fresh) marks.push(event.at)
        previousReport = fresh
      }
    } else if (event.type === 'stage-state' && assigned.has(payload.stageID)) {
      if (payload.evidence || payload.note || event.source === 'quest:worker-report') marks.push(event.at)
      const old = quest.stages.find(step => step.id === payload.stageID)
      if (old) prior.set(old.id, signature({ ...old, status: payload.status, note: payload.evidence ?? payload.note }))
    }
  }
  return marks.filter(at => Number.isFinite(Date.parse(at)) && (!Number.isFinite(started) || Date.parse(at) >= started)).sort().at(-1) ?? null
}

export async function readSystemState(store: QuestStore, host: any, options: { signal?: AbortSignal; telemetryFile?: string } = {}): Promise<SystemState> {
  const at = new Date().toISOString(), diagnostics: string[] = []
  const read = async <T>(name: string, work: () => T | Promise<T>, fallback: T): Promise<T> => {
    try { return await work() } catch (error) { diagnostics.push(name + ': ' + why(error)); return fallback }
  }
  const [inventory, release, usage, models, policy] = await Promise.all([
    read('Hosts', () => readSystemHosts(host, options.signal), { hosts: [], active: {}, knownSessions: new Set<string>(), asks: [], diagnostics: [] }),
    read('Serving revision', () => readSystemServing(options.signal), {
      serving: { channel: process.env.OPENCODE_RELEASE_CHANNEL ?? null, generation: runningGeneration(), commit: null, v2: null, matchesV2: null, checkedAt: at, repository: null }, reloadQueue: [], diagnostics: [],
    }),
    read('Account refresh', () => getAccountUsage({ refresh: true }), readAccountUsage()),
    read<string[] | null>('Model catalog', () => hostModelIdentities(host), null),
    read<ReturnType<typeof configuredAccess> | null>('Allowed routes', () => configuredAccess(), null),
  ])
  diagnostics.push(...inventory.diagnostics, ...release.diagnostics, ...usage.diagnostics)
  const listed = await read('Quest board', () => readAllQuests(store.projectRoot), [])
  for (const row of listed) for (const error of row.errors) diagnostics.push('Quest board: ' + row.path + ': ' + error)
  const quests = listed.flatMap(row => row.quest ? [row.quest] : [])
  const admission = await read('Queue admissions', () => admissionRecords(store), { continuations: [], starts: [], now: Date.now(), schedules: () => false })
  const activity = observationFromActivity({ active: inventory.active, checkedAt: at })
  const observations = new Map<QuestSession, any>()
  await Promise.all(quests.flatMap(quest => ownedRuns(quest).map(async run => {
    const id = nativeRunID(run)
    if (!id) { observations.set(run, activity(run)); return }
    try {
      const [session, permissions] = await Promise.all([
        boundedInspection(signal => host.get({ sessionID: id }, { signal })),
        boundedInspection(() => hostPermissions(host, id)),
      ])
      if (unwrap(session)?.id !== id) {
        observations.set(run, { state: 'missing', reason: 'The owning host does not return the recorded session', checkedAt: new Date().toISOString() })
        return
      }
      const observation: any = observeWorker(unwrap(session), {
        active: Object.hasOwn(inventory.active, id) ? true : inventory.knownSessions.has(id) ? false : undefined,
        permissions: unwrap(permissions), messages: [], expected: run,
        forms: inventory.asks.filter(ask => ask.sessionID === id && ask.kind === 'question'),
      } as any)
      observation.permissions = Array.isArray(unwrap(permissions)) ? unwrap(permissions) : []
      observations.set(run, observation)
    } catch (error) { observations.set(run, observationFailure(error)); diagnostics.push('Run ' + (run.runID ?? run.callID) + ': ' + why(error)) }
  })))
  const truths = quests.map(quest => questTruth(quest, run => observations.get(run) ?? activity(run), admission))
  const byID = new Map(quests.map(quest => [quest.id, quest]))
  const telemetryFile = options.telemetryFile ?? TELEMETRY_FILE
  const nativeRuns = truths.flatMap(truth => truth.runs).filter(row => nativeRunID(row.run))
  if (nativeRuns.length) await read('Run activity', () => primeSessionRequests(telemetryFile), undefined)
  const now = Date.now(), runs: SystemRun[] = [], needsYou: SystemState['needsYou'] = [], blockedSteps: SystemState['blockedSteps'] = []
  for (const ask of inventory.asks) {
    const quest = quests.find(quest => quest.sessions.some(run => nativeRunID(run) === ask.sessionID))
    needsYou.push({ ...ask, ...(quest ? { questID: quest.id } : {}), title: quest?.title ?? ask.reason })
  }
  for (const alert of driftNow().alerts) needsYou.push({ title: alert.name, kind: 'update', reason: alert.text, ask: alert.fix })
  for (const alert of routeAlerts()) needsYou.push({ title: 'Route ' + alert.route, kind: 'route', reason: alert.reason, ask: 'Routine steps only until it succeeds; check the account or model behind this route' })
  for (const truth of truths) {
    const quest = truth.quest
    if (quest.state === 'Archived') continue
    const events = truth.runs.length ? await read('Saved steps for ' + quest.id, () => readEvents(store.runtime, quest.id), []) : []
    for (const row of truth.runs) {
      const run = row.run, sessionID = nativeRunID(run) ?? null
      const lastSavedStepAt = lastSavedRunStep(quest, run, events)
      let stall: StallAssessment | null = null
      if (sessionID) stall = await read('Run activity for ' + sessionID, () => {
        const requests = readSessionRequests(sessionID, telemetryFile).records
        const calls = hostToolCalls(waterfallSources().hostDB, sessionID, 0, now).calls
        return stallAssessment(activitySpans(requests, calls), now)
      }, null)
      const model = run.providerID && run.modelID ? run.providerID + '/' + run.modelID : run.model ?? null
      const recordedRoute = model && run.reasoningEffort && !model.includes('#') ? model + '#' + run.reasoningEffort : model
      const observed = observations.get(run)
      const actual = observed?.provider && observed?.model ? observed.provider + '/' + observed.model : null
      const route = actual ? actual + (observed.reasoning && observed.reasoning !== 'unknown' ? '#' + observed.reasoning : '') : sessionID ? null : recordedRoute
      runs.push({
        questID: quest.id, questTitle: quest.title, runID: run.runID ?? run.callID, sessionID,
        role: run.agentRole ?? run.role, route, recordedRoute, stepIDs: run.deliverables, state: row.state, recordedState: run.state,
        confirmed: row.confirmed, reason: row.reason, startedAt: run.startedAt ?? null, lastSavedStepAt,
        minutesSinceLastSavedStep: lastSavedStepAt ? Math.max(0, (now - Date.parse(lastSavedStepAt)) / 60_000) : null,
        lastActivityAt: row.lastActivityAt ?? (stall?.lastActivity ? new Date(stall.lastActivity).toISOString() : null), stall,
      })
      for (const pending of row.pending) if (!needsYou.some(ask => ask.sessionID === sessionID && ask.requestID === pending.id)) needsYou.push({
        questID: quest.id, title: quest.title, runID: run.runID ?? run.callID, ...(sessionID ? { sessionID } : {}), ...(pending.id ? { requestID: pending.id } : {}),
        kind: 'permission', reason: [pending.action, ...pending.resources].join(' '),
        ask: 'Open the pending approval in Quest Web and allow or reject the request.',
      })
    }
    for (const step of quest.stages.filter(step => step.status === 'blocked')) {
      blockedSteps.push({
        questID: quest.id, questTitle: quest.title, stepID: step.id, title: step.title,
        kind: step.blocker?.kind ?? 'unknown', owner: step.blocker?.owner ?? null,
        requires: step.blocker?.requires ?? step.note ?? '', note: step.note ?? null,
      })
      if (step.needsJon) needsYou.push({
        questID: quest.id, title: quest.title, stepID: step.id, kind: step.needsJon,
        reason: step.blocker?.requires ?? step.note ?? '', ask: 'Tell the Quest Giver what you decide.',
      })
    }
    for (const set of pickWaiting(quest, lookupIn(quests))) needsYou.push({
      questID: quest.id, title: quest.title, kind: 'choice',
      reason: 'Pick one of ' + set.variations.filter(row => row.state === 'ready').length + ' variations of ' + set.thing + '.', ask: PICK_ACTION,
    })
    if (truth.group === 'you' && !needsYou.some(ask => ask.questID === quest.id)) {
      const bullet = reportBullet(truth, byID)
      needsYou.push({ questID: quest.id, title: quest.title, kind: 'choice', reason: bullet.sentence, ask: bullet.ask })
    }
  }
  const value: SystemState = {
    at, completedAt: new Date().toISOString(), board: {
      counts: questCounts(truths), queued: truths.filter(truth => truth.group === 'queued' && truth.state !== 'Archived').map(truth => ({
        questID: truth.quest.id, title: truth.quest.title, reason: reportBullet(truth, byID).sentence, nextAction: truth.quest.nextAction,
      })),
    }, runs, hosts: inventory.hosts, serving: release.serving, reloadQueue: release.reloadQueue,
    accounts: { updatedAt: usage.updatedAt || null, items: usage.accounts }, blockedSteps, needsYou,
    routes: (policy?.routes ?? []).map(route => {
      let matches: string[] | null = null, reason: string | null = models ? null : 'The host model catalog is unavailable'
      try {
        const pattern = new RegExp('^(?:' + route.modelPattern + ')$')
        matches = models ? models.filter(model => model.startsWith(route.providerID + '/') && pattern.test(model.slice(route.providerID.length + 1))) : null
        if (matches?.length === 0) reason = 'No signed-in host model matches this allowed route'
      } catch (error) { reason = 'The allowed route pattern is invalid: ' + why(error) }
      return { providerID: route.providerID, modelPattern: route.modelPattern, matches, reason }
    }),
    diagnostics,
  }
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? redactSensitive(item) : item))
}
