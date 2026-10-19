export type Capability = "tools" | "vision" | "reasoning" | "structured"
export type Readiness = "ready" | "unknown" | "unavailable"
export type AuthState = "authenticated" | "unauthenticated" | "unknown"
export type CapacityState = "available" | "exhausted" | "resetting" | "unknown"

export type CatalogModel = {
  providerID: string
  modelID: string
  sourceModelID?: string
  name?: string
  family?: string
  variant?: string
  capabilities?: Partial<Record<Capability, boolean>>
  context?: number
  priceInput?: number
  priceOutput?: number
  lane?: string
  readiness?: Readiness
  auth?: AuthState
  capacity?: CapacityState
  favorite?: boolean
  recent?: boolean
  recommended?: boolean
  harness?: boolean
}

export type PickerFilters = Partial<{
  provider: string
  capability: Capability
  minContext: number
  maxOutputPrice: number
  lane: string
  readiness: Readiness
  auth: AuthState
  query: string
}>

export type PickerGroup = { providerID: string; family: string; models: CatalogModel[] }

export function discoverModelsText(source: string): CatalogModel[] {
  try { return discoverModels(JSON.parse(stripJsonComments(source).replace(/,\s*([}\]])/g, "$1"))) } catch { return [] }
}

export function discoverModels(source: unknown): CatalogModel[] {
  const root = source && typeof source === "object" ? source as Record<string, unknown> : {}
  if (Array.isArray(root.models)) return root.models.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const m = item as Record<string, unknown>, key = typeof m.key === "string" ? m.key : ""
    const slash = key.indexOf("/")
      return slash > 0 ? [normalizeVariant({ providerID: key.slice(0, slash), modelID: typeof m.id === "string" ? m.id : key.slice(slash + 1), name: typeof m.name === "string" ? m.name : undefined, context: numberValue(m.context), priceInput: numberValue(m.costInput), priceOutput: numberValue(m.costOutput) })] : []
  })
  const providers = (root.providers && typeof root.providers === "object" ? root.providers : root) as Record<string, unknown>
  const result: CatalogModel[] = []
  for (const [providerID, rawProvider] of Object.entries(providers)) {
    if (!rawProvider || typeof rawProvider !== "object") continue
    const models = (rawProvider as Record<string, unknown>).models
    if (!models || typeof models !== "object") continue
    for (const [modelID, rawModel] of Object.entries(models as Record<string, unknown>)) {
      const m = rawModel && typeof rawModel === "object" ? rawModel as Record<string, unknown> : {}
      const limit = m.limit && typeof m.limit === "object" ? m.limit as Record<string, unknown> : {}
      const caps = m.capabilities && typeof m.capabilities === "object" ? m.capabilities as Record<string, unknown> : {}
      const base = normalizeVariant({
        providerID, modelID, name: typeof m.name === "string" ? m.name : modelID,
        family: typeof m.family === "string" ? m.family : familyOf(modelID),
        variant: typeof m.variant === "string" ? m.variant : variantOf(modelID),
        context: numberValue(m.context) ?? numberValue(limit.context),
        priceInput: numberValue(m.priceInput) ?? numberValue(recordOf(m.cost)?.input),
        priceOutput: numberValue(m.priceOutput) ?? numberValue(recordOf(m.cost)?.output),
        lane: typeof m.lane === "string" ? m.lane : undefined,
        readiness: m.readiness === "ready" || m.readiness === "unavailable" ? m.readiness : "unknown",
        auth: m.auth === "authenticated" || m.auth === "unauthenticated" ? m.auth : "unknown",
        capabilities: {
          tools: boolValue(m.tools) ?? boolValue(m.tool_call) ?? boolValue(caps.tools),
          vision: boolValue(m.vision) ?? boolValue(caps.vision),
          reasoning: boolValue(m.reasoning) ?? boolValue(caps.reasoning),
          structured: boolValue(m.structured) ?? boolValue(m.structured_output) ?? boolValue(caps.structured),
        },
      })
      result.push(base)
      const variantEntries: Array<[string, unknown]> = Array.isArray(m.variants)
        ? (m.variants as unknown[]).flatMap((entry) => { const row = recordOf(entry); return row && typeof row.id === "string" ? [[row.id, row] as [string, unknown]] : [] })
        : Object.entries(recordOf(m.variants) ?? {})
      for (const [variant, rawVariant] of variantEntries) {
        const details = recordOf(rawVariant) ?? {}
        result.push({ ...base, variant, name: typeof details.name === "string" ? details.name : base.name })
      }
    }
  }
  return result
}

