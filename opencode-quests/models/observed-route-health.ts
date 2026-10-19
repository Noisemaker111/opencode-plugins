import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs"
import type { RequestRecord } from "../usage/telemetry"
import { ROUTE_HEALTH, availabilityOf, isFailure, outcomeCodeOfRecord, readRouteLimits, type WaitClass, routeLimitKey, routeLimitsFile, routeOutageEvents, startRouteHealth, type FailureKind, type OutageEvent, type OutcomeCode, type ProviderOutage, type RouteLimitState, type RouteLimitsRecord } from "../usage/route-limits"
export { outcomeCodeOfRecord }

export const ROUTE_HEALTH_WINDOW_MS = 6 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

export const RECENT_REQUEST_CHUNK_BYTES = 2 * 1024 * 1024
export const ROUTE_HISTORY_MS = DAY_MS
export const ROUTE_HISTORY_ROWS = 2000
export const ROUTE_HISTORY_BYTES = 8 * 1024 * 1024
export const RECENT_REQUEST_CEILING_BYTES = 256 * 1024 * 1024

function parseRecords(text: string): RequestRecord[] {
  const records: RequestRecord[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try { const row = JSON.parse(line); if (row?.version === 1 && row.request?.id) records.push(row.request) } catch {}
  }
  return records
}

export function recentRequests(file: string, options: number | { chunkBytes?: number; sinceMs?: number; ceilingBytes?: number } = {}): RequestRecord[] {
  if (!existsSync(file)) return []
  const chunkBytes = typeof options === "number" ? options : options.chunkBytes ?? RECENT_REQUEST_CHUNK_BYTES
  const sinceMs = typeof options === "number" ? undefined : options.sinceMs
  const ceilingBytes = typeof options === "number" ? options : options.ceilingBytes ?? RECENT_REQUEST_CEILING_BYTES
  const size = statSync(file).size
  const handle = openSync(file, "r")
  try {
    let end = size, carry = Buffer.alloc(0), records: RequestRecord[] = []
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes)
      const buffer = Buffer.alloc(end - start)
      readSync(handle, buffer, 0, buffer.length, start)
      const text = Buffer.concat([buffer, carry]).toString("utf8")
      const cut = start > 0 ? text.indexOf("\n") : -1
      const whole = cut === -1 && start > 0 ? "" : text.slice(cut + 1)
      carry = cut === -1 ? Buffer.concat([buffer, carry]) : Buffer.from(text.slice(0, cut), "utf8")
      const parsed = parseRecords(whole)
      records = [...parsed, ...records]
      end = start
      const oldest = parsed.reduce((min, record) => Number.isFinite(record.startedAt) ? Math.min(min, record.startedAt) : min, Infinity)
      const covered = sinceMs === undefined ? true : oldest <= sinceMs
      if (covered || size - start >= ceilingBytes) break
    }
    return records
  } finally { closeSync(handle) }
}

type Outcome = { startedAt: number; code: OutcomeCode; record: RequestRecord }
function outcomesByKey(records: RequestRecord[], now: number, windowMs: number): Map<string, Outcome[]> {
  const latest = new Map<string, RequestRecord>()
  for (const record of records) if (record?.id) latest.set(record.id, record)
  const groups = new Map<string, Outcome[]>()
  for (const record of latest.values()) {
    const code = outcomeCodeOfRecord(record)
    if (!code || !record.route?.providerID || !record.route?.modelID || !Number.isFinite(record.startedAt) || now - record.startedAt > windowMs) continue
    const key = routeLimitKey(record.route.providerID, record.route.modelID)
    groups.set(key, [...(groups.get(key) ?? []), { startedAt: record.startedAt, code, record }])
  }
  for (const rows of groups.values()) rows.sort((a, b) => a.startedAt - b.startedAt)
  return groups
}

export function rebuildRouteHealth(historyFile: string, now = Date.now(), file = routeLimitsFile()): void {
  const latest = new Map<string, RequestRecord>()
  for (const record of recentRequests(historyFile, { sinceMs: now - ROUTE_HISTORY_MS, ceilingBytes: ROUTE_HISTORY_BYTES })) {
    latest.delete(record.id)
    latest.set(record.id, record)
  }
  const rows = [...latest.values()].filter(record => record.route?.providerID && record.route?.modelID && Number.isFinite(record.startedAt) && now - record.startedAt <= ROUTE_HISTORY_MS)
  startRouteHealth(file, rows.slice(-ROUTE_HISTORY_ROWS))
}

export function measuredModels(records: RequestRecord[], now: number, windowMs: number, limits: Record<string, RouteLimitState>): Set<string> {
  const measured = new Set<string>()
  for (const [model, rows] of outcomesByKey(records, now, windowMs)) if (rows.length >= ROUTE_HEALTH.trialRequests) measured.add(model)
  for (const [model, state] of Object.entries(limits)) if ((state.totals?.requests ?? 0) >= ROUTE_HEALTH.trialRequests) measured.add(model)
  return measured
}

export type OutageCounts = { requests: number; failed: number; kinds: Partial<Record<FailureKind, number>> }
export type RouteOutage = {
  route: string
  state: "up" | "cooling" | "probing" | "out"
  why: string | null
  since: string | null
  until: string | null
  wait: WaitClass | null
  lastSuccessAt: string | null
  failures: { h1: OutageCounts; h24: OutageCounts }
  recent: OutageEvent[]
}
export type ProviderOutageRow = ProviderOutage & { state: "out" | "probing" }

function countsOf(rows: Outcome[], now: number, windowMs: number): OutageCounts {
  const kinds: Partial<Record<FailureKind, number>> = {}
  let requests = 0, failed = 0
  for (const row of rows) {
    if (now - row.startedAt > windowMs) continue
    requests++
    if (!isFailure(row.code)) continue
    failed++
    kinds[row.code as FailureKind] = (kinds[row.code as FailureKind] ?? 0) + 1
  }
  return { requests, failed, kinds }
}

function outageOf(key: string, rows: Outcome[], now: number, state: RouteLimitState | undefined, record: RouteLimitsRecord, events: OutageEvent[]): RouteOutage {
  const availability = availabilityOf(key, now, record), demoted = state?.demotion
  const outage = Object.values(record.providers ?? {}).find(item => item.routes.includes(key))
  const since = outage ? outage.since : demoted?.since ?? (availability.state === "out" ? state?.refusals.at(-1)?.at ?? null : null)
  return {
    route: key, state: availability.state, why: availability.reason, since, until: availability.until, wait: availability.state === "up" ? null : availability.cls,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    failures: { h1: countsOf(rows, now, HOUR_MS), h24: countsOf(rows, now, DAY_MS) },
    recent: events.filter(event => event.route === key).slice(-3),
  }
}

export function routeOutages(records: RequestRecord[], now = Date.now(), file = routeLimitsFile()): { routes: RouteOutage[]; providers: ProviderOutageRow[] } {
  const record = readRouteLimits(file), events = routeOutageEvents(file), rows = outcomesByKey(records, now, DAY_MS)
  const keys = new Set([...Object.keys(record.routes), ...rows.keys()])
  const routes = [...keys].sort().map(key => outageOf(key, rows.get(key) ?? [], now, record.routes[key], record, events))
  const providers = Object.values(record.providers ?? {}).map(outage => ({ ...outage, state: Date.parse(outage.until) > now ? "out" as const : "probing" as const }))
  return { routes, providers }
}
