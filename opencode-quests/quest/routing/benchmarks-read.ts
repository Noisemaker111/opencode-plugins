import { existsSync, readFileSync } from "node:fs"
import { AA_INDEX_KEYS, AA_INDEX_LABELS, aaScoreOf, analysisFor, analysisHistoryFile, readAnalysisHistory, readAnalysisSafely, type AnalysisCache, type AnalysisHistoryLine, type AnalysisModel } from "../../models/artificial-analysis"
import { canonicalModelID } from "../../models/model-catalog"
import { configuredDispatchPolicyFile, readDispatchPolicy } from "../../models/dispatch-policy"
import { cachedProviderModels, providerModelsCacheFile } from "../../models/provider-live-models"
import type { Row } from "../../models/leaderboard"
import type { BenchmarkModel, BenchmarkStatus, BenchmarksReadout, RouteState } from "../../models/benchmark-readout"
import { leaderboardPaths, leaderboardPicture, type LeaderboardPaths } from "./leaderboard-read"

export type { BenchmarkModel, BenchmarkStatus, BenchmarksReadout, RouteState } from "../../models/benchmark-readout"

const DAY_MS = 86_400_000
export const BENCHMARK_STALE_MS = 2 * DAY_MS
export const DISAGREEMENT_RATIO = 2
export const BENCHMARK_STATUS = ["all", "matched", "no route yet"] as const
export const WATCH_LIMIT = 10

const roundOrNull = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value : null
const ratioText = (a: number, b: number) => (a / b).toFixed(1) + "x"
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function disagreementsFor(model: Pick<BenchmarkModel, "speed" | "price" | "measured">): string[] {
  const out: string[] = []
  const measured = model.measured
  if (!measured) return out
  const { outputTokensPerSecond: aaSpeed } = model.speed
  if (aaSpeed !== null && measured.tokensPerSecond !== null && aaSpeed > 0) {
    const ratio = measured.tokensPerSecond / aaSpeed
    if (ratio >= DISAGREEMENT_RATIO || ratio <= 1 / DISAGREEMENT_RATIO) out.push("Our median output speed is " + measured.tokensPerSecond.toFixed(0) + " tokens/s; Artificial Analysis measures " + aaSpeed.toFixed(0) + " (" + ratioText(measured.tokensPerSecond, aaSpeed) + ").")
  }
  const aaFirst = model.speed.firstTokenSeconds
  if (aaFirst !== null && measured.firstTokenSeconds !== null && aaFirst > 0) {
    const ratio = measured.firstTokenSeconds / aaFirst
    if (ratio >= DISAGREEMENT_RATIO || ratio <= 1 / DISAGREEMENT_RATIO) out.push("Our median time to first token is " + measured.firstTokenSeconds.toFixed(2) + " s; Artificial Analysis measures " + aaFirst.toFixed(2) + " s (" + ratioText(measured.firstTokenSeconds, aaFirst) + ").")
  }
  const aaPriced = (model.price.inputPer1M ?? 0) > 0 || (model.price.outputPer1M ?? 0) > 0
  if (aaPriced && measured.costPerStepUSD === 0 && measured.costReason) out.push("Artificial Analysis lists $" + model.price.inputPer1M + " in / $" + model.price.outputPer1M + " out per 1M tokens; our plan-effective cost per step is $0" + (measured.costReason ? " (" + measured.costReason + ")" : "") + ".")
  return out
}

export type BenchmarkPaths = LeaderboardPaths & { policy?: string; served?: string }
export function benchmarkPaths(env: NodeJS.ProcessEnv = process.env): BenchmarkPaths {
  return { ...leaderboardPaths(env), policy: configuredDispatchPolicyFile(), served: providerModelsCacheFile() }
}

