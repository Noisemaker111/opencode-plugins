import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { Database } from "bun:sqlite"
import { readerFiles, readSessionsRequests } from "./telemetry-store"
import { valueRequest, type RequestRecord } from "./telemetry"
import { readWorkflowOutcomesChecked, workflowOutcomesFile, type WorkflowRun } from "./workflow-outcomes"
import { taggedDepth, taggedWorkType } from "../models/work-profile"

export const TOOL_KINDS = ["read", "search", "shell", "edit", "mcp", "other"] as const
export type ToolKind = typeof TOOL_KINDS[number]
const READ = new Set(["read", "list", "ls", "view"])
const SEARCH = new Set(["grep", "glob", "find", "search", "codesearch", "websearch"])
const SHELL = new Set(["shell", "bash", "cmd", "powershell", "pwsh", "terminal", "exec"])
const EDIT = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])
export const CODE_MODE_TOOL = "execute"

export function toolKind(name: string): ToolKind {
  const bare = name.replace(/^functions\./, "").toLowerCase()
  if (READ.has(bare)) return "read"
  if (SEARCH.has(bare)) return "search"
  if (SHELL.has(bare)) return "shell"
  if (EDIT.has(bare)) return "edit"
  if (/[_.]/.test(bare)) return "mcp"
  return "other"
}

type Interval = [number, number]
const union = (spans: Interval[]) => {
  const merged: Interval[] = []
  for (const [start, end] of spans.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}
const length = (spans: Interval[]) => union(spans).reduce((total, [s, e]) => total + e - s, 0)
const clip = (span: Interval, from: number, to: number): Interval => [Math.max(span[0], from), Math.min(span[1], to)]
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

export type ToolCall = { tool: string; kind: ToolKind | "code-mode"; start: number; end: number; status: string; inner?: { tool: string; start: number; end: number; status: string }[]; untimedInner?: string[] }
export function hostToolCalls(file: string, sessionID: string, from: number, to: number): { calls: ToolCall[]; available: boolean } {
  if (!existsSync(file)) return { calls: [], available: false }
  const db = new Database(file, { readonly: true })
  try {
    const rows = db.query("select data from session_message where session_id = ? and type = 'assistant' order by seq").all(sessionID) as { data: string }[]
    const calls: ToolCall[] = []
    for (const row of rows) {
      let message: any
      try { message = JSON.parse(row.data) } catch { continue }
      for (const part of message?.content ?? []) {
        if (part?.type !== "tool" || typeof part.name !== "string") continue
        const time = part.time ?? {}, start = time.ran ?? time.created
        if (!finite(start) || start > to) continue
        const end = finite(time.completed) ? time.completed : to
        if (end < from) continue
        const metadata = part.state?.metadata ?? {}, status = String(part.state?.status ?? "unknown")
        if (part.name !== CODE_MODE_TOOL) { calls.push({ tool: part.name, kind: toolKind(part.name), start, end, status }); continue }
        const inner = (Array.isArray(metadata.innerCalls) ? metadata.innerCalls : []).filter((call: any) => typeof call?.tool === "string" && finite(call.start) && finite(call.end))
          .map((call: any) => ({ tool: call.tool, start: call.start, end: call.end, status: String(call.status ?? "completed") }))
        const named = (Array.isArray(metadata.toolCalls) ? metadata.toolCalls : []).map((call: any) => String(call?.tool ?? "unknown"))
        const untimedInner = [...named]
        for (const call of inner) { const at = untimedInner.indexOf(call.tool); if (at >= 0) untimedInner.splice(at, 1) }
        calls.push({ tool: part.name, kind: "code-mode", start, end, status, inner, untimedInner })
      }
    }
    return { calls, available: rows.length > 0 }
  } finally { db.close() }
}

type Cost = { currency: string; estimate: number; actual: number; actualRequests: number }
type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; unknownRequests: number }
export type WorkerTime = {
  wallMs: number
  model: { requests: number; ms: number; firstTokenMs: number; generationMs: number; untimedRequests: number }
  tools: { calls: number; ms: number; byKind: Record<ToolKind, { calls: number; ms: number }>; codeModeOutsideCallsMs: number; untimedCalls: number; hostRecords: boolean }
  unattributedMs: number
  tokens: Tokens
  cost: Cost[]
  unpricedRequests: number
}
export type WorkerRunTime = WorkerTime & { runID: string; questID: string; stepID: string; sessionID: string; role: "worker" | "bench"; benchOf: string | null; route: string; accountID: string; workType: string; depth: string; state: string; outcome: string | null; endedBy: "work" | "host" | null; hostEnding: string | null; startedAt: number; endedAt: number }

