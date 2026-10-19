import { createRequire } from "node:module"
import type { Database } from "bun:sqlite"
import { gapPrice } from "./price-book"
import { pricedRequest, roleTokens, type PriceLookup, type RoleTokens, type RunPoints } from "./run-telemetry"
import { requestRates, type RequestRecord, type Tokens } from "./telemetry"
import { toolKind } from "./worker-time"

export const TRACE_LIMITS = { turns: 300, tools: 300, largest: 5 }
export const TRACE_BUCKET_RANK = { tool: 10, toolWait: 20, startup: 30, thinking: 40, send: 50, streaming: 60, landing: 70, between: 80, startupGap: 90, queue: 100, route: 110, giverModel: 115, admissionHold: 116, beforeStart: 117, plan: 120 } as const
const PART_NAMES = { plan: ["before-start", "admission-hold", "giver-model"], "start-up": ["claim-to-spawn", "workspace", "first-token"] } as const
const OTHER = "other"
const REASON_LIMIT = 160
const TOKEN_KEYS = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const satisfies readonly (keyof Tokens)[]
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const at = (value: string | undefined | null) => { const parsed = Date.parse(value ?? ""); return Number.isFinite(parsed) ? parsed : undefined }

export type HostTool = { name: string; status: string; created: number | null; ran: number | null; completed: number | null; inputBytes: number; output: string; outputBytes: number; command: string | null; exit: number | null }
export type HostMessage = { type: string; created: number; streamed: number | null; completed: number | null; finish: string | null; thinking: { start: number; end: number }[]; tools: HostTool[] }
export type HostSession = { messages: HostMessage[]; createdAt: number | null; compactingAt: number | null }
export type WorkspaceStage = { stage: string; start: number; end: number }
export type RunAdmission = { queuedAt: string; held: boolean; reason: string | null }
export type RunTraceInput = {
  questID: string; runID: string; state: string
  points: RunPoints
  landingAt?: string
  workspace?: WorkspaceStage[]
  admission?: RunAdmission
  giver?: RequestRecord[]
  requests: RequestRecord[]
  session: HostSession | null
  lookup?: PriceLookup
  count?: (text: string) => number
}
export type TurnTrace = { at: number; state: string; admitMs: number | null; sendMs: number | null; firstOutMs: number | null; thinkMs: number | null; streamMs: number | null; totalMs: number; finish: string | null; retries: number; tokens: Tokens; context: { system: number; tools: number; history: number; results: number } | null; envelopeBytes: number | null }
export type ToolTrace = { turn: number | null; name: string; label: string; at: number; waitMs: number; runMs: number; inBytes: number; outBytes: number; status: string; exit: number | null; tokens: number | null }
export type TokenCost = { usd: number | null; reason: string | null }
export type RunTrace = {
  version: 1; questID: string; runID: string; state: string
  startedAt: string; endedAt: string; wallMs: number
  buckets: Record<string, number>; unaccountedMs: number
  parts: Record<string, Record<string, number>>; admission: RunAdmission | null
  startup: { workspaceMs: number | null; claimToWorkerStartMs: number | null; bindMs: number | null; claimToFirstTurnMs: number | null; sessionToPromptMs: number | null }
  turns: TurnTrace[]; tools: ToolTrace[]
  tokens: { total: RoleTokens; cost: Partial<Record<keyof Tokens, TokenCost>>; reasoningShare: number | null }
  inputBySource: { system: number; tools: number; history: number; results: number } | null
  largest: { tool: string; label: string; tokens: number; bytes: number; resentTurns: number }[]
  retries: { count: number; causes: Record<string, number> }
  compactions: { at: number; before: number | null; after: number | null }[]
  missing: string[]
}
type Span = { bucket: string; part?: string; rank: number; start: number; end: number }

let counter: ((text: string) => number) | undefined
export function o200kCount(text: string): number {
  if (!counter) {
    const load = createRequire(import.meta.url)
    const encoding = load("gpt-tokenizer/encoding/o200k_base") as { countTokens: (text: string) => number }
    counter = text => encoding.countTokens(text)
  }
  return counter(text)
}

