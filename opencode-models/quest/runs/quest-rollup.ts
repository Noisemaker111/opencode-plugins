import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { RunPoints, RunTelemetry } from "../../usage/run-telemetry"
import type { RunTrace } from "../../usage/run-trace"
import type { RequestRecord } from "../../usage/telemetry"
import type { Quest, QuestSession } from "../types"
import { isLandingStep } from "../landing/landing-step"
import { TERMINAL_RUN } from "./session-lineage"
import { questWorkflow } from "./workflow"

export type RollupRun = { session: QuestSession; telemetry: RunTelemetry | null; trace: RunTrace | undefined }
export type RollupTokens = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null }
export type RollupOutcome = "delivered" | "blocked" | "refused" | "failed"
export type RollupPhases = {
  planMs: number; routeQueueMs: number; admissionHoldMs: number; giverModelMs: number; workerStartupMs: number
  workerModelMs: number; toolMs: number; checkMs: number; landingMs: number; unaccountedMs: number
}
export type LanderRecord = { ticket?: string; arg?: string; at?: string; outcome?: string; pr?: number; branch?: string | null; attempt?: number; commit?: string; verdict?: string; total?: number; phases?: Record<string, number> }
export type RollupLanding = { totalMs: number; queueWaitMs: number; coreSuiteMs: number; pushMs: number; attempts: number; sentBack: number }
export type GiverKind = "plan" | "delegate" | "answer" | "other"
export type RollupGiverKind = { turns: number; turnMs: number | null; listUSD: number | null; tokens: RollupTokens }
export type RollupRunRow = { runID: string; state: string; wallMs: number | null; route: string | null; tokens: RollupTokens | null; listUSD: number | null }
export type QuestRollupRow = {
  version: 1; questID: string; projectRoot: string | null; createdAt: string; plannedAt: string | null; firstWorkerStartAt: string | null; finishedAt: string
  wallMs: number | null; phases: RollupPhases | null; overlapMs: number | null; landing: RollupLanding | null
  runs: RollupRunRow[]; giverRequests: number | null; giverModelMs: number | null; giverTokens: RollupTokens | null; giverByKind: Record<GiverKind, RollupGiverKind> | null; workerTokens: RollupTokens | null
  steps: { total: number; done: number }; deliveryMode: string | null; outcome: RollupOutcome | null; failureReason: string | null; listUSD: number | null
}

const PHASE_PRIORITY = ["workerModelMs", "toolMs", "checkMs", "landingMs", "workerStartupMs", "admissionHoldMs", "routeQueueMs", "planMs", "giverModelMs"] as const
const FAILED_STATES = new Set(["failed", "cancelled", "missing", "stale"])
const REASON_LIMIT = 160

const millis = (value: string | undefined) => { const found = Date.parse(value ?? ""); return Number.isFinite(found) ? found : undefined }
const earliest = (values: (string | undefined)[]) => values.filter(value => millis(value) !== undefined).sort((a, b) => millis(a)! - millis(b)!)[0] ?? null
const sumOrNull = (values: (number | null | undefined)[]) => values.length && values.every((value): value is number => typeof value === "number") ? values.reduce((total, value) => total + value, 0) : null
const sumTokens = (rows: (RollupTokens | null)[]): RollupTokens | null => rows.length && rows.every(row => row !== null) ? {
  input: sumOrNull(rows.map(row => row!.input)), output: sumOrNull(rows.map(row => row!.output)), cacheRead: sumOrNull(rows.map(row => row!.cacheRead)), cacheWrite: sumOrNull(rows.map(row => row!.cacheWrite)),
} : null
const tokensOf = (tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null }): RollupTokens => ({ input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite })
const shortText = (text: string | null | undefined) => text ? (text.length > REASON_LIMIT ? text.slice(0, REASON_LIMIT - 3) + "..." : text) : null
const routeName = (route: RunTelemetry["route"] | undefined) => route ? [route.id, route.model].filter(Boolean).join("/") : null

const GIVER_KINDS: GiverKind[] = ["plan", "delegate", "answer", "other"]
const sumEvery = (values: (number | null | undefined)[]) => values.every((value): value is number => typeof value === "number") ? values.reduce((total, value) => total + value, 0) : null
const giverTokensOf = (turns: RequestRecord[]): RollupTokens => ({ input: sumEvery(turns.map(turn => turn.tokens.input)), output: sumEvery(turns.map(turn => turn.tokens.output)), cacheRead: sumEvery(turns.map(turn => turn.tokens.cacheRead)), cacheWrite: sumEvery(turns.map(turn => turn.tokens.cacheWrite)) })
function giverByKindOf(turns: RequestRecord[], giverTurns: number | null): Record<GiverKind, RollupGiverKind> | null {
  if (giverTurns === null || turns.length !== giverTurns || turns.some(turn => !GIVER_KINDS.includes(turn.kind as GiverKind))) return null
  return Object.fromEntries(GIVER_KINDS.map(kind => {
    const group = turns.filter(turn => turn.kind === kind)
    return [kind, { turns: group.length, turnMs: sumEvery(group.map(turn => turn.elapsedMs)), listUSD: sumEvery(group.map(turn => turn.cost?.listUSD)), tokens: giverTokensOf(group) }]
  })) as Record<GiverKind, RollupGiverKind>
}

