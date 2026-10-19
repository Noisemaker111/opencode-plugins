import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import JSON5 from "json5"
import { writeFileDurable } from "../quest/core/durable-file.mjs"
import { assertConfiguredModel, assertConfiguredSelection, configuredAccess, evaluationOnlyProvider, type AccessPolicy } from "./access-policy"
import { accountsForRoute } from "../usage-service/on-computer"
import { cachedProviderModels } from "./provider-live-models"
import { canonicalModelID, slugModel } from "./model-catalog"
import { benchmarkFor, benchmarkRows, readBenchmarkTable, withCatalogLineage, type BenchmarkEntry, type BenchmarkTable } from "./benchmark-table"
import type { AccountSnapshot } from "../usage-service/on-computer"
import type { Route, RouteBenchmark } from "./route-planner"
import type { Account } from "./route-vocabulary"

export type CatalogModel = {
  providerID: string
  modelID: string
  efforts: string[]
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  limit?: { context?: number }
  releaseDate?: string
  family?: string
  toolCall?: boolean
  deprecated?: boolean
  outputs?: string[]
}
export type LiveCatalog = { models: CatalogModel[]; source: "live" | "cache" | "stale-cache" | "unavailable"; at?: string; error?: string }

export const CATALOG_URL = "https://models.dev/api.json"
export const catalogCacheFile = () => process.env.OPENCODE_MODELS_DEV_CACHE
  ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "models-dev.json")

function parseCatalog(payload: unknown): CatalogModel[] {
  const root = payload && typeof payload === "object" ? payload as Record<string, any> : {}
  const models: CatalogModel[] = []
  for (const [providerID, provider] of Object.entries(root)) {
    for (const [key, model] of Object.entries(provider?.models ?? {}) as [string, any][]) {
      const modelID = typeof model?.id === "string" && model.id ? model.id : key
      const effort = (model?.reasoning_options ?? []).find((option: any) => option?.type === "effort")
      const efforts = (effort?.values ?? []).filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value !== "null")
      const outputs = Array.isArray(model?.modalities?.output) ? model.modalities.output.filter((value: unknown): value is string => typeof value === "string") : undefined
      models.push({ providerID, modelID, efforts, cost: model.cost, ...(model.limit && typeof model.limit.context === "number" ? { limit: { context: model.limit.context } } : {}), releaseDate: typeof model?.release_date === "string" ? model.release_date : undefined, family: typeof model?.family === "string" && model.family.trim() ? model.family.trim() : undefined,
        ...(typeof model?.tool_call === "boolean" ? { toolCall: model.tool_call } : {}), ...(model?.status === "deprecated" ? { deprecated: true } : {}), ...(outputs ? { outputs } : {}) })
    }
  }
  return models
}

export async function liveModelCatalog(now = Date.now(), maxAgeMs = 6 * 60 * 60 * 1000, timeoutMs = 8000): Promise<LiveCatalog> {
  const file = catalogCacheFile()
  let cached: { at?: string; models?: CatalogModel[] } | undefined
  try { cached = JSON.parse(readFileSync(file, "utf8")) } catch {}
  const cachedAt = Date.parse(cached?.at ?? "")
  if (cached?.schema === 3 && cached?.models?.length && Number.isFinite(cachedAt) && now - cachedAt >= 0 && now - cachedAt < maxAgeMs) return { models: cached.models, source: "cache", at: cached.at }
  try {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error("models.dev returned HTTP " + response.status)
    const models = parseCatalog(await response.json())
    if (!models.length) throw new Error("models.dev returned no models")
    const at = new Date(now).toISOString()
    writeFileDurable(file, JSON.stringify({ schema: 3, at, models }))
    return { models, source: "live", at }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (cached?.models?.length) return { models: cached.models, source: "stale-cache", at: cached.at, error: reason }
    return { models: [], source: "unavailable", error: reason }
  }
}