export function shellClass(command: string | null): "test" | "build" | "git" | "install" | "shell" {
  if (!command) return "shell"
  for (const raw of command.split(/&&|\|\||;|\n/)) {
    const segment = raw.trim()
    if (/^git\b/.test(segment)) return "git"
    if (/^(bun|npm|pnpm|yarn)\s+(install|i|add)\b/.test(segment) || /^(bun|npm|pnpm|yarn)\s+run\s+install\b/.test(segment) || /^pip\s+install\b/.test(segment)) return "install"
    if (/^(bun|npm|pnpm|yarn)\s+(run\s+)?(test|check)[:\w-]*\b/.test(segment) || /^(bun|node)\s+test\b/.test(segment) || /^(bun|node)\s+--test\b/.test(segment) || /^(npx|bunx)\s+(vitest|jest)\b/.test(segment) || /^(pytest|go\s+test|cargo\s+test)\b/.test(segment)) return "test"
    if (/^(bun|npm|pnpm|yarn)\s+(run\s+)?(build|typecheck|tsc|compile)[:\w-]*\b/.test(segment) || /^(npx\s+)?tsc\b/.test(segment) || /^(go\s+build|cargo\s+build)\b/.test(segment)) return "build"
  }
  return "shell"
}

export function toolLabel(name: string, command: string | null): string {
  if (name === "execute") return "code"
  const kind = toolKind(name)
  return kind === "shell" ? shellClass(command) : kind
}

export function paint(from: number, to: number, spans: Span[]): { ms: Record<string, number>; unaccounted: number; parts: Record<string, Record<string, number>> } {
  const clipped = spans.flatMap(span => {
    const start = Math.max(span.start, from), end = Math.min(span.end, to)
    return end > start ? [{ ...span, start, end }] : []
  })
  const cuts = [...new Set([from, to, ...clipped.flatMap(span => [span.start, span.end])])].sort((a, b) => a - b)
  const ms: Record<string, number> = {}
  const parts: Record<string, Record<string, number>> = {}
  let unaccounted = 0
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1]
    let best: Span | undefined
    for (const span of clipped) if (span.start <= a && span.end >= b && (!best || span.rank < best.rank)) best = span
    if (!best) { unaccounted += b - a; continue }
    ms[best.bucket] = (ms[best.bucket] ?? 0) + (b - a)
    if (best.part) parts[best.bucket] = { ...parts[best.bucket], [best.part]: (parts[best.bucket]?.[best.part] ?? 0) + (b - a) }
  }
  return { ms, unaccounted, parts }
}

function matchTurns(requests: RequestRecord[], messages: HostMessage[]): Map<RequestRecord, HostMessage> {
  const free = messages.filter(message => message.type === "assistant")
  const matched = new Map<RequestRecord, HostMessage>()
  for (const request of requests) {
    let best: HostMessage | undefined, distance = 3000
    for (const message of free) {
      const gap = Math.abs(message.created - request.startedAt)
      if (gap <= distance && !matched.has(request) && ![...matched.values()].includes(message)) { best = message; distance = gap }
    }
    if (best) matched.set(request, best)
  }
  return matched
}

export function admissionOf(starts: { quest: string; createdAt: string; result?: unknown }[], continuations: { id: string; questID: string; admissions?: { runID?: string }[] }[], questID: string, runID: string): RunAdmission | undefined {
  const row = continuations.find(item => item.questID === questID && item.admissions?.some(admission => admission.runID === runID))
  if (!row) return undefined
  const start = starts.find(item => item.quest === questID && (item.result as { continuationID?: unknown } | undefined)?.continuationID === row.id)
  if (!start) return undefined
  const result = start.result as { state?: unknown; reason?: unknown } | undefined
  const held = result?.state === "waiting"
  const reason = held && typeof result?.reason === "string" ? result.reason : null
  return { queuedAt: start.createdAt, held, reason: reason === null || reason.length <= REASON_LIMIT ? reason : reason.slice(0, REASON_LIMIT - 3) + "..." }
}

