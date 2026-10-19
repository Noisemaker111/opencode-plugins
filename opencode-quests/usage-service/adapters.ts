import type { Connection } from "./connections"
import type { AccountPlan, AccountWindow, AccountUsage } from "./types"
export type Observation = { windows: AccountWindow[]; plan?: AccountPlan; extraUsage?: { enabled: boolean | null } }
export type ProbeFailure = { state: AccountUsage["state"]; error: string; retryAfterSeconds?: number }
const num = (x: unknown): number | null => typeof x === "number" && Number.isFinite(x) ? x : null
const pct = (x: unknown) => { const n = num(x); return n != null && n >= 0 && n <= 100 ? n : null }
const iso = (x: unknown): string | null => {
  const n = typeof x === "number" ? x * (x < 1e12 ? 1000 : 1) : typeof x === "string" ? Date.parse(x) : NaN
  return Number.isFinite(n) && Math.abs(n) < 8.64e15 ? new Date(Math.round(n / 1000) * 1000).toISOString() : null
}
export function durationLabel(seconds: number | null, fallback: string): string {
  if (!seconds || seconds <= 0) return fallback
  if (seconds % 86400 === 0) return seconds / 86400 + "d"
  if (seconds % 3600 === 0) return seconds / 3600 + "h"
  if (seconds % 60 === 0) return seconds / 60 + "m"
  return seconds + "s"
}
function window(id: string, row: any, now: number, scope: AccountWindow["scope"], duration: number | null, model?: string): AccountWindow {
  const used = pct(row.used_percent ?? row.utilization ?? row.percent)
  const remaining = pct(row.remaining_percent ?? row.percent_left) ?? (used == null ? null : 100 - used)
  const reset = iso(row.reset_at ?? row.resets_at ?? row.resetsAt ?? row.available_at) ??
    (num(row.reset_after_seconds) != null && row.reset_after_seconds >= 0 ? new Date(now + row.reset_after_seconds * 1000).toISOString() : null)
  const cap = row.available === false || row.limit_reached === true || row.allowed === false || row.status === "rate-limited" || row.status === "cap" || used === 100 || remaining === 0
  return { id, label: durationLabel(duration, id), scope, ...(model ? { model } : {}), durationSeconds: duration,
    usedPercent: used ?? (remaining == null ? null : 100 - remaining), remainingPercent: remaining, resetAt: reset,
    observedAt: new Date(now).toISOString(), state: cap ? "exhausted" : row.available === true || row.allowed === true || used != null || remaining != null ? "available" : "unknown" }
}
export function parseOpenAIAccountUsage(body: any, now: number): Observation {
  const windows: AccountWindow[] = []
  const add = (limits: any, prefix: string, scope: AccountWindow["scope"], model?: string) => {
    if (!limits || typeof limits !== "object") return
    const entries = [["primary", limits.primary_window], ["secondary", limits.secondary_window],
      ...(Array.isArray(limits.windows) ? limits.windows.map((w: any, i: number) => ["window-" + i, w]) : [])]
    for (const [id, value] of entries) if (value && typeof value === "object") {
      const row = window(prefix + ":" + id, value, now, scope, num(value.limit_window_seconds ?? value.window_seconds), model)
      windows.push(row)
    }
    if (limits.limit_reached === true || limits.allowed === false) windows.push(window(prefix + ":status", { limit_reached: true }, now, scope, null, model))
  }
  add(body.rate_limit ?? body.rate_limits, "shared", "shared")
  add(body.code_review_rate_limit, "code-review", "feature")
  for (const [index, entry] of (Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []).entries()) {
    const model = typeof entry.normal_model_slug === "string" ? entry.normal_model_slug : typeof entry.limit_name === "string" && /^gpt-[0-9]/i.test(entry.limit_name) ? entry.limit_name.toLowerCase() : undefined
    add(entry.rate_limit, "additional:" + (entry.metered_feature ?? entry.limit_name ?? index), model ? "model" : "feature", model)
  }
  for (const [model, value] of Object.entries(body.model_usage ?? {})) {
    const row = value as any
    if (row && typeof row === "object") {
      if (row.rate_limit || row.primary_window) add(row.rate_limit ?? row, "model:" + model, "model", model)
      else if (["used_percent", "utilization", "percent_left", "remaining_percent", "limit_reached", "available"].some(k => k in row)) windows.push(window("model:" + model, row, now, "model", num(row.limit_window_seconds), model))
    }
  }
  const plan = typeof body.plan_type === "string" ? { name: body.plan_type, rateLimitTier: null, multiplier: null, provenance: "provider-observed" as const, observedAt: new Date(now).toISOString() } : undefined
  return { windows, plan, extraUsage: { enabled: null } }
}
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
export function parseClaudeAccountUsage(body: any, now: number): Observation {
  const windows: AccountWindow[] = []
  for (const [id, value] of Object.entries(body)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const row = value as any
    if (!("utilization" in row) && !("resets_at" in row)) continue
    if (id === "extra_usage") continue
    if (num(row.limit_dollars) != null) {
      windows.push({ ...window(id, row, now, "unknown", null), dollars: { used: num(row.used_dollars) ?? 0, limit: num(row.limit_dollars) } })
      continue
    }
    const shared = id === "five_hour" || id === "seven_day"
    const scope = shared ? "shared" : /sonnet|opus/.test(id) ? "model" : "unknown"
    const duration = id === "five_hour" ? 18000 : id.startsWith("seven_day") ? 604800 : null
    windows.push(window(id, row, now, scope, duration, /sonnet/.test(id) ? "claude-sonnet" : /opus/.test(id) ? "claude-opus" : undefined))
  }
  const has = (id: string) => windows.some(w => w.id === id)
  for (const limit of Array.isArray(body.limits) ? body.limits : []) {
    if (!limit || typeof limit !== "object") continue
    const row = { percent: limit.percent, resets_at: limit.resets_at }
    const model = typeof limit.scope?.model?.display_name === "string" ? slug(limit.scope.model.display_name) : null
    if (limit.kind === "session" && !has("five_hour")) windows.push(window("five_hour", row, now, "shared", 18000))
    else if (limit.kind === "weekly_all" && !has("seven_day")) windows.push(window("seven_day", row, now, "shared", 604800))
    else if (limit.kind === "weekly_scoped" && model && !has("seven_day_" + model)) windows.push(window("seven_day_" + model, row, now, "model", 604800, "claude-" + model))
  }
  return { windows, extraUsage: { enabled: typeof body.extra_usage?.is_enabled === "boolean" ? body.extra_usage.is_enabled : null } }
}
export function parseClaudePlan(profile: any, now: number): AccountPlan | undefined {
  const tier = typeof profile.organization?.rate_limit_tier === "string" ? profile.organization.rate_limit_tier : null
  const name = profile.account?.has_claude_max === true ? "max" : profile.account?.has_claude_pro === true ? "pro" : null
  if (!tier && !name) return undefined
  return { name, rateLimitTier: tier, multiplier: tier?.match(/(?:^|_)(5|20)x(?:_|$)/) ? Number(tier.match(/(?:^|_)(5|20)x(?:_|$)/)![1]) : null,
    provenance: "provider-observed", observedAt: new Date(now).toISOString() }
}
export function parseGoAccountUsage(body: any, now: number): Observation {
  const windows = Object.entries(body.usage ?? {}).flatMap(([id, row]: [string, any]) => {
    if (!row || typeof row !== "object") return []
    const duration = id === "rolling" ? 18000 : id === "weekly" ? 604800 : null
    const built = window(id, row, now, ["rolling", "weekly", "monthly"].includes(id) ? "shared" : "unknown", duration)
    const unopened = id === "rolling" && built.usedPercent === 0 && built.resetAt != null && Math.abs(Date.parse(built.resetAt) - now - 18000_000) <= 120_000
    return [unopened ? { ...built, resetAt: null } : built]
  })
  return { windows, plan: typeof body.plan === "string" ? { name: body.plan, rateLimitTier: null, multiplier: null, provenance: "provider-observed", observedAt: new Date(now).toISOString() } : undefined }
}
export function parseOllamaAccountUsage(body: any, now: number): Observation {
  const durations: Record<string, number> = { session: 18000, weekly: 604800 }
  const windows = Object.entries(body.limits ?? {}).flatMap(([id, row]: [string, any]) => {
    const used = num(row?.usage)
    return used == null ? [] : [window(id, { used_percent: Math.round(Math.min(1, Math.max(0, used)) * 1000) / 10 }, now, "shared", durations[id] ?? null)]
  })
  const spent = num(body.totals?.usage_usd)
  if (!windows.length && spent != null) {
    const range = typeof body.range === "string" && /^d+d$/.test(body.range) ? body.range : "7d"
    windows.push({ id: "spend-" + range, label: range + " spend", scope: "unknown", durationSeconds: Number(range.slice(0, -1)) * 86400,
      usedPercent: null, remainingPercent: null, resetAt: null, dollars: { used: spent, limit: null }, observedAt: new Date(now).toISOString(), state: "unknown" })
  }
  return { windows, plan: typeof body.plan === "string" ? { name: body.plan, rateLimitTier: null, multiplier: null, provenance: "provider-observed", observedAt: new Date(now).toISOString() } : undefined }
}
export function parseCursorUsage(body: any, now: number): Observation {
  const start = iso(body.billingCycleStart), end = iso(body.billingCycleEnd)
  const plan = body.individualUsage?.plan
  const used = num(plan?.used), limit = num(plan?.limit)
  const percent = pct(plan?.totalPercentUsed) ?? (used != null && limit ? Math.round(Math.min(100, used / limit * 100) * 10) / 10 : null)
  const seconds = start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 86400_000) * 86400 : null
  const windows: AccountWindow[] = percent == null && body.isUnlimited !== true ? [] : [window("pool", { used_percent: body.isUnlimited === true ? 0 : percent, reset_at: end }, now, "shared", seconds)]
  return { windows, plan: typeof body.membershipType === "string" ? { name: body.membershipType, rateLimitTier: null, multiplier: null, provenance: "provider-observed", observedAt: new Date(now).toISOString() } : undefined }
}
const cursorUser = (token: string) => { try { return String(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub ?? "").split("|").pop() || undefined } catch { return undefined } }
export async function probeConnection(connection: Connection, opts: { now: () => number; fetch: typeof fetch; refreshPlan: boolean }): Promise<Observation | ProbeFailure> {
  if (connection.provider === "grok") return { state: "unsupported", error: "Grok shares the X Subscription pool, which the Grok and Cursor account shows." }
  const url = connection.provider === "openai" ? "https://chatgpt.com/backend-api/wham/usage" :
    connection.provider === "claude" ? "https://api.anthropic.com/api/oauth/usage" :
    connection.provider === "ollama-cloud" ? "https://ollama.com/api/usage" : connection.provider === "cursor" ? "https://cursor.com/api/usage-summary" : "https://opencode.ai/zen/go/v1/usage"
  const token = connection.token()
  if (!token) return { state: "auth-required", error: "Credential unavailable; refresh through its existing owner." }
  const headers: Record<string, string> = connection.provider === "cursor" ? { Cookie: "WorkosCursorSessionToken=" + encodeURIComponent((cursorUser(token) ?? "") + "::" + token), Accept: "application/json", "User-Agent": "Mozilla/5.0" } : { Authorization: "Bearer " + token, Accept: "application/json" }
  if (connection.provider === "cursor" && !cursorUser(token)) return { state: "auth-required", error: "Cursor sign-in unreadable; run cursor-agent login." }
  if (connection.provider === "openai") {
    if (!connection.upstreamAccountID) return { state: "auth-required", error: "OAuth account identity unavailable; refresh through its existing owner." }
    headers["ChatGPT-Account-Id"] = connection.upstreamAccountID
  }
  if (connection.provider === "claude") headers["anthropic-beta"] = "oauth-2025-04-20"
  const request = (target: string) => opts.fetch(target, { headers, redirect: "error", signal: AbortSignal.timeout(7000) })
  try {
    const response = await request(url)
    if (!response.ok) {
      const retry = response.headers.get("retry-after")
      const seconds = retry ? Number(retry) : NaN
      const retryAfterSeconds = Number.isFinite(seconds) ? Math.min(300, Math.max(0, seconds)) : retry && Number.isFinite(Date.parse(retry)) ? Math.min(300, Math.max(0, (Date.parse(retry) - opts.now()) / 1000)) : undefined
      return { state: response.status === 401 || response.status === 403 ? "auth-required" : "unknown",
        error: "Usage endpoint HTTP " + response.status + (response.status === 401 || response.status === 403 ? (connection.provider === "cursor" ? "; the Cursor sign-in expired: run cursor-agent login." : "; refresh through the existing credential owner.") : ""),
        retryAfterSeconds }
    }
    const body = await response.json() as any
    if (!body || typeof body !== "object" || Array.isArray(body)) return { state: "unknown", error: "Usage endpoint returned an invalid schema." }
    if (connection.provider === "openai" && typeof body.account_id === "string" && body.account_id !== connection.upstreamAccountID) return { state: "unknown", error: "Usage response account identity does not match the selected connection." }
    const now = opts.now()
    const observation = connection.provider === "openai" ? parseOpenAIAccountUsage(body, now) : connection.provider === "claude" ? parseClaudeAccountUsage(body, now) :
      connection.provider === "ollama-cloud" ? parseOllamaAccountUsage(body, now) : connection.provider === "cursor" ? parseCursorUsage(body, now) : parseGoAccountUsage(body, now)
    if (!observation.windows.length) return { state: "unknown", error: "Usage endpoint returned no recognized windows." }
    if (connection.provider === "claude" && opts.refreshPlan) {
      try {
        const profile = await request("https://api.anthropic.com/api/oauth/profile")
        if (profile.ok) observation.plan = parseClaudePlan(await profile.json(), opts.now())
      } catch {}
    }
    return observation
  } catch { return { state: "unknown", error: "Usage endpoint unavailable or response invalid." } }
}
