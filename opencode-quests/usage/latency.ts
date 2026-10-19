import { open } from "node:fs/promises"
import { TELEMETRY_FILE } from "./telemetry-store"
import { SPANS_FILE } from "../scripts/span-store"
import { spanFiles } from "../scripts/span-files.mjs"

export const LATENCY_GROUPS = ["front", "connection", "dispatch", "checks", "host"] as const
export type LatencyGroup = typeof LATENCY_GROUPS[number]
export type ModelLatency = { model: string; kind: string; count: number; median: number; p90: number; max: number; outputTokensPerSecond: number | null }
export type SpanLatency = { group: LatencyGroup; span: string; count: number; mean: number; max: number; total: number; errors: number }
export type ModelPoint = { start: number; model: string; count: number; median: number; p90: number }
export type SpanPoint = { start: number; group: LatencyGroup; span: string; count: number; mean: number; max: number }
export type LatencyPicture = { at: number; from: number; window: string; bucketMilliseconds: number; models: ModelLatency[]; spans: SpanLatency[]; overTime: { models: ModelPoint[]; spans: SpanPoint[] }; text: string; diagnostics: string[] }
export type LatencySources = { telemetryFile?: string; spansFile?: string; now?: () => number }

const WINDOW = /^-?(\d+(?:\.\d+)?)(s|m|h|d)$/
const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
export const DEFAULT_LATENCY_WINDOW = "30m"

export function latencyWindow(text: string | undefined) {
  const label = (text ?? DEFAULT_LATENCY_WINDOW).trim()
  const match = label.match(WINDOW)
  if (!match || !(Number(match[1]) > 0)) throw Error("window: give a length such as 15m, 30m, 2h or 1d; " + label + " is not one")
  return { label: label.replace(/^-/, ""), milliseconds: Number(match[1]) * UNIT[match[2]] }
}

const CHUNK = 16 * 1024 * 1024

export async function readRowsSince(file: string, since: number, written: (row: any) => number | undefined, accept: (row: any) => boolean) {
  const rows: any[] = []
  let handle
  try { handle = await open(file, "r") } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return rows; throw error }
  try {
    let position = (await handle.stat()).size, carry = ""
    while (position > 0) {
      const start = Math.max(0, position - CHUNK), buffer = Buffer.alloc(position - start)
      await handle.read(buffer, 0, buffer.length, start)
      position = start
      const lines = (buffer.toString("utf8") + carry).split("\n")
      carry = position > 0 ? lines.shift() ?? "" : ""
      let newest = -Infinity
      for (const line of lines) {
        if (!line) continue
        let row: any
        try { row = JSON.parse(line) } catch { continue }
        const at = written(row)
        if (at !== undefined && at > newest) newest = at
        if (accept(row)) rows.push(row)
      }
      if (newest !== -Infinity && newest < since) break
    }
  } finally { await handle.close() }
  return rows
}

async function spanRowsSince(file: string, from: number) {
  const rows = await Promise.all([...spanFiles(file, { from }), file].map(day => readRowsSince(day, from, row => row?.kind === "agg" ? row.to : row?.end, row =>
    row?.kind === "span" && row.start >= from && row.end >= row.start || row?.kind === "agg" && row.from >= from && row.total > 0)))
  return rows.flat()
}