export function buildRunTrace(input: RunTraceInput): RunTrace | undefined {
  const p = input.points
  const created = at(p.created) ?? at(p.workerStart), finished = at(p.finished)
  if (created === undefined || finished === undefined || finished < created) return undefined
  const landed = at(input.landingAt)
  const to = Math.max(finished, landed ?? finished), from = created
  const count = input.count ?? o200kCount
  const lookup = input.lookup ?? gapPrice
  const requests = [...new Map(input.requests.map(request => [request.id, request])).values()].sort((a, b) => a.startedAt - b.startedAt)
  const messages = input.session?.messages ?? []
  const matched = matchTurns(requests, messages)
  const spans: Span[] = []
  const span = (bucket: string, rank: number, start: number | undefined, end: number | undefined, part?: string) => {
    if (start !== undefined && end !== undefined && end > start) spans.push({ bucket, part, rank, start, end })
  }
  const planned = at(p.planned), routed = at(p.routed), claimed = at(p.claimed), workerStart = at(p.workerStart), bound = at(p.bound)
  span("plan", TRACE_BUCKET_RANK.plan, from, planned)
  if (planned !== undefined) {
    const queued = at(input.admission?.queuedAt)
    span("plan", TRACE_BUCKET_RANK.beforeStart, from, queued === undefined ? undefined : Math.min(queued, planned), "before-start")
    if (input.admission?.held) span("plan", TRACE_BUCKET_RANK.admissionHold, queued === undefined ? undefined : Math.max(queued, from), planned, "admission-hold")
    for (const part of input.giver ?? []) if (finite(part.completedAt)) span("plan", TRACE_BUCKET_RANK.giverModel, Math.max(part.startedAt, from), Math.min(part.completedAt, planned), "giver-model")
  }
  span("route", TRACE_BUCKET_RANK.route, planned, routed)
  span("queue", TRACE_BUCKET_RANK.queue, routed, claimed)
  for (const stage of input.workspace ?? []) span("start-up", TRACE_BUCKET_RANK.startup, stage.start, stage.end, "workspace")
  const firstStart = requests[0]?.startedAt
  const gapStart = claimed ?? workerStart
  if (gapStart !== undefined && firstStart !== undefined) {
    const spawn = workerStart === undefined ? undefined : Math.min(Math.max(workerStart, gapStart), firstStart)
    if (spawn === undefined) span("start-up", TRACE_BUCKET_RANK.startupGap, gapStart, firstStart)
    else {
      span("start-up", TRACE_BUCKET_RANK.startupGap, gapStart, spawn, "claim-to-spawn")
      span("start-up", TRACE_BUCKET_RANK.startupGap, spawn, firstStart, "first-token")
    }
  }
  span("landing", TRACE_BUCKET_RANK.landing, finished, landed)
  const turns: TurnTrace[] = []
  const tools = toolsOf(messages, count)
  const turnOf = new Map<HostMessage, number>([...matched].map(([request, message]) => [message, requests.indexOf(request) + 1]))
  const resultsBefore = (startedAt: number) => tools.filter(tool => tool.doneAt <= startedAt).reduce((total, tool) => total + tool.tokens, 0)
  let previousEnd: number | undefined
  for (const request of requests) {
    const start = request.startedAt, end = finite(request.completedAt) ? Math.min(request.completedAt, to) : to
    const message = matched.get(request)
    const firstResponse = finite(request.firstResponseAt) ? request.firstResponseAt : undefined
    if (firstResponse !== undefined) span("model: send", TRACE_BUCKET_RANK.send, start, firstResponse)
    span("model: streaming", TRACE_BUCKET_RANK.streaming, firstResponse ?? start, end)
    if (previousEnd !== undefined) span("between turns", TRACE_BUCKET_RANK.between, previousEnd, start)
    previousEnd = end
    const firstOutputs = [finite(request.firstVisibleAt) ? request.firstVisibleAt : undefined, ...(message ? [...message.thinking.map(part => part.start), ...message.tools.flatMap(tool => tool.created === null ? [] : [tool.created])] : [])].filter((value): value is number => finite(value) && value >= start && value <= end)
    const firstOut = firstOutputs.length ? Math.min(...firstOutputs) : undefined
    const thinkMs = message ? message.thinking.reduce((total, part) => total + Math.max(0, Math.min(part.end, end) - Math.max(part.start, start)), 0) : null
    const composition = request.composition?.parts
    const sum = (kind: string) => composition ? composition.filter(part => part.kind === kind).reduce((total, part) => total + part.tokens, 0) : 0
    const messageTokens = sum("message"), resultTokens = Math.min(messageTokens, resultsBefore(start))
    turns.push({
      at: start - from, state: request.state,
      admitMs: message ? Math.max(0, start - message.created) : null,
      sendMs: firstResponse !== undefined ? firstResponse - start : null,
      firstOutMs: firstOut !== undefined ? firstOut - start : null,
      thinkMs, streamMs: firstOut !== undefined ? end - firstOut : null,
      totalMs: end - start, finish: message?.finish ?? null, retries: request.retries ?? 0,
      tokens: { ...request.tokens },
      context: composition ? { system: sum("system"), tools: sum("tool"), history: messageTokens - resultTokens, results: resultTokens } : null,
      envelopeBytes: request.request?.envelopeBytes ?? null,
    })
  }
  for (const message of messages) if (message.type === "assistant") for (const part of message.thinking) span("model: thinking", TRACE_BUCKET_RANK.thinking, part.start, part.end)
  for (const tool of tools) {
    span("tool wait", TRACE_BUCKET_RANK.toolWait, tool.createdAt, tool.ranAt)
    span("tool: " + tool.label, TRACE_BUCKET_RANK.tool, tool.ranAt, tool.doneAt)
  }
  const painted = paint(from, to, spans)
  const buckets = { ...painted.ms, unaccounted: painted.unaccounted }
  const partsOf = (bucket: keyof typeof PART_NAMES): Record<string, number> => {
    const found = painted.parts[bucket] ?? {}
    const named = Object.fromEntries(PART_NAMES[bucket].map(name => [name, found[name] ?? 0]))
    return { ...named, [OTHER]: (painted.ms[bucket] ?? 0) - Object.values(named).reduce((total, value) => total + value, 0) }
  }
  const parts = { plan: partsOf("plan"), "start-up": partsOf("start-up") }
  const workspaceMs = input.workspace?.length ? input.workspace.reduce((total, stage) => total + Math.max(0, stage.end - stage.start), 0) : null
  const total = roleTokens(requests)
  const priced = requests.map(request => pricedRequest(request, lookup))
  const cost = Object.fromEntries(TOKEN_KEYS.map(key => [key, costOf(priced, key)])) as Partial<Record<keyof Tokens, TokenCost>>
  const sources = requests.filter(request => request.composition)
  const inputBySource = sources.length ? turns.reduce((sumsBySource, turn) => turn.context ? { system: sumsBySource.system + turn.context.system, tools: sumsBySource.tools + turn.context.tools, history: sumsBySource.history + turn.context.history, results: sumsBySource.results + turn.context.results } : sumsBySource, { system: 0, tools: 0, history: 0, results: 0 }) : null
  const causes: Record<string, number> = {}
  for (const request of requests) {
    const cause = request.failure ?? (request.response && request.response.status !== 200 ? "status " + request.response.status : null)
    if (cause) causes[cause] = (causes[cause] ?? 0) + 1
  }
  const retries = requests.reduce((total, request) => total + (request.retries ?? 0), 0)
  const compactions = messages.filter(message => message.type === "compaction").map(message => {
    const before = [...requests].reverse().find(request => request.startedAt <= message.created)
    const after = requests.find(request => request.startedAt >= message.created)
    return { at: message.created - from, before: before?.context?.tokens ?? null, after: after?.context?.tokens ?? null }
  })
  const largest = tools.filter(tool => tool.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, TRACE_LIMITS.largest).map(tool => ({
    tool: tool.name, label: tool.label, tokens: tool.tokens, bytes: tool.outBytes, resentTurns: requests.filter(request => request.startedAt >= tool.doneAt).length,
  }))
  const reasoningShare = total.reasoning !== null && total.output !== null && total.output + total.reasoning > 0 ? total.reasoning / (total.output + total.reasoning) : null
  const missing: string[] = []
  if (!requests.length) missing.push("turns: no model request recorded for this run's session")
  const unmatched = requests.filter(request => !matched.has(request)).length
  if (unmatched) missing.push(unmatched + " of " + requests.length + " turns have no host message: admission, thinking and tool calls are not measured, so tool time sits in between turns")
  const unsized = requests.filter(request => !request.composition).length
  if (unsized) missing.push(unsized + " of " + requests.length + " turns have no input composition: their input-by-source is not counted")
  if (input.session === null) missing.push("host session: not readable, so tool calls and thinking times are not measured")
  if (tools.some(tool => tool.label === "code")) missing.push("code tools: the host records the outer call only, so inner calls are not timed")
  if (!messages.some(message => message.type === "compaction")) missing.push("compaction: no compaction event in this session")
  if (landed !== undefined) missing.push("landing: timed from the worker finish, the landing start is not recorded")
  if (bound === undefined && workerStart !== undefined) missing.push("bind: no bound point")
  return {
    version: 1, questID: input.questID, runID: input.runID, state: input.state,
    startedAt: new Date(from).toISOString(), endedAt: new Date(to).toISOString(), wallMs: to - from,
    buckets, unaccountedMs: painted.unaccounted, parts, admission: input.admission ?? null,
    startup: {
      workspaceMs, claimToWorkerStartMs: claimed !== undefined && workerStart !== undefined ? workerStart - claimed : null,
      bindMs: bound !== undefined && workerStart !== undefined ? bound - workerStart : null,
      claimToFirstTurnMs: claimed !== undefined && firstStart !== undefined ? firstStart - claimed : null,
      sessionToPromptMs: input.session?.createdAt !== null && input.session?.createdAt !== undefined && messages.find(message => message.type === "user") ? messages.find(message => message.type === "user")!.created - input.session.createdAt : null,
    },
    turns: turns.slice(0, TRACE_LIMITS.turns),
    tools: tools.slice(0, TRACE_LIMITS.tools).map(tool => ({ turn: turnOf.get(tool.message) ?? null, name: tool.name, label: tool.label, at: tool.createdAt - from, waitMs: tool.ranAt - tool.createdAt, runMs: tool.doneAt - tool.ranAt, inBytes: tool.inBytes, outBytes: tool.outBytes, status: tool.status, exit: tool.exit, tokens: tool.tokens })),
    tokens: { total, cost, reasoningShare },
    inputBySource, largest, retries: { count: retries, causes }, compactions, missing,
  }
}

