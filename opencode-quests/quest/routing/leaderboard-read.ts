import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { AA_INDEX_KEYS, AA_INDEX_LABELS, analysisFile, analysisFor, aaScoreOf, readAnalysis, type AnalysisCache } from "../../models/artificial-analysis"
import { canonicalModelID } from "../../models/model-catalog"
import { recentRequests, routeOutages } from "../../models/observed-route-health"
import { runDelivered } from "../../models/route-outcomes"
import { leaderboard, sortRows, type Allowance, type Health, type Pick, type Plan, type Row, type RouteInput, type Speed } from "../../models/leaderboard"
import { readRouteLimits } from "../../usage/route-limits"
import { readerFiles } from "../../usage/telemetry-store"
import { readWorkflowOutcomesChecked, type WorkflowRun } from "../../usage/workflow-outcomes"
import { readAccountUsage, type AccountUsage } from "../../usage-service/on-computer"

const LEADERBOARD_WINDOW_DAYS = 28
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const PERCENT_READING_MAX_AGE_MS = HOUR_MS
const PLAN_TABLE = join(import.meta.dirname, "..", "..", "models", "allowance-plans.json")
const PAYG_PROVIDERS = ["openrouter", "ollama-cloud"]
const SUBSCRIPTION_PROVIDERS = ["claude", "openai"]
const FREE_MODEL = /(-free|:free)$/
const SOURCES = ["requests", "workflows", "speeds", "routeLimits", "prices", "analysis"] as const
type Source = (typeof SOURCES)[number]

export type LeaderboardPaths = Record<Source, string> & { plans: string; accountUsage?: string }
export type LeaderboardReadout = {
  at: number
  text: string
  rows: Row[]
  picks: Pick[]
  counts: { routes: number; runs: number; timedRuns: number; models: number; aaMatched: number }
  observed: string[]
  benchmark: { category: string; label: string }
  efforts: Record<string, string>
  missing: string[]
  accountUsage: { updatedAt: string | null; ageSeconds: number | null } | null
  diagnostics: string[]
  paths: LeaderboardPaths
}

type PlanTable = {
  plans: Record<string, { priceUSD: number }>
  accounts: Record<string, { plan: string }>
  models: Record<string, { monthlyUSD: Record<string, number> | null }>
}
type Seen = { accountID: string | null; accountAt: number; reasoning: string | null; reasoningAt: number }

export function leaderboardPaths(env: NodeJS.ProcessEnv = process.env): LeaderboardPaths {
  const requests = readerFiles(env).requests
  return {
    requests,
    workflows: requests + ".workflows.json",
    speeds: requests + ".speeds.json",
    routeLimits: requests + ".route-limits.json",
    prices: requests + ".prices.json",
    analysis: analysisFile(),
    plans: PLAN_TABLE,
  }
}

const modelOf = (key: string) => key.slice(key.indexOf("/") + 1)
const providerOf = (key: string) => key.slice(0, key.indexOf("/"))
const knownAccount = (id: string | null | undefined): id is string => !!id && id !== "unknown"

function touch(seen: Map<string, Seen>, key: string) {
  if (!seen.has(key)) seen.set(key, { accountID: null, accountAt: -Infinity, reasoning: null, reasoningAt: -Infinity })
  return seen.get(key)!
}

function observe(seen: Map<string, Seen>, key: string, at: number, accountID: string | null | undefined, reasoning: string | null | undefined) {
  const row = touch(seen, key)
  if (knownAccount(accountID) && at >= row.accountAt) Object.assign(row, { accountID, accountAt: at })
  if (reasoning && at >= row.reasoningAt) Object.assign(row, { reasoning, reasoningAt: at })
}

function readJSON<T>(file: string, fallback: T, diagnostics: string[], name: string): T {
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, "utf8")) as T }
  catch (error) { diagnostics.push(name + " unreadable (" + (error instanceof Error ? error.message : String(error)) + "); read as empty"); return fallback }
}

function capsFor(models: PlanTable["models"], planID: string): Record<string, number | null> {
  return Object.fromEntries(Object.entries(models).map(([model, row]) => [model, row.monthlyUSD?.[planID] ?? null]))
}

const subscriptionPlan = (account: AccountUsage) => account.provider + ":" + account.plan!.name

