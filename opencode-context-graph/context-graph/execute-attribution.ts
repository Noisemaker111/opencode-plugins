import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { hostDatabaseFile, type MessageRow } from "./context-graph"

export type InnerCallStatus = "completed" | "error" | "interrupted"

export type InnerCallRecord = {
  tool: string
  start: number
  end: number
  status: InnerCallStatus
}

export type ExecuteSpan = {
  sessionID: string
  seq: number
  callID: string
  status: string
  durationMs: number
  queuedMs: number
  calls: number
  untimed: { tool: string; status: string }[]
  inner: InnerCallRecord[]
  attributedMs: number
  unaccountedMs: number
  startupMs: number
  betweenMs: number
  tailMs: number
  timed: boolean
  aborted: boolean
}

const isAborted = (part: any) => part?.state?.status === "error" && part?.state?.error?.type === "aborted"

export type InnerToolStat = {
  tool: string
  calls: number
  errors: number
  totalMs: number
  medianMs: number
  p95Ms: number
  maxMs: number
}

export type AttributionTotals = {
  executes: number
  timed: number
  untimed: number
  untimedCalls: Record<string, number>
  untimedRejected: number
  aborted: number
  abortedMs: number
  spanMs: number
  attributedMs: number
  unaccountedMs: number
  startupMs: number
  betweenMs: number
  tailMs: number
  coverage: number
  coverageOfAll: number
}

export function mergedLength(spans: { start: number; end: number }[]): number {
  const sorted = spans.filter(span => span.end > span.start).sort((a, b) => a.start - b.start)
  let total = 0, start = 0, end = -1
  for (const span of sorted) {
    if (span.start > end) { total += Math.max(0, end - start); start = span.start; end = span.end; continue }
    if (span.end > end) end = span.end
  }
  return total + Math.max(0, end - start)
}

const asRecord = (value: unknown): InnerCallRecord | undefined => {
  if (!value || typeof value !== "object") return undefined
  const { tool, start, end, status } = value as Record<string, unknown>
  if (typeof tool !== "string" || typeof start !== "number" || typeof end !== "number") return undefined
  return { tool, start, end, status: status === "error" || status === "interrupted" ? status : "completed" }
}

export function attributeExecutePart(part: any, sessionID: string, seq: number): ExecuteSpan | undefined {
  if (part?.type !== "tool" || part.name !== "execute") return undefined
  const time = part.time ?? {}
  const began = time.ran ?? time.created
  if (typeof began !== "number" || typeof time.completed !== "number") return undefined
  const metadata = part.state?.metadata ?? {}
  const inner = (Array.isArray(metadata.innerCalls) ? metadata.innerCalls : []).flatMap((value: unknown) => {
    const record = asRecord(value)
    return record ? [record] : []
  })
  const clamped = inner.map(record => ({
    start: Math.max(record.start, began),
    end: Math.min(record.end, time.completed),
  }))
  const durationMs = time.completed - began
  const attributedMs = Math.min(durationMs, mergedLength(clamped))
  const first = clamped.length ? Math.min(...clamped.map(span => span.start)) : time.completed
  const last = clamped.length ? Math.max(...clamped.map(span => span.end)) : time.completed
  const startupMs = inner.length ? first - began : 0
  const tailMs = inner.length ? time.completed - last : 0
  const named = (Array.isArray(metadata.toolCalls) ? metadata.toolCalls : [])
    .map((call: any) => ({ tool: String(call?.tool ?? "unknown"), status: String(call?.status ?? "unknown") }))
  const calls = named.length || inner.length
  const untimed = [...named]
  for (const record of inner) {
    const at = untimed.findIndex(call => call.tool === record.tool)
    if (at >= 0) untimed.splice(at, 1)
  }
  return {
    sessionID,
    seq,
    callID: String(part.id ?? ""),
    status: String(part.state?.status ?? "unknown"),
    durationMs,
    queuedMs: typeof time.ran === "number" && typeof time.created === "number" ? time.ran - time.created : 0,
    calls,
    untimed,
    inner,
    attributedMs,
    unaccountedMs: durationMs - attributedMs,
    startupMs,
    betweenMs: inner.length ? durationMs - attributedMs - startupMs - tailMs : 0,
    tailMs,
    timed: inner.length > 0,
    aborted: isAborted(part),
  }
}

