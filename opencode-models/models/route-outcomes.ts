import { countsForRoute, workflowOutcomesFile, type WorkflowRun, type WorkflowStore } from "../usage/workflow-outcomes"
import { readPooledOutcomes } from "../usage/pooled-evidence"
import { DEPTHS, taggedDepth, taggedWorkType, type Depth } from "./work-profile"
import type { FinishedRuns, LearnedOutcomes, Route, RunTimes } from "./route-planner"

export const UNCLASSIFIED_WORK = "unclassified"
export const workKind = (workType?: string) => workType ?? UNCLASSIFIED_WORK
export const runKind = (run: Pick<WorkflowRun, "taskTags">): string => workKind(taggedWorkType(run.taskTags))
export function runDelivered(run: WorkflowRun): boolean | null {
  const o = run.observation
  if (!o || o.state === "cancelled" || !countsForRoute(run)) return null
  if (run.judgment) return run.judgment.accepted
  if (o.outcome === "work-failed" || o.outcome === "empty") return false
  if (o.outcome && o.outcome !== "delivered") return null
  return o.state === "completed" && o.delivered === true ? true : null
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined }

export const EVERY_KIND = "*"
const outputTokens = (run: WorkflowRun) => { const t = run.observation?.tokens; return t && (t.output !== null || t.reasoning !== null) ? (t.output ?? 0) + (t.reasoning ?? 0) : NaN }
const ofRoute = (run: WorkflowRun, route: Route) => run.route.accountID === route.accountID && run.route.providerID === route.providerID && run.route.modelID === route.modelID && run.route.reasoning === route.reasoning
export const atOrDeeper = (run: Pick<WorkflowRun, "taskTags">, depth: Depth) => DEPTHS.indexOf(taggedDepth(run.taskTags) ?? DEPTHS[0]) >= DEPTHS.indexOf(depth)
export function withLearnedOutcomes(routes: Route[], store: WorkflowStore, kind: string, now: number, maxAgeDays: number, source = "Quest outcomes", into: "learned" | "learnedOverall" | "learnedOther" = "learned", depth?: Depth, exceptKind?: string): Route[] {
  const since = now - maxAgeDays * 86400000
  const trials = store.runs.flatMap(run => {
    const delivered = runDelivered(run), ended = run.observation?.completedAt ?? run.observation?.observedAt
    return delivered === null || ended === undefined || ended < since || ended > now || kind !== EVERY_KIND && runKind(run) !== kind || exceptKind !== undefined && runKind(run) === exceptKind || depth && !atOrDeeper(run, depth) ? [] : [{ run, delivered, ended }]
  })
  if (!trials.length) return routes
  return routes.map(route => {
    const mine = trials.filter(({ run }) => run.route.modelID === route.modelID && run.route.reasoning === route.reasoning)
    if (!mine.length) return route
    const elsewhere = [...new Set(mine.filter(({ run }) => !ofRoute(run, route)).map(({ run }) => run.route.providerID))]
    const via = elsewhere.length ? elsewhere.join(", ") : undefined
    const finished = median(mine.flatMap(({ run }) => runDelivered(run) === true && run.observation?.state === "completed" && run.observation.completedAt ? [run.observation.completedAt - run.startedAt] : []).filter(ms => ms > 0))
    const learned: LearnedOutcomes = {
      kind, trials: mine.length, delivered: mine.filter(t => t.delivered).length, ...(mine.some(({ run }) => run.replayOf) ? { replays: mine.filter(({ run }) => run.replayOf).length } : {}),
      requests: mine.reduce((n, t) => n + (t.run.observation?.requests ?? 0), 0),
      measuredAt: new Date(Math.max(...mine.map(t => t.ended))).toISOString(), source,
      reworked: mine.filter(({ run }) => run.judgment?.firstPass === false).length, judged: mine.filter(({ run }) => run.judgment !== null).length, ...(via ? { via } : {}), ...(depth ? { depth } : {}),
      ...(finished !== undefined ? { medianMilliseconds: finished } : {}),
    }
    return { ...route, [into]: learned }
  })
}

