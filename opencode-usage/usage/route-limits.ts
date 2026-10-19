import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { readJsonRecord, writeFileDurable } from "../quest/core/durable-file.mjs"
import { knownTokenTotal, type RequestRecord } from "./telemetry"
import { TELEMETRY_FILE } from "./telemetry-store"
import { enforceJsonlBudget, TELEMETRY_BUDGET } from "../scripts/telemetry-budget.mjs"
import { ROUTE_HEALTH, applyHealthRow, availabilityOf, routeKeysOf, routeLimitKey, unhealthyText, updateBalanceHolds, type HealthMaps, type HealthRow, type OutageEvent, type ProviderOutage, type RouteDemotion, type RouteLimitState, type RouteLimitsRecord } from "./route-availability"

export * from "./route-availability"

export type RouteLimitRow = RouteLimitState & { refusalsLastHour: number; blocked: boolean; source: "headers" | "refusals" | "headers and refusals" | "none"; beforeLastRefusal: { requests: number; tokens: number } | null }
export type RouteAlert = { route: string; reason: string; since: string; until: string }

const HOUR_MS = 3_600_000
export const routeLimitsFile = () => process.env.OPENCODE_ROUTE_LIMITS_FILE ?? TELEMETRY_FILE + ".route-limits.json"
export const routeOutageLog = (file: string) => file.replace(/\.json$/, ".outages.jsonl")

type Tracker = HealthMaps & { file: string; starts: Map<string, number[]>; dirty: boolean; timer?: ReturnType<typeof setTimeout> }
const trackers = new Map<string, Tracker>()
let exitHooked = false
const recordOf = (tracker: Tracker): RouteLimitsRecord => ({ version: 1, routes: Object.fromEntries(tracker.routes), ...(tracker.providers.size ? { providers: Object.fromEntries(tracker.providers) } : {}) })
const healthListeners = new Set<() => void>()
export function onRouteHealthChange(listener: () => void): () => void {
  healthListeners.add(listener)
  return () => { healthListeners.delete(listener) }
}

function trackerFor(file: string): Tracker {
  const existing = trackers.get(file)
  if (existing) return existing
  const tracker: Tracker = { file, routes: new Map(), providers: new Map(), starts: new Map(), dirty: false }
  trackers.set(file, tracker)
  if (!exitHooked) { exitHooked = true; process.once("exit", () => { for (const item of trackers.values()) if (item.dirty) writeSnapshot(item) }) }
  return tracker
}

function writeSnapshot(tracker: Tracker): void {
  if (!existsSync(dirname(tracker.file))) return
  try { writeFileDurable(tracker.file, JSON.stringify(recordOf(tracker)) + "\n"); tracker.dirty = false } catch {}
}

function scheduleSnapshot(tracker: Tracker): void {
  if (tracker.timer) return
  tracker.timer = setTimeout(() => { tracker.timer = undefined; writeSnapshot(tracker) }, 0)
  tracker.timer.unref?.()
}

function appendOutageEvents(file: string, events: OutageEvent[]): void {
  if (!existsSync(dirname(file))) return
  const log = routeOutageLog(file)
  try { appendFileSync(log, events.map(event => JSON.stringify(event) + "\n").join("")); enforceJsonlBudget(log, TELEMETRY_BUDGET.routeOutagesBytes) } catch {}
}

function lowerBound(sorted: number[], at: number): number {
  let low = 0, high = sorted.length
  while (low < high) { const mid = (low + high) >> 1; if (sorted[mid] < at) low = mid + 1; else high = mid }
  return low
}

function applyToTracker(tracker: Tracker, row: HealthRow): { events: OutageEvent[]; changed: boolean } {
  const key = routeLimitKey(row.route.providerID, row.route.modelID), now = row.response?.at ?? row.firstResponseAt ?? row.startedAt
  const starts = tracker.starts.get(key) ?? []
  while (starts.length && starts[0] < now - HOUR_MS) starts.shift()
  const requestsBefore = lowerBound(starts, now)
  if (row.state !== "failed") starts.splice(lowerBound(starts, row.startedAt), 0, row.startedAt)
  tracker.starts.set(key, starts)
  return applyHealthRow(tracker, row, requestsBefore)
}

export function observeHealthRow(row: HealthRow, file = routeLimitsFile()): RouteLimitState | undefined {
  const tracker = trackerFor(file), key = routeLimitKey(row.route.providerID, row.route.modelID)
  const { events, changed } = applyToTracker(tracker, row)
  tracker.dirty = true
  if (events.length) appendOutageEvents(file, events)
  if (changed) { scheduleSnapshot(tracker); for (const listener of healthListeners) listener() }
  return tracker.routes.get(key)
}