export function executeSpans(messages: MessageRow[], sessionID: string): ExecuteSpan[] {
  const spans: ExecuteSpan[] = []
  for (const message of messages) {
    if (message.type !== "assistant") continue
    let data: any
    try { data = JSON.parse(message.data) } catch { continue }
    for (const part of data.content ?? []) {
      const span = attributeExecutePart(part, sessionID, message.seq)
      if (span) spans.push(span)
    }
  }
  return spans
}

const quantile = (values: number[], fraction: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

export function innerToolStats(spans: ExecuteSpan[]): InnerToolStat[] {
  const byTool = new Map<string, { durations: number[]; errors: number }>()
  for (const span of spans) {
    for (const call of span.inner) {
      const entry = byTool.get(call.tool) ?? { durations: [], errors: 0 }
      entry.durations.push(Math.max(0, call.end - call.start))
      if (call.status === "error") entry.errors++
      byTool.set(call.tool, entry)
    }
  }
  return [...byTool.entries()]
    .map(([tool, entry]) => ({
      tool,
      calls: entry.durations.length,
      errors: entry.errors,
      totalMs: entry.durations.reduce((n, value) => n + value, 0),
      medianMs: quantile(entry.durations, 0.5),
      p95Ms: quantile(entry.durations, 0.95),
      maxMs: Math.max(...entry.durations),
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
}

export function attributionTotals(all: ExecuteSpan[]): AttributionTotals {
  const abortedSpans = all.filter(span => span.aborted)
  const spans = all.filter(span => !span.aborted)
  const timed = spans.filter(span => span.timed)
  const spanMs = spans.reduce((n, span) => n + span.durationMs, 0)
  const attributedMs = spans.reduce((n, span) => n + span.attributedMs, 0)
  const timedSpanMs = timed.reduce((n, span) => n + span.durationMs, 0)
  const sum = (pick: (span: ExecuteSpan) => number) => spans.reduce((n, span) => n + pick(span), 0)
  const untimedCalls: Record<string, number> = {}
  let untimedRejected = 0
  for (const span of spans) for (const call of span.untimed) {
    untimedCalls[call.tool] = (untimedCalls[call.tool] ?? 0) + 1
    if (call.status === "error") untimedRejected++
  }
  return {
    executes: spans.length,
    timed: timed.length,
    untimed: spans.length - timed.length,
    untimedCalls,
    untimedRejected,
    aborted: abortedSpans.length,
    abortedMs: abortedSpans.reduce((n, span) => n + span.durationMs, 0),
    spanMs,
    attributedMs,
    unaccountedMs: spanMs - attributedMs,
    startupMs: sum(span => span.startupMs),
    betweenMs: sum(span => span.betweenMs),
    tailMs: sum(span => span.tailMs),
    coverage: timedSpanMs ? attributedMs / timedSpanMs : 0,
    coverageOfAll: spanMs ? attributedMs / spanMs : 0,
  }
}

export function readExecuteSpans(options: { file?: string; sessionID?: string } = {}): { file: string; spans: ExecuteSpan[] } {
  const file = options.file ?? hostDatabaseFile()
  if (!existsSync(file)) throw new Error("No session database at " + file)
  const db = new Database(file, { readonly: true })
  try {
    db.exec("PRAGMA busy_timeout=1000")
    const rows = (options.sessionID
      ? db.query("select session_id,type,seq,data from session_message where type='assistant' and session_id=? order by seq").all(options.sessionID)
      : db.query("select session_id,type,seq,data from session_message where type='assistant' order by session_id,seq").all()) as (MessageRow & { session_id: string })[]
    const spans = rows.flatMap(row => executeSpans([row], row.session_id))
    return { file, spans }
  } finally { db.close() }
}
