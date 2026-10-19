import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import {writeFileDurable} from '../core/durable-file.mjs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isSafeReference } from '../core/readable-reference'
import { readAllQuests } from '../index'
import { watchEntries } from '../host/coordinator-events'
import { askModelRouter, type ModelRouterHost } from './model-router'
import { routingSettings as savedRoutingSettings } from './routing-settings'
import { dispatchReservationFile, reserveDispatch, type DispatchInput, type DispatchStage, type RoutingRecord } from '../../models/dispatch-planner'
import type { DecisionTrace } from '../../models/decision-trace'
import type { RoutingSettings } from '../../models/routing-settings'
import { RouteReservations } from '../../models/route-reservations'
import { ledgerFirstRequests } from '../../usage/passive-ledger'
import type { QuestStore } from '../store'
import type { Quest, QuestSession } from '../types'
import { LEGACY_SIZE_DEPTH } from '../../models/work-profile'
import { allReplays, isReplayRun, readReplay, replayRun } from '../bench/replay-record'
import { enforceDirectoryBudget, retentionFrom, TELEMETRY_BUDGET } from '../../scripts/telemetry-budget.mjs'

type ChosenRoute = { id: string; model: string; effort: string }
type SavedDecision = Partial<RoutingRecord> & Pick<RoutingRecord, 'automatic' | 'task' | 'considered' | 'excluded'> & { version: 1; runID: string; route: ChosenRoute; at: string; size?: string }
const DECIDING = '.deciding.json'
export const routingDecisionsDirectory = (runtime: string) => join(runtime, 'routing-decisions')
const decisionFile = (runtime: string, runID: string, suffix = '.json') => {
  if (!isSafeReference(runID)) throw Error('Invalid run identity')
  return join(routingDecisionsDirectory(runtime), runID + suffix)
}
const writeAtomically = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileDurable(file, JSON.stringify(value))
}
const ALTERNATIVE_KEYS = ['considered', 'passedOver', 'excluded', 'exclusions'] as const
export function keepAlternatives(record: RoutingRecord): RoutingRecord {
  const kept: Record<string, unknown> = { ...record }
  for (const key of ALTERNATIVE_KEYS) if (Array.isArray(kept[key])) kept[key] = (kept[key] as unknown[]).slice(0, TELEMETRY_BUDGET.routingAlternatives)
  return kept as RoutingRecord
}
export function recordRoutingDecision(runtime: string, runID: string, route: ChosenRoute, record: RoutingRecord, at = new Date()) {
  writeAtomically(decisionFile(runtime, runID), { version: 1, runID, route, at: at.toISOString(), ...keepAlternatives(record) } satisfies SavedDecision)
  clearRoutingProgress(runtime, runID)
  enforceDirectoryBudget(routingDecisionsDirectory(runtime), TELEMETRY_BUDGET.routingDecisionsBytes, { cutoff: retentionFrom(), deletable: entry => !entry.name.endsWith(DECIDING) })
}
export type Deciding = { version: 1; runID: string; at: string; stage: DispatchStage; quest: { id: string; ref?: string; title: string }; steps: { id: string; title: string }[]; trace: DecisionTrace }
export function routingProgress(runtime: string, runID: string, context: Pick<Deciding, 'quest' | 'steps'>) {
  const file = decisionFile(runtime, runID, DECIDING)
  return (stage: DispatchStage, trace: DecisionTrace) => writeAtomically(file, { version: 1, runID, at: new Date().toISOString(), stage, ...context, trace } satisfies Deciding)
}
export function clearRoutingProgress(runtime: string, runID: string) { rmSync(decisionFile(runtime, runID, DECIDING), { force: true }) }

export type RoutingEvent = { type: 'routing.decided'; runID: string; route: ChosenRoute } | { type: 'routing.stage'; runID: string; deciding: Omit<Deciding, 'version'> | null }
export function watchRoutingDecisions(runtime: string, listener: (event: RoutingEvent) => void) {
  const directory = routingDecisionsDirectory(runtime)
  mkdirSync(directory, { recursive: true })
  return watchEntries(directory, { matches: name => name.endsWith('.json') && isSafeReference(name.slice(0, name.endsWith(DECIDING) ? -DECIDING.length : -5)) }, name => {
    if (!name) return
    if (name.endsWith(DECIDING)) {
      const runID = name.slice(0, -DECIDING.length)
      let deciding: Deciding | null = null
      try { const value = JSON.parse(readFileSync(join(directory, name), 'utf8')); if (value?.version === 1 && value.runID === runID) deciding = value } catch {}
      const { version: _version, ...shown } = deciding ?? { version: 1 }
      listener({ type: 'routing.stage', runID, deciding: deciding ? shown as Omit<Deciding, 'version'> : null })
      return
    }
    const runID = name.slice(0, -5), saved = savedDecision(runtime, runID)
    if (saved) listener({ type: 'routing.decided', runID, route: saved.route })
  })
}
export function savedDecision(runtime: string, runID: string): SavedDecision | undefined {
  try { const value = JSON.parse(readFileSync(decisionFile(runtime, runID), 'utf8')); return value?.version === 1 && value.runID === runID ? value : undefined } catch { return undefined }
}