const emptyKinds = () => Object.fromEntries(TOOL_KINDS.map(kind => [kind, { calls: 0, ms: 0 }])) as WorkerTime["tools"]["byKind"]
function tally(requests: RequestRecord[], window: { start: number; end: number }) {
  const { start, end } = window
  const modelSpans: Interval[] = [], tokens: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, unknownRequests: 0 }
  const model = { requests: requests.length, ms: 0, firstTokenMs: 0, generationMs: 0, untimedRequests: 0 }
  const costs = new Map<string, Cost>()
  let unpricedRequests = 0
  for (const request of requests) {
    const done = request.completedAt ?? (request.state === "running" ? end : undefined)
    if (done === undefined || done < request.startedAt) model.untimedRequests++
    else modelSpans.push(clip([request.startedAt, done], start, end))
    if (finite(request.firstVisibleAt) && request.firstVisibleAt >= request.startedAt) {
      model.firstTokenMs += request.firstVisibleAt - request.startedAt
      const finished = request.completedAt ?? request.lastOutputAt
      if (finite(finished) && finished >= request.firstVisibleAt) model.generationMs += finished - request.firstVisibleAt
    }
    const counted = request.tokens
    if ([counted.input, counted.cacheRead, counted.cacheWrite, counted.output, counted.reasoning].some(value => value === null)) tokens.unknownRequests++
    tokens.input += counted.input ?? 0; tokens.cacheRead += counted.cacheRead ?? 0; tokens.cacheWrite += counted.cacheWrite ?? 0
    tokens.output += counted.output ?? 0; tokens.reasoning += counted.reasoning ?? 0
    const valued = valueRequest(request)
    if (valued.value === null || !valued.currency) unpricedRequests++
    else { const row = costs.get(valued.currency) ?? costs.set(valued.currency, { currency: valued.currency, estimate: 0, actual: 0, actualRequests: 0 }).get(valued.currency)!; row.estimate += valued.value }
    if (request.actualCharge) { const row = costs.get(request.actualCharge.currency) ?? costs.set(request.actualCharge.currency, { currency: request.actualCharge.currency, estimate: 0, actual: 0, actualRequests: 0 }).get(request.actualCharge.currency)!; row.actual += request.actualCharge.value; row.actualRequests++ }
  }
  model.ms = length(modelSpans)
  return { model, modelSpans, tokens, cost: [...costs.values()], unpricedRequests }
}

export function measureWorker(window: { start: number; end: number }, requests: RequestRecord[], calls: ToolCall[], hostRecords: boolean): WorkerTime {
  const { start, end } = window
  const { model, modelSpans, tokens, cost, unpricedRequests } = tally(requests, window)
  const byKind = emptyKinds(), toolSpans: Interval[] = [], kindSpans = new Map<ToolKind, Interval[]>()
  let codeModeOutsideCallsMs = 0, untimedCalls = 0, count = 0
  const add = (kind: ToolKind, span: Interval) => { byKind[kind].calls++; (kindSpans.get(kind) ?? kindSpans.set(kind, []).get(kind)!).push(clip(span, start, end)) }
  for (const call of calls) {
    const span = clip([call.start, call.end], start, end)
    toolSpans.push(span)
    if (call.kind !== "code-mode") { count++; add(call.kind, span); continue }
    const inner = (call.inner ?? []).map(each => clip([Math.max(each.start, call.start), Math.min(each.end, call.end)], span[0], span[1]))
    ;(call.inner ?? []).forEach((each, index) => { count++; add(toolKind(each.tool), inner[index]) })
    codeModeOutsideCallsMs += Math.max(0, span[1] - span[0] - length(inner))
    count += call.untimedInner?.length ?? 0
    untimedCalls += call.untimedInner?.length ?? 0
  }
  for (const [kind, spans] of kindSpans) byKind[kind].ms = length(spans)
  const wallMs = Math.max(0, end - start)
  return {
    wallMs,
    model,
    tools: { calls: count, ms: length(toolSpans), byKind, codeModeOutsideCallsMs, untimedCalls, hostRecords },
    unattributedMs: Math.max(0, wallMs - length([...modelSpans, ...toolSpans])),
    tokens, cost, unpricedRequests,
  }
}

