import { existsSync, mkdirSync, readFileSync } from "node:fs"
import {writeFileDurable} from "../quest/core/durable-file.mjs"
import { dirname } from "node:path"
import { acquireLock } from "../quest/locking.mts"
import { outputIncludingReasoning, type RequestRecord } from "./telemetry"
import { readRequestsSinceAsync, TELEMETRY_FILE, type TelemetryCursor } from "./telemetry-store"
import { peerTelemetryFiles } from "./pooled-evidence"

export type SpeedBasis = "measured" | "calibration" | "published"
export type RateBasis = "stream" | "whole call"
export type RouteSpeed = { tokensPerSecond: number | null; rate: RateBasis | null; firstTokenMilliseconds: number | null; secondsPerCall: number | null; timedRequests: number; waitSamples: number; basis: SpeedBasis; measuredAt: string; via?: string }
export type Calibration = { sessionID?: string; requestedAt: number; state: "pending" | "measured" | "failed"; reason?: string; tokensPerSecond?: number; rate?: RateBasis; firstTokenMilliseconds?: number; outputTokens?: number; measuredAt?: number }
type Day = { rates: [number, number, 0 | 1][]; waits: number[]; calls: number[]; last: number }
type Store = { version: 3; cursor: TelemetryCursor | null; routes: Record<string, Record<string, Day>>; calibrations: Record<string, Calibration> }

export const routeSpeedsFile = () => process.env.OPENCODE_ROUTE_SPEEDS_FILE ?? TELEMETRY_FILE + ".speeds.json"
export const speedKey = (route: { providerID: string; modelID: string; reasoning?: string; variant?: string }) =>
  route.providerID + "/" + route.modelID + "#" + String(route.reasoning ?? route.variant ?? "default").toLowerCase()
export const modelEffortKey = (key: string) => key.slice(key.indexOf("/") + 1)
const recordKey = (record: RequestRecord) => speedKey({ providerID: record.route.providerID, modelID: record.route.modelID, reasoning: record.route.variant ?? record.route.reasoning })
const empty = (): Store => ({ version: 3, cursor: null, routes: {}, calibrations: {} })
export const tokenWeightedMedian = (samples: [number, number][]) => {
  const sorted = [...samples].sort((a, b) => a[0] - b[0]), total = sorted.reduce((n, sample) => n + sample[1], 0)
  let seen = 0
  for (const [rate, tokens] of sorted) { seen += tokens; if (seen >= total / 2) return rate }
  return null
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : null }

function load(file: string): Store {
  if (!existsSync(file)) return empty()
  let value: { version?: number; routes?: unknown; calibrations?: Record<string, Calibration> }
  try { value = JSON.parse(readFileSync(file, "utf8")) } catch { return empty() }
  if (value?.version === 3 && value.routes && value.calibrations) return value as Store
  const kept = Object.fromEntries(Object.entries(value?.calibrations ?? {}).map(([key, c]) => [key, c.state === "measured" && c.sessionID ? { sessionID: c.sessionID, requestedAt: c.requestedAt, state: "pending" as const } : c]))
  return { ...empty(), calibrations: kept }
}
function save(file: string, store: Store) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileDurable(file, JSON.stringify(store), { mode: 0o600 })
}
function locked<T>(file: string, change: (store: Store) => T): T {
  const lock = acquireLock(dirname(file), "route-speeds")
  try { const store = load(file), result = change(store); save(file, store); return result } finally { lock.release() }
}

export function timing(record: RequestRecord) {
  const tokens = outputIncludingReasoning(record)
  if (record.state !== "completed" || record.firstResponseAt === undefined || record.firstResponseAt < record.startedAt || record.completedAt === undefined || record.completedAt <= record.startedAt || tokens === null || tokens <= 0) return null
  const call = record.completedAt - record.startedAt
  const window = record.lastOutputAt !== undefined && record.lastOutputAt > record.firstResponseAt ? record.lastOutputAt - record.firstResponseAt : 0
  const streamed = window * 2 >= call
  return { wait: record.firstResponseAt - record.startedAt, call, tokens, streamed, tokensPerSecond: tokens / ((streamed ? window : call) / 1000) }
}

