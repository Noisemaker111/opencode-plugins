import type { Catalog as PriceCatalog, Cost as PriceCost } from "./price-aliases"
import { priceBook, readAssumedPrices, type PriceAssumption } from "./plan-capacity-prices"
import { scanSources, type ScanCursor, type ScanInput, type ScanResult, type SourceStat } from "./plan-capacity-sources"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import {writeFileDurable} from "../quest/core/durable-file.mjs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { readQuotaObservations } from "./calibration-store"
import { ACCOUNT_USAGE_FILE, readAccountUsage } from "../usage-service/on-computer"
import { burnRate, capacityIntervals, estimateCapacity, priceRatioTest, tasksRemaining, tokenAllowanceMapping, totalTokens, valueTokensAt, TOKEN_KINDS, type CapacityEvent, type CapacityInterval } from "./plan-capacity"
import type { Observation } from "./calibration"
import type { Tokens } from "./telemetry"

const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "opencode")
export const planCapacityFile = () => process.env.OPENCODE_PLAN_CAPACITY_FILE ?? join(STATE_DIR, "plan-capacity.json")
export const PLAN_CAPACITY_FILE = planCapacityFile()
const CATALOG = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode", "models.json")
export const DEEPSWE = "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json"

export const RETAINED_EVENT_MS = 7 * 86400_000
const MAX_INTERVAL_MS = 3 * 3600_000
export const PLAN_CAPACITY_VALID_MS = 86400_000

type Cost = PriceCost
type Catalog = PriceCatalog

export { priceBook, readAssumedPrices, scanSources }
export type { PriceAssumption, ScanCursor, ScanInput, ScanResult, SourceStat }

export type RetainedColumns = { at: number[]; route: number[]; account: number[]; harness: number[]; units: (number | null)[]; tokens: number[]; assumed: number[]; kinds?: number[][] }
export type RetainedEvents = { from: number; routes: string[]; accounts: string[]; harnesses: string[]; files: Record<string, RetainedColumns> }

export function retainEvents(byFile: Record<string, CapacityEvent[]>, floor: number): RetainedEvents {
  const routes: string[] = [], routeIndex = new Map<string, number>()
  const accounts: string[] = [], accountIndex = new Map<string, number>()
  const harnesses: string[] = [], harnessIndex = new Map<string, number>()
  const intern = (list: string[], index: Map<string, number>, value: string) => {
    const found = index.get(value); if (found !== undefined) return found
    const next = list.push(value) - 1; index.set(value, next); return next
  }
  const files: Record<string, RetainedColumns> = {}
  for (const [path, events] of Object.entries(byFile)) {
    const keep = events.filter(e => e.at >= floor)
    if (!keep.length) continue
    const columns: RetainedColumns = { at: [], route: [], account: [], harness: [], units: [], tokens: [], assumed: [], kinds: [] }
    for (const e of keep) {
      columns.at.push(e.at)
      columns.route.push(intern(routes, routeIndex, e.provider + "/" + e.model))
      columns.account.push(intern(accounts, accountIndex, e.accountID))
      columns.harness.push(intern(harnesses, harnessIndex, e.harness))
      columns.units.push(e.units === null ? null : Number(e.units.toFixed(6)))
      columns.tokens.push(totalTokens(e.tokens))
      columns.assumed.push(e.assumedPrice ? 1 : 0)
      columns.kinds!.push(e.kindsUnknown ? [] : TOKEN_KINDS.map(k => e.tokens[k] ?? 0))
    }
    files[path] = columns
  }
  return { from: floor, routes, accounts, harnesses, files }
}

export function expandRetained(retained: RetainedEvents | undefined): Record<string, CapacityEvent[]> {
  const out: Record<string, CapacityEvent[]> = {}
  if (!retained?.files) return out
  for (const [path, columns] of Object.entries(retained.files)) {
    const events: CapacityEvent[] = []
    for (let i = 0; i < columns.at.length; i++) {
      const key = retained.routes[columns.route[i]] ?? "/"
      const slash = key.indexOf("/")
      const kinds = columns.kinds?.[i]
      const known = Array.isArray(kinds) && kinds.length === TOKEN_KINDS.length
      events.push({ at: columns.at[i], accountID: retained.accounts[columns.account[i]], harness: retained.harnesses[columns.harness[i]] ?? "",
        provider: key.slice(0, slash), model: key.slice(slash + 1),
        tokens: known ? Object.fromEntries(TOKEN_KINDS.map((k, j) => [k, kinds[j]])) as unknown as Tokens : { input: columns.tokens[i] } as Tokens,
        units: columns.units[i], ...(columns.assumed[i] ? { assumedPrice: true } : {}), ...(known ? {} : { kindsUnknown: true }) })
    }
    out[path] = events
  }
  return out
}