function plansOf(table: PlanTable, accounts: AccountUsage[]): Record<string, Plan> {
  const plans: Record<string, Plan> = { payg: { kind: "payg" }, free: { kind: "free" } }
  for (const [id, plan] of Object.entries(table.plans)) plans[id] = { kind: "capped", priceUSD: plan.priceUSD, capUSD: capsFor(table.models, id), reconciled: false }
  for (const account of accounts) if (SUBSCRIPTION_PROVIDERS.includes(account.provider) && account.plan?.name) plans[subscriptionPlan(account)] = { kind: "capped", priceUSD: 0, capUSD: {}, reconciled: true }
  return plans
}

function planOf(key: string, accountID: string | null, table: PlanTable, accounts: Map<string, AccountUsage>): string | null {
  if (FREE_MODEL.test(modelOf(key))) return "free"
  const goPlan = accountID ? table.accounts[accountID]?.plan : undefined
  if (goPlan && table.plans[goPlan]) return goPlan
  const account = accountID ? accounts.get(accountID) : undefined
  if (account && SUBSCRIPTION_PROVIDERS.includes(account.provider) && account.plan?.name) return subscriptionPlan(account)
  if (PAYG_PROVIDERS.includes(providerOf(key)) || (account && PAYG_PROVIDERS.includes(account.provider))) return "payg"
  return null
}

function allowanceOf(key: string, account: AccountUsage | undefined, now: number): Allowance {
  if (FREE_MODEL.test(modelOf(key))) return { known: false, reason: "free pool not read" }
  if (!account) return { known: false, reason: "no account usage record" }
  const model = canonicalModelID(modelOf(key))
  const windows = account.windows.filter(window =>
    (window.scope === "shared" || (window.scope === "model" && !!window.model && canonicalModelID(window.model) === model)) &&
    typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) && (!window.resetAt || Date.parse(window.resetAt) > now))
  if (!windows.length) return { known: false, reason: "no current percent window" }
  const observed = Date.parse(account.observedAt ?? "")
  if (!Number.isFinite(observed)) return { known: false, reason: "account snapshot has no reading time" }
  if (now - observed > PERCENT_READING_MAX_AGE_MS) return { known: false, reason: "account snapshot " + ((now - observed) / HOUR_MS).toFixed(1) + " h old" }
  return { known: false, reason: "observation count not readable" }
}

function timingsOf(runs: WorkflowRun[]): Map<string, Speed> {
  const timings = new Map<string, Speed>()
  const empty = (): Speed => ({ stepMs: [], firstTokenMs: [], tokensPerSecond: [], listUSDPerStep: [], outcomes: { ok: 0, total: 0 } })
  for (const run of runs) {
    const key = run.route.providerID + "/" + run.route.modelID
    const speed = timings.get(key) ?? empty()
    timings.set(key, speed)
    const telemetry = run.telemetry
    const values: [number[], number | null | undefined][] = [
      [speed.stepMs, telemetry?.speed?.wallMs],
      [speed.firstTokenMs, telemetry?.speed?.firstTokenMs?.p50],
      [speed.tokensPerSecond, telemetry?.speed?.tokensPerSecond],
      [speed.listUSDPerStep, telemetry?.cost?.worker?.listUSD],
    ]
    for (const [list, value] of values) if (typeof value === "number" && Number.isFinite(value)) list.push(value)
    const delivered = runDelivered(run)
    if (delivered !== null) { speed.outcomes.total++; if (delivered) speed.outcomes.ok++ }
  }
  return timings
}

function analysisIndex(cache: AnalysisCache, models: Map<string, { model: string; effort: string; at: number }>, category: string): Record<string, number | null> {
  return Object.fromEntries([...models.values()].map(({ model, effort }) => {
    const row = analysisFor(cache, model, effort)
    return [canonicalModelID(model), row ? aaScoreOf(row, category)?.value ?? null : null]
  }))
}

