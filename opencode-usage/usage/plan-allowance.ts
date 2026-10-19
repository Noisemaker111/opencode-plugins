import { Database } from "bun:sqlite"
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { openRouterKey } from "../models/jev-bridge"
import { discoveryPaths, readAccountUsage } from "../usage-service/on-computer"
import type { AccountUsage } from "../usage-service/index"
import { readQuotaObservations } from "./calibration-store"
import { freePools } from "./free-allowance"
import { responseObservation } from "./route-limits"
import type { RequestRecord } from "./telemetry"

const HOUR = 3_600_000
const MIN_USED_POINTS = 10
const AGREE_SPREAD = 0.25
const OPENROUTER_CREDITS = "https://openrouter.ai/api/v1/credits"
const CLAUDE_WINDOWS = [
  { id: "five_hour", label: "5h", ms: 5 * HOUR },
  { id: "seven_day", label: "weekly", ms: 7 * 24 * HOUR },
] as const
const LIMIT_TEXT = /(\d[\d,]*)\s+(requests?|tokens?|messages?)\b(?:[^.\n]*?\bper\s+(\d+\s+(?:minutes?|hours?|days?)))?/i
const UNIFIED = /^anthropic-ratelimit-unified-(5h|7d)-(status|reset|utilization)$/

export type Confidence = "none" | "low" | "medium"
export type UnifiedWindow = { status: string | null; utilization: number | null; resetAt: string | null }
export type UnifiedWindows = { "5h"?: UnifiedWindow; "7d"?: UnifiedWindow; claim?: string }
export type ResponseRecord = NonNullable<RequestRecord["response"]> & { windows?: UnifiedWindows }
export type UsageRow = { at: number; tokens: number; ok: boolean; cutOff: boolean }
export type WindowObservation = { at: number; usedPoints: number; resetAt: number | null }
export type SampleFit = { value: number | null; confidence: Confidence; samples: number; reason: string | null }
export type WindowEstimate = SampleFit & { observations: number; cutOffs: number }

export type Sources = {
  accountUsageFile?: string
  observationsFile?: string
  channelDir?: string
  openCodeDb?: string
  dataDirectory?: string
  env?: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
}

type Attempt = { route: string | null; provider: string | null; accountID: string | null; at: number; ok: boolean; cutOff: boolean; tokens: number; cost: number | null; response: ResponseRecord | undefined }

const iso = (at: number) => new Date(at).toISOString()

function resetOf(value: string): string | null {
  const number = value.trim() === "" ? NaN : Number(value)
  const at = Number.isFinite(number) ? (number < 1e11 ? number * 1000 : number) : Date.parse(value)
  return Number.isFinite(at) ? iso(at) : null
}

export function unifiedWindowsOf(headers: Headers): UnifiedWindows | undefined {
  const windows: UnifiedWindows = {}
  headers.forEach((value, name) => {
    const match = UNIFIED.exec(name)
    if (!match) return
    const window = windows[match[1] as "5h" | "7d"] ??= { status: null, utilization: null, resetAt: null }
    if (match[2] === "status") window.status = value
    else if (match[2] === "reset") window.resetAt = resetOf(value)
    else window.utilization = value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null
  })
  const claim = headers.get("anthropic-ratelimit-unified-representative-claim")
  if (claim) windows.claim = claim
  return Object.keys(windows).length ? windows : undefined
}

export function responseOf(status: number, headers: Headers, at: number): ResponseRecord {
  const observed = responseObservation(status, headers, at)
  const windows = unifiedWindowsOf(headers)
  return windows ? { ...observed, windows } : observed
}

const tokensBetween = (rows: UsageRow[], start: number, end: number) => rows.reduce((sum, row) => sum + (row.ok && row.at >= start && row.at <= end ? row.tokens : 0), 0)
const messagesBetween = (rows: UsageRow[], start: number, end: number) => rows.filter(row => row.ok && row.at >= start && row.at <= end).length

function fitSamples(samples: number[]): SampleFit {
  const n = samples.length
  if (n < 2) return { value: null, confidence: "none", samples: n, reason: "fewer than 2 samples" }
  const sorted = [...samples].sort((a, b) => a - b)
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  const spread = (sorted[n - 1] - sorted[0]) / median
  if (spread > AGREE_SPREAD) return { value: null, confidence: "none", samples: n, reason: "samples disagree by " + Math.round(spread * 100) + "%" }
  return { value: Math.round(median), confidence: n >= 4 ? "medium" : "low", samples: n, reason: null }
}