export function filterModels(models: CatalogModel[], filters: PickerFilters = {}) {
  const q = filters.query?.trim().toLowerCase()
  const qSpaced = q?.replace(/[-_]+/g, " ")
  return models.filter((m) => {
    if (filters.provider && m.providerID !== filters.provider) return false
    if (filters.capability && m.capabilities?.[filters.capability] !== true) return false
    if (filters.minContext != null && (m.context ?? 0) < filters.minContext) return false
    if (filters.maxOutputPrice != null && (m.priceOutput ?? Infinity) > filters.maxOutputPrice) return false
    if (filters.lane && m.lane !== filters.lane) return false
    if (filters.readiness && m.readiness !== filters.readiness) return false
    if (filters.auth && m.auth !== filters.auth) return false
    if (!q) return true
    const hay = `${m.providerID}/${m.modelID} ${m.name ?? ""} ${m.family ?? ""} ${m.variant ?? ""}`.toLowerCase()
    return hay.includes(q) || hay.replace(/[-_]+/g, " ").includes(qSpaced!)
  })
}

export function buildPicker(models: CatalogModel[], filters: PickerFilters = {}) {
  const visible = filterModels(models, filters)
  const featured = (flag: "favorite" | "recent" | "recommended") => visible.filter((m) => m[flag])
  const all = visible.filter((m) => !m.harness)
  const groups = new Map<string, PickerGroup>()
  for (const model of all) {
    const key = `${model.providerID}\0${model.family ?? familyOf(model.modelID)}`
    const group = groups.get(key) ?? { providerID: model.providerID, family: model.family ?? familyOf(model.modelID), models: [] }
    group.models.push(model); groups.set(key, group)
  }
  return { favorites: featured("favorite").filter((m) => !m.harness), recent: featured("recent").filter((m) => !m.harness), recommended: featured("recommended").filter((m) => !m.harness), harnesses: visible.filter((m) => m.harness), groups: [...groups.values()] }
}

export function exactIdentity(model: CatalogModel) { return `${model.providerID}/${model.modelID}${model.variant ? ` [variant=${model.variant}]` : ""}` }
export function familyOf(id: string) { return id.replace(/[-_](?:fast|pro|mini|thinking|reasoning|preview|latest)$/i, "").split(/[-_]/)[0] || id }
export function variantOf(id: string) {
  if (/^gpt-5\.6-luna-fast$/i.test(id)) return
  return id.match(/(?:fast|pro|mini|thinking|reasoning|preview|latest)$/i)?.[0]
}

export type ModelRef = { providerID: string; modelID: string }
export type CostLane = "go-quota" | "sub" | "free" | "metered"

export function splitProviderModel(ref: string): ModelRef | undefined {
  const trimmed = String(ref ?? "").trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) }
}

export function canonicalModelID(ref: string): string {
  const trimmed = String(ref ?? "").trim().toLowerCase()
  if (!trimmed) return ""
  const parts = trimmed.split("/")
  return parts[parts.length - 1] ?? ""
}

export function slugModel(value: string): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

export function isForbiddenXai(ref: string): boolean {
  return /(?:^|\/)(?:xai|x-ai)(?:\/|$)/i.test(String(ref ?? ""))
}

export function overlayProviderLane(providerID: string): CostLane | undefined {
  const p = String(providerID ?? "").toLowerCase()
  if (p === "opencode-go") return "go-quota"
  if (p === "opencode") return "free"
  if (p === "openrouter" || p === "xai" || p === "x-ai") return "metered"
}

function numberValue(v: unknown) { return typeof v === "number" && Number.isFinite(v) ? v : undefined }
function boolValue(v: unknown) { return typeof v === "boolean" ? v : undefined }
function recordOf(v: unknown): Record<string, unknown> | undefined { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined }
function normalizeVariant(model: CatalogModel): CatalogModel {
  const match = model.modelID.match(/^(gpt-5\.6-luna)-(none|low|medium|high|xhigh|max)(-fast)?$/i)
  if (!match) return model
  return { ...model, modelID: match[1], sourceModelID: model.modelID, variant: match[2].toLowerCase() + (match[3] ? "-fast" : "") }
}
function stripJsonComments(source: string) {
  let out = "", quote = false, escaped = false, line = false, block = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i], n = source[i + 1]
    if (line) { if (c === "\n") { line = false; out += c }; continue }
    if (block) { if (c === "*" && n === "/") { block = false; i++ }; continue }
    if (quote) { out += c; if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quote = false; continue }
    if (c === '"') { quote = true; out += c; continue }
    if (c === "/" && n === "/") { line = true; i++; continue }
    if (c === "/" && n === "*") { block = true; i++; continue }
    out += c
  }
  return out
}
