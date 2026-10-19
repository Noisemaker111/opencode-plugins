import { mkdirSync, readFileSync } from "node:fs"
import {writeFileDurable} from "../quest/core/durable-file.mjs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { assertConfiguredRequest, configuredAccess, type AccessPolicy } from "./access-policy"

export type ProviderModelLists = { version: 1; providers: Record<string, string> }
export type LiveProviderModels = { identities: string[]; source: "live" | "cache" | "stale-cache" | "unavailable"; at?: string; diagnostics: string[]; listed?: Record<string, ListedModel[]> }

export const providerModelListsFile = () =>
  process.env.OPENCODE_PROVIDER_MODEL_LISTS ?? join(import.meta.dir, "provider-model-lists.json")
export const providerModelsCacheFile = () =>
  process.env.OPENCODE_PROVIDER_MODELS_CACHE
  ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "provider-models.json")
export const PROVIDER_MODELS_MAX_AGE_MS = 6 * 60 * 60 * 1000

export function providerModelLists(file = providerModelListsFile()): ProviderModelLists {
  let value: ProviderModelLists
  try { value = JSON.parse(readFileSync(file, "utf8")) } catch { return { version: 1, providers: {} } }
  if (!value || typeof value !== "object" || value.version !== 1 || !value.providers || typeof value.providers !== "object" || Array.isArray(value.providers))
    throw new Error("Invalid provider model list configuration; each entry must name a provider and the URL that provider publishes its own models at")
  for (const [providerID, url] of Object.entries(value.providers))
    if (typeof url !== "string" || !URL.canParse(url)) throw new Error("Provider model list for " + providerID + " is not an absolute URL")
  return { version: 1, providers: { ...value.providers } }
}

export type ListedModel = { id: string; type?: string; contextWindow?: number; ownedBy?: string }
export function parseProviderModelRows(payload: unknown): ListedModel[] {
  const rows = Array.isArray(payload) ? payload : Array.isArray((payload as { data?: unknown })?.data) ? (payload as { data: unknown[] }).data : undefined
  if (!rows) throw new Error("Provider model list did not contain a model array")
  return rows.flatMap(row => {
    const id = typeof row === "string" ? row : typeof (row as { id?: unknown })?.id === "string" ? (row as { id: string }).id : ""
    if (!id) return []
    const record = typeof row === "object" && row ? row as Record<string, unknown> : {}
    const window = record.context_window ?? record.contextWindow
    return [{ id, ...(typeof record.type === "string" ? { type: record.type } : {}), ...(typeof window === "number" && Number.isFinite(window) ? { contextWindow: window } : {}), ...(typeof record.owned_by === "string" && record.owned_by ? { ownedBy: record.owned_by } : {}) }]
  })
}
const listings = new Map<string, { at: number; models: ListedModel[] }>()
export async function listedProviderModels(providerID: string, input: { lists?: ProviderModelLists; fetchImpl?: typeof fetch; now?: number; maxAgeMs?: number; timeoutMs?: number } = {}): Promise<ListedModel[] | undefined> {
  const now = input.now ?? Date.now(), maxAgeMs = input.maxAgeMs ?? PROVIDER_MODELS_MAX_AGE_MS
  const memo = listings.get(providerID)
  if (memo && now - memo.at >= 0 && now - memo.at < maxAgeMs) return memo.models
  let url: string | undefined
  try { url = (input.lists ?? providerModelLists()).providers[providerID] } catch { return undefined }
  if (!url) return undefined
  try {
    const fetchImpl = input.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== "function") throw new Error("fetch is not configured")
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(input.timeoutMs ?? 8000) })
    if (!response.ok) throw new Error(url + " returned HTTP " + response.status)
    const models = parseProviderModelRows(await response.json())
    listings.set(providerID, { at: now, models })
    return models
  } catch { return undefined }
}
export async function listedProviderModel(providerID: string, id: string, input: Parameters<typeof listedProviderModels>[1] = {}) {
  return (await listedProviderModels(providerID, input))?.find(model => model.id === id)
}