export type RoutingHistoryRow = {
  runID: string
  at: string
  quest: { id: string; ref?: string; title: string }
  project: { id: string; root: string } | null
  steps: { id: string; title: string }[]
  task: string | null
  workType: string | null
  depth: string | null
  profileSource: string | null
  route: { id: string; model: string | null; effort: string | null }
  automatic: boolean | null
  benchOf: string | null
  reason: string
  evidence: string | null
  speed: string | null
  considered: string[] | null
  passedOver: { routeID: string; model?: string; effort?: string; why: string }[] | null
  excluded: { routeID: string; model?: string; effort?: string; reasons: string[] }[] | null
  state: string
  timing: { firstRequestMs: number | null; totalMs: number | null }
  traced: boolean
  decision?: DecisionTrace | null
}
export type RoutingHistoryInput = { questID?: string; projectID?: string; runID?: string; offset?: number; limit?: number }
const SAVED_EVIDENCE_WORDS: Record<string, string> = { replay: 'bench', 'routing judge': 'model router' }
const evidenceWord = (word: string) => SAVED_EVIDENCE_WORDS[word] ?? word
const TERMINAL = ['completed', 'failed', 'cancelled', 'missing', 'stale']
const statedTask = (reason: string) => /\btask (coding|review|planning|utility)\b/.exec(reason)?.[1] ?? null
const statedDepth = (reason: string) => /\bdepth (routine|standard|deep|frontier)\b/.exec(reason)?.[1] ?? LEGACY_SIZE_DEPTH[/\bsize (small|medium|large)\b/.exec(reason)?.[1] ?? ''] ?? null
const statedWorkType = (reason: string) => /\bwork ([a-z][a-z0-9-]*)\b/.exec(reason)?.[1] ?? null
const judgedAutomatically = (routeID: string, reason: string) => routeID.startsWith('chosen-') ? false : /: judged |routine work|speed setting/.test(reason) ? true : null

