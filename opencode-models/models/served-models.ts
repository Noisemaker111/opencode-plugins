import { hostCatalog } from "./host-catalog"
import { liveProviderModels, providerModelLists, type ProviderModelLists } from "./provider-live-models"
import { statSync } from "node:fs"
import { readRequestsSince, readRequestsSinceAsync, TELEMETRY_FILE, type TelemetryCursor } from "../usage/telemetry-store"
import { ModelAvailability } from "./model-availability"

const fileStamp = (file: string) => { try { const { size, mtimeMs } = statSync(file); return size + ":" + mtimeMs } catch { return "" } }

type Variant = { id: string; settings?: Record<string, unknown> }
type Limit = { context: number; input?: number; output: number }
type CatalogModel = {
  status?: string
  id: string
  modelID?: string
  name: string
  family?: string
  time: { released: number }
  limit: Limit
  capabilities: { tools: boolean; input: readonly string[]; output: readonly string[] }
  variants: Variant[]
}
type CatalogProvider = { id: string; name?: string; settings?: Record<string, unknown> }
type ProviderRecord = { provider: CatalogProvider; models: ReadonlyMap<string, CatalogModel> }
export type ServedModelsDraft = {
  provider: { list(): readonly ProviderRecord[]; get(providerID: string): ProviderRecord | undefined }
  model: { get(providerID: string, modelID: string): CatalogModel | undefined; update(providerID: string, modelID: string, fn: (model: CatalogModel) => void): void }
}
export type ServingEndpoint = { providerID: string; url: string; apiKey?: string }
export type ServedModel = { id: string; ownedBy?: string }

const HOST_DEFAULT_LIMIT: Limit = { context: 200_000, output: 32_000 }
const isHostDefaultLimit = (limit: Limit) =>
  limit.context === HOST_DEFAULT_LIMIT.context && limit.output === HOST_DEFAULT_LIMIT.output && limit.input === undefined

export function servingEndpoints(providers: readonly CatalogProvider[], lists: ProviderModelLists): ServingEndpoint[] {
  return Object.entries(lists.providers).flatMap(([providerID, url]) => {
    const settings = providers.find(provider => provider.id === providerID)?.settings
    const base = typeof settings?.baseURL === "string" ? settings.baseURL.replace(/\/+$/, "") : ""
    if (!base || !url.startsWith(base + "/")) return []
    return [{ providerID, url, ...(typeof settings?.apiKey === "string" && settings.apiKey ? { apiKey: settings.apiKey } : {}) }]
  })
}

export async function discoverServedModels(endpoints: ServingEndpoint[], options: Parameters<typeof liveProviderModels>[0] = {}) {
  const apiKeys = Object.fromEntries(endpoints.flatMap(endpoint => endpoint.apiKey ? [[endpoint.providerID, endpoint.apiKey]] : []))
  const live = await liveProviderModels({ maxAgeMs: 0, ...options, apiKeys })
  const served: Record<string, ServedModel[]> = {}
  for (const endpoint of endpoints) served[endpoint.providerID] = []
  for (const identity of live.identities) {
    const slash = identity.indexOf("/"), providerID = identity.slice(0, slash), id = identity.slice(slash + 1)
    const ownedBy = live.listed?.[providerID]?.find(row => row.id === id)?.ownedBy
    served[providerID]?.push({ id, ...(ownedBy ? { ownedBy } : {}) })
  }
  return { served, live }
}