const percent = (fraction: number) => (fraction * 100).toFixed(1) + "%"
export function benchmarkedEfforts(entry: BenchmarkEntry, model: CatalogModel, permits: (reasoning: string) => boolean = () => true): { reasoning: string; benchmark: RouteBenchmark }[] {
  const claim = (effort: string, row: { passAt1: number; provenance: BenchmarkEntry["provenance"]; source: string; measuredAt: string; perTask?: RouteBenchmark["perTask"]; from?: string }, attribution?: string, publishedAt = effort): RouteBenchmark => {
    const inherited = row.from
      ? "no independent score yet; its predecessor " + row.from + " scored " + percent(row.passAt1) + " at " + publishedAt + " — treated as at least that" +
        (entry.vendorClaim ? ", while " + entry.id + "'s own " + entry.vendorClaim.provenance + " claim is " + percent(entry.vendorClaim.passAt1) + " (" + entry.vendorClaim.source + ")" : "")
      : ""
    const why = [inherited, row.from && entry.lineage ? entry.lineage : "", attribution].filter(Boolean).join("; ")
    return { suite: "", passAt1: row.passAt1, effort, provenance: row.provenance, source: row.source, measuredAt: row.measuredAt,
      ...(entry.intelligence !== undefined ? { intelligence: entry.intelligence } : {}), ...(row.from ? { inheritedFrom: row.from } : {}),
      ...(why ? { attribution: why } : {}), ...(row.perTask ? { perTask: row.perTask } : {}) }
  }
  const rows = benchmarkRows(entry)
  const scored = Object.entries(rows)
  if (!scored.length) {
    const unstated = entry.passAt1.unstated
    if (unstated === undefined) return []
    const declared = model.efforts.filter(permits)
    const highest = declared[declared.length - 1] ?? model.efforts[model.efforts.length - 1]
    const row = { passAt1: unstated, provenance: entry.provenance, source: entry.source, measuredAt: entry.measuredAt }
    return [{ reasoning: highest ?? "unknown", benchmark: claim(highest ?? "unknown", row,
      "The source published no effort level; attributed to the highest effort this model declares" + (highest && highest !== model.efforts[model.efforts.length - 1] ? " that the access policy permits (" + highest + ")" : "")) }]
  }
  if (!model.efforts.length) {
    const [effort, row] = scored.sort((a, b) => a[1].passAt1 - b[1].passAt1)[0]
    return [{ reasoning: "unknown", benchmark: claim(effort, row, "This route states no effort setting, so only the lowest published effort (" + effort + ") is claimed") }]
  }
  const claimed: { reasoning: string; benchmark: RouteBenchmark }[] = []
  for (const [index, effort] of model.efforts.entries()) {
    const row = rows[effort]
    if (!row) continue
    if (permits(effort)) { claimed.push({ reasoning: effort, benchmark: claim(effort, row) }); continue }
    if (!row.from || model.efforts.slice(index).some(permits)) continue
    const below = model.efforts.slice(0, index).filter(permits)
    const target = below[below.length - 1]
    if (!target || rows[target] || claimed.some(c => c.reasoning === target)) continue
    claimed.push({ reasoning: target, benchmark: claim(target, row,
      "the predecessor published this at " + effort + ", which the access policy forbids for this model, and no higher effort is permitted either, so it is carried to " + target, effort) })
  }
  return claimed
}

export type ConfiguredModel = { efforts: string[]; pinned?: string }
export const configuredModelsFile = () => process.env.OPENCODE_CONFIG_FILE ?? join(import.meta.dir, "..", "opencode.jsonc")
export function configuredModelEfforts(file = configuredModelsFile()): Map<string, ConfiguredModel> {
  const configured = new Map<string, ConfiguredModel>()
  let config: any
  try { config = JSON5.parse(readFileSync(file, "utf8")) } catch { return configured }
  for (const [providerID, provider] of Object.entries(config?.providers ?? {}) as [string, any][])
    for (const [modelID, model] of Object.entries(provider?.models ?? {}) as [string, any][]) {
      const efforts = (Array.isArray(model?.variants) ? model.variants : []).flatMap((variant: any) => typeof variant?.id === "string" && variant.id.trim() ? [variant.id.trim()] : [])
      const pinned = model?.settings?.providerOptions?.reasoningEffort
      configured.set(providerID + "/" + modelID, { efforts, ...(typeof pinned === "string" && pinned.trim() ? { pinned: pinned.trim() } : {}) })
    }
  return configured
}

export type DerivationPolicy = { routes: Route[]; billing: Record<string, unknown> }
export const KEYLESS_ACCOUNT = "keyless:"
export const keylessAccountID = (providerID: string) => KEYLESS_ACCOUNT + providerID
export function keylessAccounts(routes: Pick<Route, "accountID">[], billing: Record<string, unknown>, connected: { id: string }[], now: number): Account[] {
  const ids = [...new Set(routes.map(route => route.accountID))].filter(id => id.startsWith(KEYLESS_ACCOUNT) && !connected.some(account => account.id === id))
  return ids.flatMap(id => billing[id] === "free" ? [{ id, billing: "free" as const, authenticated: true, observedAt: new Date(now).toISOString(), capacity: "available" as const, windows: [] }] : [])
}

