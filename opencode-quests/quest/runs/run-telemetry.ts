import { join } from "node:path"
import { readJsonRecord } from "../core/durable-file.mjs"
import { readEvents } from "../core/journal"
import { isSafeReference } from "../core/readable-reference"
import { routingDecisionsDirectory } from "../routing/routing-history"
import { readRequests, readSessionRequests } from "../../usage/telemetry-api"
import { readerFiles, readJsonlRows, runTraceFile, writeQuestRollup, writeRunTrace } from "../../usage/telemetry-store"
import type { RequestRecord } from "../../usage/telemetry"
import { buildRunTelemetry, permissionTokensOf, roleCost, roleTokens, speedSummary, type PriceLookup, type RoleCost, type RouterTokens, type RunDecision, type RunLanding, type RunPoints, type RunTelemetry, type SpeedRun, type ToolCounts } from "../../usage/run-telemetry"
import { admissionOf, buildRunTrace, hostSession, traceFromRows, traceRows, traceTable, type RunTrace, type RunTraceInput, type WorkspaceStage } from "../../usage/run-trace"
import { hostDatabaseFile, hostToolCalls } from "../../usage/worker-time"
import { readAllQuests } from "../index"
import { readContinuations } from "../core/runtime-queues"
import { startRequests } from "./start-request"
import { timed } from "../../scripts/plugin-spans"
import { TERMINAL_RUN } from "./session-lineage"
import { questIsFinished, questRollupOf, type RollupRun } from "./quest-rollup"
import { giverTurnRequests, giverTurnsOfQuest, openHostDatabase, type GiverTurn } from "../giver/handoff-cost"
import { JEV_PROVIDER } from "../../models/jev-bridge"
import type { QuestStore } from "../store"
import type { Quest, QuestSession } from "../types"
import { questReference } from "../core/references"
import type { Database } from "bun:sqlite"

type SavedDecision = { at?: string; route?: { id: string; model?: string; effort?: string }; chosenBy?: string; considered?: string[]; excluded?: RunDecision["excluded"] }

export type TelemetrySources = { requests: RequestRecord[]; host: Database | undefined; hostFile: string }
export function telemetrySources(hostDB = hostDatabaseFile()): TelemetrySources {
  return { requests: readRequests(readerFiles().requests).records, host: openHostDatabase(hostDB), hostFile: hostDB }
}

const toolCountsOf = (file: string, sessionID: string, from: number, to: number): ToolCounts | null => {
  const read = hostToolCalls(file, sessionID, from, to)
  return read.available ? { calls: read.calls.length, failed: read.calls.filter(call => call.status === "error").length } : null
}

export function routerRequestFor(requests: RequestRecord[], window: { from: number; to: number }): RequestRecord | undefined {
  let best: RequestRecord | undefined
  for (const request of requests) {
    if (request.route.providerID !== JEV_PROVIDER || request.route.modelID !== "auto" || request.state !== "completed" || request.completedAt === undefined) continue
    if (request.completedAt > window.to || request.startedAt < window.from) continue
    if (!best || request.completedAt > best.completedAt!) best = request
  }
  return best
}

function routerOf(requests: RequestRecord[], createdAt: string | undefined, routedAt: string | undefined, lookup?: PriceLookup): RouterTokens | null {
  const from = Date.parse(createdAt ?? ""), to = Date.parse(routedAt ?? "")
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  const row = routerRequestFor(requests, { from, to })
  if (!row) return null
  return { model: JEV_PROVIDER + "/auto", calls: 1, tokens: roleTokens([row]), cost: roleCost([row], lookup), matched: "time" }
}

export function recordRunTelemetry(store: QuestStore, questID: string, callID: string, state: string, finishedAt: string, lookup?: PriceLookup, sources?: TelemetrySources): RunTelemetry | undefined {
  return recordRunReading(store, questID, callID, state, finishedAt, lookup, sources)?.telemetry
}

export type RunReading = { telemetry: RunTelemetry; trace: RunTrace | undefined; giverTurns: RequestRecord[] }

export function recordRunReading(store: QuestStore, questID: string, callID: string, state: string, finishedAt: string, lookup?: PriceLookup, sources?: TelemetrySources, withTrace = false): RunReading | undefined {
  const own = sources ? undefined : telemetrySources()
  try { return recordRun(store, questID, callID, state, finishedAt, lookup, sources ?? own!, withTrace) } finally { own?.host?.close() }
}

