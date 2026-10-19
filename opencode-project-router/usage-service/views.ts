import type { AccountUsage, AccountWindow } from "./types"
import { accountIsStale, ageSeconds, readingState, windowNeedsRefresh } from "./freshness"
import { describeAccount } from "./describe"

export type ReadAccount = AccountUsage & { nodes?: string[] }
export type Filter = { account?: string; provider?: string }

const seconds = (iso: string | null, now: number) => iso && Number.isFinite(Date.parse(iso)) ? Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000)) : null
const stale = (account: AccountUsage, now: number) => account.freshness?.stale ?? accountIsStale(account, now)
const label = (window: AccountWindow) => window.label || window.id
const matches = (account: AccountUsage, filter: Filter) =>
  (!filter.account || account.id === filter.account || account.id.endsWith(filter.account)) && (!filter.provider || account.provider === filter.provider)

const limitOf = (account: AccountUsage): "available" | "exhausted" | "unknown" => {
  const shared = account.windows.filter(window => window.scope === "shared")
  return shared.some(window => window.state === "exhausted") ? "exhausted" : shared.length > 0 && shared.every(window => window.state === "available") ? "available" : "unknown"
}

export function plansView(accounts: ReadAccount[], now: number, timeZone?: string) {
  return {
    at: now,
    accounts: accounts.map(account => {
      const resets = account.windows.flatMap(window => window.scope === "unknown" || seconds(window.resetAt, now) === null ? [] : [window.resetAt!]).sort()
      return {
        account: account.id,
        provider: account.provider,
        plan: account.plan.name ?? account.plan.rateLimitTier ?? null,
        multiplier: account.plan.multiplier,
        planSource: account.plan.provenance,
        state: readingState(account, now),
        limit: limitOf(account),
        ageSeconds: ageSeconds(account, now),
        stale: stale(account, now),
        observedAt: account.observedAt,
        summary: describeAccount(account, now, timeZone),
        windows: account.windows.length,
        nextResetAt: resets.find(at => Date.parse(at) > now) ?? null,
        signedInVia: [...new Set(account.connections.map(connection => connection.owner))],
        computers: account.nodes ?? [],
        error: account.error,
      }
    }),
  }
}

export function usageView(accounts: ReadAccount[], filter: Filter, now: number, timeZone?: string) {
  const chosen = accounts.filter(account => matches(account, filter))
  return {
    at: now,
    accounts: chosen.map(account => ({
      account: account.id,
      provider: account.provider,
      state: readingState(account, now),
      limit: limitOf(account),
      ageSeconds: ageSeconds(account, now),
      summary: describeAccount(account, now, timeZone),
    })),
    windows: chosen.flatMap(account => account.windows.map(window => ({
      account: account.id,
      provider: account.provider,
      dollars: window.dollars ?? null,
      ageSeconds: ageSeconds(account, now),
      window: label(window),
      scope: window.scope,
      model: window.model ?? null,
      usedPercent: window.usedPercent,
      remainingPercent: window.remainingPercent,
      resetAt: window.resetAt,
      resetsInSeconds: seconds(window.resetAt, now),
      state: window.state,
      stale: stale(account, now) || windowNeedsRefresh(window, now),
    }))),
  }
}

export type Outcome = "runs-out-before-reset" | "lasts-until-reset" | "exhausted" | "idle" | "unknown"

export function forecastWindow(window: AccountWindow, now: number) {
  const base = { window: label(window), scope: window.scope, model: window.model ?? null, usedPercent: window.usedPercent, resetAt: window.resetAt }
  const unknown = (reason: string) => ({ ...base, outcome: "unknown" as Outcome, pacePercentPerHour: null, runsOutAt: null, reason })
  if (window.dollars) return unknown("A dollar balance, not a rate window.")
  if (window.usedPercent === null) return unknown("The provider reported no share used.")
  if (window.usedPercent >= 100 || window.state === "exhausted") return { ...base, outcome: "exhausted" as Outcome, pacePercentPerHour: null, runsOutAt: null, reason: "Already at the limit." }
  const resetAt = window.resetAt ? Date.parse(window.resetAt) : NaN
  if (!window.durationSeconds || !Number.isFinite(resetAt) || resetAt <= now) return unknown("The window length or reset time is not known.")
  const elapsed = window.durationSeconds - (resetAt - now) / 1000
  if (elapsed < Math.max(60, window.durationSeconds * 0.02)) return unknown("The window only just opened, so there is no pace yet.")
  const perSecond = window.usedPercent / elapsed
  if (perSecond <= 0) return { ...base, outcome: "idle" as Outcome, pacePercentPerHour: 0, runsOutAt: null, reason: "Nothing used in this window yet." }
  const runsOut = now + ((100 - window.usedPercent) / perSecond) * 1000
  const before = runsOut < resetAt
  return {
    ...base, outcome: (before ? "runs-out-before-reset" : "lasts-until-reset") as Outcome,
    pacePercentPerHour: Math.round(perSecond * 3600 * 10) / 10,
    runsOutAt: before ? new Date(runsOut).toISOString() : null,
    reason: "Average pace since the window opened, continued unchanged.",
  }
}

export function forecastView(accounts: ReadAccount[], filter: Filter, now: number) {
  return {
    at: now,
    basis: "Each window's average pace since it opened, continued unchanged. It is not a promise.",
    accounts: accounts.filter(account => matches(account, filter)).map(account => ({
      account: account.id,
      provider: account.provider,
      state: readingState(account, now),
      ageSeconds: ageSeconds(account, now),
      stale: stale(account, now),
      windows: account.windows.map(window => forecastWindow(window, now)),
    })),
  }
}