export type WorkerTimeQuery = { runID?: string; sessionID?: string; from?: number; to?: number; format?: "text" | "json" }
export type WorkerTimeSources = { requestsFile?: string; outcomesFile?: string; hostDB?: string; now?: number }
export const hostDatabaseFile = (requestsFile = readerFiles().requests) => process.env.OPENCODE_DB ?? join(dirname(requestsFile), "host.db")
const routeName = (run: WorkflowRun) => run.route.providerID + "/" + run.route.modelID + (run.route.reasoning && run.route.reasoning !== "unknown" ? "#" + run.route.reasoning : "")

function combine(rows: WorkerTime[]): WorkerTime {
  const total = measureWorker({ start: 0, end: 0 }, [], [], rows.every(row => row.tools.hostRecords))
  const addCost = (into: Cost[], cost: Cost) => { const held = into.find(each => each.currency === cost.currency); if (held) { held.estimate += cost.estimate; held.actual += cost.actual; held.actualRequests += cost.actualRequests } else into.push({ ...cost }) }
  for (const row of rows) {
    total.wallMs += row.wallMs; total.unattributedMs += row.unattributedMs; total.unpricedRequests += row.unpricedRequests
    for (const key of ["requests", "ms", "firstTokenMs", "generationMs", "untimedRequests"] as const) total.model[key] += row.model[key]
    for (const key of ["calls", "ms", "codeModeOutsideCallsMs", "untimedCalls"] as const) total.tools[key] += row.tools[key]
    for (const kind of TOOL_KINDS) { total.tools.byKind[kind].calls += row.tools.byKind[kind].calls; total.tools.byKind[kind].ms += row.tools.byKind[kind].ms }
    for (const key of Object.keys(total.tokens) as (keyof WorkerTime["tokens"])[]) total.tokens[key] += row.tokens[key]
    for (const cost of row.cost) addCost(total.cost, cost)
  }
  return total
}

export function workerTime(query: WorkerTimeQuery = {}, sources: WorkerTimeSources = {}) {
  const requestsFile = sources.requestsFile ?? readerFiles().requests, now = sources.now ?? Date.now()
  const hostDB = sources.hostDB ?? hostDatabaseFile(requestsFile)
  const outcomes = readWorkflowOutcomesChecked(sources.outcomesFile ?? workflowOutcomesFile())
  const runs = outcomes.store.runs.filter(run =>
    (!query.runID || run.runID === query.runID) && (!query.sessionID || run.sessionID === query.sessionID) &&
    (query.from === undefined || run.startedAt >= query.from) && (query.to === undefined || run.startedAt <= query.to))
  const sessions = new Set(runs.map(run => run.sessionID))
  const bySession = new Map<string, RequestRecord[]>()
  const ledger = readSessionsRequests(sessions, requestsFile)
  for (const request of ledger.records) if (sessions.has(request.sessionID)) (bySession.get(request.sessionID) ?? bySession.set(request.sessionID, []).get(request.sessionID)!).push(request)
  const measured: WorkerRunTime[] = runs.map(run => {
    const observation = run.observation, ended = observation && observation.state !== "running" ? observation.completedAt ?? observation.observedAt : now
    const window = { start: run.startedAt, end: Math.max(run.startedAt, ended) }
    const requests = (bySession.get(run.sessionID) ?? []).filter(request => request.startedAt >= run.startedAt - 1000 && request.startedAt <= window.end)
    const host = hostToolCalls(hostDB, run.sessionID, window.start, window.end)
    return { runID: run.runID, questID: run.workflowID, stepID: run.stepID, sessionID: run.sessionID, role: run.replayOf ? "bench" as const : "worker" as const, benchOf: run.replayOf ?? null, route: routeName(run), accountID: run.route.accountID,
      workType: taggedWorkType(run.taskTags) ?? "unclassified", depth: taggedDepth(run.taskTags) ?? "unstated", state: observation?.state ?? "unobserved", outcome: observation?.outcome ?? null, endedBy: observation?.endedBy ?? null, hostEnding: observation?.hostEnding ?? null,
      startedAt: window.start, endedAt: window.end, ...measureWorker(window, requests, host.calls, host.available) }
  }).sort((a, b) => a.startedAt - b.startedAt)
  const group = (key: (run: WorkerRunTime) => string) => [...new Set(measured.map(key))].map(name => ({ name, runs: measured.filter(run => key(run) === name).length, ...combine(measured.filter(run => key(run) === name)) }))
  return {
    window: { from: query.from ?? null, to: query.to ?? null, now },
    sources: { requests: requestsFile, outcomes: sources.outcomesFile ?? workflowOutcomesFile(), hostDB, hostRecords: existsSync(hostDB) },
    total: { runs: measured.length, ...combine(measured) },
    byRoute: group(run => run.route),
    byWorkType: group(run => run.workType),
    byRole: group(run => run.role),
    runs: measured,
    diagnostics: [...outcomes.diagnostics, ...ledger.diagnostics],
    note: "Each run has a role: worker for real work, bench for a finished run run again on another route, which is scored and never lands. Wall time runs from the worker run's start to its end (now while it runs). Model time is the union of the worker session's request intervals; first token is request start to first visible text and generation is first visible text to completion, summed over requests. Tool time comes from the host's own record of the session's tool calls (host.db session parts); calls inside a Code Mode execute are timed by its recorded inner calls, and the execute time outside them is counted as Code Mode time outside its calls. Kinds: read, search, shell, edit, mcp (any other tool named server_tool) and other. Unattributed time is wall time covered by no model request and no tool call: host step preparation and snapshot capture, tool dispatch, queueing and waits. Code Mode calls the host named but did not time are counted as untimed calls. Cost is the ledger's price estimate per currency plus any actual charge the provider reported; unpriced requests are counted, not guessed.",
  }
}