export function absorb(store: Store, records: RequestRecord[]) {
  const calibrating = new Map(Object.entries(store.calibrations).flatMap(([key, c]) => c.sessionID ? [[c.sessionID, key] as const] : []))
  for (const record of records) {
    const measured = timing(record)
    if (!measured) continue
    const calibration = calibrating.get(record.sessionID)
    if (calibration) {
      const entry = store.calibrations[calibration]
      if (entry.state === "measured") continue
      store.calibrations[calibration] = { ...entry, state: "measured", outputTokens: measured.tokens, tokensPerSecond: measured.tokensPerSecond, rate: measured.streamed ? "stream" : "whole call", firstTokenMilliseconds: measured.wait, measuredAt: record.completedAt ?? record.startedAt }
      continue
    }
    const key = recordKey(record), day = new Date(record.startedAt).toISOString().slice(0, 10)
    const days = store.routes[key] ??= {}, bucket = days[day] ??= { rates: [], waits: [], calls: [], last: 0 }
    bucket.waits.push(measured.wait)
    bucket.calls.push(measured.call)
    bucket.rates.push([measured.tokensPerSecond, measured.tokens, measured.streamed ? 1 : 0])
    bucket.last = Math.max(bucket.last, record.completedAt ?? record.startedAt)
  }
}

export function speedsOf(store: Pick<Store, "routes" | "calibrations">, now: number, maxAgeDays: number): Map<string, RouteSpeed> {
  const since = new Date(now - maxAgeDays * 86400000).toISOString().slice(0, 10)
  const speeds = new Map<string, RouteSpeed>()
  for (const [key, days] of Object.entries(store.routes)) {
    const recent = Object.entries(days).filter(([day]) => day >= since).map(([, bucket]) => bucket)
    const rates = recent.flatMap(b => b.rates), waits = recent.flatMap(b => b.waits), calls = recent.flatMap(b => b.calls)
    if (!rates.length) continue
    const streamedTokens = rates.filter(r => r[2]).reduce((n, r) => n + r[1], 0), allTokens = rates.reduce((n, r) => n + r[1], 0)
    const rate: RateBasis = streamedTokens * 2 >= allTokens ? "stream" : "whole call"
    const chosen = rates.filter(r => (r[2] === 1) === (rate === "stream")).map(r => [r[0], r[1]] as [number, number])
    speeds.set(key, { tokensPerSecond: tokenWeightedMedian(chosen), rate, firstTokenMilliseconds: median(waits), secondsPerCall: calls.length ? median(calls)! / 1000 : null, timedRequests: rates.length, waitSamples: waits.length, basis: "measured", measuredAt: new Date(Math.max(...recent.map(b => b.last))).toISOString() })
  }
  for (const [key, c] of Object.entries(store.calibrations)) {
    if (c.state !== "measured" || !c.tokensPerSecond || speeds.has(key)) continue
    speeds.set(key, { tokensPerSecond: c.tokensPerSecond, rate: c.rate ?? null, firstTokenMilliseconds: c.firstTokenMilliseconds ?? null, secondsPerCall: null, timedRequests: 1, waitSamples: 1, basis: "calibration", measuredAt: new Date(c.measuredAt ?? c.requestedAt).toISOString() })
  }
  return speeds
}

export function speedFor(speeds: Map<string, RouteSpeed>, key: string): RouteSpeed | undefined {
  const own = speeds.get(key)
  if (own?.basis === "measured") return own
  const same = modelEffortKey(key)
  const elsewhere = [...speeds].filter(([other, speed]) => other !== key && speed.basis === "measured" && modelEffortKey(other) === same).sort((a, b) => b[1].timedRequests - a[1].timedRequests)[0]
  if (elsewhere) return { ...elsewhere[1], via: elsewhere[0].slice(0, elsewhere[0].indexOf("/")) }
  return own
}

