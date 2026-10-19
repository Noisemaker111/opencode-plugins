import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { analysisFile, analysisFor, aaScoreOf, readAnalysisSafely, type AnalysisCache } from "../../models/artificial-analysis"
import { openRouterKey } from "../../models/jev-bridge"
import { catalogCacheFile, type CatalogModel } from "../../models/live-routes"
import { recentRequests } from "../../models/observed-route-health"
import type { RequestRecord } from "../../usage/telemetry"
import { readerFiles } from "../../usage/telemetry-store"
import { freePools } from "../../usage/free-allowance"

const DAY_MS = 86_400_000
const WINDOW_MS = 28 * DAY_MS
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key"

type CatalogRow = CatalogModel
type FreeProbe = { at: string; route: string; status: number; kind?: string; message?: string; resetAt?: string | null; source?: string }
type Pool = ReturnType<typeof freePools>["pools"][number]
type Reset = { at: string; basis: string; source: string | null; local: string }
type OpenRouterDaily = { used: number; limit: number; remaining: number; resetAt: string; checkedAt: string; source: string }

export type FreeModelsPaths = {
  catalog: string
  requests: string
  analysis: string
  probes: string
  channelDir?: string
  openCodeDb?: string
}

export type FreeBucket = {
  pool: string
  label: string
  provider: string
  state: "exhausted" | "usable" | "unknown"
  estimate: string
  confidence: string
  n: number
  models: number
  currentModels: number
  used: { requests: number; tokens: number }
  since: string | null
  limit: { lower: { requests: number; tokens: number }; upper: { requests: number; tokens: number }; basis: string; evidenceRows: number; n: number } | null
  left: { requests: number; tokens: number; upper: { requests: number; tokens: number }; basis: string; evidenceRows: number; n: number } | null
  published: string | null
  live: OpenRouterDaily | null
  lastCutAt: string | null
  lastSuccessAt: string | null
  reset: Reset | null
  lastProbe: FreeProbe | null
}

export type FreeModel = {
  route: string
  provider: string
  model: string
  bucket: string
  status: "current" | "deprecated" | "unlisted"
  efforts: string[]
  context: number | null
  published: string | null
  iq: number | null
  coding: number | null
  outputTokensPerSecond: number | null
  firstTokenSeconds: number | null
  requestsSinceReset: number | null
  tokensSinceReset: number | null
  lastAt: string | null
  lastOutcome: string | null
  lastSuccessAt: string | null
  lastCutAt: string | null
  lastProbe: FreeProbe | null
}

export type FreeModelsReadout = {
  at: number
  text: string
  current: number
  deprecated: number
  unlisted: number
  reset: Reset | null
  pools: FreeBucket[]
  models: FreeModel[]
  openRouter: { key: "configured" | "missing"; checkedAt: string | null; error: string | null; freeModelDailyRequests: OpenRouterDaily | null } | null
  diagnostics: string[]
}

export const freeProbesFile = () => process.env.QUEST_FREE_PROBES ?? join(homedir(), ".local", "state", "questgiver", "free-probes.json")

export function freeModelsPaths(env: NodeJS.ProcessEnv = process.env): FreeModelsPaths {
  const files = readerFiles(env)
  return { catalog: catalogCacheFile(), requests: files.requests, analysis: analysisFile(), probes: freeProbesFile() }
}