export function upsertServedModels(draft: ServedModelsDraft, served: Record<string, readonly ServedModel[]>, names: Record<string, string> = {}, unavailable: ReadonlySet<string> = new Set()) {
  const references = new Map<string, { providerID: string; model: CatalogModel }[]>()
  for (const { provider, models } of draft.provider.list()) {
    for (const model of models.values()) {
      for (const id of new Set([model.id, model.modelID ?? model.id])) {
        const rows = references.get(id) ?? []
        rows.push({ providerID: provider.id, model })
        references.set(id, rows)
      }
    }
  }
  const referenceFor = (providerID: string, { id, ownedBy }: ServedModel) => (references.get(id) ?? [])
    .filter(row => row.providerID !== providerID && row.model.time.released > 0)
    .sort((a, b) => Number(b.providerID === ownedBy) - Number(a.providerID === ownedBy)
      || b.model.time.released - a.model.time.released || a.providerID.localeCompare(b.providerID))[0]?.model

  for (const [providerID, models] of Object.entries(served)) {
    const providerName = names[providerID] || draft.provider.get(providerID)?.provider.name || providerID
    for (const listing of models) {
      const id = listing.id, reference = referenceFor(providerID, listing)
      const shared = (references.get(id) ?? []).filter(row => row.providerID !== providerID && !(row.providerID in served))
      const label = unavailable.has(`${providerID}/${id}`) ? "Unavailable: model not found or retired"
        : shared.length && shared.every(row => row.model.status === "deprecated") ? "Deprecated in shared catalog"
        : !shared.length ? "Unverified: not in shared catalog" : undefined
      const configured = draft.model.get(providerID, id) !== undefined
      if (!configured && reference && !reference.capabilities.output.includes("text")) continue
      draft.model.update(providerID, id, model => {
        model.name = model.name.replace(/ \[(?:Unavailable: model not found or retired|Deprecated in shared catalog|Unverified: not in shared catalog)\]$/, "")
        if (label) model.name += ` [${label}]`
        if (!reference) return
        if (!configured) {
          model.name = reference.name + " (" + providerName + ")" + (label ? ` [${label}]` : "")
          model.capabilities = { tools: reference.capabilities.tools, input: [...reference.capabilities.input], output: [...reference.capabilities.output] }
          model.variants = reference.variants.map(variant => ({ id: variant.id, settings: { providerOptions: { reasoningEffort: variant.id } } }))
        }
        if (model.family === undefined && reference.family !== undefined) model.family = reference.family
        if (!(model.time.released > 0)) model.time = { released: reference.time.released }
        if (reference.limit.context > 0 && (!configured || isHostDefaultLimit(model.limit))) model.limit = { ...reference.limit }
      })
    }
  }
}

export async function installServedModels(ctx: import("./host-catalog").CatalogHost, lists = providerModelLists()) {
  const catalog = hostCatalog(ctx)
  if (typeof catalog?.transform !== "function") throw new Error("Host catalog transform is unavailable")
  let served: Record<string, readonly ServedModel[]> = {}
  let names: Record<string, string> = {}
  let fetched: string | undefined
  let scheduled = false
  const refresh = async () => {
    const listed = await catalog.provider?.list?.()
    const rows = listed && typeof listed === "object" && "data" in listed ? listed.data : listed
    const providers: CatalogProvider[] = Array.isArray(rows) ? rows : []
    const endpoints = servingEndpoints(providers, lists)
    const key = JSON.stringify(endpoints)
    if (!endpoints.length || key === fetched) return
    fetched = key
    const found = await discoverServedModels(endpoints)
    for (const line of found.live.diagnostics) if (/could not|unavailable/.test(line)) console.warn("[models] served models:", line)
    served = found.served
    names = Object.fromEntries(providers.map(provider => [provider.id, provider.name ?? provider.id]))
    await catalog.reload?.()
  }
  await catalog.transform((draft: ServedModelsDraft) => {
    if (!scheduled) {
      scheduled = true
      setTimeout(() => { scheduled = false; void refresh().catch(error => console.warn("[models] served models unavailable:", error)) }, 0)
    }
    upsertServedModels(draft, served, names, observedUnavailable(() => catalog.reload?.()))
  })
}

const observed = { stamp: "", cursor: null as TelemetryCursor | null, availability: new ModelAvailability(), unavailable: new Set<string>(), history: undefined as Promise<void> | undefined, loaded: false, waiting: new Set<() => unknown>() }
function observedUnavailable(rebuild: () => unknown) {
  if (!observed.loaded) {
    observed.waiting.add(rebuild)
    observed.history ??= readRequestsSinceAsync(null).then(update => {
      observed.availability.add(update.records)
      observed.cursor = update.cursor
    }, () => {}).finally(() => {
      observed.loaded = true
      for (const each of observed.waiting) void Promise.resolve(each()).catch(() => {})
      observed.waiting.clear()
    })
    return observed.unavailable
  }
  const stamp = fileStamp(TELEMETRY_FILE)
  if (stamp === observed.stamp) return observed.unavailable
  observed.stamp = stamp
  try {
    const update = readRequestsSince(observed.cursor)
    if (update.restarted) observed.availability.clear()
    observed.availability.add(update.records)
    observed.cursor = update.cursor
  } catch {}
  return observed.unavailable = observed.availability.unavailable()
}