export function leaderboardPicture(now: number = Date.now(), paths: LeaderboardPaths = leaderboardPaths(), benchmark?: string): LeaderboardReadout {
  const category = benchmark && AA_INDEX_KEYS[benchmark] ? benchmark : "intelligence"
  const present = Object.fromEntries(SOURCES.map(source => [source, existsSync(paths[source])])) as Record<Source, boolean>
  const missing = SOURCES.filter(source => !present[source]).map(String)
  const diagnostics: string[] = []
  const since = now - LEADERBOARD_WINDOW_DAYS * DAY_MS

  const records = recentRequests(paths.requests, { sinceMs: since }).filter(record => record.startedAt >= since && record.startedAt <= now)
  const workflow = present.workflows ? readWorkflowOutcomesChecked(paths.workflows) : { store: { version: 1 as const, runs: [] as WorkflowRun[] }, diagnostics: [] as string[] }
  diagnostics.push(...workflow.diagnostics)
  const runs = workflow.store.runs.filter(run => run.startedAt >= since && run.startedAt <= now)
  const speedKeys = present.speeds ? Object.keys(readJSON<{ routes?: Record<string, unknown> }>(paths.speeds, {}, diagnostics, "speeds store").routes ?? {}).map(key => key.split("#")[0]) : []
  const limitKeys = present.routeLimits ? Object.keys(readRouteLimits(paths.routeLimits).routes) : []

  const seen = new Map<string, Seen>()
  for (const run of runs) observe(seen, run.route.providerID + "/" + run.route.modelID, run.startedAt, run.route.accountID, run.route.reasoning)
  for (const record of records) observe(seen, record.route.providerID + "/" + record.route.modelID, record.startedAt, record.accountID, record.route.variant ?? record.route.reasoning)
  const observed = [...seen.keys()].sort()
  for (const key of [...speedKeys, ...limitKeys]) touch(seen, key)
  const keys = [...seen.keys()].sort()

  const table = readJSON<PlanTable>(paths.plans, { plans: {}, accounts: {}, models: {} }, diagnostics, "plan table")
  const snapshot = readAccountUsage(paths.accountUsage, now)
  const accounts = new Map(snapshot.accounts.map(account => [account.id, account]))
  const outages = routeOutages(records, now, paths.routeLimits)
  const health: Record<string, Health> = Object.fromEntries(outages.routes.map(route => [route.route, { state: route.state, until: route.until ? Date.parse(route.until) : null }]))

  let cache: AnalysisCache = { version: 1, fetchedAt: null, nextRefreshAt: 0, tier: null, indexVersion: null, models: [], error: null }
  if (present.analysis) {
    try { cache = readAnalysis(paths.analysis) }
    catch (error) { diagnostics.push("Artificial Analysis index unreadable (" + (error instanceof Error ? error.message : String(error)) + "); no IQ read") }
  }

  const routes: RouteInput[] = keys.map(key => {
    const accountID = seen.get(key)!.accountID
    return { route: key, provider: providerOf(key), model: canonicalModelID(modelOf(key)), plan: planOf(key, accountID, table, accounts) }
  })
  const usage: Record<string, Allowance> = Object.fromEntries(keys.map(key => {
    const accountID = seen.get(key)!.accountID
    return [key, allowanceOf(key, knownAccount(accountID) ? accounts.get(accountID) : undefined, now)]
  }))
  const plans = plansOf(table, snapshot.accounts)
  const timings = timingsOf(runs)
  const speedStats = Object.fromEntries(keys.flatMap(key => timings.has(key) ? [[key, timings.get(key)!]] : []))

  const modelEfforts = new Map<string, { model: string; effort: string; at: number }>()
  for (const key of keys) {
    const model = canonicalModelID(modelOf(key)), row = seen.get(key)!
    const current = modelEfforts.get(model)
    if (!current || row.reasoningAt > current.at) modelEfforts.set(model, { model: modelOf(key), effort: row.reasoning ?? "default", at: row.reasoningAt })
  }
  const aa = analysisIndex(cache, modelEfforts, category)

  const result = leaderboard(routes, usage, plans, health, aa, speedStats)
  const timedRuns = runs.filter(run => typeof run.telemetry?.speed?.wallMs === "number").length
  const aaMatched = Object.values(aa).filter(value => value !== null).length
  const models = Object.keys(aa).length
  const rows = sortRows(result.rows, "iq")
  const ageSeconds = snapshot.updatedAt ? Math.round((now - Date.parse(snapshot.updatedAt)) / 1000) : null
  if (ageSeconds !== null && ageSeconds > 3600) diagnostics.push("account usage snapshot is " + Math.round(ageSeconds / 60) + " min old: percent left may be out of date")
  const text = keys.length + " routes ranked from " + timedRuns + " of " + runs.length + " runs timed" + (missing.length ? "; missing: " + missing.join(", ") : "") + "."

  return {
    at: now,
    text,
    rows,
    picks: result.picks,
    counts: { routes: keys.length, runs: runs.length, timedRuns, models, aaMatched },
    observed,
    benchmark: { category, label: AA_INDEX_LABELS[category] },
    efforts: Object.fromEntries([...modelEfforts].map(([model, row]) => [model, row.effort])),
    missing,
    accountUsage: snapshot.updatedAt ? { updatedAt: snapshot.updatedAt, ageSeconds } : null,
    diagnostics,
    paths,
  }
}