const iso = (at: number | null | undefined) => typeof at === "number" && Number.isFinite(at) ? new Date(at).toISOString() : null
const local = (at: string) => new Date(at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
const routeOf = (model: { providerID: string; modelID: string }) => model.providerID + "/" + model.modelID
const freeProviders = new Set(["opencode", "opencode-go", "openrouter"])
const freeModel = (model: CatalogRow) => {
  const text = !model.outputs || model.outputs.includes("text")
  if (!text || model.toolCall === false) return false
  if (model.providerID === "opencode") return /(?:-free|^big-pickle$)/.test(model.modelID)
  if (model.providerID === "opencode-go") return /-free$/.test(model.modelID)
  if (model.providerID === "openrouter") return /:free$/.test(model.modelID) || model.modelID === "openrouter/free"
  return false
}
const bucketOf = (provider: string) => provider === "opencode" ? "opencode/free" : provider === "opencode-go" ? "opencode-go/free" : "free:" + provider
const bucketLabel = (bucket: string) => bucket === "opencode/free" ? "OpenCode Zen" : bucket === "opencode-go/free" ? "OpenCode Go" : bucket === "free:openrouter" ? "OpenRouter" : bucket === "free:jev" ? "Jev" : bucket
const bucketProvider = (bucket: string) => bucket === "opencode/free" ? "opencode" : bucket === "opencode-go/free" ? "opencode-go" : bucket.slice(5)
const publishedLimit = (bucket: string) => bucket === "free:openrouter"
  ? "20 requests a minute; 50 a day below $10 lifetime credits, 1,000 a day at $10 or more; UTC day"
  : bucket === "opencode/free" ? "shared daily free quota; the provider does not publish a cap, and a cut reports the next UTC midnight"
  : bucket === "opencode-go/free" ? "separate from OpenCode Zen; promotion models may be unlimited, and the provider does not publish a cap"
  : null
const modelPublished = (model: CatalogRow) => model.providerID === "opencode-go" && model.modelID === "longcat-2.5-preview-free" ? "unlimited while the promotion runs" : null
const nextUtcMidnight = (now: number) => {
  const date = new Date(now)
  date.setUTCHours(24, 0, 0, 0)
  return date.getTime()
}
const isUtcMidnight = (at: number) => {
  const date = new Date(at)
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0
}

function readJSON<T>(file: string, fallback: T, diagnostics: string[], name: string): T {
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, "utf8")) as T }
  catch (error) {
    diagnostics.push(name + " unreadable (" + (error instanceof Error ? error.message : String(error)) + "); read as empty")
    return fallback
  }
}

function readCatalog(file: string, diagnostics: string[]) {
  const saved = readJSON<{ at?: string; models?: CatalogRow[] }>(file, {}, diagnostics, "model catalog")
  if (!Array.isArray(saved.models)) return { models: [] as CatalogRow[], at: null as string | null }
  return { models: saved.models.filter(model => typeof model?.providerID === "string" && typeof model?.modelID === "string"), at: saved.at ?? null }
}

function readProbes(file: string, diagnostics: string[]) {
  const saved = readJSON<{ version?: number; probes?: FreeProbe[] }>(file, {}, diagnostics, "free-model probes")
  if (saved.version !== 1 || !Array.isArray(saved.probes)) return [] as FreeProbe[]
  return saved.probes.filter(probe => typeof probe?.route === "string" && Number.isFinite(Date.parse(probe.at)))
}

