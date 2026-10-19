import { gapPrice } from "./price-book"
export type Tokens = { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null; reasoning: number | null }
export type TokenSemantics = { inputIncludesCache: boolean; outputIncludesReasoning: boolean }
export function normalizeTokens(raw: Partial<Tokens>, semantics: TokenSemantics): Tokens {
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
  const result: Tokens = { input: n(raw.input), output: n(raw.output), reasoning: n(raw.reasoning), cacheRead: n(raw.cacheRead), cacheWrite: n(raw.cacheWrite) }
  if (semantics.inputIncludesCache) result.input = result.input === null || result.cacheRead === null || result.cacheWrite === null ? null : result.input - result.cacheRead - result.cacheWrite
  if (semantics.outputIncludesReasoning) result.output = result.output === null || result.reasoning === null ? null : result.output - result.reasoning
  if (result.input !== null && result.input < 0 || result.output !== null && result.output < 0) throw new Error("Inconsistent token counters")
  return result
}
export type RequestRole = "giver" | "worker" | "jev" | "router" | "other"
export type PriceSource = "host-catalog" | "price-book" | "fallback-row" | "owner-catalog"
export type Price = { version: string; provider: string; model: string; date: string; currency: string; perMillion: Partial<Record<keyof Tokens, number>>; contextAbove?: number; longContext?: Partial<Record<keyof Tokens, number>>; tiers?: { above: number; perMillion: Partial<Record<keyof Tokens, number>> }[] }
export type RequestRecord = {
  failure?: "model-unavailable" | "rate-limited"
  limitWindow?: "allowance" | "balance"
  limitResetAt?: string
  windowResetAt?: string
  response?:{ status: number; at: number; retryAfterSeconds: number | null; limits?: Partial<Record<"requests" | "tokens" | "inputTokens" | "outputTokens", { limit: number | null; remaining: number | null; resetAt: string | null }>> }
  source?: "bench"
  id: string; sessionID: string; parentID?: string; questID?: string; accountID?: string; accountRegime?: string
  route: { providerID: string; modelID: string; reasoning?: string; variant?: string; serviceTier?: string; harness?: string }
  kind: string; retries?: number; recordedAt?: number; startedAt: number; firstResponseAt?: number; firstVisibleAt?: number; lastOutputAt?: number; completedAt?: number
  state: "running" | "completed" | "failed" | "interrupted" | "error"; tokens: Tokens; outputTotal?: number; price?: Price; actualCharge?: { value: number; currency: string }
  role?: RequestRole | null; runID?: string | null; stepID?: string | null; errorName?: string | null; elapsedMs?: number
  cost?: { listUSD: number | null; planUSD: number | null; priceSource: PriceSource | null }
  overheadMs?: { beforeSend: number; afterResponse: number | null }
  capture?: {mediaType:string;framing:"sse"|"json-or-unknown";parsedPayloads:number;usagePayloads:number;parseFailures:number;truncatedBuffers:number}
  request?: { observedAt:number; envelopeBytes:number; messageCount:number; inputItemCount:number; toolDefinitionCount:number; systemInstructionCount:number; prefix?:{tools:string[];system:string[];tokens?:{tools:number[];system:number[]}}; cacheKeyed?:true; sessionAffinity?:true; instructionRevision?:number; instructionRevisionObservedAt?:number; instructionEventCreatedAt?:number; correlation?:"session-revision-snapshot" }
  context?: { tokens: number; source: "host" | "provider" | "tokenizer-estimate"; at: number; missingComponents?: string[] }
  composition?: import("./request-composition").Composition
}
export type TelemetryFilter = { sessionID?: string; questID?: string; accountID?: string; from?: number; to?: number; includeWorkers?: boolean }
export const isProductionRequest = (request: RequestRecord) => request.source !== "bench"
export const requestPrice = (request: RequestRecord) => request.price ?? gapPrice(request)
export function requestRates(request: RequestRecord) {
  const p = requestPrice(request), t = request.tokens, input = t.input === null || t.cacheRead === null || t.cacheWrite === null ? null : t.input + t.cacheRead + t.cacheWrite
  const tier = input === null ? undefined : p?.tiers?.filter(t => input > t.above).sort((a,b) => b.above-a.above)[0]
  return { input, rates: p ? tier?.perMillion ?? (p.contextAbove !== undefined && input !== null && input > p.contextAbove ? p.longContext : p.perMillion) : undefined }
}
export function valueRequest(request: RequestRecord) {
  const p = requestPrice(request)
  if (!p) return { value: null, currency: null, complete: false, missing: ["price schedule"] }
  const t = request.tokens, { input, rates } = requestRates(request)
  const missing: string[] = []; let value = 0
  if ((p.contextAbove !== undefined || p.tiers?.length) && input === null) missing.push("context tier")
  const combinedOutput = outputIncludingReasoning(request)
  const combinedPricing = (t.output === null || t.reasoning === null) && combinedOutput !== null && typeof rates?.output === "number" && rates.output === rates.reasoning
  if (combinedPricing) value += combinedOutput! * rates!.output! / 1e6
  for (const key of Object.keys(t) as (keyof Tokens)[]) {
    if (combinedPricing && (key === "output" || key === "reasoning")) continue
    const count = t[key], rate = rates?.[key]
    if (count === null) missing.push(key + " tokens")
    else if (count !== 0 && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)) missing.push(key + " price")
    else if (count && rate !== undefined) value += count * rate / 1e6
  }
  return { value: missing.length ? null : value, currency: p.currency, complete: !missing.length, missing, reference: { provider: p.provider, model: p.model, date: p.date, version: p.version } }
}
type Counted = Pick<RequestRecord, "tokens" | "outputTotal">
export function outputIncludingReasoning(r: Counted): number | null {
  return r.outputTotal ?? (r.tokens.output !== null && r.tokens.reasoning !== null ? r.tokens.output + r.tokens.reasoning : null)
}
export function knownTokenTotal(r: Counted): number {
  const t = r.tokens
  return (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) + (r.outputTotal ?? (t.output ?? 0) + (t.reasoning ?? 0))
}
export function requestTiming(r: RequestRecord) {
  const duration = (end?: number, start?: number) => end !== undefined && start !== undefined && end >= start ? end - start : null
  const generationMilliseconds = duration(r.lastOutputAt, r.firstVisibleAt)
  return { elapsedMilliseconds: duration(r.completedAt, r.startedAt), firstVisibleMilliseconds: duration(r.firstVisibleAt, r.startedAt), generationMilliseconds,
    visibleOutputTokensPerSecond: generationMilliseconds !== null && generationMilliseconds > 0 && r.tokens.output !== null ? r.tokens.output / (generationMilliseconds / 1000) : null }
}
export function aggregateTelemetry(records: RequestRecord[], filter: TelemetryFilter = {}) {
  const unique = [...new Map(records.map(r => [r.id, r])).values()]
  const sessions = new Set(filter.sessionID ? [filter.sessionID] : [])
  if (filter.sessionID && filter.includeWorkers) {
    let changed = true
    while (changed) { changed = false; for (const r of unique) if (r.parentID && sessions.has(r.parentID) && !sessions.has(r.sessionID)) { sessions.add(r.sessionID); changed = true } }
  }
  const rows = unique.filter(r => (!filter.sessionID || sessions.has(r.sessionID)) && (!filter.questID || r.questID === filter.questID) && (!filter.accountID || r.accountID === filter.accountID) && (filter.from === undefined || r.startedAt >= filter.from) && (filter.to === undefined || r.startedAt <= filter.to))
  const totals: Tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, missing: Record<string, number> = {}
  const values: Record<string, { knownValue: number; unavailableRequests: number }> = {}, charges: Record<string, number> = {}
  for (const r of rows) {
    for (const key of Object.keys(totals) as (keyof Tokens)[]) if (r.tokens[key] === null) missing[key] = (missing[key] ?? 0) + 1; else totals[key]! += r.tokens[key]!
    const value = valueRequest(r), currency = value.currency ?? "unknown"
    const bucket = values[currency] ??= { knownValue: 0, unavailableRequests: 0 }
    if (value.value === null) bucket.unavailableRequests++; else bucket.knownValue += value.value
    if (r.actualCharge) charges[r.actualCharge.currency] = (charges[r.actualCharge.currency] ?? 0) + r.actualCharge.value
  }
  const intervals = rows.filter(r => r.completedAt !== undefined).map(r => [r.startedAt, r.completedAt!] as [number,number]).sort((a,b) => a[0]-b[0])
  let activeMilliseconds = 0, end = -Infinity
  for (const [start, finish] of intervals) { activeMilliseconds += Math.max(0, finish - Math.max(start,end)); end = Math.max(end,finish) }
  const contexts = rows.filter(r => r.context && ["primary", "chat"].includes(r.kind)).map(r => ({ sessionID: r.sessionID, ...r.context! })).sort((a,b) => a.at-b.at)
  const chronological = [...rows].sort((a,b)=>a.startedAt-b.startedAt), latest = chronological.at(-1)
  const compactions = chronological.filter(r=>r.kind==="compaction").map(r=>({requestID:r.id,sessionID:r.sessionID,startedAt:r.startedAt,completedAt:r.completedAt,state:r.state,activation:"unverified" as const,tokens:r.tokens,timing:requestTiming(r),value:valueRequest(r)}))
  return { filter, compactions, latestRequest: latest ? {id:latest.id,route:latest.route,timing:requestTiming(latest)} : null, requests: rows.length, tokens: { knownTotals: totals, missingRequests: missing, outputIncludingReasoning: { knownTotal: rows.reduce((n,r) => n + (outputIncludingReasoning(r) ?? 0), 0), missingRequests: rows.filter(r => outputIncludingReasoning(r) === null).length } }, apiEquivalent: values, actualCharges: charges,
    timing: { summedRequestMilliseconds: intervals.reduce((n,[s,e]) => n + e-s,0), activeMilliseconds, wallMilliseconds: intervals.length ? Math.max(...intervals.map(x=>x[1])) - intervals[0][0] : null },
    context: { current: contexts.filter(c => !filter.sessionID || c.sessionID === filter.sessionID).at(-1) ?? null, history: contexts },
    requestHistory: [...rows].sort((a,b) => a.startedAt-b.startedAt).map(r => ({ id:r.id, sessionID:r.sessionID, route:r.route, kind:r.kind, request:r.request, context:r.context, capture:r.capture, startedAt:r.startedAt, state:r.state, tokens:r.tokens, timing:requestTiming(r), value:valueRequest(r) })) }
}

export function observedWindowRate(input:{before:number;after:number;beforeAt:number;afterAt:number;resetAt:number;beforeResetAt:number}) {
 const {before,after,beforeAt,afterAt,resetAt,beforeResetAt}=input
 if(Object.values(input).some(v=>!Number.isFinite(v))||before<0||after>100||after<=before||afterAt<=beforeAt||resetAt<=afterAt||Math.abs(resetAt-beforeResetAt)>2000)return null
 const pointsPerMinute=(after-before)/(afterAt-beforeAt)*60000
 return {pointsPerMinute,secondsToExhaustion:(100-after)/pointsPerMinute*60,resetAt,basis:"observed-percentage-delta" as const}
}