export function observeNoTurn(model: string, answered: boolean, now = Date.now(), file = routeLimitsFile()): RouteLimitState | undefined {
  const slash = model.indexOf("/")
  if (slash < 1) return undefined
  const route = { providerID: model.slice(0, slash), modelID: model.slice(slash + 1).split("#")[0] }
  const key = routeLimitKey(route.providerID, route.modelID)
  const state = observeHealthRow({ route, startedAt: now, state: answered ? "completed" : "failed", tokens: { input: null, output: answered ? 0 : null, reasoning: null, cacheRead: null, cacheWrite: null } }, file)
  if (!state || state.demotion) return state
  const tracker = trackerFor(file)
  const demotion: RouteDemotion = { since: new Date(now).toISOString(), until: new Date(now + ROUTE_HEALTH.burstStartMs).toISOString(), kind: answered ? "empty" : "timeout", reason: answered ? "answered without a model turn" : "the host never started the run", wait: "burst" }
  tracker.routes.set(key, { ...state, demotion, cooldownMs: state.cooldownMs ?? ROUTE_HEALTH.burstStartMs })
  tracker.dirty = true
  scheduleSnapshot(tracker)
  appendOutageEvents(file, [{ at: now, event: "down", route: key, kind: demotion.kind, reason: demotion.reason, until: demotion.until, cooldownMs: ROUTE_HEALTH.burstStartMs }])
  for (const listener of healthListeners) listener()
  return tracker.routes.get(key)
}

export function checkBalances(provider: string, remainingUSD: number | null, now = Date.now(), file = routeLimitsFile()): boolean {
  if (remainingUSD === null) return false
  const tracker = trackerFor(file)
  if (!updateBalanceHolds(tracker.routes, provider, remainingUSD, now)) return false
  tracker.dirty = true
  scheduleSnapshot(tracker)
  for (const listener of healthListeners) listener()
  return true
}

export function startRouteHealth(file: string, rows: HealthRow[]): void {
  const previous = trackers.get(file)
  if (previous?.timer) clearTimeout(previous.timer)
  trackers.delete(file)
  const tracker = trackerFor(file)
  for (const row of rows) applyToTracker(tracker, row)
  tracker.dirty = true
  scheduleSnapshot(tracker)
}

export function flushRouteHealth(file = routeLimitsFile()): void {
  const tracker = trackers.get(file)
  if (tracker?.dirty) writeSnapshot(tracker)
}

export function readRouteLimits(file = routeLimitsFile()): RouteLimitsRecord {
  const tracker = trackers.get(file)
  if (tracker) return recordOf(tracker)
  const saved = readJsonRecord(file) as RouteLimitsRecord | undefined
  return saved?.version === 1 && saved.routes && typeof saved.routes === "object" ? saved : { version: 1, routes: {} }
}

export function routeOutageEvents(file = routeLimitsFile()): OutageEvent[] {
  const log = routeOutageLog(file)
  if (!existsSync(log)) return []
  return readFileSync(log, "utf8").split("\n").flatMap(line => { try { return line.trim() ? [JSON.parse(line) as OutageEvent] : [] } catch { return [] } })
}

export function demotedRoute(route: { providerID: string; modelID: string }, now = Date.now(), file = routeLimitsFile()): RouteDemotion | undefined {
  const demotion = readRouteLimits(file).routes[routeLimitKey(route.providerID, route.modelID)]?.demotion
  return demotion && Date.parse(demotion.until) > now ? demotion : undefined
}

export function stopRouteRetries(route: { providerID: string; modelID: string }, sessionID: string, now = Date.now(), file = routeLimitsFile()): void {
  const tracker = trackers.get(file), key = routeLimitKey(route.providerID, route.modelID), state = tracker?.routes.get(key)
  if (!tracker || !state?.demotion || state.demotion.stopped?.sessionID === sessionID) return
  tracker.routes.set(key, { ...state, demotion: { ...state.demotion, stopped: { sessionID, at: new Date(now).toISOString() } } })
  tracker.dirty = true
  scheduleSnapshot(tracker)
}