export type TaskProfile = { model: string; harness: string; effort: string; attempts: number; tokens: Tokens }
const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0
const routesOf = (rows: CapacityEvent[]) => [...rows.reduce((m, e) => { const k = e.provider + "/" + e.model; m.set(k, (m.get(k) ?? 0) + (e.units ?? 0)); return m }, new Map<string, number>())]
  .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key]) => ({ provider: key.slice(0, key.indexOf("/")), model: key.slice(key.indexOf("/") + 1) }))

export async function taskProfiles(fetchProfiles = true): Promise<{ rows: TaskProfile[]; pooled: Tokens | null; error: string | null }> {
  const fail = (error: string) => ({ rows: [] as TaskProfile[], pooled: null, error })
  if (!fetchProfiles) return fail("published per-task profiles were not fetched on this refresh")
  try {
    const response = await fetch(DEEPSWE, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return fail("DeepSWE leaderboard returned " + response.status)
    const body: any = await response.json()
    const best = new Map<string, TaskProfile>()
    for (const row of body.rows ?? []) {
      const reasoning = row.mean_reasoning_tokens ?? 0
      const profile: TaskProfile = { model: row.model, harness: row.harness, effort: row.reasoning_effort, attempts: row.n_attempted ?? 0, tokens: {
        input: row.mean_uncached_input_tokens ?? 0, cacheRead: row.mean_cache_read_tokens ?? 0, cacheWrite: row.mean_cache_write_tokens ?? 0,
        output: Math.max(0, (row.mean_output_tokens ?? 0) - reasoning), reasoning } }
      const prior = best.get(profile.model)
      if (!prior || profile.attempts > prior.attempts) best.set(profile.model, profile)
    }
    const rows = [...best.values()]
    const pooled = rows.length ? Object.fromEntries((["input", "cacheRead", "cacheWrite", "output", "reasoning"] as (keyof Tokens)[]).map(k => [k, median(rows.map(r => r.tokens[k] ?? 0))])) as unknown as Tokens : null
    return { rows, pooled, error: null }
  } catch (error: any) { return fail("DeepSWE leaderboard unavailable: " + (error?.message ?? "unknown")) }
}

export type PlanCapacityOptions = {
  now?: number
  since?: number | null
  skip?: { codex?: boolean; claude?: boolean; opencode?: boolean }
  previous?: any
  assumePrice?: Record<string, string>
  profiles?: boolean
  progress?: (text: string) => void
}

export function readPlanCapacityReport(file = PLAN_CAPACITY_FILE): any | undefined {
  try { const data = JSON.parse(readFileSync(file, "utf8")); return data?.schema === 1 ? data : undefined } catch { return undefined }
}

export async function buildPlanCapacity(options: PlanCapacityOptions = {}) {
  const started = Date.now()
  const now = options.now ?? Date.now()
  const progress = options.progress ?? (() => {})
  const catalog: Catalog = JSON.parse(readFileSync(CATALOG, "utf8"))
  const catalogAge = statSync(CATALOG).mtimeMs
  const assumptions = readAssumedPrices()
  const price = priceBook(catalog, assumptions, options.assumePrice)

  const snapshot = readAccountUsage()
  const accountOf = (provider: string) => snapshot.accounts.find(a => a.provider === provider)?.id
  const OPENAI = accountOf("openai"), CLAUDE = accountOf("claude"), GO = accountOf("opencode-go")
  const excluded = new Map<string, number>()
  const accountFor = (provider: string, model: string): string | null => {
    if (provider === "openai" || provider === "codex") return OPENAI ?? null
    if (provider === "claude-code" || provider === "anthropic-subscription") return CLAUDE ?? null
    if (provider === "opencode-go") return GO ?? null
    if (provider === "cliproxyapi") return /^claude-/.test(model) ? CLAUDE ?? null : /^(gpt|o[1-9])/.test(model) ? OPENAI ?? null : null
    excluded.set(provider, (excluded.get(provider) ?? 0) + 1)
    return null
  }

  const previous = options.previous
  const priorGenerated = Date.parse(previous?.generatedAt ?? "")
  const retainedFloor = now - RETAINED_EVENT_MS
  const incremental = Boolean(previous) && Number.isFinite(priorGenerated) && priorGenerated <= now
    && Number.isFinite(previous?.scan?.retained?.from) && previous.scan.retained.from <= retainedFloor
    && previous?.scan?.cursors && typeof previous.scan.cursors === "object"

  progress(incremental ? "Refreshing from what changed…" : "Scanning token logs…")
  const scan = await scanSources({ since: options.since, skip: options.skip, price, accountFor, excluded, progress,
    ...(incremental ? { cursors: previous.scan.cursors as Record<string, ScanCursor>, databaseFrom: retainedFloor } : {}) })

  const carried = incremental ? expandRetained(previous.scan.retained as RetainedEvents) : {}
  const byFile: Record<string, CapacityEvent[]> = { ...Object.fromEntries(scan.skipped.map(path => [path, carried[path] ?? []])), ...scan.byFile }
  const events = Object.values(byFile).flat().sort((a, b) => a.at - b.at)

  const history = readQuotaObservations(ACCOUNT_USAGE_FILE + ".observations")
  const profiles = await taskProfiles(options.profiles ?? true)
  if (!profiles.rows.length && previous?.taskProfiles?.models?.length) {
    profiles.rows = previous.taskProfiles.models as TaskProfile[]
    profiles.pooled = Object.fromEntries((["input", "cacheRead", "cacheWrite", "output", "reasoning"] as (keyof Tokens)[]).map(k => [k, median(profiles.rows.map(r => r.tokens[k] ?? 0))])) as unknown as Tokens
    profiles.error = "per-task profiles carried over from " + previous.generatedAt + "; the leaderboard was not fetched on this refresh"
  }

  const byAccount = new Map<string, CapacityEvent[]>()
  for (const e of events) byAccount.set(e.accountID, [...(byAccount.get(e.accountID) ?? []), e])

  const report: any = {
    schema: 1, generatedAt: new Date(now).toISOString(), runtimeMilliseconds: 0,
    validForMilliseconds: PLAN_CAPACITY_VALID_MS,
    catalog: { file: CATALOG, observedAt: new Date(catalogAge).toISOString() },
    method: "capacity = 100 x (API-dollar value of logged requests) / (quota points those requests consumed)",
    assumedPrices: assumptions.map(a => ({ ...a, applied: price.assumedRoutes.has(a.model) })),
    sources: scan.sources, excludedProviders: Object.fromEntries(excluded), unpricedRoutes: Object.fromEntries([...price.unpriced].sort((a, b) => b[1] - a[1]).slice(0, 20)),
    taskProfiles: { source: DEEPSWE, error: profiles.error, models: profiles.rows.map(r => ({ model: r.model, harness: r.harness, effort: r.effort, attempts: r.attempts, tokens: r.tokens })) },
    accounts: [] as any[],
  }

  for (const account of snapshot.accounts) {
    const mine = byAccount.get(account.id) ?? []
    if (!mine.length) continue
    const priorAccount = incremental ? previous.accounts?.find((a: any) => a.id === account.id) : undefined
    const priorFrom = Date.parse(priorAccount?.coverage?.from ?? "")
    const coverage = { from: Math.min(mine[0].at, Number.isFinite(priorFrom) ? priorFrom : mine[0].at), to: mine.at(-1)!.at }
    const models: Record<string, any> = {}
    if (!incremental) for (const e of mine) {
      const key = e.provider + "/" + e.model
      const row = models[key] ??= { requests: 0, units: 0, unpriced: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
      row.requests++; row.units += e.units ?? 0; row.unpriced += e.units === null ? 1 : 0
      for (const k of ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as (keyof Tokens)[]) row[k] += e.tokens[k] ?? 0
    }
    const entry: any = incremental && priorAccount
      ? { ...structuredClone(priorAccount), coverage: { from: new Date(coverage.from).toISOString(), to: new Date(coverage.to).toISOString() }, aggregatesAsOf: priorAccount.aggregatesAsOf ?? previous.generatedAt, windows: [] as any[] }
      : { id: account.id, provider: account.provider, plan: account.plan, events: mine.length, models,
          coverage: { from: new Date(coverage.from).toISOString(), to: new Date(coverage.to).toISOString() },
          units: mine.reduce((n, e) => n + (e.units ?? 0), 0), unpricedRequests: mine.filter(e => e.units === null).length,
          tokens: mine.reduce((n, e) => n + totalTokens(e.tokens), 0), windows: [] as any[] }

    for (const window of account.windows) {
      const observations = history.observations.filter(o => o.accountID === account.id && o.windowID === window.id) as Observation[]
      if (observations.length < 2) continue
      const priorWindow = incremental ? priorAccount?.windows?.find((w: any) => w.id === window.id) : undefined
      const priorIntervals: CapacityInterval[] = (priorWindow?.intervals ?? []).map((i: any) => ({ ...i, tokensByModel: {}, assumedEvents: i.assumedEvents ?? 0 }))
      const cut = incremental ? Math.max(retainedFloor, ...priorIntervals.map(i => i.to), 0) : 0
      const kept = incremental ? priorIntervals.filter(i => i.to <= cut) : []
      const fresh = capacityIntervals(incremental ? observations.filter(o => o.at >= cut) : observations, mine, { minDeltaPoints: 1, maxIntervalMs: MAX_INTERVAL_MS, coverage })
      const intervals = [...kept, ...fresh]
      const estimate = estimateCapacity(intervals)
      const tokenMapping = tokenAllowanceMapping(intervals)
      const ratio = priceRatioTest(intervals)
      const resetAt = window.resetAt ? Date.parse(window.resetAt) : null
      const day = burnRate(observations, mine, { now, windowMs: 86400_000, usedPoints: window.usedPercent, resetAt })
      const week = burnRate(observations, mine, { now, windowMs: RETAINED_EVENT_MS, usedPoints: window.usedPercent, resetAt })
      const capacityUnits = estimate.unitsPerPoint !== null ? estimate.unitsPerPoint * 100 : null
      const capacityTokens = estimate.tokensPerPoint !== null ? estimate.tokensPerPoint * 100 : null

      const mixSource = incremental ? priorWindow?.tokenMix : null
      const mix: number[] = mixSource ?? ["input", "cacheRead", "cacheWrite", "output", "reasoning"].map(k => mine.reduce((n, e) => n + (e.tokens[k as keyof Tokens] ?? 0), 0))
      const mixTotal = mix.reduce((n, v) => n + v, 0)
      const inModel = (provider: string, model: string) => {
        if (capacityUnits === null || mixTotal <= 0) return null
        const found = price.rates(provider, model, mix[0] + mix[1] + mix[2], false)
        if (!found) return null
        const unit = valueTokensAt({ input: mix[0] / mixTotal, cacheRead: mix[1] / mixTotal, cacheWrite: mix[2] / mixTotal, output: mix[3] / mixTotal, reasoning: mix[4] / mixTotal }, found.perMillion)
        return unit && unit > 0 ? capacityUnits / unit : null
      }

      const remaining = window.usedPercent === null ? null : 100 - window.usedPercent
      const tasks = routesOf(mine).map(route => {
        const own = profiles.rows.find(p => p.model === route.model)
        const size = own?.tokens ?? profiles.pooled
        if (!size) return null
        const found = price.rates(route.provider, route.model, (size.input ?? 0) + (size.cacheRead ?? 0) + (size.cacheWrite ?? 0), false)
        const unitsPerTask = found ? valueTokensAt(size, found.perMillion) : null
        if (!unitsPerTask || estimate.unitsPerPoint === null) return null
        return { model: route.provider + "/" + route.model, basis: own ? "DeepSWE " + own.harness + "/" + own.effort : "pooled DeepSWE median", unitsPerTask,
          tasksPerWindow: tasksRemaining(100, estimate.unitsPerPoint, unitsPerTask), tasksRemaining: remaining === null ? null : tasksRemaining(remaining, estimate.unitsPerPoint, unitsPerTask) }
      }).filter(Boolean)

      const sessions = new Map<string, number>(incremental ? (priorWindow?.sessionTotals ?? []).map((s: any) => [s.sessionID, s.units] as [string, number]) : [])
      for (const e of (incremental ? Object.values(scan.byFile).flat().filter(e => e.at > priorGenerated) : mine))
        if (e.accountID === account.id && e.sessionID && e.units !== null) sessions.set(e.sessionID, (sessions.get(e.sessionID) ?? 0) + e.units)
      const ranked = [...sessions].sort((a, b) => b[1] - a[1])

      const row = { id: window.id, label: window.label, usedPercent: window.usedPercent, resetAt: window.resetAt, periodSeconds: window.durationSeconds ?? null, observations: observations.length,
        estimate, tokenMapping, capacity: { apiDollars: capacityUnits, rawTokens: capacityTokens, byModel: {} as Record<string, number | null> },
        tokenMix: mix,
        intervals: intervals.map(i => ({ from: i.from, to: i.to, deltaPoints: i.deltaPoints, units: i.units, rawTokens: i.rawTokens, events: i.events, unpricedEvents: i.unpricedEvents, assumedEvents: i.assumedEvents, state: i.state, unitsByModel: i.unitsByModel, ...(i.tokensByKind ? { tokensByKind: i.tokensByKind } : {}) })),
        priceRatioTest: ratio, burn: { day, week }, tasks,
        sessionTotals: ranked.slice(0, 32).map(([sessionID, units]) => ({ sessionID, units })),
        topSessions: ranked.slice(0, 8).map(([sessionID, units]) => ({ sessionID, units, windowsConsumed: capacityUnits ? units / capacityUnits : null })) }
      for (const [provider, model] of [["openai", "gpt-5.6-luna"], ["openai", "gpt-6-astra"], ["openai", "gpt-5.6-sol"], ["anthropic", "claude-opus-5"], ["anthropic", "claude-sonnet-4-6"], ["opencode-go", "muse-spark-1.2-contributor"], ["opencode-go", "glm-5.3"]] as const)
        row.capacity.byModel[provider + "/" + model] = inModel(provider, model)
      entry.windows.push(row)
    }
    report.accounts.push(entry)
  }

  report.scan = { mode: incremental ? "incremental" : "full",
    cursors: { ...(incremental ? previous.scan.cursors : {}), ...scan.cursors },
    retained: retainEvents(byFile, retainedFloor),
    filesRead: Object.values(scan.sources).reduce((n, s) => n + s.files, 0),
    filesSkipped: Object.values(scan.sources).reduce((n, s) => n + s.skipped, 0),
    bytesRead: Object.values(scan.sources).reduce((n, s) => n + s.bytes, 0) }
  report.runtimeMilliseconds = Date.now() - started
  return { report, snapshot, excluded, unpriced: price.unpriced, profiles, incremental }
}

export function planCapacityRefreshReason(report: any | undefined, snapshot: { accounts: { id: string; observedAt?: string | null; windows: { id: string; usedPercent: number | null }[] }[] }, now: number, pollIntervalMs: number): "absent" | "moved" | null {
  if (!report) return "absent"
  const generatedAt = Date.parse(report.generatedAt ?? "")
  if (!Number.isFinite(generatedAt)) return "absent"
  const observed = snapshot.accounts.map(a => Date.parse(a.observedAt ?? "")).filter(n => Number.isFinite(n) && n <= now)
  if (!observed.length || Math.max(...observed) - generatedAt <= pollIntervalMs) return null
  const moved = snapshot.accounts.some(account => account.windows.some(window => {
    const prior = report.accounts?.find((a: any) => a.id === account.id)?.windows?.find((w: any) => w.id === window.id)
    return prior && window.usedPercent !== null && prior.usedPercent !== null && window.usedPercent !== prior.usedPercent
  }))
  return moved ? "moved" : null
}

let refreshing: Promise<unknown> | undefined
export function refreshPlanCapacityFromMeter(snapshot: Parameters<typeof planCapacityRefreshReason>[1], options: { now?: number; pollIntervalMs: number; file?: string } ): Promise<unknown> | undefined {
  if (refreshing) return refreshing
  const file = options.file ?? PLAN_CAPACITY_FILE
  const previous = readPlanCapacityReport(file)
  const reason = planCapacityRefreshReason(previous, snapshot, options.now ?? Date.now(), options.pollIntervalMs)
  if (!reason) return undefined
  refreshing = buildPlanCapacity({ now: options.now, previous, profiles: false })
    .then(built => writePlanCapacity(built.report, file))
    .catch(() => undefined)
    .finally(() => { refreshing = undefined })
  return refreshing
}

export function writePlanCapacity(report: unknown, file = PLAN_CAPACITY_FILE) {
  mkdirSync(dirname(file), { recursive: true })
  const { scan, ...rest } = (report ?? {}) as any
  const body = scan === undefined ? JSON.stringify(report, null, 2)
    : JSON.stringify(rest, null, 2).replace(/\n\}$/, ",\n  \"scan\": " + JSON.stringify(scan) + "\n}")
  writeFileDurable(file, body, { mode: 0o600 })
  return file
}
