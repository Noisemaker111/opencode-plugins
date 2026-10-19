import type { RequestRecord } from "./telemetry"
import { delayMsOf } from "../quest/core/backoff"
import { Duration, Schedule } from "effect"

export type LimitKind = "requests" | "tokens" | "inputTokens" | "outputTokens"
export type HeaderLimit = { limit: number | null; remaining: number | null; resetAt: string | null }
export type RouteRefusal = { at: string; status: number; retryAfterSeconds: number | null }
export type LearnedLimit = { hitRequestsPerHour: number; safeRequestsPerHour: number; hits: number }
export const FAILURE_KINDS = ["rate-limited", "error", "timeout", "empty"] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]
export type OutcomeCode = "ok" | FailureKind
export type RouteTotals = { requests: number; ok: number; failed: number; kinds: Partial<Record<FailureKind, number>> }
export type RouteDecay = { ok: number; failed: number; at: string }
export type WaitClass = "reset" | "burst" | "allowance" | "balance"
export type LimitWindow = "allowance" | "balance"
export type RouteDemotion = { since: string; until: string; kind: FailureKind; reason: string; wait: WaitClass; stopped?: { sessionID: string; at: string }; balanceUSD?: number; awaiting?: boolean }
export type RouteLimitState = { route: string; headers: Partial<Record<LimitKind, HeaderLimit>>; headersObservedAt: string | null; refusals: RouteRefusal[]; blockedUntil: string | null; lastAnsweredAt: string | null; lastSuccessAt?: string; learned?: LearnedLimit; outcomes?: OutcomeCode[]; totals?: RouteTotals; decayed?: RouteDecay; demotion?: RouteDemotion; cooldownMs?: number }
export type ProviderOutage = { provider: string; since: string; until: string; reason: string; cooldownMs: number; probe: string; routes: string[] }
export type OutageEvent = { at: number; event: "down" | "probe-failed" | "up" | "provider-down" | "provider-up"; route?: string; provider?: string; kind?: FailureKind; reason?: string; until?: string; cooldownMs?: number }
export type RouteLimitsRecord = { version: 1; routes: Record<string, RouteLimitState>; providers?: Record<string, ProviderOutage> }
export type HealthRow = Pick<RequestRecord, "route" | "startedAt" | "state" | "failure" | "firstResponseAt" | "tokens" | "response" | "limitResetAt" | "windowResetAt"> & { limitWindow?: LimitWindow }
export type ResponseObservation = NonNullable<RequestRecord["response"]>
export type HealthMaps = { routes: Map<string, RouteLimitState>; providers: Map<string, ProviderOutage> }
export type Availability = { state: "up" | "cooling" | "probing" | "out"; until: string | null; reason: string | null; cls: WaitClass | null }

export const ROUTE_REFUSAL_HISTORY = 20
export const ROUTE_HEALTH = { consecutiveFailures: 3, windowRequests: 10, failureShare: 0.3, minimumShareSample: 5, keepOutcomes: 20, burstStartMs: 30_000, burstCapMs: 15 * 60_000, allowanceRetryMs: 30 * 60_000, providerWindowMs: 30 * 60_000, providerRoutes: 2, trialRequests: 3, halfLifeMs: 6 * 3_600_000, balanceCheckMs: 5 * 60_000 } as const
const SAFE_SHARE = 0.8
const HOUR_MS = 3_600_000
export const routeLimitKey = (providerID: string, modelID: string) => providerID + "/" + modelID
const providerOf = (key: string) => key.slice(0, key.indexOf("/"))
export const rateLimitError = (error: unknown) => /rate.?limit|too many requests|\bquota\b|(limit|allowance|credits?|capacity)\s+(is\s+)?exhausted/i.test(typeof error === "string" ? error : JSON.stringify(error ?? ""))
export const limitWindowOf = (error: unknown): LimitWindow | undefined => {
  const text = typeof error === "string" ? error : JSON.stringify(error ?? "")
  if (/balance|insufficient (funds|credits?)|credits? (exhausted|depleted|too low|required)/i.test(text)) return "balance"
  return /\b(daily|weekly|monthly|5[- ]?hour|five[- ]hour|hourly)\b|allowance|usage (limit|cap)/i.test(text) ? "allowance" : undefined
}