export function routingHistory(store: QuestStore, input: RoutingHistoryInput = {}, firstRequests: (sessionIDs: string[]) => Map<string, number> = ledgerFirstRequests) {
  const quests = readAllQuests(store.projectRoot, { includeArchived: true }).flatMap(row => row.quest ? [row.quest] : [])
  const runs = new Map<string, { quest: Quest; run: QuestSession }>()
  for (const quest of quests) for (const run of quest.sessions) if (run.runID && run.role !== 'command') runs.set(run.runID, { quest, run })
  for (const replay of allReplays(store.runtime)) { const quest = quests.find(row => row.id === replay.questID); if (quest) runs.set(replay.id, { quest, run: replayRun(replay) }) }
  const reservations = new RouteReservations(dispatchReservationFile(store.runtime)).list().filter(row => runs.has(row.runID))
  const projects = new Map<string, { id: string; root: string }>(), questsSeen = new Map<string, { id: string; ref?: string; title: string; projectID: string | null }>()
  for (const row of reservations) {
    const { quest } = runs.get(row.runID)!
    if (quest.project) projects.set(quest.project.id, quest.project)
    questsSeen.set(quest.id, { id: quest.id, ...(quest.ref ? { ref: quest.ref } : {}), title: quest.title, projectID: quest.project?.id ?? null })
  }
  const matching = reservations.filter(row => {
    const { quest } = runs.get(row.runID)!
    return (!input.questID || quest.id === input.questID || quest.ref === input.questID) && (!input.projectID || quest.project?.id === input.projectID) && (!input.runID || row.runID === input.runID)
  }).sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '') || b.runID.localeCompare(a.runID))
  const offset = input.offset ?? 0, limit = input.limit ?? 50
  const page = matching.slice(offset, offset + limit)
  const sessionOf = (run: QuestSession) => run.openCodeSessionId ?? run.sessionID
  let first = new Map<string, number>()
  try { first = firstRequests(page.flatMap(row => { const id = sessionOf(runs.get(row.runID)!.run); return id ? [id] : [] })) } catch {}
  const items: RoutingHistoryRow[] = page.map(row => {
    const { quest, run } = runs.get(row.runID)!
    const saved = savedDecision(store.runtime, row.runID)
    const reason = run.routingNote ?? row.reason
    const started = Date.parse(row.startedAt ?? '')
    const firstAt = sessionOf(run) ? first.get(sessionOf(run)!) : undefined
    const ended = row.state === 'settled' ? Date.parse(row.completedAt ?? '') : TERMINAL.includes(run.state) ? Date.parse(run.updatedAt) : NaN
    return {
      runID: row.runID, at: row.startedAt ?? run.updatedAt,
      quest: { id: quest.id, ...(quest.ref ? { ref: quest.ref } : {}), title: quest.title },
      project: quest.project ?? null,
      steps: run.deliverables.map(id => ({ id, title: quest.stages.find(step => step.id === id)?.title ?? id })),
      task: saved?.task ?? statedTask(reason), workType: saved?.workType ?? statedWorkType(reason), depth: saved?.depth ?? (saved?.size ? LEGACY_SIZE_DEPTH[saved.size] ?? null : null) ?? statedDepth(reason), profileSource: saved?.profileSource ?? null,
      route: { id: row.routeID, model: run.providerID && run.modelID ? run.providerID + '/' + run.modelID : saved?.route.model ?? null, effort: run.reasoningEffort ?? saved?.route.effort ?? null },
      automatic: saved ? saved.automatic : judgedAutomatically(row.routeID, reason),
      benchOf: saved?.replayOf ?? (isReplayRun(run) ? readReplay(store.runtime, row.runID)?.of ?? null : null),
      reason, evidence: saved?.evidence ? evidenceWord(saved.evidence) : null, speed: saved?.speed ?? null,
      considered: saved?.considered ?? null, passedOver: saved?.passedOver ?? null,
      excluded: saved?.excluded ?? null,
      state: run.state,
      timing: {
        firstRequestMs: Number.isFinite(started) && firstAt !== undefined && firstAt >= started ? firstAt - started : null,
        totalMs: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null,
      },
      traced: !!saved?.trace,
      ...(input.runID ? { decision: saved?.trace ? { ...saved.trace, how: evidenceWord(saved.trace.how) } : null } : {}),
    }
  })
  const nextOffset = offset + page.length < matching.length ? offset + page.length : null
  return { items, total: matching.length, nextOffset, projects: [...projects.values()], quests: [...questsSeen.values()] }
}

export type SimulationInput = { text: string; workType?: string; depth?: string; task?: string }
export type Simulation = { simulated: true; at: string; runID: string; route: { id: string; model: string; effort: string }; reason: string; record: RoutingRecord; decision: DecisionTrace }
export function dispatchHelpers(host: ModelRouterHost, runtime: string, directory: string, routing: RoutingSettings, runID?: string): Pick<DispatchInput, 'modelRouter'> {
  return {
    modelRouter: question => askModelRouter(host, { kind: 'model', runtime, directory, ...(runID ? { key: runID } : {}), ...question }),
  }
}
export async function simulateRouting(store: QuestStore, host: ModelRouterHost, input: SimulationInput, options: { policyFile: string; directory: string; reserve?: typeof reserveDispatch; routing?: () => RoutingSettings; runID?: string }): Promise<Simulation> {
  const text = input.text.trim()
  if (!text) throw Error('Describe the work to simulate')
  const routing = (options.routing ?? savedRoutingSettings)()
  const runID = options.runID ?? 'simulated-' + randomUUID().slice(0, 8)
  const at = new Date().toISOString()
  const selected = await (options.reserve ?? reserveDispatch)({
    runID, policyFile: options.policyFile, reservationFile: dispatchReservationFile(store.runtime), routing, simulate: true, brief: text,
    task: input.task, depth: input.depth, workType: input.workType, profileSetBy: { workType: 'you', depth: 'you' },
    ...dispatchHelpers(host, store.runtime, options.directory, routing, runID),
  })
  const route = { id: selected.route.id, model: selected.route.providerID + '/' + selected.route.modelID, effort: selected.route.reasoning }
  return { simulated: true, at, runID, route, reason: selected.decision?.summary ?? '', record: { ...selected.record, trace: undefined }, decision: selected.record.trace! }
}