const seconds = (ms: number) => (ms / 1000).toFixed(ms >= 100_000 ? 0 : 1) + "s"
const share = (part: number, whole: number) => whole > 0 ? Math.round(part / whole * 100) + "%" : "-"
function line(name: string, row: WorkerTime & { runs?: number }) {
  const kinds = TOOL_KINDS.filter(kind => row.tools.byKind[kind].calls).map(kind => kind + " " + seconds(row.tools.byKind[kind].ms) + " (" + row.tools.byKind[kind].calls + ")").join(", ")
  const cost = row.cost.map(each => each.currency + " " + each.estimate.toFixed(4) + (each.actualRequests ? " (charged " + each.actual.toFixed(4) + ")" : "")).join(", ") || "no priced requests"
  const tokens = row.tokens
  return [
    name + (row.runs !== undefined ? " — " + row.runs + " run" + (row.runs === 1 ? "" : "s") : "") + ": wall " + seconds(row.wallMs),
    "  model " + seconds(row.model.ms) + " (" + share(row.model.ms, row.wallMs) + ", " + row.model.requests + " requests; first token " + seconds(row.model.firstTokenMs) + ", generation " + seconds(row.model.generationMs) + ")",
    "  tools " + seconds(row.tools.ms) + " (" + share(row.tools.ms, row.wallMs) + ", " + row.tools.calls + " calls" + (kinds ? ": " + kinds : "") + (row.tools.codeModeOutsideCallsMs ? "; Code Mode outside its calls " + seconds(row.tools.codeModeOutsideCallsMs) : "") + (row.tools.untimedCalls ? "; " + row.tools.untimedCalls + " untimed" : "") + (row.tools.hostRecords ? "" : "; host records unavailable") + ")",
    "  unattributed " + seconds(row.unattributedMs) + " (" + share(row.unattributedMs, row.wallMs) + ")",
    "  tokens in " + tokens.input + ", cache read " + tokens.cacheRead + ", cache write " + tokens.cacheWrite + ", out " + tokens.output + ", reasoning " + tokens.reasoning + (tokens.unknownRequests ? " (" + tokens.unknownRequests + " requests with unknown counts)" : "") + "; cost " + cost + (row.unpricedRequests ? ", " + row.unpricedRequests + " unpriced" : ""),
  ].join("\n")
}
export function formatWorkerTime(result: ReturnType<typeof workerTime>) {
  const diagnostics = result.diagnostics.length ? ["", "Diagnostics", ...result.diagnostics.map(each => "  " + each)] : []
  if (!result.runs.length) return ["No worker runs recorded in the outcome ledger for this selection.", ...diagnostics].join("\n")
  return [
    line("All worker runs", result.total),
    "", "By route", ...result.byRoute.map(row => line(row.name, row)),
    "", "By work type", ...result.byWorkType.map(row => line(row.name, row)),
    ...(result.byRole.some(row => row.name === "bench") ? ["", "By role", ...result.byRole.map(row => line(row.name, row))] : []),
    "", "Runs", ...result.runs.map(run => line(run.runID + (run.role === "bench" ? " (bench of " + run.benchOf + ")" : "") + " " + run.route + " " + run.workType + " " + run.state + (run.outcome ? " " + run.outcome : ""), run)),
    ...diagnostics,
  ].join("\n")
}