export function permittedProviderModels(providerID: string, url: string, ids: string[], policy: AccessPolicy) {
  const permitted: string[] = []
  for (const id of ids) {
    try { assertConfiguredRequest({ providerID, id }, url, policy) } catch { continue }
    permitted.push(id)
  }
  return permitted.sort()
}

type Cached = { schema?: number; at?: string; providers?: Record<string, string[]> }
const readCache = (file: string): Cached | undefined => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return undefined } }
export function cachedProviderModels(file = providerModelsCacheFile()): Record<string, string[]> {
  const cached = readCache(file)
  return cached?.schema === 1 && cached.providers && typeof cached.providers === "object" ? cached.providers : {}
}

export async function liveProviderModels(input: {
  policy?: AccessPolicy
  lists?: ProviderModelLists
  fetchImpl?: typeof fetch
  now?: number
  maxAgeMs?: number
  timeoutMs?: number
  cacheFile?: string
  apiKeys?: Record<string, string>
} = {}): Promise<LiveProviderModels> {
  const now = input.now ?? Date.now(), maxAgeMs = input.maxAgeMs ?? PROVIDER_MODELS_MAX_AGE_MS
  const file = input.cacheFile ?? providerModelsCacheFile()
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  let policy: AccessPolicy
  let lists: ProviderModelLists
  try { policy = input.policy ?? configuredAccess(); lists = input.lists ?? providerModelLists() }
  catch (error) { return { identities: [], source: "unavailable", diagnostics: ["Provider model lists are unavailable (" + String(error) + ")"] } }
  const entries = Object.entries(lists.providers)
  if (!entries.length) return { identities: [], source: "unavailable", diagnostics: ["No provider publishes its own model list in provider-model-lists.json"] }

  const cached = readCache(file), cachedAt = Date.parse(cached?.at ?? "")
  const flatten = (providers: Record<string, string[]>) =>
    [...new Set(entries.flatMap(([providerID, url]) => permittedProviderModels(providerID, url, providers[providerID] ?? [], policy).map(id => providerID + "/" + id)))].sort()
  if (cached?.schema === 1 && cached.providers && Number.isFinite(cachedAt) && now - cachedAt >= 0 && now - cachedAt < maxAgeMs)
    return { identities: flatten(cached.providers), source: "cache", at: cached.at, diagnostics: ["Provider model lists cached at " + cached.at] }

  const providers: Record<string, string[]> = {}
  const listed: Record<string, ListedModel[]> = {}
  const diagnostics: string[] = []
  let failures = 0
  for (const [providerID, url] of entries) {
    try {
      if (typeof fetchImpl !== "function") throw new Error("fetch is not configured")
      const apiKey = input.apiKeys?.[providerID]
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(input.timeoutMs ?? 8000), ...(apiKey ? { headers: { authorization: "Bearer " + apiKey } } : {}) })
      if (!response.ok) throw new Error(url + " returned HTTP " + response.status)
      const rows = parseProviderModelRows(await response.json())
      const ids = [...new Set(rows.map(model => model.id))]
      providers[providerID] = ids
      listed[providerID] = rows
      const permitted = permittedProviderModels(providerID, url, ids, policy)
      diagnostics.push(providerID + ": " + permitted.length + " of " + ids.length + " listed models are permitted by the access policy")
    } catch (error) {
      failures++
      diagnostics.push(providerID + ": own model list could not be read (" + (error instanceof Error ? error.message : String(error)) + ")")
      if (cached?.providers?.[providerID]) providers[providerID] = cached.providers[providerID]
    }
  }
  if (failures === entries.length) {
    if (!cached?.providers) return { identities: [], source: "unavailable", diagnostics }
    return { identities: flatten(cached.providers), source: "stale-cache", at: cached.at, diagnostics }
  }
  const at = new Date(now).toISOString()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileDurable(file, JSON.stringify({ schema: 1, at, providers }))
  } catch (error) { diagnostics.push("Provider model lists could not be cached (" + String(error) + ")") }
  return { identities: flatten(providers), source: "live", at, diagnostics, listed }
}