function configuredRoutes(paths: BenchmarkPaths) {
  const reasoning = new Map<string, string | null>()
  const diagnostics: string[] = []
  const add = (route: string, effort: string | null) => { if (!reasoning.has(route) || reasoning.get(route) === null) reasoning.set(route, effort) }
  if (paths.policy) {
    try { for (const route of readDispatchPolicy(paths.policy).routes ?? []) add(route.providerID + "/" + route.modelID, route.reasoning ?? null) }
    catch (error) { diagnostics.push("dispatch policy unreadable (" + message(error) + "); its configured routes are not listed") }
  }
  try {
    const plans = paths.plans && existsSync(paths.plans) ? JSON.parse(readFileSync(paths.plans, "utf8")) : {}
    if (typeof plans.provider === "string") for (const model of Object.keys(plans.models ?? {})) add(plans.provider + "/" + model, null)
  } catch (error) { diagnostics.push("allowance plans unreadable (" + message(error) + "); their models are not listed") }
  if (paths.served && !existsSync(paths.served)) diagnostics.push("no provider model lists saved yet, so provider routes are not listed")
  if (paths.served) for (const [provider, models] of Object.entries(cachedProviderModels(paths.served))) for (const model of models) add(provider + "/" + model, null)
  return { reasoning, diagnostics }
}

type Facts = { route: string; model: string; effort: string | null; aa: AnalysisModel | null; row: Row | null; state: RouteState }

function modelRow(aa: AnalysisModel | null, routes: Facts[], category: string): BenchmarkModel {
  const score = aa ? aaScoreOf(aa, category) : null
  const best = routes.flatMap(facts => facts.row && facts.row.step.n > 0 ? [{ facts, row: facts.row }] : []).sort((a, b) => b.row.step.n - a.row.step.n)[0]
  const measured = best ? { route: best.facts.route, stepSeconds: roundOrNull(best.row.step.p50 === null ? null : best.row.step.p50 / 1000), stepSamples: best.row.step.n, firstTokenSeconds: roundOrNull(best.row.firstToken.p50 === null ? null : best.row.firstToken.p50 / 1000), tokensPerSecond: roundOrNull(best.row.tokensPerSecond.p50), costPerStepUSD: roundOrNull(best.row.costPerStep.usd), costReason: best.row.costPerStep.reason } : null
  const model: BenchmarkModel = {
    aaID: aa?.id ?? null, name: aa?.name ?? routes[0]?.model ?? "", slug: aa?.slug ?? routes[0]?.model ?? "", creator: aa?.model_creator?.name ?? null, releaseDate: aa?.release_date ?? null,
    status: routes.length ? "matched" : "no route yet", routes: routes.map(facts => facts.route), routeStates: Object.fromEntries(routes.map(facts => [facts.route, facts.state])), effort: routes[0]?.effort ?? null,
    score: score ? { category: score.category, label: score.label, value: score.value, fellBack: score.fellBack } : null,
    benchmarks: Object.fromEntries(Object.entries(aa?.evaluations ?? {}).map(([key, value]) => [key, roundOrNull(value)])),
    speed: { outputTokensPerSecond: roundOrNull(aa?.performance?.median_output_tokens_per_second), firstTokenSeconds: roundOrNull(aa?.performance?.median_time_to_first_token_seconds), firstAnswerSeconds: roundOrNull(aa?.performance?.median_time_to_first_answer_token_seconds), endToEndSeconds: roundOrNull(aa?.performance?.median_end_to_end_response_time_seconds) },
    price: { inputPer1M: roundOrNull(aa?.pricing?.price_1m_input_tokens), outputPer1M: roundOrNull(aa?.pricing?.price_1m_output_tokens), cacheHitPer1M: roundOrNull(aa?.pricing?.price_1m_cache_hit_tokens), cacheWritePer1M: roundOrNull(aa?.pricing?.price_1m_cache_write_tokens), indexRunUSD: roundOrNull(aa?.artificial_analysis_intelligence_index_cost?.total_cost as number | undefined) },
    measured, disagreements: [],
  }
  model.disagreements = disagreementsFor(model)
  return model
}