export function withFinishedRuns(routes: Route[], store: WorkflowStore, kind: string, now: number, maxAgeDays: number, into: "finished" | "finishedOverall" = "finished"): Route[] {
  const since = now - maxAgeDays * 86400000
  const done = store.runs.filter(run => {
    const o = run.observation
    return runDelivered(run) === true && o?.state === "completed" && o.routeConsistent !== false && o.completedAt !== undefined && o.completedAt > run.startedAt && o.completedAt >= since && o.completedAt <= now && (kind === EVERY_KIND || runKind(run) === kind)
  })
  if (!done.length) return routes
  return routes.map(route => {
    const own = done.filter(run => ofRoute(run, route))
    const elsewhere = own.length ? [] : done.filter(run => run.route.modelID === route.modelID && run.route.reasoning === route.reasoning)
    const mine = own.length ? own : elsewhere
    if (!mine.length) return route
    const via = own.length ? undefined : [...new Set(elsewhere.map(run => run.route.providerID))].join(", ")
    const tokens = median(mine.map(outputTokens).filter(n => Number.isFinite(n) && n > 0))
    const calls = median(mine.flatMap(run => run.observation?.requests ? [run.observation.requests] : []))
    const finished: FinishedRuns = { kind, completed: mine.length, medianMilliseconds: median(mine.map(run => run.observation!.completedAt! - run.startedAt))!,
      ...(tokens !== undefined ? { medianOutputTokens: tokens } : {}), ...(calls !== undefined ? { medianRequests: calls } : {}), ...(via ? { via } : {}) }
    return { ...route, [into]: finished }
  })
}

export function withRunTimes(routes: Route[], store: WorkflowStore, kind: string, now: number, maxAgeDays: number): Route[] {
  const since = now - maxAgeDays * 86400000
  const ended = store.runs.filter(run => {
    const o = run.observation
    return o?.state === "completed" && countsForRoute(run) && o.completedAt !== undefined && o.completedAt > run.startedAt && o.completedAt >= since && o.completedAt <= now
  })
  if (!ended.length) return routes
  const times = (runs: WorkflowRun[], of: string, reasoning: string, sameModel: boolean): RunTimes[] => runs.length ? [{ kind: of, reasoning, sameModel, completed: runs.length, medianMilliseconds: median(runs.map(run => run.observation!.completedAt! - run.startedAt))! }] : []
  return routes.map(route => {
    const level = ended.filter(run => run.route.reasoning === route.reasoning), typed = level.filter(run => kind === EVERY_KIND || runKind(run) === kind)
    const runTimes = [...times(typed.filter(run => run.route.modelID === route.modelID), kind, route.reasoning, true), ...times(typed, kind, route.reasoning, false), ...(kind === EVERY_KIND ? [] : times(level, EVERY_KIND, route.reasoning, false))]
    return runTimes.length ? { ...route, runTimes } : route
  })
}

export function withRoutineOutcomes(routes: Route[], store: WorkflowStore, now: number, maxAgeDays: number): Route[] {
  const since = now - maxAgeDays * 86400000
  const runs = store.runs.flatMap(run => {
    const ended = run.observation?.completedAt ?? run.observation?.observedAt, passed = runDelivered(run)
    return taggedDepth(run.taskTags) === "routine" && passed !== null && ended !== undefined && ended >= since && ended <= now ? [{ run, ended, passed }] : []
  }).sort((a, b) => a.ended - b.ended)
  if (!runs.length) return routes
  return routes.map(route => {
    const timeline = runs.filter(({ run }) => run.route.modelID === route.modelID).map(({ run, passed }) => ({ effort: run.route.reasoning, passed }))
    return timeline.length ? { ...route, routineOutcomes: timeline } : route
  })
}

export function learnedRoutes(routes: Route[], kind: string, now: number, maxAgeDays: number, depth: Depth, file = workflowOutcomesFile(), peers?: string[]) {
  let store: WorkflowStore
  let fromPeers = 0
  try { const read = readPooledOutcomes(file, ...(peers ? [peers] : [])); store = read.store; fromPeers = read.pooled } catch (error) { return { routes, diagnostic: "Quest outcomes unreadable (" + (error instanceof Error ? error.message : String(error)) + "); routes ranked on published priors only" } }
  const finished = withRunTimes(withFinishedRuns(withFinishedRuns(routes, store, EVERY_KIND, now, maxAgeDays, "finishedOverall"), store, kind, now, maxAgeDays), store, kind, now, maxAgeDays)
  const pooled = withLearnedOutcomes(finished, store, EVERY_KIND, now, maxAgeDays, undefined, "learnedOverall", depth)
  const others = withLearnedOutcomes(pooled, store, EVERY_KIND, now, maxAgeDays, undefined, "learnedOther", depth, kind)
  const updated = withRoutineOutcomes(withLearnedOutcomes(others, store, kind, now, maxAgeDays, undefined, "learned", depth), store, now, maxAgeDays)
  const measured = updated.filter(r => r.learned).length
  return { routes: updated, diagnostic: measured + " route" + (measured === 1 ? "" : "s") + " with recorded " + kind + " outcomes" + (fromPeers ? "; " + fromPeers + " runs pooled from the other channel" : "") }
}