export function windowEstimate(durationMs: number, rows: UsageRow[], observations: WindowObservation[]): WindowEstimate {
  const latest = new Map<number, WindowObservation>()
  for (const observation of observations) {
    if (observation.resetAt === null) continue
    const kept = latest.get(observation.resetAt)
    if (!kept || observation.usedPoints > kept.usedPoints || (observation.usedPoints === kept.usedPoints && observation.at > kept.at)) latest.set(observation.resetAt, observation)
  }
  const samples: number[] = []
  let observed = 0
  for (const [resetAt, observation] of latest) {
    if (observation.usedPoints < MIN_USED_POINTS) continue
    const tokens = tokensBetween(rows, resetAt - durationMs, observation.at)
    if (tokens <= 0) continue
    samples.push(tokens / (observation.usedPoints / 100))
    observed++
  }
  const resets = [...latest.keys()]
  let cut = 0
  for (const row of rows) {
    if (!row.cutOff) continue
    const covering = resets.find(resetAt => resetAt - durationMs <= row.at && row.at < resetAt)
    const start = covering === undefined ? row.at - durationMs : covering - durationMs
    const tokens = tokensBetween(rows, start, row.at)
    if (tokens <= 0) continue
    samples.push(tokens)
    cut++
  }
  return { ...fitSamples(samples), observations: observed, cutOffs: cut }
}

function attemptOf(request: any): Attempt {
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0
  const tokens = request.tokens ?? {}
  const input = count(tokens.input), output = count(tokens.output), cacheRead = count(tokens.cacheRead), cacheWrite = count(tokens.cacheWrite)
  const ok = request.state === "completed"
  const per = request.price?.perMillion
  const cost = ok && per ? (input * count(per.input) + output * count(per.output) + cacheRead * count(per.cacheRead) + cacheWrite * count(per.cacheWrite)) / 1e6 : null
  const providerID = request.route?.providerID ?? null, modelID = request.route?.modelID ?? null
  return {
    route: providerID && modelID ? providerID + "/" + modelID : null,
    provider: providerID,
    accountID: typeof request.accountID === "string" ? request.accountID : null,
    at: request.startedAt,
    ok,
    cutOff: request.failure === "rate-limited" || request.response?.status === 429,
    tokens: input + output + cacheRead + cacheWrite,
    cost,
    response: request.response,
  }
}

function channelAttempts(channelDir: string): Attempt[] {
  if (!existsSync(channelDir)) return []
  const latest = new Map<string, any>()
  const seen = new Set<string>()
  for (const name of readdirSync(channelDir).sort()) {
    const link = join(channelDir, name, "requests.jsonl")
    if (!existsSync(link)) continue
    const file = realpathSync(link)
    if (seen.has(file)) continue
    seen.add(file)
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const request = line.trim() ? JSON.parse(line)?.request : undefined
        if (request?.id) latest.set(request.id, request)
      } catch {}
    }
  }
  return [...latest.values()].map(attemptOf)
}

type ErrorBody = { route: string; at: number; message: string }

function errorBodies(file: string): ErrorBody[] {
  if (!existsSync(file)) return []
  const db = new Database(file, { readonly: true })
  try {
    const rows = db.query(`select json_extract(data, '$.providerID') providerID, json_extract(data, '$.modelID') modelID, json_extract(data, '$.time.created') at, json_extract(data, '$.error.data.message') message from message where json_extract(data, '$.role') = 'assistant' and json_extract(data, '$.error') is not null`).all() as any[]
    return rows.filter(row => row.providerID && row.modelID && typeof row.message === "string").map(row => ({ route: row.providerID + "/" + row.modelID, at: row.at, message: row.message }))
  } finally {
    db.close()
  }
}

export type StatedLimit = { source: "headers" | "error body"; route: string; at: string; unit: string; limit: number; remaining?: number | null; resetAt?: string | null; window?: string | null }

function statedFrom(members: string[], attempts: Attempt[], bodies: ErrorBody[]): StatedLimit[] {
  const stated: StatedLimit[] = []
  for (const attempt of attempts) {
    if (!attempt.route || !members.includes(attempt.route) || !attempt.response?.limits) continue
    for (const [unit, limit] of Object.entries(attempt.response.limits)) {
      if (!limit || typeof limit.limit !== "number") continue
      stated.push({ source: "headers", route: attempt.route, at: iso(attempt.at), unit, limit: limit.limit, remaining: limit.remaining, resetAt: limit.resetAt })
    }
  }
  for (const body of bodies) {
    const match = LIMIT_TEXT.exec(body.message)
    if (!match || !members.includes(body.route)) continue
    stated.push({ source: "error body", route: body.route, at: iso(body.at), unit: match[2].toLowerCase(), limit: Number(match[1].replace(/,/g, "")), window: match[3] ?? null })
  }
  return stated
}

type Credits = { answered: boolean; status: number | null; remainingUSD: number | null }

