import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { writeFileDurable } from '../core/durable-file.mjs'
import { backwardChunks, localDay, spanFiles } from '../../scripts/span-files.mjs'
import { TELEMETRY_BUDGET } from '../../scripts/telemetry-budget.mjs'

export const TREND_BUCKET_MILLISECONDS = 5 * 60_000
const STEP = Math.log(1.01)
const KEEP_DAYS = 14
const OPERATIONS = ['request', 'tool.execute', 'tool.call', 'host.event', 'event', 'quests.api', 'process']

const VERSION = 2

type Series = { n: number; b: Record<string, number> }
type ModelTotals = { calls: number; tokenCalls: number; tokens: number; milliseconds: number }
type Day = { count: number; names: Record<string, Series>; trends: Record<string, Series>; models: Record<string, ModelTotals> }
export type SpanState = { version: number; files: Record<string, number>; days: Record<string, Day> }

const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const bucketOf = (value: number) => Math.round(Math.log1p(value) / STEP)
const valueOf = (bucket: number) => Math.expm1(bucket * STEP)
const emptyState = (): SpanState => ({ version: VERSION, files: {}, days: {} })

export const startOf = (row: Record<string, unknown>) => number(row.start) ?? number(row.at) ?? number(row.created) ?? number(row.observed)
export const spanGroup = (row: Record<string, any>) => [row.plugin ?? row.kind, row.name ?? row.type, OPERATIONS.includes(row.name) ? row.op : undefined].filter(Boolean).join(' · ')

function addTo(series: Series | undefined, value: number): Series {
  const next = series ?? { n: 0, b: {} }
  const key = String(bucketOf(value))
  next.n++
  next.b[key] = (next.b[key] ?? 0) + 1
  return next
}

function mergeSeries(a: Series | undefined, b: Series): Series {
  const merged = { n: (a?.n ?? 0) + b.n, b: { ...a?.b } }
  for (const [key, count] of Object.entries(b.b)) merged.b[key] = (merged.b[key] ?? 0) + count
  return merged
}

function addRow(state: SpanState, line: string) {
  let row: Record<string, any>
  try { row = JSON.parse(line) } catch { return }
  if (row?.v !== 1 || row.kind === 'location') return
  const start = startOf(row)
  if (start === undefined) return
  const day = state.days[localDay(start)] ??= { count: 0, names: {}, trends: {}, models: {} }
  day.count++
  const end = number(row.end)
  if (end === undefined) return
  const duration = Math.max(0, end - start)
  const name = spanGroup(row)
  day.names[name] = addTo(day.names[name], duration)
  const trend = name + '\0' + Math.floor(start / TREND_BUCKET_MILLISECONDS) * TREND_BUCKET_MILLISECONDS
  day.trends[trend] = addTo(day.trends[trend], duration)
  if (row.name === 'model.call' && typeof row.route === 'string') {
    const model = day.models[row.route + '\0' + (row.harness ?? 'OpenCode')] ??= { calls: 0, tokenCalls: 0, tokens: 0, milliseconds: 0 }
    const tokens = number(row.tokens)
    model.calls++
    if (tokens !== undefined) { model.tokenCalls++; model.tokens += tokens; model.milliseconds += duration }
  }
}

function readRange(file: string, from: number, to: number) {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(to - from)
    readSync(fd, buffer, 0, buffer.length, from)
    return buffer
  } finally { closeSync(fd) }
}

function sourcesOf(file: string) {
  return existsSync(file) ? [file, ...spanFiles(file)] : spanFiles(file)
}