const DEFAULT_LANDING_STATE = "land"
const ALREADY_MERGED = /already merged/
type LandingEntry = { state?: string; head?: string }

export function landerRecordsOf(projectRoot: string): LanderRecord[] {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim()
    const config = JSON.parse(readFileSync(join(projectRoot, "land.config.json"), "utf8")) as { state?: unknown }
    const state = typeof config.state === "string" ? config.state : DEFAULT_LANDING_STATE
    return readFileSync(join(common, state, "record.jsonl"), "utf8").split(/\r?\n/).flatMap(line => {
      try { const row: unknown = JSON.parse(line); return row && typeof row === "object" && !Array.isArray(row) ? [row as LanderRecord] : [] } catch { return [] }
    })
  } catch { return [] }
}

const secondsToMs = (seconds: number | undefined) => typeof seconds === "number" ? Math.round(seconds * 1000) : 0

const runBranchOf = (session: QuestSession) => {
  const branch = session.scope?.branch
  return typeof branch === "string" ? branch : "quest/" + session.runID
}

function landingOf(quest: Quest, runs: RollupRun[], landers: LanderRecord[]): RollupLanding | null {
  const branches = new Set(runs.flatMap(run => run.session.runID ? [runBranchOf(run.session)] : []))
  const heads = new Set(Object.values((quest.extensions.landings ?? {}) as Record<string, LandingEntry | undefined>).flatMap(entry => entry?.state === "landed" && entry.head ? [entry.head] : []))
  const rows = landers.filter(row => typeof row.total === "number" && !ALREADY_MERGED.test(row.verdict ?? "") &&
    (typeof row.branch === "string" ? branches.has(row.branch) : (row.arg !== undefined && branches.has(row.arg)) || (row.commit !== undefined && heads.has(row.commit))))
  if (!rows.length) return null
  const sum = (pick: (row: LanderRecord) => number | undefined) => rows.reduce((total, row) => total + secondsToMs(pick(row)), 0)
  return {
    totalMs: sum(row => row.total), queueWaitMs: sum(row => row.phases?.["queue-wait"]), coreSuiteMs: sum(row => row.phases?.["core-suite"]), pushMs: sum(row => row.phases?.push),
    attempts: rows.length, sentBack: rows.filter(row => row.outcome !== "landed").length,
  }
}

const workSteps = (quest: Quest) => quest.stages.filter(stage => !isLandingStep(stage))

export function questIsFinished(quest: Quest, endingCallID: string): boolean {
  const runs = quest.sessions.filter(session => session.runID)
  const ending = runs.find(session => session.callID === endingCallID)
  if (!ending || runs.some(session => !TERMINAL_RUN.has(session.state))) return false
  const work = workSteps(quest)
  const stepsDone = work.length > 0 && work.every(stage => stage.status === "done")
  return stepsDone || ending.state !== "completed"
}

function phasesOf(traces: RunTrace[], giverModelMs: number | null, wallMs: number, landerMs: number): { phases: RollupPhases; overlapMs: number } {
  const raw: Record<(typeof PHASE_PRIORITY)[number], number> = { workerModelMs: 0, toolMs: 0, checkMs: 0, landingMs: 0, workerStartupMs: 0, admissionHoldMs: 0, routeQueueMs: 0, planMs: 0, giverModelMs: giverModelMs ?? 0 }
  traces.forEach((trace, index) => {
    const buckets = trace.buckets, plan = trace.parts.plan
    raw.workerModelMs += (buckets["model: send"] ?? 0) + (buckets["model: thinking"] ?? 0) + (buckets["model: streaming"] ?? 0)
    for (const [bucket, value] of Object.entries(buckets)) {
      if (bucket === "tool: test" || bucket === "tool: build") raw.checkMs += value
      else if (bucket === "tool wait" || bucket.startsWith("tool: ")) raw.toolMs += value
    }
    raw.landingMs += buckets.landing ?? 0
    raw.workerStartupMs += buckets["start-up"] ?? 0
    raw.routeQueueMs += (buckets.route ?? 0) + (buckets.queue ?? 0)
    raw.admissionHoldMs += plan["admission-hold"] ?? 0
    if (index === 0) raw.planMs += (plan["before-start"] ?? 0) + (plan.other ?? 0)
    else if (trace.admission) raw.planMs += plan.other ?? 0
  })
  raw.landingMs += landerMs
  let left = wallMs, overlapMs = 0
  const kept = {} as Record<(typeof PHASE_PRIORITY)[number], number>
  for (const name of PHASE_PRIORITY) {
    const take = Math.min(Math.round(raw[name]), left)
    kept[name] = take
    overlapMs += Math.round(raw[name]) - take
    left -= take
  }
  return {
    phases: { planMs: kept.planMs, routeQueueMs: kept.routeQueueMs, admissionHoldMs: kept.admissionHoldMs, giverModelMs: kept.giverModelMs, workerStartupMs: kept.workerStartupMs, workerModelMs: kept.workerModelMs, toolMs: kept.toolMs, checkMs: kept.checkMs, landingMs: kept.landingMs, unaccountedMs: left },
    overlapMs,
  }
}