type ToolRow = { message: HostMessage; name: string; label: string; createdAt: number; ranAt: number; doneAt: number; inBytes: number; outBytes: number; status: string; exit: number | null; tokens: number }
function toolsOf(messages: HostMessage[], count: (text: string) => number): ToolRow[] {
  return messages.filter(message => message.type === "assistant").flatMap(message => message.tools.map(tool => {
    const createdAt = tool.created ?? message.created, ranAt = tool.ran ?? createdAt, doneAt = tool.completed ?? ranAt
    return { message, name: tool.name, label: toolLabel(tool.name, tool.command), createdAt, ranAt, doneAt, inBytes: tool.inputBytes, outBytes: tool.outputBytes, status: tool.status, exit: tool.exit, tokens: tool.output ? count(tool.output) : 0 }
  }))
}

function costOf(priced: RequestRecord[], key: keyof Tokens): TokenCost {
  let usd = 0
  for (const request of priced) {
    const counted = request.tokens[key]
    if (counted === null) return { usd: null, reason: "some turns have no " + key + " count" }
    if (!counted) continue
    if (!request.price) return { usd: null, reason: "no price schedule" }
    const rate = requestRates(request).rates?.[key]
    if (typeof rate !== "number" || !Number.isFinite(rate)) return { usd: null, reason: "no " + key + " price" }
    usd += counted * rate / 1e6
  }
  return { usd, reason: null }
}