export function benchmarksPicture(now: number = Date.now(), paths: BenchmarkPaths = benchmarkPaths(), benchmark?: string, options: { status?: BenchmarkStatus; limit?: number; cache?: AnalysisCache } = {}): BenchmarksReadout {
  const category = benchmark && AA_INDEX_KEYS[benchmark] ? benchmark : "intelligence"
  const board = leaderboardPicture(now, paths, category)
  const cache = options.cache ?? readAnalysisSafely(paths.analysis)
  const configured = configuredRoutes(paths)
  const diagnostics = [...board.diagnostics, ...configured.diagnostics]
  const fetchedAt = cache.fetchedAt
  const ageMs = fetchedAt ? now - Date.parse(fetchedAt) : null
  let history: AnalysisHistoryLine[] = []
  try { history = readAnalysisHistory(analysisHistoryFile(paths.analysis)) } catch (error) { diagnostics.push("Artificial Analysis history unreadable (" + message(error) + ")") }
  const lastChange = [...history].reverse().find(line => line.ok && line.changes.length > 0 || line.ok && line.baseline) ?? null
  const lastError = [...history].reverse().find(line => !line.ok) ?? null

  const rows = new Map<string, Row>(board.rows.map(row => [row.route, row]))
  const observed = new Set(board.observed)
  const facts: Facts[] = [...new Set([...rows.keys(), ...configured.reasoning.keys()])].sort().map(route => {
    const row = rows.get(route) ?? null
    const model = canonicalModelID(route.slice(route.indexOf("/") + 1))
    const effort = row ? board.efforts[model] ?? null : configured.reasoning.get(route) ?? board.efforts[model] ?? null
    const state: RouteState = observed.has(route) ? "run in 28 days" : row ? "not run in 28 days" : "never run"
    return { route, model, effort, aa: analysisFor(cache, model, effort ?? ""), row, state }
  })

  const byAA = new Map<string, Facts[]>(), byModel = new Map<string, Facts[]>()
  for (const entry of facts) {
    if (entry.aa) byAA.set(entry.aa.id, [...(byAA.get(entry.aa.id) ?? []), entry])
    else byModel.set(entry.model, [...(byModel.get(entry.model) ?? []), entry])
  }
  const all = [...cache.models.map(aa => modelRow(aa, byAA.get(aa.id) ?? [], category)), ...[...byModel.values()].map(routes => modelRow(null, routes, category))].sort((a, b) => {
    if (a.status !== b.status) return a.status === "matched" ? -1 : 1
    const left = a.score?.value ?? null, right = b.score?.value ?? null
    if (left !== right) return left === null ? 1 : right === null ? -1 : right - left
    return a.name.localeCompare(b.name)
  })

  const codingOf = (model: BenchmarkModel) => model.benchmarks[AA_INDEX_KEYS.coding] ?? null
  const watch = all.filter(model => model.status === "no route yet" && codingOf(model) !== null).sort((a, b) => (codingOf(b) ?? 0) - (codingOf(a) ?? 0)).slice(0, WATCH_LIMIT)
  const status = options.status ?? "all"
  const shown = all.filter(model => status === "all" || model.status === status).slice(0, options.limit ?? all.length)
  const routes = facts.map(entry => ({ route: entry.route, model: entry.model, effort: entry.effort, aaID: entry.aa?.id ?? null, aaName: entry.aa?.name ?? null, state: entry.state }))
  const matched = all.filter(model => model.status === "matched").length
  return {
    at: new Date(now).toISOString(),
    benchmark: { category, label: AA_INDEX_LABELS[category] },
    source: { fetchedAt, ageHours: ageMs === null || !Number.isFinite(ageMs) ? null : Math.round(ageMs / 3_600_000 * 10) / 10, stale: ageMs === null || !Number.isFinite(ageMs) || ageMs > BENCHMARK_STALE_MS, tier: cache.tier, indexVersion: cache.indexVersion, error: cache.error,
      lastChangeAt: lastChange?.at ?? null, lastErrorAt: lastError?.at ?? null, refreshAttempts: history.length },
    counts: { aaModels: cache.models.length, models: all.length, matched, noRouteYet: all.length - matched, routes: routes.length, routesWithAA: routes.filter(route => route.aaID !== null).length, routesRun: routes.filter(route => route.state === "run in 28 days").length, neverRun: routes.filter(route => route.state === "never run").length, disagreements: all.filter(model => model.disagreements.length > 0).length },
    models: shown,
    watch,
    routes,
    diagnostics,
  }
}