const identity = (route: { accountID: string; providerID: string; modelID: string; reasoning: string }) =>
  [route.accountID, route.providerID, route.modelID, route.reasoning].join("\0")

export function unbenchedEffort(model: Pick<CatalogModel, "efforts">, permits: (reasoning: string) => boolean, configured?: ConfiguredModel) {
  if (configured?.pinned && permits(configured.pinned) && (!model.efforts.length || model.efforts.includes(configured.pinned))) return configured.pinned
  if (!model.efforts.length) return permits("unknown") ? "unknown" : undefined
  return model.efforts.filter(permits).at(-1)
}

export const canWork = (model: Pick<CatalogModel, "toolCall" | "deprecated" | "outputs">) => model.toolCall === true && !model.deprecated && (!model.outputs || model.outputs.includes("text"))
const unpriced = (model: CatalogModel) => model.cost?.input === 0 && model.cost?.output === 0
export function withFreeTiers(table: BenchmarkTable, catalog: CatalogModel[]) {
  const aliases = new Map<BenchmarkEntry, string[]>(), diagnostics: string[] = [], priced = new Map<string, CatalogModel[]>()
  for (const model of catalog) if (!unpriced(model) && model.releaseDate) priced.set(canonicalModelID(model.modelID), [...(priced.get(canonicalModelID(model.modelID)) ?? []), model])
  for (const model of catalog) {
    if (!unpriced(model) || !model.releaseDate || !model.modelID.includes("-") || benchmarkFor(table, model.modelID)) continue
    const twin = priced.get(canonicalModelID(model.modelID.slice(0, model.modelID.lastIndexOf("-"))))?.find(other => other.releaseDate === model.releaseDate)
    const entry = twin && benchmarkFor(table, twin.modelID)
    if (!entry) continue
    const known = aliases.get(entry) ?? []
    if (!known.includes(model.modelID)) aliases.set(entry, [...known, model.modelID])
    const line = model.modelID + ": a free listing of " + twin.modelID + " (same name with a suffix, no price, released the same day " + model.releaseDate + "), so it is ranked by " + entry.id + "'s scores"
    if (!diagnostics.includes(line)) diagnostics.push(line)
  }
  if (!aliases.size) return { table, diagnostics }
  return { table: { ...table, entries: table.entries.map(entry => aliases.has(entry) ? { ...entry, aliases: [...(entry.aliases ?? []), ...aliases.get(entry)!] } : entry) }, diagnostics }
}

