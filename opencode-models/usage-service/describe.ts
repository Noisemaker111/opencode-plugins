import { ageSeconds, readingState } from "./freshness"
import type { AccountUsage, AccountWindow } from "./types"

const PROVIDER: Record<string, string> = { claude: "Claude", openai: "OpenAI", "opencode-go": "OpenCode Go", "ollama-cloud": "Ollama Cloud", cursor: "Cursor", grok: "Grok" }
const titled = (text: string) => text.split(/[-_\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(" ")
const round = (value: number) => Math.round(value * 10) / 10
const money = (value: number) => "$" + (value >= 100 ? Math.round(value) : value.toFixed(2))

export function span(seconds: number): string {
  if (seconds < 90) return Math.round(seconds) + "s"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes + "m"
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return hours + "h" + (minutes % 60 && hours < 10 ? (minutes % 60) + "m" : "")
  return Math.round(seconds / 86400) + "d"
}

export function clock(iso: string, now: number, timeZone?: string): string {
  const at = Date.parse(iso)
  const zone = timeZone ?? "UTC"
  const format = (options: Intl.DateTimeFormatOptions) => {
    try { return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options }).format(at) } catch { return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(at) }
  }
  const time = format({ hour: "numeric", minute: "2-digit" }).toLowerCase().replace(/\s+/g, " ")
  const ahead = at - now
  const text = ahead < 18 * 3600_000 ? time : ahead < 6 * 86400_000 ? format({ weekday: "short" }) + " " + time : format({ month: "short", day: "numeric" }) + ", " + time
  return timeZone ? text : text + " UTC"
}

export function windowName(window: AccountWindow): string {
  const seconds = window.durationSeconds
  const base = seconds === 18000 ? "5-hour window" : seconds === 604800 ? "week" : /^monthly$/i.test(window.label) ? "month" :
    seconds && seconds % 86400 === 0 ? seconds / 86400 + "-day window" : window.label
  return window.model ? titled(window.model.replace(/^claude-/, "")) + " " + base : base
}

const usedOf = (window: AccountWindow) => window.usedPercent ?? (window.remainingPercent === null ? null : 100 - window.remainingPercent)

function describeWindow(window: AccountWindow, now: number, timeZone?: string): string | null {
  if (window.dollars) {
    const { used, limit } = window.dollars
    if (limit === null) return `${money(used)} spent in ${window.label.replace(/ spend$/, "")} (no limit published)`
    return `${money(used)} of ${money(limit)} credit (${window.id})` + (window.resetAt ? `, resets ${clock(window.resetAt, now, timeZone)}` : "")
  }
  const used = usedOf(window)
  if (used === null) return null
  const text = `${round(used)}% of the ${windowName(window)}`
  if (window.state === "exhausted") return text + (window.resetAt ? `, blocked until ${clock(window.resetAt, now, timeZone)}` : ", blocked")
  return text + (used > 0 && window.resetAt ? `, resets ${clock(window.resetAt, now, timeZone)}` : "")
}

export function describeAccount(account: AccountUsage, now: number, timeZone?: string, includeUnknown = false): string {
  const state = readingState(account, now), age = ageSeconds(account, now)
  const name = (PROVIDER[account.provider] ?? titled(account.provider)) + (account.plan.name ? " " + titled(account.plan.name) : "") + (account.plan.multiplier ? " " + account.plan.multiplier + "x" : "")
  if (state === "unsupported") return `${name}: signed in; the provider publishes no usage to read.`
  const shown = account.windows
    .filter(window => window.scope !== "unknown" || includeUnknown || (window.dollars && window.dollars.limit === null))
    .sort((a, b) => Number(b.state === "exhausted") - Number(a.state === "exhausted") || (a.durationSeconds ?? Infinity) - (b.durationSeconds ?? Infinity))
  const parts = shown.flatMap(window => describeWindow(window, now, timeZone) ?? [])
  const reading = age === null ? "Never read." : state === "fresh" ? `Read ${span(age)} ago.` : state === "stale" ? `Last read ${span(age)} ago, so these may be out of date.` : `Last read ${span(age)} ago.`
  const trouble = state === "error" ? ` Problem: ${(account.error ?? "sign-in needs attention").replace(/[.]$/, "")}.` : ""
  return `${name}: ${parts.length ? parts.join("; ") : "no limits readable"}. ${reading}${trouble}`
}