function recordRun(store: QuestStore, questID: string, callID: string, state: string, finishedAt: string, lookup: PriceLookup | undefined, sources: TelemetrySources, withTrace: boolean): RunReading | undefined {
  const quest = store.read(questID)
  const run: QuestSession | undefined = quest?.sessions.find(session => session.callID === callID)
  if (!quest || !run?.runID) return undefined
  const runID = run.runID
  const events = readEvents(store.runtime, questID)
  const firstAt = (type: string, matches: (payload: Record<string, unknown>) => boolean) => events.find(event => event.type === type && matches(event.payload))?.at
  const decision = isSafeReference(runID) ? readJsonRecord<SavedDecision>(join(routingDecisionsDirectory(store.runtime), runID + ".json")) : undefined
  const points: RunPoints = {
    created: quest.createdAt,
    routed: decision?.at,
    planned: firstAt("session-planned", payload => payload.runID === runID || payload.callID === callID),
    claimed: firstAt("session-claimed", payload => payload.callID === callID),
    bound: firstAt("session-bound", payload => payload.callID === callID),
    workerStart: run.startedAt,
    finished: finishedAt,
  }
  const sessionID = run.openCodeSessionId ?? run.sessionID
  const requests = sessionID ? readSessionRequests(sessionID, readerFiles().requests).records : []
  const landing = (quest.extensions.landings as Record<string, RunLanding> | undefined)?.[runID]
  const giver = giverRecordOf(quest, sources.host, sources.requests)
  const permission = permissionTokensOf(run.permissionDecisions ?? [], sources.requests)
  const from = Date.parse(run.startedAt ?? ""), to = Date.parse(finishedAt)
  const tools = sessionID && Number.isFinite(from) && Number.isFinite(to) ? toolCountsOf(sources.hostFile, sessionID, from, to) : null
  const workType = (quest.extensions.workflow as { task?: unknown } | undefined)?.task
  const telemetry = buildRunTelemetry({
    questID, runID, callID, state, points, requests, landing, tools, workType: typeof workType === "string" ? workType : null,
    route: decision?.route,
    decision: decision?.excluded && decision.considered ? { chosenBy: decision.chosenBy, considered: decision.considered, excluded: decision.excluded } : undefined,
    giverRequests: giver?.requests, giver: giver?.summary ?? null,
    router: routerOf(sources.requests, quest.createdAt, decision?.at, lookup),
    permission,
  }, lookup)
  const saved = ((quest.extensions.runTelemetry ?? {}) as Record<string, RunTelemetry>)[runID]?.points
  const trace = withTrace ? traceOf(store, questID, runID, state, points, saved, requests, landing, sessionID, sources, lookup, giver?.requests) : undefined
  return { telemetry, trace, giverTurns: giver?.requests ?? [] }
}

function workspaceStages(runtime: string, runID: string): WorkspaceStage[] | undefined {
  if (!isSafeReference(runID)) return undefined
  return readJsonRecord<{ preparationTimeline?: WorkspaceStage[] }>(join(runtime, "workspaces", runID + ".json"))?.preparationTimeline
}

function traceOf(store: QuestStore, questID: string, runID: string, state: string, points: RunPoints, saved: RunPoints | undefined, requests: RequestRecord[], landing: RunLanding | undefined, sessionID: string | undefined, sources: TelemetrySources, lookup?: PriceLookup, giver: RequestRecord[] = []): RunTrace | undefined {
  const known = Object.fromEntries(Object.entries(points).filter(([, value]) => value !== undefined)) as RunPoints
  return timed({ plugin: "quests", name: "run.trace", op: runID }, () => buildRunTrace({
    questID, runID, state, points: { ...saved, ...known }, requests, lookup, giver,
    landingAt: landing?.at,
    workspace: workspaceStages(store.runtime, runID),
    admission: admissionOf(startRequests(store, questID), readContinuations(store.runtime), questID, runID),
    session: sessionID && sources.host ? hostSession(sources.host, sessionID) : null,
  }))
}

const giverTurnKey = (sessionID: string, startedAt: number) => sessionID + "@" + startedAt