const percentile = (sorted: number[], fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
const tenth = (value: number) => Math.round(value * 10) / 10
const RUN_KEYED = /^(dispatch\.|return\.|continuation: |start admission: )/

export function spanKey(row: { plugin?: string; name?: string; op?: string }): { group: LatencyGroup; span: string } {
  const plugin = String(row.plugin ?? ""), name = String(row.name ?? ""), op = String(row.op ?? "")
  if (plugin === "quests" && (name === "read.api" || name === "front.api")) return { group: "front", span: op || name }
  if (plugin === "connector" && name === "connection") return { group: "connection", span: op }
  if (name === "startup") return { group: "connection", span: plugin + " startup " + op }
  if (name.startsWith("dispatch.")) return { group: "dispatch", span: name.slice("dispatch.".length) }
  if (plugin === "checks") return { group: "checks", span: name }
  return { group: "host", span: [plugin, name, RUN_KEYED.test(name) ? "" : op.slice(0, 40)].filter(Boolean).join(" / ") }
}

function modelKey(row: any) { return { model: (row.route?.modelID ?? "?") + (row.route?.variant ? "#" + row.route.variant : ""), kind: String(row.kind ?? "") } }

export async function latencyPicture(input: { window?: string } = {}, sources: LatencySources = {}): Promise<LatencyPicture> {
  const at = (sources.now ?? Date.now)(), window = latencyWindow(input.window), from = at - window.milliseconds
  const bucketMilliseconds = Math.max(60_000, Math.ceil(window.milliseconds / 30 / 60_000) * 60_000)
  const bucket = (time: number) => Math.floor(time / bucketMilliseconds) * bucketMilliseconds
  const diagnostics: string[] = []
  const [requests, spans] = await Promise.all([
    readRowsSince(sources.telemetryFile ?? process.env.OPENCODE_TELEMETRY_FILE ?? TELEMETRY_FILE, from, row => row?.request?.recordedAt, row => {
      const request = row?.request
      return request?.state === "completed" && request.startedAt >= from && request.recordedAt >= request.startedAt
    }).catch(error => { diagnostics.push("model calls unread: " + (error instanceof Error ? error.message : String(error))); return [] }),
    spanRowsSince(sources.spansFile ?? process.env.OPENCODE_SPANS_FILE ?? SPANS_FILE, from).catch(error => { diagnostics.push("host spans unread: " + (error instanceof Error ? error.message : String(error))); return [] }),
  ])

  const calls = new Map<string, { model: string; kind: string; values: number[]; output: number }>()
  const callPoints = new Map<string, { start: number; model: string; values: number[] }>()
  for (const { request } of requests) {
    const key = modelKey(request), duration = request.recordedAt - request.startedAt, id = key.model + " " + key.kind
    const entry = calls.get(id) ?? calls.set(id, { ...key, values: [], output: 0 }).get(id)!
    entry.values.push(duration); entry.output += request.tokens?.output ?? 0
    const start = bucket(request.startedAt), point = callPoints.get(key.model + "\0" + start) ?? callPoints.set(key.model + "\0" + start, { start, model: key.model, values: [] }).get(key.model + "\0" + start)!
    point.values.push(duration)
  }
  const models = [...calls.values()].sort((a, b) => b.values.length - a.values.length).map(entry => {
    const sorted = entry.values.toSorted((a, b) => a - b), total = sorted.reduce((sum, value) => sum + value, 0)
    return { model: entry.model, kind: entry.kind, count: sorted.length, median: percentile(sorted, .5), p90: percentile(sorted, .9), max: sorted.at(-1)!, outputTokensPerSecond: total ? tenth(entry.output / (total / 1000)) : null }
  })

  const totals = new Map<string, SpanLatency>(), spanPoints = new Map<string, SpanPoint & { total: number }>()
  for (const row of spans) {
    const key = spanKey(row), id = key.group + "\0" + key.span
    const single = row.kind === "span", count = single ? 1 : row.count, total = single ? row.end - row.start : row.total, max = single ? total : row.max
    const entry = totals.get(id) ?? totals.set(id, { ...key, count: 0, mean: 0, max: 0, total: 0, errors: 0 }).get(id)!
    entry.count += count; entry.total += total; entry.max = Math.max(entry.max, max); if (single && row.error) entry.errors++
    const start = bucket(single ? row.start : row.from), pointID = id + "\0" + start
    const point = spanPoints.get(pointID) ?? spanPoints.set(pointID, { start, ...key, count: 0, mean: 0, max: 0, total: 0 }).get(pointID)!
    point.count += count; point.total += total; point.max = Math.max(point.max, max)
  }
  const shown = (entry: SpanLatency) => entry.group !== "host" || entry.max >= 1000
  const spanRows = [...totals.values()].filter(shown).map(entry => ({ ...entry, mean: tenth(entry.total / entry.count), max: tenth(entry.max), total: tenth(entry.total) }))
    .sort((a, b) => LATENCY_GROUPS.indexOf(a.group) - LATENCY_GROUPS.indexOf(b.group) || b.max - a.max)
  const kept = new Set(spanRows.map(row => row.group + "\0" + row.span))
  const overTime = {
    models: [...callPoints.values()].map(point => { const sorted = point.values.toSorted((a, b) => a - b); return { start: point.start, model: point.model, count: sorted.length, median: percentile(sorted, .5), p90: percentile(sorted, .9) } }).sort((a, b) => a.start - b.start),
    spans: [...spanPoints.values()].filter(point => kept.has(point.group + "\0" + point.span)).map(({ total, ...point }) => ({ ...point, mean: tenth(total / point.count), max: tenth(point.max) })).sort((a, b) => a.start - b.start),
  }
  const slowest = spanRows.filter(row => row.group === "host").sort((a, b) => b.max - a.max)[0], busiest = models[0]
  const text = "In the last " + window.label + ": " + requests.length + " model calls" + (busiest ? ", the most on " + busiest.model + " with a median of " + (busiest.median / 1000).toFixed(1) + " s and a p90 of " + (busiest.p90 / 1000).toFixed(1) + " s" : "") + "; " + spanRows.length + " span types" + (slowest ? ", the slowest host span " + slowest.span + " at " + (slowest.max / 1000).toFixed(1) + " s" : "") + "."
  return { at, from, window: window.label, bucketMilliseconds, models, spans: spanRows, overTime, text, diagnostics }
}