export async function creditsOf(key: string, fetch: typeof globalThis.fetch): Promise<Credits> {
  try {
    const response = await fetch(OPENROUTER_CREDITS, { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return { answered: false, status: response.status, remainingUSD: null }
    const data = (await response.json())?.data
    const credits = Number(data?.total_credits), used = Number(data?.total_usage)
    if (!Number.isFinite(credits) || !Number.isFinite(used)) return { answered: false, status: response.status, remainingUSD: null }
    return { answered: true, status: response.status, remainingUSD: Math.round((credits - used) * 100) / 100 }
  } catch {
    return { answered: false, status: null, remainingUSD: null }
  }
}

function claudeWindow(now: number, account: AccountUsage, spec: (typeof CLAUDE_WINDOWS)[number], observations: WindowObservation[], attempts: Attempt[]) {
  const window = account.windows.find(w => w.id === spec.id)
  const rows: UsageRow[] = attempts.filter(a => a.accountID === account.id && a.at <= now).map(a => ({ at: a.at, tokens: a.tokens, ok: a.ok, cutOff: a.cutOff }))
  const estimate = windowEstimate(spec.ms, rows, observations.filter(o => o.at <= now))
  const resetAt = window?.resetAt ? Date.parse(window.resetAt) : NaN
  const current = Number.isFinite(resetAt) && resetAt > now
  const start = current ? resetAt - spec.ms : null
  const used = start === null ? null : { tokens: tokensBetween(rows, start, now), messages: messagesBetween(rows, start, now), basis: "estimate from rows since the window started" }
  return {
    accountID: account.id,
    plan: { name: account.plan.name, multiplier: account.plan.multiplier },
    label: spec.label,
    windowID: spec.id,
    usedPercent: { value: window?.usedPercent ?? null, basis: "observed", at: window?.observedAt ?? null },
    nextReset: { at: current ? iso(resetAt) : null, basis: "observed" },
    used,
    limitTokens: { value: estimate.value, basis: "estimate", confidence: estimate.confidence, samples: estimate.samples, observations: estimate.observations, cutOffs: estimate.cutOffs, reason: estimate.reason },
    leftTokens: estimate.value !== null && used ? Math.max(0, estimate.value - used.tokens) : null,
  }
}

export async function planAllowances(now: number, sources: Sources = {}) {
  const home = homedir()
  const accountUsageFile = sources.accountUsageFile ?? join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "opencode", "account-usage.json")
  const observationsFile = sources.observationsFile ?? accountUsageFile + ".observations"
  const channelDir = sources.channelDir ?? join(home, ".local", "state", "questgiver", "channels")
  const openCodeDb = sources.openCodeDb ?? join(home, ".local", "share", "opencode", "opencode.db")
  const env = sources.env ?? process.env
  const fetch = sources.fetch ?? globalThis.fetch

  const attempts = channelAttempts(channelDir)
  const snapshot = readAccountUsage(accountUsageFile, now)
  const observations = readQuotaObservations(observationsFile).observations.map(o => ({ accountID: o.accountID, windowID: o.windowID, at: o.at, usedPoints: o.usedPoints, resetAt: o.resetAt }))
  const claude = snapshot.accounts.filter(account => account.provider === "claude").flatMap(account =>
    CLAUDE_WINDOWS.map(spec => claudeWindow(now, account, spec, observations.filter(o => o.accountID === account.id && o.windowID === spec.id), attempts)))

  const bodies = errorBodies(openCodeDb)
  const pools = freePools(now, { channelDir, openCodeDb }).pools
  const freePoolReadout = pools.filter(pool => pool.free).map(pool => ({
    poolId: pool.poolId,
    estimate: pool.estimate,
    reason: pool.reason,
    evidence: pool.evidence,
    n: pool.n,
    statedLimits: statedFrom(pool.members, attempts, bodies),
  }))

  const key = openRouterKey(env, sources.dataDirectory ?? discoveryPaths().data)
  const endpoint: Credits = key === undefined ? { answered: false, status: null, remainingUSD: null } : await creditsOf(key, fetch)
  const paid = pools.find(pool => pool.poolId === "paid:openrouter")?.balance ?? null
  const lastBalanceError = paid?.lastBalanceError ?? null
  const since = lastBalanceError === null ? null : Date.parse(lastBalanceError)
  const priced = since === null ? [] : attempts.filter(a => a.provider === "openrouter" && a.ok && a.at > since && a.cost !== null)
  const spentSinceLastBalanceErrorUSD = since === null || priced.length === 0 ? null : Math.round(priced.reduce((sum, a) => sum + a.cost!, 0) * 100) / 100
  const inferred = paid?.state === "balance exhausted" && lastBalanceError ? "balance exhausted since " + lastBalanceError : "balance ok, no fit"
  const openRouter = {
    key: key === undefined ? "not configured" : "configured",
    endpoint: { answered: endpoint.answered, status: endpoint.status, checkedAt: endpoint.answered ? iso(now) : null },
    balance: endpoint.answered
      ? { state: "remaining", remainingUSD: endpoint.remainingUSD, basis: "endpoint", lastBalanceError, spentSinceLastBalanceErrorUSD }
      : { state: inferred, remainingUSD: null, basis: "inference", lastBalanceError, spentSinceLastBalanceErrorUSD },
  }
  return { now: iso(now), claude, freePools: freePoolReadout, openRouter }
}