export function traceRows(trace: RunTrace): object[] {
  const { turns, tools, ...header } = trace
  return [
    { k: "run", ...header },
    ...turns.map((turn, index) => ({ k: "turn", i: index + 1, ...turn })),
    ...tools.map((tool, index) => ({ k: "tool", i: index + 1, ...tool })),
  ]
}

const withoutRowKeys = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "k" && key !== "i"))
export function traceFromRows(rows: unknown[]): RunTrace | undefined {
  const records = rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
  const header = records.find(row => row.k === "run")
  if (!header) return undefined
  const turns = records.filter(row => row.k === "turn").map(withoutRowKeys) as unknown as TurnTrace[]
  const tools = records.filter(row => row.k === "tool").map(withoutRowKeys) as unknown as ToolTrace[]
  return { ...withoutRowKeys(header), turns, tools } as unknown as RunTrace
}

export function hostSession(db: Database, sessionID: string): HostSession {
  const session = db.query("select time_created, time_compacting from session_v2 where id = ?").get(sessionID) as { time_created: number; time_compacting: number | null } | null
  const rows = db.query("select type, time_created, data from session_message where session_id = ? order by seq").all(sessionID) as { type: string; time_created: number; data: string }[]
  const messages: HostMessage[] = []
  for (const row of rows) {
    let data: any
    try { data = JSON.parse(row.data) } catch { continue }
    const time = data?.time ?? {}
    if (row.type === "user" || row.type === "compaction") { messages.push({ type: row.type, created: finite(time.created) ? time.created : row.time_created, streamed: null, completed: null, finish: null, thinking: [], tools: [] }); continue }
    if (row.type !== "assistant") continue
    const created = finite(time.created) ? time.created : row.time_created
    const thinking: { start: number; end: number }[] = [], tools: HostTool[] = []
    for (const part of Array.isArray(data.content) ? data.content : []) {
      if (part?.type === "reasoning") {
        const start = finite(part.time?.created) ? part.time.created : created, end = finite(part.time?.completed) ? part.time.completed : finite(time.completed) ? time.completed : undefined
        if (end !== undefined) thinking.push({ start, end })
      }
      if (part?.type === "tool" && typeof part.name === "string") {
        const state = part.state ?? {}, partTime = part.time ?? {}
        const text = (Array.isArray(state.content) ? state.content : []).flatMap((item: any) => item?.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n")
        tools.push({
          name: part.name, status: typeof state.status === "string" ? state.status : "unknown",
          created: finite(partTime.created) ? partTime.created : null, ran: finite(partTime.ran) ? partTime.ran : null, completed: finite(partTime.completed) ? partTime.completed : null,
          inputBytes: Buffer.byteLength(JSON.stringify(state.input ?? {})), output: text, outputBytes: Buffer.byteLength(text),
          command: typeof state.input?.command === "string" ? state.input.command : null,
          exit: finite(state.metadata?.exit) ? state.metadata.exit : null,
        })
      }
    }
    messages.push({ type: "assistant", created, streamed: finite(time.streamed) ? time.streamed : null, completed: finite(time.completed) ? time.completed : null, finish: typeof data.finish === "string" ? data.finish : null, thinking, tools })
  }
  return { messages, createdAt: session?.time_created ?? null, compactingAt: session?.time_compacting ?? null }
}

export const traceTable = (trace: RunTrace): string[] => {
  const seconds = (ms: number) => (ms / 1000).toFixed(1) + " s"
  const buckets = Object.entries(trace.buckets).filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1])
  const lines = [
    "time budget, " + seconds(trace.wallMs) + " from Quest created to finished (buckets sum to wall; unaccounted " + seconds(trace.unaccountedMs) + ")",
    ...buckets.flatMap(([name, ms]) => [
      "  " + name.padEnd(24) + seconds(ms).padStart(9) + "  " + Math.round(ms / trace.wallMs * 100) + "%",
      ...Object.entries(trace.parts[name] ?? {}).filter(([, value]) => value > 0).map(([part, value]) => "    " + part.padEnd(22) + seconds(value).padStart(9) + "  " + Math.round(value / trace.wallMs * 100) + "%"),
    ]),
  ]
  if (trace.admission?.held) lines.push("held for admission from " + trace.admission.queuedAt + (trace.admission.reason ? ": " + trace.admission.reason : ""))
  const total = trace.tokens.total, cost = trace.tokens.cost
  const money = (key: keyof Tokens) => typeof cost[key]?.usd === "number" ? "$" + cost[key]!.usd!.toFixed(4) : "unpriced: " + (cost[key]?.reason ?? "no cost")
  lines.push("", "token budget (" + trace.turns.length + " turns)")
  for (const key of TOKEN_KEYS) lines.push("  " + key.padEnd(12) + String(total[key] ?? "unknown").padStart(9) + "  " + money(key))
  if (trace.inputBySource) lines.push("input sent by source: system " + trace.inputBySource.system + ", tools " + trace.inputBySource.tools + ", history " + trace.inputBySource.history + ", tool results " + trace.inputBySource.results + " (estimate)")
  if (trace.largest.length) {
    lines.push("", "largest tool results (o200k estimate)")
    trace.largest.forEach((row, index) => lines.push("  " + (index + 1) + ". " + row.label + " " + row.tool + ": " + row.tokens + " tokens, " + row.bytes + " bytes, re-sent in " + row.resentTurns + " turns"))
  }
  if (trace.turns.length) {
    lines.push("", "turns: at, admit, send, first out, thinking, streaming, total, finish, fresh in, cache read, output, reasoning")
    trace.turns.forEach((turn, index) => lines.push("  " + (index + 1) + ". " + [turn.at, turn.admitMs, turn.sendMs, turn.firstOutMs, turn.thinkMs, turn.streamMs, turn.totalMs].map(value => value === null ? "-" : seconds(value)).join(" | ") + " | " + (turn.finish ?? "-") + " | " + [turn.tokens.input, turn.tokens.cacheRead, turn.tokens.output, turn.tokens.reasoning].map(value => value ?? "?").join(" | ")))
  }
  if (trace.missing.length) lines.push("", "not measured: " + trace.missing.join("; "))
  return lines
}