export function questRollupOf(quest: Quest, projectRoot: string, runs: RollupRun[], finishedAt: string, giverTurns: RequestRecord[] = [], landers: LanderRecord[] = landerRecordsOf(projectRoot)): QuestRollupRow {
  const telemetry = runs.flatMap(run => run.telemetry ? [run.telemetry] : [])
  const giver = runs.flatMap(run => run.telemetry?.tokens?.giver ? [run.telemetry.tokens.giver] : []).at(-1) ?? null
  const created = millis(quest.createdAt), finished = millis(finishedAt)
  const wallMs = created !== undefined && finished !== undefined && finished >= created ? finished - created : null
  const runRows: RollupRunRow[] = runs.map(run => {
    const worker = run.telemetry?.tokens?.worker
    const counted = worker !== undefined && worker.requests > 0
    return {
      runID: run.session.runID ?? run.session.callID, state: run.session.state, wallMs: run.telemetry?.speed?.wallMs ?? null, route: routeName(run.telemetry?.route),
      tokens: counted ? tokensOf(worker) : null, listUSD: counted ? run.telemetry?.cost?.worker?.listUSD ?? null : null,
    }
  })
  const deliveryMode = questWorkflow(quest).delivery ?? null
  const sessions = runs.map(run => run.session)
  const landings = (quest.extensions.landings ?? {}) as Record<string, { reason?: string }>
  const refused = sessions.find(session => session.state === "failed" && session.refusalReplied === true)
  const failed = sessions.find(session => FAILED_STATES.has(session.state))
  const blocked = deliveryMode !== "none" ? runs.find(run => run.telemetry?.outcome?.landed === false) : undefined
  const outcome: RollupOutcome | null = refused ? "refused" : failed ? "failed" : blocked ? "blocked" : sessions.length && sessions.every(session => session.state === "completed") ? "delivered" : null
  const failureReason = outcome === "refused" ? shortText(refused?.result) : outcome === "failed" ? shortText(failed?.result) : outcome === "blocked" ? shortText(landings[blocked?.session.runID ?? ""]?.reason) : null
  const landing = deliveryMode !== "none" ? landingOf(quest, runs, landers) : null
  const traces = runs.flatMap(run => run.trace?.parts?.plan ? [run.trace] : [])
  const shaped = wallMs !== null && traces.length === runs.length && traces.length > 0 ? phasesOf(traces, giver?.modelMs ?? null, wallMs, landing?.totalMs ?? 0) : null
  const workerStart = earliest(telemetry.map(item => item.points?.workerStart))
  const planned = earliest(telemetry.map(item => item.points?.planned))
  return {
    version: 1, questID: quest.id, projectRoot: basename(projectRoot) || null, createdAt: quest.createdAt, plannedAt: planned, firstWorkerStartAt: workerStart, finishedAt,
    wallMs, phases: shaped?.phases ?? null, overlapMs: shaped?.overlapMs ?? null, landing,
    runs: runRows, giverRequests: giver?.requests ?? null, giverModelMs: giver?.modelMs ?? null,
    giverTokens: giver ? tokensOf(giver.tokens) : null,
    giverByKind: giverByKindOf(giverTurns, giver?.turns ?? null),
    workerTokens: sumTokens(runRows.map(row => row.tokens)),
    steps: { total: workSteps(quest).length, done: workSteps(quest).filter(stage => stage.status === "done").length },
    deliveryMode, outcome, failureReason,
    listUSD: sumOrNull([...runRows.map(row => row.listUSD), giver ? giver.cost?.listUSD ?? null : null]),
  }
}