export function deriveBenchmarkRoutes(input: { catalog: CatalogModel[]; table: BenchmarkTable; snapshot: AccountSnapshot; policy: DerivationPolicy; configured?: Map<string, ConfiguredModel>; served?: Record<string, string[]> }) {
  const { catalog, table, snapshot, policy, served = {} } = input
  const configured = input.configured ?? configuredModelEfforts()
  const taken = new Set(policy.routes.map(identity))
  const routes: Route[] = []
  const diagnostics: string[] = []
  const note = (reason: string) => { if (!diagnostics.includes(reason)) diagnostics.push(reason) }
  let access: AccessPolicy
  try { access = configuredAccess() } catch { return { routes, diagnostics } }
  for (const model of catalog) {
    if (evaluationOnlyProvider(model.providerID, access)) continue
    if (model.deprecated) { note(model.providerID + "/" + model.modelID + ": the catalog marks this model deprecated, so it derives no route"); continue }
    try { assertConfiguredModel({ providerID: model.providerID, id: model.modelID }, access) } catch { continue }
    const accounts = accountsForRoute(snapshot, model.providerID, model.modelID)
    const serving = accounts.length > 1 ? [...accounts].sort((a, b) => Number(a.state !== "available") - Number(b.state !== "available") || a.id.localeCompare(b.id)) : accounts
    if (serving.length > 1) note(model.providerID + "/" + model.modelID + ": " + serving.length + " connected accounts serve this identity; it routes on " + serving[0].id + " while that account has capacity")
    const keyless = keylessAccountID(model.providerID)
    const accountID = serving[0]?.id ?? (policy.billing[keyless] ? keyless : undefined)
    if (!accountID) continue
    if (!policy.billing[accountID]) { note(model.providerID + "/" + model.modelID + ": billing arrangement for " + accountID + " is not configured"); continue }
    const entry = benchmarkFor(table, model.modelID)
    const permits = (reasoning: string) => { try { assertConfiguredSelection({ ...model, reasoning }, access); return true } catch { return false } }
    if (!entry) {
      if (!served[model.providerID]) { note(model.providerID + "/" + model.modelID + ": no benchmark entry, and " + model.providerID + " has no saved list of the models it serves (models/provider-model-lists.json), so nothing shows the account serves it"); continue }
      if (!served[model.providerID].includes(model.modelID)) { note(model.providerID + "/" + model.modelID + ": no benchmark entry, and " + model.providerID + "'s own model list does not include it"); continue }
      if (!canWork(model)) { note(model.providerID + "/" + model.modelID + ": no benchmark entry, and the catalog does not list it as a current model that calls tools and writes text, so it derives no route"); continue }
      const reasoning = unbenchedEffort(model, permits, configured.get(model.providerID + "/" + model.modelID))
      if (!reasoning) { note(model.providerID + "/" + model.modelID + ": connected and permitted, but no effort it declares (" + model.efforts.join(", ") + ") is permitted by the access policy"); continue }
      const route: Route = {
        id: "live-" + slugModel(model.providerID) + "-" + slugModel(model.modelID) + "-" + slugModel(reasoning),
        accountID, providerID: model.providerID, modelID: model.modelID,
        harness: "native", agent: "worker", reasoning, serviceTier: "default",
        verified: true, admission: "unbenched", evidence: [], quotaPerTask: {},
      }
      if (taken.has(identity(route)) || routes.some(existing => existing.id === route.id)) continue
      taken.add(identity(route))
      routes.push(route)
      note(model.providerID + "/" + model.modelID + "#" + reasoning + ": no benchmark entry and no declared succession, so it derives a route with no published score that only exploration tries until its runs here are judged")
      continue
    }
    const claimed = benchmarkedEfforts(entry, model, permits)
    if (!claimed.length) note(model.providerID + "/" + model.modelID + ": connected and permitted, but no effort it declares (" + (model.efforts.join(", ") || "none") + ") has a score the access policy also permits")
    if (claimed.length && claimed.length < model.efforts.filter(permits).length) {
      const ranked = new Set(claimed.map(c => c.reasoning))
      const unranked = model.efforts.filter(effort => permits(effort) && !ranked.has(effort))
      if (unranked.length) note(model.providerID + "/" + model.modelID + ": " + unranked.join(", ") + " derive no ranked route because no row is published or inherited for them; " + [...ranked].join(", ") + " is what the evidence covers, so name one of the others explicitly to dispatch on it")
    }
    for (const { reasoning, benchmark } of claimed) {
      try { assertConfiguredSelection({ ...model, reasoning }, access) } catch(error) { note(String(error)); continue }
      const route: Route = {
        id: "live-" + slugModel(model.providerID) + "-" + slugModel(model.modelID) + "-" + slugModel(reasoning),
        accountID, providerID: model.providerID, modelID: model.modelID,
        harness: "native", agent: "worker", reasoning, serviceTier: "default",
        verified: true, admission: "benchmark-ranked",
        benchmark: { ...benchmark, suite: table.suite },
        evidence: [], quotaPerTask: {},
      }
      if (taken.has(identity(route)) || routes.some(existing => existing.id === route.id)) continue
      taken.add(identity(route))
      routes.push(route)
    }
  }
  return { routes, diagnostics }
}

export function withBenchmarkPriors(routes: Route[], table: BenchmarkTable, catalog: CatalogModel[], configured = configuredModelEfforts()): Route[] {
  return routes.map(route => {
    if (route.benchmark) return route
    const entry = benchmarkFor(table, route.modelID)
    if (!entry) return route
    const declared = configured.get(route.providerID + "/" + route.modelID)
    const runsAt = route.reasoning && route.reasoning !== "unknown" ? route.reasoning : declared?.pinned ?? route.reasoning
    const want = slugModel(route.modelID)
    const stated = runsAt && runsAt !== "unknown"
    const model = (stated && (catalog.find(m => m.providerID === route.providerID && m.modelID === route.modelID && m.efforts.length)
      ?? catalog.find(m => slugModel(m.modelID) === want && m.efforts.length)
      ?? (declared?.efforts.length ? { providerID: route.providerID, modelID: route.modelID, efforts: declared.efforts } : undefined)))
      || { providerID: route.providerID, modelID: route.modelID, efforts: [] as string[] }
    const permits = (reasoning: string) => { try { assertConfiguredSelection({ providerID: route.providerID, modelID: route.modelID, reasoning }); return true } catch { return false } }
    const match = benchmarkedEfforts(entry, model, permits).find(candidate => candidate.reasoning === runsAt)
    if (!match) return route
    const pinned = runsAt !== route.reasoning
      ? "the route states no effort and " + route.providerID + "/" + route.modelID + " is configured to send " + runsAt + " on every request, which is the effort it runs at" : ""
    const attribution = [match.benchmark.attribution, pinned].filter(Boolean).join("; ")
    return { ...route, ...(pinned && declared?.efforts.includes(runsAt!) ? { reasoning: runsAt! } : {}),
      benchmark: { ...match.benchmark, suite: table.suite, ...(attribution ? { attribution } : {}) } }
  })
}

