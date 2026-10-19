import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { writeFileDurable } from "../quest/core/durable-file.mjs"

export type Cost = { input?: number; output?: number; cache_read?: number; cache_write?: number; tiers?: { input?: number; output?: number; cache_read?: number; cache_write?: number; tier?: { type?: string; size?: number } }[] }
export type Catalog = Record<string, { models: Record<string, { cost?: Cost }> }>

export const PRICE_CATALOG_URL = "https://models.dev/api.json"
export const catalogFile = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode", "models.json")
export const catalogWarningsFile = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "price-catalog-warnings.jsonl")

export type CatalogRefreshOptions = { transport?: typeof fetch; warningsFile?: string; timeoutMs?: number }
export type CatalogWarning = { at: string; file: string; provider: string; model: string; reason: string }

export const priceProviders = (catalog: Catalog, provider: string, model: string): string[] =>
  provider in catalog ? [provider] :
  provider === "claude-code" || /^claude-/.test(model) ? ["anthropic"] :
  provider === "codex" || /^(gpt|o[1-9])/.test(model) ? ["openai"] : []

const fileStamp = (file: string) => { try { return statSync(file).mtimeMs } catch { return undefined } }

let loaded: { file: string; mtime: number; catalog: Catalog } | undefined
function readCatalog(file: string): Catalog | undefined {
  try {
    const mtime = statSync(file).mtimeMs
    if (loaded?.file !== file || loaded.mtime !== mtime) loaded = { file, mtime, catalog: JSON.parse(readFileSync(file, "utf8")) }
    return loaded.catalog
  } catch { return undefined }
}

function ratesIn(catalog: Catalog, provider: string, model: string, inputTotal: number) {
  for (const p of priceProviders(catalog, provider, model)) {
    const cost = catalog[p]?.models?.[model]?.cost
    if (!cost) continue
    const tier = cost.tiers?.filter(t => t.tier?.type === "context" && typeof t.tier.size === "number" && inputTotal > t.tier.size!).sort((a, b) => b.tier!.size! - a.tier!.size!)[0] ?? cost
    return { provider: p, input: tier.input, output: tier.output, cacheRead: tier.cache_read }
  }
  return undefined
}

export function recordCatalogWarning(warning: CatalogWarning, file = catalogWarningsFile()) {
  console.warn("[usage] price catalog: " + warning.reason)
  try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(warning) + "\n", { encoding: "utf8", mode: 0o600 }) }
  catch (error) { console.warn("[usage] price catalog warning could not be saved", error instanceof Error ? error.message : error) }
}

const isCatalog = (payload: unknown): payload is Catalog =>
  !!payload && typeof payload === "object" && !Array.isArray(payload) &&
  Object.values(payload as Record<string, any>).some(provider => provider?.models && typeof provider.models === "object")

export async function refreshPriceCatalog(file = catalogFile(), options: CatalogRefreshOptions = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await (options.transport ?? fetch)(PRICE_CATALOG_URL, { signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) })
    if (!response.ok) throw new Error("models.dev returned HTTP " + response.status)
    const payload: unknown = await response.json()
    if (!isCatalog(payload)) throw new Error("models.dev returned no provider models")
    writeFileDurable(file, JSON.stringify(payload))
    if (loaded?.file === file) loaded = undefined
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const refreshing = new Map<string, Promise<void>>()
const missingAt = new Map<string, number | undefined>()
export const pendingCatalogRefresh = (file = catalogFile()) => refreshing.get(file)

function refreshForMissing(file: string, provider: string, model: string, options: CatalogRefreshOptions) {
  const key = file + "\n" + provider + "/" + model
  if (missingAt.has(key) && missingAt.get(key) === fileStamp(file)) return
  if (refreshing.has(file)) return
  const warn = (reason: string) => recordCatalogWarning({ at: new Date().toISOString(), file, provider, model, reason }, options.warningsFile)
  const run = refreshPriceCatalog(file, options).then(result => {
    if (!result.ok) { warn("could not refresh " + file + " from " + PRICE_CATALOG_URL + " for " + provider + "/" + model + ": " + result.error); return }
    if (!ratesIn(readCatalog(file) ?? {}, provider, model, 0)) warn(PRICE_CATALOG_URL + " has no price for " + provider + "/" + model)
    missingAt.set(key, fileStamp(file))
  }).finally(() => refreshing.delete(file))
  refreshing.set(file, run)
}

export function catalogRates(provider: string, model: string, inputTotal = 0, file = catalogFile(), options: CatalogRefreshOptions = {}) {
  const found = ratesIn(readCatalog(file) ?? {}, provider, model, inputTotal)
  if (!found) refreshForMissing(file, provider, model, options)
  return found
}