export function giverRecordOf(quest: Quest, host: Database | undefined, rows: RequestRecord[] = []): { requests: RequestRecord[]; summary: { turns: number; requests: number; modelMs: number; unmapped: string[] } | null } | undefined {
  const saved = rows.filter(row => row.role === "giver" && row.questID === quest.id)
  if (!host) return saved.length ? { requests: saved, summary: null } : undefined
  const workerSessions = new Set(quest.sessions.flatMap(run => [run.openCodeSessionId, run.sessionID, ...(run.permissionDecisions ?? []).map(decision => decision.jevCall?.sessionID)]).filter((id): id is string => !!id))
  const placing = (quest.request ?? []).filter(request => !request.context).map(request => request.messageID)
  const found = giverTurnsOfQuest(host, { quest: { id: quest.id, ref: quest.ref }, runIDs: quest.sessions.map(session => session.runID).filter((id): id is string => !!id), placing })
  const turns: GiverTurn[] = found.turns.filter(turn => !workerSessions.has(turn.sessionID))
  const savedKeys = new Set(saved.map(row => giverTurnKey(row.sessionID, row.startedAt)))
  const hostedKeys = new Set(turns.map(turn => giverTurnKey(turn.sessionID, turn.startedAt)))
  const unhosted = saved.filter(row => !hostedKeys.has(giverTurnKey(row.sessionID, row.startedAt))).length
  const unmapped = [
    ...(found.unmapped.length ? [found.unmapped.length + " of " + found.starts.length + " Giver turns are still running or not in the host database"] : []),
    ...(unhosted ? [unhosted + " Giver turn" + (unhosted === 1 ? "" : "s") + " saved as rows but not in the host database: model calls and model time not counted"] : []),
  ]
  const unsaved = turns.filter(turn => !savedKeys.has(giverTurnKey(turn.sessionID, turn.startedAt)))
  return {
    requests: [...saved, ...giverTurnRequests(unsaved)],
    summary: { turns: saved.length + unsaved.length, requests: turns.reduce((n, turn) => n + turn.requests, 0), modelMs: turns.reduce((n, turn) => n + turn.modelMs, 0), unmapped },
  }
}

export function runEndPayload(store: QuestStore, questID: string, payload: Record<string, unknown>): Record<string, unknown> {
  const before = store.read(questID)?.sessions.find(session => session.callID === payload.callID)
  if (!before || TERMINAL_RUN.has(before.state)) return payload
  return timed({ plugin: "quests", name: "run.telemetry", op: before.runID ?? before.callID }, () => {
    const reading = recordRunReading(store, questID, String(payload.callID), String(payload.state), new Date().toISOString(), undefined, undefined, true)
    if (!reading) return payload
    const { telemetry, trace } = reading
    if (trace && isSafeReference(telemetry.runID)) writeRunTrace(runTraceFile(store.runtime, telemetry.runID), traceRows(trace))
    timed({ plugin: "quests", name: "quest.rollup", op: questID }, () => recordQuestRollup(store, questID, String(payload.callID), String(payload.state), reading))
    return { ...payload, extensionsPatch: { runTelemetry: { [telemetry.runID]: telemetry } } }
  })
}

function savedTrace(runtime: string, runID: string): RunTrace | undefined {
  return isSafeReference(runID) ? traceFromRows(readJsonlRows(runTraceFile(runtime, runID)) ?? []) : undefined
}

function recordQuestRollup(store: QuestStore, questID: string, callID: string, state: string, reading: RunReading): void {
  try {
    const quest = store.read(questID)
    if (!quest) return
    const sessions = quest.sessions.map(session => session.callID === callID ? { ...session, state: state as QuestSession["state"] } : session)
    const finishing = { ...quest, sessions }
    if (!questIsFinished(finishing, callID)) return
    const saved = (quest.extensions.runTelemetry ?? {}) as Record<string, RunTelemetry>
    const runs = sessions.flatMap((session): RollupRun[] => {
      if (!session.runID) return []
      return [session.callID === callID
        ? { session, telemetry: reading.telemetry, trace: reading.trace }
        : { session, telemetry: saved[session.runID] ?? null, trace: savedTrace(store.runtime, session.runID) }]
    })
    writeQuestRollup(store.runtime, questRollupOf(finishing, quest.project?.root ?? store.projectRoot, runs, reading.telemetry.points.finished ?? "", reading.giverTurns))
  } catch (error) { console.error("[quests] quest rollup not recorded", questID, error) }
}