let inFlight: Promise<void> | undefined
async function catchUp(file: string, telemetry: string) {
  const before = load(file)
  const read = await readRequestsSinceAsync(before.cursor, telemetry)
  locked(file, store => {
    if (JSON.stringify(store.cursor) !== JSON.stringify(before.cursor)) return
    if (read.restarted && before.cursor) store.routes = {}
    absorb(store, read.records)
    store.cursor = read.cursor
  })
}
export async function catchUpSpeeds(file = routeSpeedsFile(), telemetry = TELEMETRY_FILE) {
  if (file !== routeSpeedsFile() || telemetry !== TELEMETRY_FILE) return catchUp(file, telemetry)
  inFlight ??= catchUp(file, telemetry).finally(() => { inFlight = undefined })
  return inFlight
}
export function pooledStore(own: Store, peers: Store[]): Store {
  const routes: Store["routes"] = {}, calibrations: Store["calibrations"] = {}
  for (const store of [own, ...peers]) {
    for (const [key, days] of Object.entries(store.routes)) for (const [day, bucket] of Object.entries(days)) {
      const into = (routes[key] ??= {})[day] ??= { rates: [], waits: [], calls: [], last: 0 }
      into.rates.push(...bucket.rates); into.waits.push(...bucket.waits); into.calls.push(...bucket.calls); into.last = Math.max(into.last, bucket.last)
    }
    for (const [key, calibration] of Object.entries(store.calibrations)) if (!calibrations[key] || calibrations[key].state !== "measured" && calibration.state === "measured") calibrations[key] = calibration
  }
  return { ...own, routes, calibrations }
}
export const peerSpeedFiles = () => peerTelemetryFiles().map(file => file + ".speeds.json")
export async function measuredRouteSpeeds(options: { now?: number; maxAgeDays: number; file?: string; telemetry?: string; peers?: string[] }) {
  const file = options.file ?? routeSpeedsFile()
  await catchUpSpeeds(file, options.telemetry ?? TELEMETRY_FILE)
  const peers = (options.peers ?? (options.file ? [] : peerSpeedFiles())).filter(peer => existsSync(peer)).map(load)
  const store = pooledStore(load(file), peers)
  return { speeds: speedsOf(store, options.now ?? Date.now(), options.maxAgeDays), calibrations: store.calibrations, pooledChannels: peers.length }
}
export function pooledCalibrations(file = routeSpeedsFile(), peers = peerSpeedFiles()) { return pooledStore(load(file), peers.filter(peer => existsSync(peer)).map(load)).calibrations }

export function calibrations(file = routeSpeedsFile()) { return load(file).calibrations }
export function claimCalibration(key: string, now: number, file = routeSpeedsFile(), processStartedAt = performance.timeOrigin, again = false, peers = file === routeSpeedsFile() ? peerSpeedFiles() : []): boolean {
  if (!again && peers.some(peer => existsSync(peer) && load(peer).calibrations[key]?.state === "measured")) return false
  return locked(file, store => {
    const prior = store.calibrations[key], inFlight = prior?.state === "pending" && prior.requestedAt >= processStartedAt
    if (prior && (inFlight || !again && prior.state === "measured")) return false
    store.calibrations[key] = { requestedAt: now, state: "pending" }
    return true
  })
}
export function calibrationSession(key: string, sessionID: string, file = routeSpeedsFile()) {
  locked(file, store => { const c = store.calibrations[key]; if (c) c.sessionID = sessionID })
}
export function calibrationFailed(key: string, reason: string, file = routeSpeedsFile()) {
  locked(file, store => { const c = store.calibrations[key]; if (c && c.state !== "measured") Object.assign(c, { state: "failed", reason: reason.slice(0, 300) }) })
}