export function blockedRoutes(now = Date.now(), file = routeLimitsFile()): Map<string, string> {
  const saved = readRouteLimits(file), blockedMap = new Map<string, string>()
  for (const key of routeKeysOf(saved)) {
    const availability = availabilityOf(key, now, saved), state = saved.routes[key]
    const outage = Object.values(saved.providers ?? {}).find(item => item.routes.includes(key))
    if (outage && availability.state !== "up") {
      const waiting = Date.parse(outage.until) > now
      if (waiting || key !== outage.probe) blockedMap.set(key, "Provider outage: " + outage.provider + " (" + outage.reason + "); " + (waiting ? "not routed to until " + outage.until + ", then one probe on " + outage.probe : "waiting for the one probe on " + outage.probe))
    } else if (availability.state === "out" && state) {
      const refusal = state.refusals.at(-1), demoted = state.demotion
      const why = refusal && Date.parse(refusal.at) >= now - 3_600_000 ? "the endpoint refused with HTTP " + refusal.status + (refusal.retryAfterSeconds !== null ? " and asked for " + refusal.retryAfterSeconds + "s" : "") : "the endpoint headers show no requests or tokens left"
      blockedMap.set(key, "Rate limit reached: " + why + "; waits until " + state.blockedUntil + (demoted ? "; demoted after " + demoted.reason : ""))
    } else if (availability.state === "cooling") blockedMap.set(key, unhealthyText(availability.reason!, availability.until!))
  }
  return blockedMap
}

export function probingRoutes(now = Date.now(), file = routeLimitsFile()): Map<string, string> {
  const saved = readRouteLimits(file), probingMap = new Map<string, string>()
  for (const key of routeKeysOf(saved)) {
    const availability = availabilityOf(key, now, saved)
    if (availability.state === "probing") probingMap.set(key, "Probing after " + (availability.reason?.startsWith("provider outage") ? availability.reason : "cooldown: " + availability.reason) + "; only a synthetic probe tries it, no real worker is routed here")
  }
  return probingMap
}

export function routeAlerts(file = routeLimitsFile()): RouteAlert[] {
  return Object.values(readRouteLimits(file).routes).flatMap(state => state.demotion && state.demotion.kind !== "rate-limited" ? [{ route: state.route, reason: state.demotion.reason, since: state.demotion.since, until: state.demotion.until }] : [])
}

export function routeStatusLines(now = Date.now(), file = routeLimitsFile()): string[] {
  const saved = readRouteLimits(file)
  const demoted = Object.values(saved.routes).flatMap(state => state.demotion ? [state.route + " (" + state.demotion.reason + "; " + (Date.parse(state.demotion.until) > now ? "until " + state.demotion.until : "probing after cooldown") + ")"] : [])
  const providers = Object.values(saved.providers ?? {}).map((outage: ProviderOutage) => outage.provider + " (" + outage.reason + "; " + (Date.parse(outage.until) > now ? "until " + outage.until : "probing after cooldown") + ")")
  return [
    demoted.length ? "Routes demoted: " + demoted.join("; ") : "Routes: none demoted",
    ...(providers.length ? ["Providers out: " + providers.join("; ")] : []),
  ]
}

const hourBefore = (records: RequestRecord[], key: string, at: number) => records.filter(r => routeLimitKey(r.route.providerID, r.route.modelID) === key && r.startedAt < at && r.startedAt >= at - HOUR_MS && r.state !== "failed")

export function routeLimitRows(records: RequestRecord[] = [], now = Date.now(), file = routeLimitsFile()): RouteLimitRow[] {
  return Object.values(readRouteLimits(file).routes).map(state => {
    const refusalsLastHour = state.refusals.filter(r => Date.parse(r.at) >= now - 3_600_000).length
    const last = state.refusals.at(-1), lastAt = last ? Date.parse(last.at) : NaN
    const before = Number.isFinite(lastAt) ? hourBefore(records, state.route, lastAt) : []
    const hasHeaders = Object.keys(state.headers).length > 0, hasRefusals = state.refusals.length > 0
    return { ...state, refusalsLastHour, blocked: !!state.blockedUntil && Date.parse(state.blockedUntil) > now,
      source: hasHeaders && hasRefusals ? "headers and refusals" : hasHeaders ? "headers" : hasRefusals ? "refusals" : "none",
      beforeLastRefusal: Number.isFinite(lastAt) ? { requests: new Set(before.map(r => r.id)).size, tokens: [...new Map(before.map(r => [r.id, r])).values()].reduce((sum, r) => sum + knownTokenTotal(r), 0) } : null } as RouteLimitRow
  }).sort((a, b) => a.route.localeCompare(b.route))
}
