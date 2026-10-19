import type { AccountUsage, AccountWindow } from "./types"

export const ACCOUNT_USAGE_TTL_MS = 30_000
export const ACCOUNT_USAGE_FRESH_MS = 120_000

export type ReadingState = "fresh" | "stale" | "error" | "unsupported"

export function accountIsStale(account: AccountUsage, now = Date.now()): boolean {
  const observed = Date.parse(account.observedAt ?? "")
  return !Number.isFinite(observed) || observed > now || now - observed >= ACCOUNT_USAGE_FRESH_MS
}

export function ageSeconds(account: Pick<AccountUsage, "observedAt">, now = Date.now()): number | null {
  const observed = Date.parse(account.observedAt ?? "")
  return Number.isFinite(observed) ? Math.max(0, Math.floor((now - observed) / 1000)) : null
}

export function readingState(account: AccountUsage, now = Date.now()): ReadingState {
  if (account.state === "unsupported") return "unsupported"
  if (account.error || account.state === "auth-required") return "error"
  return accountIsStale(account, now) ? "stale" : "fresh"
}

export function windowNeedsRefresh(window: AccountWindow, now = Date.now()): boolean {
  return window.resetAt != null && Date.parse(window.resetAt) <= now
}
