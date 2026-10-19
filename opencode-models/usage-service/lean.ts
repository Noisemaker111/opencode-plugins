import type { ConnectStart, ConnectStatus, Disconnected } from "./backend"
import type { forecastView, plansView, usageView } from "./views"

import { span } from "./describe"

export const LEAN_SIZE_CAP = { plans: 1600, usage: 1600, forecast: 1000 }

export const detailInput = { type: "boolean", description: "The whole view instead of the short answer." }
export const includeInput = { type: "array", items: { enum: ["unknown"] }, description: "unknown: also list windows the provider did not describe." }

const tail = (id: string) => id.slice(-6)

const until = (iso: string | null, now: number) => {
  const time = iso ? Date.parse(iso) : NaN
  return Number.isFinite(time) ? "in " + span(Math.max(0, (time - now) / 1000)) : undefined
}

const present = (value: unknown) => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0) && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0)

export function prune<T>(value: T): T {
  if (Array.isArray(value)) return value.map(prune) as T
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, prune(field)]).filter(([, field]) => present(field))) as T
  return value
}

const sentence = (parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ")
const rounded = (value: number | null) => value === null ? undefined : Math.round(value * 10) / 10
const shown = (scope: string, include: string[]) => scope !== "unknown" || include.includes("unknown")

const accountState = (state: string) => state === "fresh" ? undefined : state

export function leanPlans(view: ReturnType<typeof plansView>, detail: boolean) {
  if (detail) return prune(view)
  return prune({
    head: view.accounts.length ? view.accounts.map(account => account.summary).join(" ") : "No accounts are connected yet. Call connect_start to connect some.",
    accounts: view.accounts.map(account => ({
      id: tail(account.account), p: account.provider,
      plan: account.plan ? account.plan + (account.multiplier && account.multiplier !== 1 ? " " + account.multiplier + "x" : "") : undefined,
      st: accountState(account.state), age: account.ageSeconds ?? undefined,
      next: until(account.nextResetAt, view.at),
      via: account.signedInVia, err: account.error ? account.error.slice(0, 120) : undefined,
    })),
  })
}

export function leanUsage(view: ReturnType<typeof usageView>, detail: boolean, include: string[]) {
  if (detail) return prune(view)
  const rows = view.accounts.map(account => {
    const w: Record<string, { left: number; reset?: string }> = {}
    for (const window of view.windows) {
      if (window.account !== account.account || !shown(window.scope, include) || window.remainingPercent === null) continue
      w[window.window + (window.model ? " " + window.model : "")] = { left: rounded(window.remainingPercent)!, reset: until(window.resetAt, view.at) }
    }
    return { id: tail(account.account), p: account.provider, st: accountState(account.state), age: account.ageSeconds ?? undefined, w }
  })
  const tight = view.windows.filter(window => window.remainingPercent !== null && window.remainingPercent < 10 && shown(window.scope, include)).length
  return prune({
    head: view.accounts.length ? sentence([...view.accounts.map(account => account.summary), tight ? tight + " windows under 10% left." : ""]) : "No usage windows match.",
    accounts: rows,
  })
}

export function leanForecast(view: ReturnType<typeof forecastView>, detail: boolean) {
  if (detail) return prune(view)
  let unknown = 0
  const accounts = view.accounts.map(account => ({
    id: tail(account.account), p: account.provider, st: accountState(account.state), age: account.ageSeconds ?? undefined,
    w: Object.fromEntries(account.windows.flatMap(window => {
      if (window.outcome === "unknown" || window.scope === "unknown") { unknown++; return [] }
      const out = window.outcome === "runs-out-before-reset" ? "runs out " + until(window.runsOutAt, view.at) : window.outcome === "lasts-until-reset" ? "lasts" : window.outcome
      return [[window.window + (window.model ? " " + window.model : ""), { out, pace: window.pacePercentPerHour ?? undefined }]]
    })),
  }))
  const risky = accounts.flatMap(account => Object.entries(account.w).filter(([, value]) => value.out.startsWith("runs out") || value.out === "exhausted").map(([name, value]) => `${account.p} ${name} ${value.out}`))
  return prune({
    head: sentence([risky.length ? risky.join("; ") + "." : "Every forecast window lasts until its reset.", unknown ? unknown + " windows unknown." : ""]),
    accounts,
  })
}

export const leanStart = (attempts: ConnectStart[]) => prune({
  head: attempts.length ? "Show each link, code or command exactly as given; never ask for a key." : "Every provider Usage can connect is already connected.",
  attempts: attempts.map(attempt => ({ id: attempt.id, p: attempt.provider, url: attempt.url, code: attempt.code, command: attempt.command, form: attempt.url ? undefined : attempt.formPath, limits: attempt.readsUsage ? undefined : false })),
})

export const leanStatus = (status: ConnectStatus) => prune({ head: `${status.provider}: ${status.state}. ${status.message}`, id: status.id, state: status.state, account: status.account ? tail(status.account) : undefined })

export const leanDisconnect = (result: Disconnected) => prune({ head: result.message, account: tail(result.account), hidden: result.hidden || undefined, removedKey: result.removedKey || undefined, via: result.stillSignedInVia, command: result.command })