export function replaceSupersededRoutes(routes: Route[], table: BenchmarkTable) {
  const identities = (entry: BenchmarkEntry) => [entry.id, ...(entry.aliases ?? [])].map(canonicalModelID)
  const successorsOf = new Map<string, BenchmarkEntry[]>()
  for (const entry of table.entries) {
    if (!entry.succeeds) continue
    const predecessor = benchmarkFor(table, entry.succeeds)
    for (const name of predecessor ? identities(predecessor) : [canonicalModelID(entry.succeeds)]) successorsOf.set(name, [...(successorsOf.get(name) ?? []), entry])
  }
  const served = new Set(routes.map(route => route.accountID + "\0" + canonicalModelID(route.modelID)))
  const diagnostics: string[] = []
  const kept = routes.filter(route => {
    const entry = benchmarkFor(table, route.modelID)
    if (!entry) return true
    const seen = new Set<BenchmarkEntry>(), queue = [...(successorsOf.get(canonicalModelID(entry.id)) ?? [])]
    for (let successor = queue.shift(); successor; successor = queue.shift()) {
      if (seen.has(successor)) continue
      seen.add(successor)
      queue.push(...(successorsOf.get(canonicalModelID(successor.id)) ?? []))
      if (!identities(successor).some(name => served.has(route.accountID + "\0" + name))) continue
      const retired = canonicalModelID(entry.retiredInto ?? "") === canonicalModelID(successor.id)
      diagnostics.push(entry.id + " replaced by its successor " + successor.id + " on " + route.accountID +
        (retired ? ", which that account serves and whose provider has retired the older id into it" : ", which that account serves") +
        "; " + route.id + " (" + route.providerID + "/" + route.modelID + "#" + route.reasoning + ") is not a candidate")
      return false
    }
    return true
  })
  return { routes: kept, diagnostics }
}

export async function liveDispatchRoutes(policy: DerivationPolicy, snapshot: AccountSnapshot, now = Date.now()) {
  const catalog = await liveModelCatalog(now)
  const lineage = withCatalogLineage(readBenchmarkTable(), catalog.models)
  const free = withFreeTiers(lineage.table, catalog.models)
  const table = free.table
  const derived = deriveBenchmarkRoutes({ catalog: catalog.models, table, snapshot, policy, served: cachedProviderModels() })
  const deprecated = new Set(catalog.models.filter(model => model.deprecated).map(model => model.providerID + "/" + model.modelID))
  const curatedRoutes = policy.routes.filter(route => !evaluationOnlyProvider(route.providerID))
  const curated = withBenchmarkPriors(curatedRoutes.filter(route => !deprecated.has(route.providerID + "/" + route.modelID)), table, catalog.models)
  const retired = curatedRoutes.filter(route => deprecated.has(route.providerID + "/" + route.modelID)).map(route => route.providerID + "/" + route.modelID)
  const replaced = replaceSupersededRoutes([...curated, ...derived.routes], table)
  const candidate = new Set(replaced.routes.map(route => route.id))
  return {
    curated: curated.filter(route => candidate.has(route.id)),
    derived: derived.routes.filter(route => candidate.has(route.id)),
    catalog,
    table,
    diagnostics: [catalog.source === "unavailable" ? "models.dev catalog unavailable (" + catalog.error + "); only curated routes are candidates"
      : catalog.source === "stale-cache" ? "models.dev fetch failed (" + catalog.error + "); using the cached catalog from " + catalog.at
      : "models.dev catalog " + catalog.source + " at " + catalog.at, ...lineage.diagnostics, ...free.diagnostics, ...derived.diagnostics, ...replaced.diagnostics,
      ...retired.map(route => route + ": the catalog marks this model deprecated, so it is not a candidate")],
  }
}