function traceView(store: QuestStore, runID: string, computed: RunTrace | undefined) {
  const file = isSafeReference(runID) ? runTraceFile(store.runtime, runID) : undefined
  const trace = traceFromRows(file ? readJsonlRows(file) ?? [] : []) ?? computed
  if (!trace) return { file, lines: ["no trace: this run's sources are not readable"] }
  return { file, lines: traceTable(trace), wallMs: trace.wallMs, unaccountedMs: trace.unaccountedMs, buckets: trace.buckets, turns: trace.turns, tokens: trace.tokens.total, largest: trace.largest, missing: trace.missing }
}

const wallMilliseconds = (run: RunTelemetry) => {
  const from = Date.parse(run.points?.workerStart ?? ""), to = Date.parse(run.points?.finished ?? "")
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null
}

export function runSpeedPicture(store: QuestStore, now: number) {
  const runs = readAllQuests(store.projectRoot, { includeArchived: true }).flatMap(entry => entry.quest ? Object.values((entry.quest.extensions.runTelemetry ?? {}) as Record<string, RunTelemetry>) : [])
  const rows: SpeedRun[] = runs.map(run => ({ route: run.route ? run.route.model ?? run.route.id : null, workType: run.workType ?? null, state: run.state, landed: run.outcome?.landed ?? null, wallMs: run.speed?.wallMs ?? wallMilliseconds(run), planUSD: run.cost?.worker?.planUSD ?? null }))
  const unmeasured = runs.filter(run => !run.speed).length
  return {
    at: now,
    head: runs.length + (runs.length === 1 ? " run record" : " run records") + (unmeasured ? ", " + unmeasured + " saved before speed was recorded (wall time from phase points only)" : ""),
    routes: speedSummary(rows, "route"),
    workTypes: speedSummary(rows, "workType"),
  }
}

const unknownIfReason = (cost: RoleCost) => cost.reason ? "unknown" : null
const shownCost = (cost: RoleCost | null) => cost && { ...cost, listUSD: cost.listUSD ?? unknownIfReason(cost), planUSD: cost.planUSD ?? unknownIfReason(cost), allowanceShare: cost.allowanceShare ?? unknownIfReason(cost) }

export function runTelemetryPicture(store: QuestStore, quest: Quest, now: number, options: { trace?: boolean } = {}) {
  const saved = Object.values((quest.extensions.runTelemetry ?? {}) as Record<string, RunTelemetry>)
  const sources = saved.length && store.read(quest.id) ? telemetrySources() : undefined
  let readings: RunReading[]
  try {
    readings = saved.map(run => {
      const reading = sources && recordRunReading(store, quest.id, run.callID, run.state, run.points?.finished ?? new Date(now).toISOString(), undefined, sources, !!options.trace)
      return reading ? reading : { telemetry: run, trace: undefined, giverTurns: [] }
    })
  } finally { sources?.host?.close() }
  const runs = readings.map(reading => reading.telemetry)
  const partial = runs.filter(run => run.partial).length
  return {
    at: now, quest: questReference(quest),
    head: runs.length + (runs.length === 1 ? " run record" : " run records") + (partial ? ", " + partial + " partial (stopped or failed)" : "") + (runs.length ? "" : "; none recorded yet"),
    runs: readings.map(({ telemetry: run, trace }) => ({
      run: run.runID, state: run.state, partial: run.partial,
      gaps: (run.gaps ?? []).map(gap => ({ from: gap.from, to: gap.to, seconds: Math.round(gap.milliseconds / 1000) })),
      tokens: run.tokens?.worker ?? null, startContext: run.tokens?.startContext ?? null, giver: run.tokens?.giver ?? null, router: run.tokens?.router ?? null, permission: run.tokens?.permission ?? null,
      cost: run.cost && !Array.isArray(run.cost) ? { worker: shownCost(run.cost.worker), giver: shownCost(run.cost.giver), router: shownCost(run.cost.router) } : null, route: run.route ?? null, outcome: run.outcome ?? null,
      workType: run.workType ?? null, speed: run.speed ?? null,
      failed: (run.routes ?? []).filter(route => route.failed > 0), excluded: run.decision?.excluded ?? [], missing: run.missing ?? [],
      ...(options.trace ? { trace: traceView(store, run.runID, trace) } : {}),
    })),
  }
}