function enforceAggregateBudget(state: SpanState) {
  const days = Object.keys(state.days).sort()
  for (const day of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete state.days[day]
  let text = JSON.stringify(state)
  while (Buffer.byteLength(text) > TELEMETRY_BUDGET.spanAggregateBytes && Object.keys(state.days).length > 1) {
    delete state.days[Object.keys(state.days).sort()[0]!]
    text = JSON.stringify(state)
  }
  return text
}

function writeState(path: string, state: SpanState) {
  writeFileDurable(path, enforceAggregateBudget(state))
}

export function foldSpans(file: string): SpanState {
  const path = file + '.aggregate.json'
  const sources = sourcesOf(file)
  let state: SpanState = emptyState()
  try { state = JSON.parse(readFileSync(path, 'utf8')) as SpanState } catch {}
  if (state.version !== VERSION) state = emptyState()
  const sizes = sources.map(source => statSync(source).size)
  if (sources.some((source, index) => sizes[index]! < (state.files[source] ?? 0))) state = emptyState()
  let changed = false
  sources.forEach((source, index) => {
    const size = sizes[index]!, at = state.files[source] ?? 0
    if (size <= at) return
    const data = readRange(source, at, size)
    const last = data.lastIndexOf(10)
    if (last < 0) return
    for (const line of data.subarray(0, last).toString('utf8').split('\n')) addRow(state, line)
    state.files[source] = at + last + 1
    changed = true
  })
  if (changed) writeState(path, state)
  return state
}

type Stats = Record<'count' | 'p05' | 'p10' | 'p25' | 'p50' | 'p75' | 'p90' | 'p95' | 'p99', number | null>
export function statsOf(series: Series): Stats {
  const keys = Object.keys(series.b).map(Number).sort((a, b) => a - b)
  const at = (part: number) => {
    if (!series.n) return null
    const rank = Math.max(1, Math.ceil(part * series.n))
    let seen = 0
    for (const key of keys) {
      seen += series.b[String(key)]!
      if (seen >= rank) return Math.round(valueOf(key) * 10) / 10
    }
    return null
  }
  return { count: series.n, p05: at(.05), p10: at(.1), p25: at(.25), p50: at(.5), p75: at(.75), p90: at(.9), p95: at(.95), p99: at(.99) }
}

export function windowOf(state: SpanState, from: number, to: number) {
  const first = localDay(from), last = localDay(to), floor = Math.floor(from / TREND_BUCKET_MILLISECONDS) * TREND_BUCKET_MILLISECONDS
  let count = 0
  const names = new Map<string, Series>(), trends = new Map<string, Series>(), models = new Map<string, ModelTotals>()
  for (const [day, value] of Object.entries(state.days)) {
    if (day < first || day > last) continue
    count += value.count
    for (const [key, total] of Object.entries(value.models ?? {})) {
      const merged = models.get(key) ?? { calls: 0, tokenCalls: 0, tokens: 0, milliseconds: 0 }
      models.set(key, { calls: merged.calls + total.calls, tokenCalls: merged.tokenCalls + total.tokenCalls, tokens: merged.tokens + total.tokens, milliseconds: merged.milliseconds + total.milliseconds })
    }
    for (const [name, series] of Object.entries(value.names)) names.set(name, mergeSeries(names.get(name), series))
    for (const [key, series] of Object.entries(value.trends)) {
      const start = Number(key.slice(key.lastIndexOf('\0') + 1))
      if (start >= floor && start <= to) trends.set(key, mergeSeries(trends.get(key), series))
    }
  }
  return { count, names, trends, models }
}

export function recentRows(file: string, from: number, to: number, limit: number): Record<string, any>[] {
  const rows: Record<string, any>[] = []
  const calls = new Map<string, { start: number; route?: string; harness?: string }[]>()
  const sources = [...(existsSync(file) ? [file] : []), ...spanFiles(file, { from, to }).reverse()]
  for (const source of sources) {
    for (const lines of backwardChunks(source)) {
      let newest = -Infinity
      for (const line of lines) {
        const full = rows.length >= limit
        if (full && !line.includes('"model.call"')) continue
        let row: Record<string, any>
        try { row = JSON.parse(line) } catch { continue }
        if (row?.v !== 1 || row.kind === 'location') continue
        const start = startOf(row)
        if (start === undefined) continue
        newest = Math.max(newest, start)
        if (start < from || start > to) continue
        if (!full) rows.push({ ...row, start })
        if (row.name === 'model.call' && typeof row.sessionID === 'string') {
          const list = calls.get(row.sessionID) ?? []
          list.push({ start, route: row.route, harness: row.harness })
          calls.set(row.sessionID, list)
        }
      }
      if (newest !== -Infinity && newest < from) break
    }
  }
  for (const list of calls.values()) list.sort((a, b) => a.start - b.start)
  const routeAt = (sessionID: unknown, start: number) => {
    const list = typeof sessionID === 'string' ? calls.get(sessionID) : undefined
    if (!list) return undefined
    const before = list.filter(call => call.start <= start).at(-1) ?? list[0]!
    return { route: before.route, harness: before.harness }
  }
  return rows.map(row => {
    const end = number(row.end)
    return { ...routeAt(row.sessionID, row.start), ...row, ...(end === undefined ? {} : { duration: Math.max(0, end - row.start) }) }
  }).sort((a, b) => b.start - a.start)
}