function latestProbe(probes: FreeProbe[], routes: Set<string>) {
  return probes.filter(probe => routes.has(probe.route)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null
}

function outcomeOf(record: RequestRecord) {
  if (record.failure === "rate-limited" || record.response?.status === 429) return "rate-limited"
  if (record.failure === "model-unavailable" || record.response?.status === 410) return "deprecated"
  if (record.state === "completed") return "ok"
  return record.failure ?? record.state
}

function resetOf(pool: Pool | undefined, probes: FreeProbe[], memberRoutes: Set<string>, now: number): Reset | null {
  const probe = latestProbe(probes, memberRoutes)
  const probed = probe?.status === 429 && probe.resetAt ? Date.parse(probe.resetAt) : NaN
  if (Number.isFinite(probed) && probed > now) return { at: iso(probed)!, basis: "probe", source: probe!.source ?? "free-model probe", local: local(iso(probed)!) }
  const next = pool?.nextReset?.at ? Date.parse(pool.nextReset.at) : NaN
  if (Number.isFinite(next) && next > now) return { at: iso(next)!, basis: pool!.nextReset!.basis ?? "estimate", source: (pool!.nextReset as { source?: string }).source ?? null, local: local(iso(next)!) }
  const provider = pool?.providerReset?.at ? Date.parse(pool.providerReset.at) : NaN
  if (Number.isFinite(provider) && isUtcMidnight(provider)) {
    const at = provider > now ? provider : nextUtcMidnight(now)
    return { at: iso(at)!, basis: "provider daily UTC", source: pool!.providerReset!.source ?? null, local: local(iso(at)!) }
  }
  if (Number.isFinite(next)) return { at: iso(next)!, basis: "provider", source: pool!.nextReset?.source ?? null, local: local(iso(next)!) }
  return null
}

function scoresFor(cache: AnalysisCache, modelID: string, efforts: string[]) {
  for (const effort of [...efforts].reverse().concat("default")) {
    const row = analysisFor(cache, modelID, effort)
    if (!row) continue
    const iq = aaScoreOf(row, "intelligence"), coding = aaScoreOf(row, "coding")
    return {
      iq: iq?.value ?? null,
      coding: coding?.value ?? null,
      outputTokensPerSecond: typeof row.performance?.median_output_tokens_per_second === "number" ? row.performance.median_output_tokens_per_second : null,
      firstTokenSeconds: typeof row.performance?.median_time_to_first_token_seconds === "number" ? row.performance.median_time_to_first_token_seconds : null,
    }
  }
  return { iq: null, coding: null, outputTokensPerSecond: null, firstTokenSeconds: null }
}

function requestsText(count: number) { return count + (count === 1 ? ' request' : ' requests') }
function bucketSentence(pool: FreeBucket) {
  const label = pool.label
  if (pool.live) return label + ": " + pool.live.remaining + " of " + pool.live.limit + " free requests left today" + (pool.reset ? ", resets " + pool.reset.local : "") + "."
  if (pool.state === "exhausted") return label + ": exhausted" + (pool.reset ? " until " + pool.reset.local : "") + "."
  if (pool.state === "usable") return label + ": " + requestsText(pool.used.requests) + " since " + (pool.since ? local(pool.since) : "the last reset") + "; last answered " + (pool.lastSuccessAt ? local(pool.lastSuccessAt) : "unknown") + (pool.reset ? ", resets " + pool.reset.local : "") + "."
  if (pool.used.requests > 0) return label + ": " + requestsText(pool.used.requests) + " since " + (pool.since ? local(pool.since) : "the last reset") + "; no successful answer recorded" + (pool.published ? "; " + pool.published : "") + "."
  return label + ": no request recorded" + (pool.published ? "; " + pool.published : "") + "."
}

function textOf(readout: FreeModelsReadout) {
  const head = readout.current + " current free models" + (readout.deprecated ? ", " + readout.deprecated + " deprecated" : "") + (readout.unlisted ? ", " + readout.unlisted + " not in the catalog" : "")
  return head + ". " + readout.pools.filter(pool => pool.currentModels > 0).map(bucketSentence).join(" ")
}

export function freeModelsPicture(now: number = Date.now(), paths: FreeModelsPaths = freeModelsPaths(), options: { all?: boolean } = {}): FreeModelsReadout {
  const diagnostics: string[] = []
  const catalog = readCatalog(paths.catalog, diagnostics)
  if (catalog.at) {
    const age = now - Date.parse(catalog.at)
    if (Number.isFinite(age) && age > 6 * 3_600_000) diagnostics.push("model catalog is " + Math.round(age / 3_600_000) + " h old")
  }
  const probes = readProbes(paths.probes, diagnostics)
  const records = recentRequests(paths.requests, { sinceMs: now - WINDOW_MS, ceilingBytes: 64 * 1024 * 1024 })
  const latest = new Map<string, RequestRecord>()
  for (const record of records) if (record?.id && record.route?.providerID && record.route?.modelID && record.startedAt <= now) latest.set(record.id, record)
  const rows = [...latest.values()]
  const pools = freePools(now, { channelDir: paths.channelDir, openCodeDb: paths.openCodeDb }).pools.filter(pool => pool.free && (pool.poolId === "opencode/free" || pool.poolId === "opencode-go/free" || /^free:[^:]+$/.test(pool.poolId)))
  const parent = new Map<string, Pool>()
  for (const pool of pools) for (const route of pool.members) parent.set(route, pool)
  const catalogRows = new Map<string, CatalogRow>()
  for (const model of catalog.models) if (freeModel(model)) catalogRows.set(routeOf(model), model)
  const observed = new Map<string, string>()
  for (const record of rows) {
    const route = routeOf(record.route)
    if (freeProviders.has(record.route.providerID) && (parent.has(route) || /(?:-free|:free)$/.test(record.route.modelID))) observed.set(route, route)
  }
  const modelRows = new Map<string, CatalogRow>()
  for (const [route, model] of catalogRows) modelRows.set(route, model)
  for (const route of observed.keys()) if (!modelRows.has(route)) {
    const slash = route.indexOf("/")
    modelRows.set(route, { providerID: route.slice(0, slash), modelID: route.slice(slash + 1), efforts: [], cost: { input: 0, output: 0 } })
  }
  const analysis = readAnalysisSafely(paths.analysis)
  if (analysis.error) diagnostics.push("Artificial Analysis: " + analysis.error)
  const current = [...modelRows.values()].filter(model => !model.deprecated && catalogRows.has(routeOf(model))).length
  const deprecated = [...modelRows.values()].filter(model => model.deprecated).length
  const unlisted = [...modelRows.values()].filter(model => !catalogRows.has(routeOf(model))).length
  const modelViews: FreeModel[] = [...modelRows.entries()].map(([route, model]) => {
    const routeRows = rows.filter(record => routeOf(record.route) === route)
    const cuts = routeRows.filter(record => outcomeOf(record) === "rate-limited")
    const successes = routeRows.filter(record => outcomeOf(record) === "ok")
    const latestRow = routeRows.sort((a, b) => b.startedAt - a.startedAt)[0]
    const pool = parent.get(route)
    const usage = pool?.perRoute.find(item => item.route === route)
    const probe = latestProbe(probes, new Set([route]))
    const probeOkAt = probe && probe.status < 300 ? Date.parse(probe.at) : -Infinity
    const probeCutAt = probe?.status === 429 ? Date.parse(probe.at) : -Infinity
    const status: FreeModel["status"] = model.deprecated ? "deprecated" : catalogRows.has(route) ? "current" : "unlisted"
    const scores = scoresFor(analysis, model.modelID, model.efforts ?? [])
    return {
      route,
      provider: model.providerID,
      model: model.modelID,
      bucket: bucketOf(model.providerID),
      status,
      efforts: model.efforts ?? [],
      context: model.limit?.context ?? null,
      published: modelPublished(model),
      ...scores,
      requestsSinceReset: usage?.requests ?? (pool ? 0 : null),
      tokensSinceReset: usage?.tokens ?? (pool ? 0 : null),
      lastAt: iso(latestRow?.startedAt),
      lastOutcome: latestRow ? outcomeOf(latestRow) : probe ? String(probe.status) : null,
      lastSuccessAt: iso(Math.max(successes.sort((a, b) => b.startedAt - a.startedAt)[0]?.startedAt ?? -Infinity, probeOkAt)),
      lastCutAt: iso(Math.max(cuts.sort((a, b) => b.startedAt - a.startedAt)[0]?.startedAt ?? -Infinity, probeCutAt)),
      lastProbe: probe,
    }
  })
  const bucketIds = [...new Set([...pools.map(pool => pool.poolId), ...modelViews.filter(model => model.status === "current").map(model => model.bucket)])]
  const poolViews: FreeBucket[] = bucketIds.map(bucket => {
    const pool = pools.find(item => item.poolId === bucket)
    const members = new Set([...(pool?.members ?? []), ...modelViews.filter(model => model.bucket === bucket && model.status === "current").map(model => model.route)])
    const poolRows = rows.filter(record => members.has(routeOf(record.route)))
    const cuts = poolRows.filter(record => outcomeOf(record) === "rate-limited")
    const successes = poolRows.filter(record => outcomeOf(record) === "ok")
    const probe = latestProbe(probes, members)
    const latestCut = cuts.sort((a, b) => b.startedAt - a.startedAt)[0]
    const latestSuccess = successes.sort((a, b) => b.startedAt - a.startedAt)[0]
    const cutAt = Math.max(latestCut?.startedAt ?? -Infinity, probe?.status === 429 ? Date.parse(probe.at) : -Infinity)
    const okAt = Math.max(latestSuccess?.startedAt ?? -Infinity, probe && probe.status < 300 ? Date.parse(probe.at) : -Infinity)
    const state: FreeBucket["state"] = cutAt > -Infinity && cutAt > okAt ? "exhausted" : cutAt > -Infinity || okAt > -Infinity ? "usable" : "unknown"
    const currentMembers = modelViews.filter(model => model.bucket === bucket && model.status === "current").length
    return {
      pool: bucket,
      label: bucketLabel(bucket),
      provider: bucketProvider(bucket),
      state,
      estimate: pool?.estimate ?? "no estimate",
      confidence: pool?.confidence ?? "none",
      n: pool?.n ?? 0,
      models: members.size,
      currentModels: currentMembers,
      used: { requests: pool?.sinceLastReset.requests ?? 0, tokens: pool?.sinceLastReset.tokens ?? 0 },
      since: pool?.sinceLastReset.since ?? null,
      limit: pool?.limitEstimate ? { lower: pool.limitEstimate.lower, upper: pool.limitEstimate.upper, basis: pool.limitEstimate.basis, evidenceRows: pool.limitEstimate.evidenceRows, n: pool.limitEstimate.n } : null,
      left: pool?.leftEstimate ? { requests: pool.leftEstimate.requests, tokens: pool.leftEstimate.tokens, upper: pool.leftEstimate.upper, basis: pool.leftEstimate.basis, evidenceRows: pool.leftEstimate.evidenceRows, n: pool.leftEstimate.n } : null,
      published: publishedLimit(bucket),
      live: null,
      lastCutAt: iso(Math.max(latestCut?.startedAt ?? -Infinity, probe?.status === 429 ? Date.parse(probe.at) : -Infinity)),
      lastSuccessAt: iso(Math.max(latestSuccess?.startedAt ?? -Infinity, probe && probe.status < 300 ? Date.parse(probe.at) : -Infinity)),
      reset: resetOf(pool, probes, members, now),
      lastProbe: probe,
    }
  }).filter(pool => pool.currentModels > 0).sort((a, b) => a.pool.localeCompare(b.pool))
  const openCode = poolViews.find(pool => pool.pool === "opencode/free")
  const shownModels = modelViews
    .filter(model => options.all || model.status === "current")
    .sort((a, b) => (a.status === "current" ? 0 : 1) - (b.status === "current" ? 0 : 1) || (b.iq ?? -Infinity) - (a.iq ?? -Infinity) || a.route.localeCompare(b.route))
  const readout: FreeModelsReadout = {
    at: now,
    text: "",
    current,
    deprecated,
    unlisted,
    reset: openCode?.reset ?? poolViews.find(pool => pool.reset)?.reset ?? null,
    pools: poolViews,
    models: shownModels,
    openRouter: null,
    diagnostics,
  }
  readout.text = textOf(readout)
  if (poolViews.some(pool => pool.pool === "opencode/free" || pool.pool === "opencode-go/free")) diagnostics.push("Zen and Go are separate buckets; the counts in each bucket are that bucket's pool total, not a per-model cap.")
  return readout
}

export async function freeModelsLive(now: number = Date.now(), paths: FreeModelsPaths = freeModelsPaths(), options: { all?: boolean } = {}, deps: { fetch?: typeof globalThis.fetch; key?: string } = {}): Promise<FreeModelsReadout> {
  const readout = freeModelsPicture(now, paths, options)
  const key = "key" in deps ? deps.key : openRouterKey()
  if (!key) {
    readout.openRouter = { key: "missing", checkedAt: null, error: null, freeModelDailyRequests: null }
    readout.diagnostics.push("OpenRouter key is not configured; its live free-model daily counter was not read")
    readout.text = textOf(readout)
    return readout
  }
  try {
    const response = await (deps.fetch ?? globalThis.fetch)(OPENROUTER_KEY_URL, { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error("HTTP " + response.status)
    const daily = (await response.json())?.data?.free_model_daily_requests
    if (!daily || !Number.isFinite(daily.used) || !Number.isFinite(daily.limit) || !Number.isFinite(daily.remaining)) throw new Error("no free_model_daily_requests in the key response")
    const checkedAt = new Date(now).toISOString()
    const resetAt = new Date(nextUtcMidnight(now)).toISOString()
    const live: OpenRouterDaily = { used: daily.used, limit: daily.limit, remaining: daily.remaining, resetAt, checkedAt, source: "OpenRouter /api/v1/key" }
    const bucket = readout.pools.find(pool => pool.pool === "free:openrouter")
    if (bucket) {
      bucket.live = live
      bucket.state = live.remaining > 0 ? "usable" : "exhausted"
      bucket.reset = { at: resetAt, basis: "endpoint daily UTC", source: live.source, local: local(resetAt) }
      bucket.used = { ...bucket.used, requests: live.used }
    }
    readout.openRouter = { key: "configured", checkedAt, error: null, freeModelDailyRequests: live }
    readout.diagnostics.push("OpenRouter's live key counter says " + live.remaining + " of " + live.limit + " free-model requests are left in the current UTC day")
  } catch (error) {
    readout.openRouter = { key: "configured", checkedAt: new Date(now).toISOString(), error: error instanceof Error ? error.message : String(error), freeModelDailyRequests: null }
    readout.diagnostics.push("OpenRouter's live free-model counter was not read (" + readout.openRouter.error + "); the published limits stay in place")
  }
  readout.text = textOf(readout)
  return readout
}