const UNIT_MS: Record<string, number> = { ms: 1, millisecond: 1, milliseconds: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000 }
export function resetFromText(text: string, now: number): number | null {
  const relative = /(?:try again|retry|resets?|available|wait)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(text)
  if (relative) return now + Number(relative[1]) * UNIT_MS[relative[2].toLowerCase()]
  const asked = /retry[_-]?after["'\s:]+(\d+(?:\.\d+)?)\b/i.exec(text)
  if (asked) return now + Number(asked[1]) * 1000
  const absolute = /(?:resets?|try again|retry|available again)\s+(?:at|on)?\s*:?\s*["']?(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text)
  if (absolute) { const at = Date.parse(absolute[1]); return Number.isFinite(at) ? at : null }
  return null
}
export const isFailure = (code: OutcomeCode) => code !== "ok"
export const outcomeCodeOfStatus = (status: number): OutcomeCode => status === 429 ? "rate-limited" : status >= 200 && status < 300 ? "ok" : "error"
export function outcomeCodeOfRecord(record: HealthRow): OutcomeCode | undefined {
  if (record.state !== "failed" && record.state !== "completed") return undefined
  if (record.failure === "rate-limited") return "rate-limited"
  if (record.state === "failed") return record.firstResponseAt === undefined ? "timeout" : "error"
  return record.tokens.output === 0 ? "empty" : "ok"
}
const codeOf = (row: HealthRow): OutcomeCode => row.response ? outcomeCodeOfStatus(row.response.status) : outcomeCodeOfRecord(row) ?? "error"
const healthTime = (row: HealthRow) => row.response?.at ?? row.firstResponseAt ?? row.startedAt

export type HealthVerdict = { unhealthy: false } | { unhealthy: true; kind: FailureKind; reason: string }

function countKinds(codes: OutcomeCode[]) {
  const counts = new Map<FailureKind, number>()
  for (const code of codes) if (isFailure(code)) counts.set(code as FailureKind, (counts.get(code as FailureKind) ?? 0) + 1)
  return counts
}
const describeKinds = (codes: OutcomeCode[]) => [...countKinds(codes)].map(([kind, n]) => n + " " + kind).join(", ")
function dominantKind(codes: OutcomeCode[]): FailureKind {
  const latest = [...codes].reverse().find(isFailure) as FailureKind | undefined
  return [...countKinds(codes)].sort((a, b) => b[1] - a[1] || (a[0] === latest ? -1 : b[0] === latest ? 1 : 0))[0]?.[0] ?? latest ?? "error"
}

export function healthVerdict(codes: OutcomeCode[], settings: typeof ROUTE_HEALTH = ROUTE_HEALTH): HealthVerdict {
  let run = 0
  for (let i = codes.length - 1; i >= 0 && isFailure(codes[i]); i--) run++
  if (run >= settings.consecutiveFailures) {
    const trailing = codes.slice(codes.length - run)
    return { unhealthy: true, kind: dominantKind(trailing), reason: run + " consecutive requests failed (" + describeKinds(trailing) + ")" }
  }
  const window = codes.slice(-settings.windowRequests), failed = window.filter(isFailure)
  if (window.length >= settings.minimumShareSample && failed.length / window.length > settings.failureShare)
    return { unhealthy: true, kind: dominantKind(failed), reason: failed.length + " of the last " + window.length + " requests failed (" + Math.round(100 * failed.length / window.length) + "%: " + describeKinds(failed) + ")" }
  return { unhealthy: false }
}

export const unhealthyText = (reason: string, until: string) => "Unhealthy: " + reason + "; not routed to until " + until + ", then a synthetic probe decides"

export function addOutcome(totals: RouteTotals | undefined, code: OutcomeCode): RouteTotals {
  const next: RouteTotals = { requests: (totals?.requests ?? 0) + 1, ok: (totals?.ok ?? 0) + (isFailure(code) ? 0 : 1), failed: (totals?.failed ?? 0) + (isFailure(code) ? 1 : 0), kinds: { ...(totals?.kinds ?? {}) } }
  if (isFailure(code)) next.kinds[code as FailureKind] = (next.kinds[code as FailureKind] ?? 0) + 1
  return next
}

export function decayedCounts(prior: RouteDecay | undefined, now: number): { ok: number; failed: number } {
  if (!prior) return { ok: 0, failed: 0 }
  const age = Math.max(0, now - Date.parse(prior.at)), factor = Number.isFinite(age) ? 0.5 ** (age / ROUTE_HEALTH.halfLifeMs) : 1
  return { ok: prior.ok * factor, failed: prior.failed * factor }
}
export function decayedSuccessRate(decay: RouteDecay | undefined, now = Date.now()): number | null {
  const counts = decayedCounts(decay, now)
  return counts.ok + counts.failed > 0 ? counts.ok / (counts.ok + counts.failed) : null
}

const HEADER_NAMES: Record<LimitKind, { limit: string[]; remaining: string[]; reset: string[] }> = {
  requests: { limit: ["anthropic-ratelimit-requests-limit", "x-ratelimit-limit-requests", "x-ratelimit-limit"], remaining: ["anthropic-ratelimit-requests-remaining", "x-ratelimit-remaining-requests", "x-ratelimit-remaining"], reset: ["anthropic-ratelimit-requests-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset"] },
  tokens: { limit: ["anthropic-ratelimit-tokens-limit", "x-ratelimit-limit-tokens"], remaining: ["anthropic-ratelimit-tokens-remaining", "x-ratelimit-remaining-tokens"], reset: ["anthropic-ratelimit-tokens-reset", "x-ratelimit-reset-tokens"] },
  inputTokens: { limit: ["anthropic-ratelimit-input-tokens-limit"], remaining: ["anthropic-ratelimit-input-tokens-remaining"], reset: ["anthropic-ratelimit-input-tokens-reset"] },
  outputTokens: { limit: ["anthropic-ratelimit-output-tokens-limit"], remaining: ["anthropic-ratelimit-output-tokens-remaining"], reset: ["anthropic-ratelimit-output-tokens-reset"] },
}

const first = (headers: Headers, names: string[]) => { for (const name of names) { const value = headers.get(name); if (value !== null && value.trim()) return value.trim() } return undefined }
const count = (value?: string) => { if (value === undefined) return null; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null }

export function resetTime(value: string | undefined, now: number): number | null {
  if (value === undefined) return null
  if (/^\d+(\.\d+)?$/.test(value)) {
    const n = Number(value)
    return n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000
  }
  const duration = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(value)
  if (duration && duration.slice(1).some(Boolean)) {
    const [, h, m, s, ms] = duration.map(part => Number(part ?? 0))
    return now + h * 3_600_000 + m * 60_000 + s * 1000 + ms
  }
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

export function retryAfterSeconds(headers: Headers, now: number): number | null {
  const ms = count(headers.get("retry-after-ms") ?? undefined)
  if (ms !== null) return Math.ceil(ms / 1000)
  const value = headers.get("retry-after")?.trim()
  if (!value) return null
  const at = resetTime(value, now)
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000))
}

export function headerLimits(headers: Headers, now: number): Partial<Record<LimitKind, HeaderLimit>> {
  const out: Partial<Record<LimitKind, HeaderLimit>> = {}
  for (const [kind, names] of Object.entries(HEADER_NAMES) as [LimitKind, typeof HEADER_NAMES[LimitKind]][]) {
    const limit = count(first(headers, names.limit)), remaining = count(first(headers, names.remaining)), reset = resetTime(first(headers, names.reset), now)
    if (limit === null && remaining === null && reset === null) continue
    out[kind] = { limit, remaining, resetAt: reset === null ? null : new Date(reset).toISOString() }
  }
  return out
}

export function responseObservation(status: number, headers: Headers, at: number): ResponseObservation {
  const limits = headerLimits(headers, at)
  return { status, at, retryAfterSeconds: status === 429 ? retryAfterSeconds(headers, at) : null, ...(Object.keys(limits).length ? { limits } : {}) }
}

const latest = (...times: (number | null)[]) => { const known = times.filter((t): t is number => t !== null && Number.isFinite(t)); return known.length ? Math.max(...known) : null }
const learnLimit = (prior: LearnedLimit | undefined, requestsPerHour: number): LearnedLimit => {
  const hit = Math.min(prior?.hitRequestsPerHour ?? Infinity, requestsPerHour)
  return { hitRequestsPerHour: hit, safeRequestsPerHour: Math.max(1, Math.floor(hit * SAFE_SHARE)), hits: (prior?.hits ?? 0) + 1 }
}
export const emptyState = (key: string): RouteLimitState => ({ route: key, headers: {}, headersObservedAt: null, refusals: [], blockedUntil: null, lastAnsweredAt: null })
export const blocked = (state: RouteLimitState, now: number) => !!state.blockedUntil && Date.parse(state.blockedUntil) > now
const probing = (state: RouteLimitState, now: number) => !!state.demotion && Date.parse(state.demotion.until) <= now && !blocked(state, now)
const isDown = (state: RouteLimitState, now: number) => !!state.demotion || blocked(state, now)

export const burstBackoff: Schedule.Schedule<number, void> = Schedule.min([
  Schedule.exponential(Duration.millis(ROUTE_HEALTH.burstStartMs)),
  Schedule.spaced(Duration.millis(ROUTE_HEALTH.burstCapMs)),
])
export const backoffMs = (attempt: number): number => delayMsOf(burstBackoff, attempt)
const trailingRateLimits = (codes: OutcomeCode[]) => { let n = 0; for (let i = codes.length - 1; i >= 0 && codes[i] === "rate-limited"; i--) n++; return n }
export function waitOf(prior: Pick<RouteLimitState, "cooldownMs">, now: number, signal: number | null, window: LimitWindow | undefined, failedProbe: boolean, rateStreak: number, windowReset: number | null = null): { until: number; cooldownMs: number; cls: WaitClass } {
  if (signal !== null) return { until: signal, cooldownMs: prior.cooldownMs ?? ROUTE_HEALTH.burstStartMs, cls: "reset" }
  if (window) {
    const learned = window === "allowance" && !failedProbe && windowReset !== null && windowReset > now ? windowReset : now + ROUTE_HEALTH.allowanceRetryMs
    return { until: learned, cooldownMs: ROUTE_HEALTH.allowanceRetryMs, cls: window }
  }
  const cooldownMs = rateStreak > 0 ? backoffMs(rateStreak) : failedProbe ? Math.min(ROUTE_HEALTH.burstCapMs, 2 * (prior.cooldownMs ?? ROUTE_HEALTH.burstStartMs)) : prior.cooldownMs ?? ROUTE_HEALTH.burstStartMs
  return { until: now + cooldownMs, cooldownMs, cls: "burst" }
}

export function applyRow(prior: RouteLimitState, key: string, row: HealthRow, requestsBefore: number): RouteLimitState {
  const now = healthTime(row), response = row.response, limits = response?.limits ?? {}, code = codeOf(row)
  const refused = response ? response.status === 429 : row.failure === "rate-limited", wait = refused ? response?.retryAfterSeconds ?? null : null
  const resets = Object.values(limits).map(limit => limit.resetAt ? Date.parse(limit.resetAt) : NaN).filter(at => at > now)
  const stated = row.limitResetAt ? Date.parse(row.limitResetAt) : NaN, learnedReset = row.windowResetAt ? Date.parse(row.windowResetAt) : NaN
  const signal = refused ? (wait !== null ? now + wait * 1000 : resets.length ? Math.min(...resets) : stated > now ? stated : null) : null
  const exhausted = Object.values(limits).filter(limit => limit.remaining === 0 && limit.resetAt).map(limit => Date.parse(limit.resetAt!)).filter(at => at > now)
  const priorBlock = refused && prior.blockedUntil && Date.parse(prior.blockedUntil) > now ? Date.parse(prior.blockedUntil) : null
  const rateStreak = refused ? trailingRateLimits(prior.outcomes ?? []) + 1 : 0
  const refusalWait = refused && signal === null && !row.limitWindow ? backoffMs(rateStreak) : null
  const until = latest(signal, priorBlock, ...exhausted, refusalWait === null ? null : now + refusalWait)
  const learned = refused && requestsBefore > 0 ? learnLimit(prior.learned, requestsBefore) : prior.learned
  const restored = !!prior.demotion && code === "ok"
  const probe = !restored && !!prior.demotion && probing(prior, now)
  const outcomes = [...(restored ? [] : prior.outcomes ?? []), code].slice(-ROUTE_HEALTH.keepOutcomes)
  const verdict = healthVerdict(outcomes)
  const failedProbe = probe && verdict.unhealthy
  const waited = waitOf(prior, now, signal, row.limitWindow, failedProbe, rateStreak, Number.isFinite(learnedReset) ? learnedReset : null)
  const holdUntil = prior.demotion && !probe && !restored ? Date.parse(prior.demotion.until) : null
  const demotedUntil = verdict.unhealthy ? holdUntil ?? waited.until : null
  const cooldownMs = restored ? undefined : verdict.unhealthy ? waited.cooldownMs : prior.cooldownMs
  const demotion: RouteDemotion | undefined = verdict.unhealthy && demotedUntil !== null ? { since: prior.demotion && !restored ? prior.demotion.since : new Date(now).toISOString(), until: new Date(demotedUntil).toISOString(), kind: verdict.kind, reason: verdict.reason, wait: waited.cls, ...(prior.demotion?.stopped && !restored ? { stopped: prior.demotion.stopped } : {}) } : undefined
  const decay = decayedCounts(prior.decayed, now)
  return {
    route: key,
    headers: Object.keys(limits).length ? { ...prior.headers, ...limits } : prior.headers,
    headersObservedAt: Object.keys(limits).length ? new Date(now).toISOString() : prior.headersObservedAt,
    refusals: refused ? [...prior.refusals, { at: new Date(now).toISOString(), status: 429, retryAfterSeconds: wait }].slice(-ROUTE_REFUSAL_HISTORY) : prior.refusals,
    blockedUntil: until === null ? null : new Date(until).toISOString(),
    lastAnsweredAt: refused ? prior.lastAnsweredAt : new Date(now).toISOString(),
    ...(code === "ok" ? { lastSuccessAt: new Date(now).toISOString() } : prior.lastSuccessAt ? { lastSuccessAt: prior.lastSuccessAt } : {}),
    ...(learned ? { learned } : {}),
    outcomes,
    totals: addOutcome(prior.totals, code),
    decayed: { ok: decay.ok + (isFailure(code) ? 0 : 1), failed: decay.failed + (isFailure(code) ? 1 : 0), at: new Date(now).toISOString() },
    ...(demotion ? { demotion } : {}),
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
  }
}

function transition(key: string, prior: RouteLimitState, next: RouteLimitState, now: number): OutageEvent[] {
  const detail = (state: RouteLimitState) => state.demotion ? { kind: state.demotion.kind, reason: state.demotion.reason, until: state.demotion.until } : { kind: "rate-limited" as const, reason: "rate limited", until: state.blockedUntil ?? undefined }
  const wasDown = isDown(prior, now), down = isDown(next, now)
  if (!wasDown && down) return [{ at: now, event: "down", route: key, ...detail(next) }]
  if (wasDown && !down) return [{ at: now, event: "up", route: key }]
  if (down && probing(prior, now)) return [{ at: now, event: "probe-failed", route: key, ...detail(next), cooldownMs: next.cooldownMs ?? ROUTE_HEALTH.burstStartMs }]
  return []
}

function setDemotionUntil(state: HealthMaps, key: string, until: number): void {
  const route = state.routes.get(key)
  if (route?.demotion) state.routes.set(key, { ...route, demotion: { ...route.demotion, until: new Date(until).toISOString() } })
}

function restoreRoute(state: HealthMaps, key: string): void {
  const route = state.routes.get(key)
  if (route) state.routes.set(key, { ...route, outcomes: [], demotion: undefined, cooldownMs: undefined })
}

function settleProvider(state: HealthMaps, key: string, prior: RouteLimitState, next: RouteLimitState, row: HealthRow, now: number): OutageEvent[] {
  const provider = providerOf(key), code = codeOf(row), outage = state.providers.get(provider)
  if (outage) {
    if (outage.probe !== key) return []
    if (code === "ok") {
      state.providers.delete(provider)
      for (const member of outage.routes) if (member !== key) restoreRoute(state, member)
      return [{ at: now, event: "provider-up", provider }]
    }
    if (!isFailure(code) || !next.demotion || Date.parse(outage.until) > now) return []
    const rateLimited = next.demotion.kind === "rate-limited"
    const cooldownMs = rateLimited ? outage.cooldownMs : Math.min(ROUTE_HEALTH.burstCapMs, 2 * outage.cooldownMs)
    const until = rateLimited ? Date.parse(next.demotion.until) : now + cooldownMs
    state.providers.set(provider, { ...outage, until: new Date(until).toISOString(), cooldownMs })
    for (const member of outage.routes) setDemotionUntil(state, member, until)
    return [{ at: now, event: "probe-failed", provider, route: key, kind: next.demotion.kind, reason: next.demotion.reason, until: new Date(until).toISOString(), cooldownMs }]
  }
  if (!next.demotion || prior.demotion) return []
  const members = [...state.routes].filter(([member, route]) => providerOf(member) === provider && route.demotion && Date.parse(route.demotion.since) >= now - ROUTE_HEALTH.providerWindowMs)
  if (members.length < ROUTE_HEALTH.providerRoutes) return []
  members.sort(([aKey, a], [bKey, b]) => Date.parse(a.demotion!.since) - Date.parse(b.demotion!.since) || (aKey < bKey ? -1 : 1))
  const routes = members.map(([member]) => member)
  const until = Math.max(...members.map(([, route]) => Date.parse(route.demotion!.until)))
  const reason = routes.length + " routes failed together"
  const since = members[0][1].demotion!.since
  state.providers.set(provider, { provider, since, until: new Date(until).toISOString(), reason, cooldownMs: ROUTE_HEALTH.burstStartMs, probe: routes[0], routes })
  for (const member of routes) setDemotionUntil(state, member, until)
  return [{ at: now, event: "provider-down", provider, reason, until: new Date(until).toISOString(), cooldownMs: ROUTE_HEALTH.burstStartMs }]
}

export function applyHealthRow(state: HealthMaps, row: HealthRow, requestsBefore: number): { events: OutageEvent[]; changed: boolean } {
  const key = routeLimitKey(row.route.providerID, row.route.modelID), now = healthTime(row)
  const prior = state.routes.get(key) ?? emptyState(key)
  const next = applyRow(prior, key, row, requestsBefore)
  state.routes.set(key, next)
  const events = [...transition(key, prior, next, now), ...settleProvider(state, key, prior, next, row, now)]
  const kindChanged = (prior.demotion?.kind ?? null) !== (next.demotion?.kind ?? null) || blocked(prior, now) !== blocked(next, now)
  return { events, changed: events.length > 0 || kindChanged }
}

export const routeKeysOf = (saved: RouteLimitsRecord) => [...new Set([...Object.keys(saved.routes), ...Object.values(saved.providers ?? {}).flatMap(outage => outage.routes)])]

export function availabilityOf(key: string, now: number, saved: RouteLimitsRecord): Availability {
  const state = saved.routes[key], demotion = state?.demotion, blockedUntil = state?.blockedUntil ? Date.parse(state.blockedUntil) : NaN
  const outage = Object.values(saved.providers ?? {}).find(item => item.routes.includes(key))
  let status: Availability["state"] = "up", until: string | null = null, reason: string | null = demotion?.reason ?? null, cls: WaitClass | null = demotion?.wait ?? null
  if (demotion?.awaiting) { status = "out"; reason = demotion.reason + "; waits for the balance to change"; cls = "balance" }
  else if (blockedUntil > now) { status = "out"; until = state!.blockedUntil; reason ??= "rate limited"; cls = cls ?? "reset" }
  else if (demotion && Date.parse(demotion.until) > now) { status = "cooling"; until = demotion.until }
  else if (demotion) status = "probing"
  if (outage) {
    reason = "provider outage: " + outage.provider + " (" + outage.reason + ")"
    if (Date.parse(outage.until) > now) { status = "out"; until = outage.until }
    else if (outage.probe === key) status = "probing"
    else { status = "out"; until = null; reason += "; waiting for the one probe on " + outage.probe }
  }
  return { state: status, until, reason: status === "up" ? null : reason, cls: status === "up" ? null : cls }
}

export function observeRecord(record: RouteLimitsRecord, row: HealthRow, requestsBefore = 0): RouteLimitsRecord {
  const maps: HealthMaps = { routes: new Map(Object.entries(record.routes)), providers: new Map(Object.entries(record.providers ?? {})) }
  applyHealthRow(maps, row, requestsBefore)
  return { version: 1, routes: Object.fromEntries(maps.routes), ...(maps.providers.size ? { providers: Object.fromEntries(maps.providers) } : {}) }
}

export function notUpReason(availability: Availability): string | null {
  if (availability.state === "up") return null
  return "Not up (" + availability.state + "): " + availability.reason + (availability.until ? "; not before " + availability.until : "") + "; only a synthetic probe tries it"
}

export function updateBalanceHolds(routes: Map<string, RouteLimitState>, provider: string, remainingUSD: number, now: number): boolean {
  let changed = false
  for (const [key, state] of routes) {
    const demotion = state.demotion
    if (!demotion || demotion.wait !== "balance" || !key.startsWith(provider + "/")) continue
    if (demotion.balanceUSD === undefined) {
      routes.set(key, { ...state, demotion: { ...demotion, balanceUSD: remainingUSD, awaiting: true } })
      changed = true
    } else if (demotion.awaiting && remainingUSD > demotion.balanceUSD + 0.005) {
      routes.set(key, { ...state, demotion: { ...demotion, balanceUSD: remainingUSD, awaiting: false, until: new Date(now).toISOString() } })
      changed = true
    }
  }
  return changed
}
