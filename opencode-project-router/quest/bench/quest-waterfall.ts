import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, appendFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { valueRequest, type RequestRecord } from "../../usage/telemetry"
import { partCount } from "../../usage/request-composition"
import { defaultSources, hostGitSpawns, parseTime, phaseName } from "../waterfall.mjs"
import { spanFiles } from "../../scripts/span-files.mjs"
import { deliveredRunIDs } from "../workers/return-metadata"

export type Category = "model-wait" | "model-stream" | "tool" | "dispatch" | "plugin" | "host" | "quest" | "gap" | "unaccounted"
export type Lane = { id: string; label: string; kind: "quest" | "giver" | "worker"; sessionID?: string; questID?: string; runID?: string; model?: string }
export type Span = { id: string; lane: string; start: number; end: number; category: Category; label: string; requestID?: string; detail?: Record<string, string | number> }
export type WaterfallRequest = {
  id: string; lane: string; start: number; firstResponseAt?: number; end: number
  route: { providerID: string; modelID: string; variant?: string }
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  costUSD?: number
  composition?: { basis: string; parts: { kind: "system" | "tool" | "message" | "output" | "reasoning"; label: string; chars?: number; tokens: number; cached: boolean; count?: number }[] }
}
export type Waterfall = {
  window: { start: number; end: number }
  lanes: Lane[]
  spans: Span[]
  accounted: { lanes: Record<string, { totalMs: number; byCategory: Record<string, number> }> }
  requests: WaterfallRequest[]
}
export type WaterfallSources = { state: string; hostDB: string; requests: string; spans: string; hostLog?: string; questDir: string }

export function waterfallSources(env: Record<string, string | undefined> = process.env, state?: string): WaterfallSources {
  const fallback = defaultSources(env)
  const dir = state ?? (env.OPENCODE_TELEMETRY_FILE ? dirname(env.OPENCODE_TELEMETRY_FILE) : fallback.state)
  const requests = state ? join(dir, "requests.jsonl") : env.OPENCODE_TELEMETRY_FILE ?? join(dir, "requests.jsonl")
  return {
    state: dir, requests, spans: requests + ".spans.jsonl",
    hostDB: state ? join(dir, "host.db") : env.OPENCODE_DB ?? join(dir, "host.db"),
    questDir: join(state ? join(dir, "quests") : env.OPENCODE_QUEST_ROOT ?? join(dir, "quests"), ".opencode"),
    hostLog: fallback.hostLog,
  }
}

export function linesBetween(file: string, from: number, to: number, key: (line: string) => number | undefined, needles?: string[]): { lines: string[]; bytes: number } {
  if (!existsSync(file)) return { lines: [], bytes: 0 }
  const fd = openSync(file, "r")
  try {
    const size = fstatSync(fd).size
    const read = (at: number, length: number) => { const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - at))); readSync(fd, buffer, 0, buffer.length, at); return buffer }
    const lineStart = (offset: number) => {
      if (offset <= 0) return 0
      for (let at = offset - 1; at < size; at += 65536) { const buffer = read(at, 65536), nl = buffer.indexOf(10); if (nl >= 0) return at + nl + 1 }
      return size
    }
    const lineAt = (start: number) => {
      for (let length = 65536; ; length *= 2) {
        const buffer = read(start, length), nl = buffer.indexOf(10)
        if (nl >= 0 || start + buffer.length >= size) { const end = nl >= 0 ? nl : buffer.length; return { next: start + end + 1, time: key(buffer.subarray(0, end).toString("utf8")) } }
      }
    }
    const seek = (target: number) => {
      let lo = 0, hi = size
      while (hi - lo > 16384) {
        const mid = Math.floor((lo + hi) / 2)
        let at = lineStart(mid), line = at < hi ? lineAt(at) : undefined
        while (line && line.time === undefined && line.next < hi) { at = line.next; line = lineAt(at) }
        if (!line || line.time === undefined) hi = mid
        else if (line.time < target) lo = line.next
        else hi = mid
      }
      return { lo, hi }
    }
    const begin = lineStart(seek(from).lo), stop = lineStart(seek(to).hi)
    if (stop <= begin) return { lines: [], bytes: 0 }
    const buffer = read(begin, stop - begin)
    const lines = buffer.toString("utf8").split("\n").filter(line => line && (!needles || needles.some(n => line.includes(n))))
    return { lines, bytes: buffer.length }
  } finally { closeSync(fd) }
}
const numberAfter = (line: string, field: string) => { const at = line.indexOf('"' + field + '":'); if (at < 0) return undefined; const value = parseFloat(line.slice(at + field.length + 3, at + field.length + 23)); return Number.isFinite(value) ? value : undefined }
export const requestKey = (line: string) => numberAfter(line, "recordedAt") ?? numberAfter(line, "completedAt") ?? numberAfter(line, "startedAt")
const spanKey = (line: string) => numberAfter(line, "end") ?? numberAfter(line, "observed") ?? numberAfter(line, "to") ?? numberAfter(line, "start")
const logKey = (line: string) => { const at = Date.parse(/^timestamp=(\S+)/.exec(line)?.[1] ?? ""); return Number.isFinite(at) ? at : undefined }

const json = (text: string) => { try { return JSON.parse(text) } catch { return undefined } }
type JournalEvent = { type: string; at: number; source?: string; payload?: any }
function readJournal(questDir: string, id: string): JournalEvent[] {
  const file = join(questDir, ".quest-runtime", "journals", id + ".jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8").split("\n").flatMap(line => { const row = line ? json(line) : undefined; return row?.type ? [{ type: row.type, at: Date.parse(row.at), source: row.source, payload: row.payload }] : [] })
}
function questID(questDir: string, reference: string) {
  if (existsSync(join(questDir, ".quest-runtime", "journals", reference + ".jsonl"))) return reference
  const entries = json(existsSync(join(questDir, ".quest-runtime", "references.json")) ? readFileSync(join(questDir, ".quest-runtime", "references.json"), "utf8") : "")?.entries ?? []
  return entries.find((entry: any) => entry.ref === reference)?.id ?? reference
}
function questTitle(questDir: string, id: string): string | undefined {
  const candidates = [join(questDir, "quests", id + ".md")]
  const archive = join(questDir, "quests-archive")
  if (existsSync(archive)) for (const day of readdirSync(archive)) candidates.push(join(archive, day, id + ".md"))
  for (const file of candidates) if (existsSync(file)) { const line = /^title: (.*)$/m.exec(readFileSync(file, "utf8"))?.[1]; if (line) return json(line) ?? line }
}

async function openDatabase(file: string): Promise<any> {
  if ((globalThis as any).Bun) { const { Database } = await import("bun:sqlite"); return new Database(file, { readonly: true }) }
  const { DatabaseSync } = await import("node:sqlite" as any); return new DatabaseSync(file, { readOnly: true })
}

type Interval = { start: number; end: number; category: Category; label: string; priority: number; requestID?: string; detail?: Record<string, string | number> }
type Boundary = { t: number; kind: string; label: string }
const PRIORITY: Record<string, number> = { "model-wait": 0, "model-stream": 0, tool: 1, "tool-span": 2, dispatch: 3, plugin: 4, host: 5, quest: 6 }

export function partition(lane: string, start: number, end: number, intervals: Interval[], gap: (from: number, to: number) => { category: Category; label: string; detail?: Record<string, string> }, cuts: number[] = []): Span[] {
  const inside = intervals.map(i => ({ ...i, start: Math.max(start, i.start), end: Math.min(end, i.end) })).filter(i => i.end > i.start)
  const within = cuts.filter(t => t > start && t < end), cut = new Set(within)
  const points = [...new Set([start, end, ...within, ...inside.flatMap(i => [i.start, i.end])])].sort((a, b) => a - b)
  const sorted = inside.sort((a, b) => a.start - b.start), active: Interval[] = []
  const pieces: { start: number; end: number; winner?: Interval }[] = []
  let next = 0
  for (let p = 0; p < points.length - 1; p++) {
    const a = points[p], b = points[p + 1]
    while (next < sorted.length && sorted[next].start <= a) active.push(sorted[next++])
    for (let i = active.length - 1; i >= 0; i--) if (active[i].end <= a) active.splice(i, 1)
    let winner: Interval | undefined
    for (const i of active) if (!winner || i.priority < winner.priority || i.priority === winner.priority && (i.start > winner.start || i.start === winner.start && i.end < winner.end)) winner = i
    const last = pieces.at(-1)
    if (last && last.winner === winner && (winner || !cut.has(a))) last.end = b; else pieces.push({ start: a, end: b, winner })
  }
  const spans: Span[] = []
  for (const piece of pieces) {
    const w = piece.winner, named = w ? { category: w.category, label: w.label } : gap(piece.start, piece.end), last = spans.at(-1)
    if (last && last.end === piece.start && last.category === named.category && last.label === named.label && last.requestID === w?.requestID) {
      last.end = piece.end
      if (w) last.detail = { ...last.detail, count: Number(last.detail?.count ?? 1) + 1 }
      else if ("detail" in named && named.detail?.to) last.detail = { ...last.detail, to: named.detail.to }
      continue
    }
    spans.push({ id: lane + "#" + spans.length, lane, start: piece.start, end: piece.end, ...named, ...(w?.requestID ? { requestID: w.requestID } : {}), ...(w?.detail ? { detail: { ...w.detail } } : {}) })
  }
  return spans
}

const route = (r: { providerID?: string; modelID?: string; variant?: string }) => `${r.providerID}/${r.modelID}${r.variant ? "#" + r.variant : ""}`
const round = (t: number) => Math.round(t)
function modelRequest(r: RequestRecord, lane: string, now: number): WaterfallRequest {
  const t = r.tokens ?? ({} as any), value = valueRequest(r), first = r.firstResponseAt, reasoning = t.reasoning ?? 0
  return { id: r.id, lane, start: round(r.startedAt), ...(first !== undefined ? { firstResponseAt: round(first) } : {}), end: round(r.completedAt ?? now), route: { providerID: r.route.providerID, modelID: r.route.modelID, ...(r.route.variant ? { variant: r.route.variant } : {}) },
    tokens: { input: t.input ?? 0, output: t.output ?? Math.max(0, (r.outputTotal ?? 0) - reasoning), reasoning, cacheRead: t.cacheRead ?? 0, cacheWrite: t.cacheWrite ?? 0 },
    ...(value?.value !== null && value?.value !== undefined && value.currency === "USD" ? { costUSD: value.value } : {}), ...(r.composition ? { composition: r.composition } : {}) }
}

export type WaterfallInput = { quest?: string; from?: string; to?: string }
export type WaterfallOptions = { sources?: WaterfallSources; now?: number; env?: Record<string, string | undefined>; resolveQuest?: (reference: string) => string | undefined; titleOf?: (questID: string) => string | undefined }

export async function questWaterfall(input: WaterfallInput, options: WaterfallOptions = {}): Promise<Waterfall> {
  const sources = options.sources ?? waterfallSources(options.env)
  const now = options.now ?? Date.now()
  if (!input.quest && !input.from) throw Error("Name a quest or a from time")
  if (!existsSync(sources.hostDB)) throw Error("No host database at " + sources.hostDB)

  let questIDs: string[] = [], start: number | undefined, end: number | undefined
  if (input.quest) questIDs = [options.resolveQuest?.(input.quest) ?? questID(sources.questDir, input.quest)]
  const journals = new Map(questIDs.map(id => [id, readJournal(sources.questDir, id)]))
  if (input.quest && !journals.get(questIDs[0])?.length) throw Error("No Quest journal for " + input.quest)
  if (input.from) start = parseTime(input.from, now)
  if (input.to) end = parseTime(input.to, now)
  if (!input.quest && start !== undefined) {
    const dir = join(sources.questDir, ".quest-runtime", "journals"), until = end ?? now
    for (const name of existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".jsonl")) : []) {
      if (statSync(join(dir, name)).mtimeMs < start) continue
      const events = readJournal(sources.questDir, name.slice(0, -6))
      if (events.some(e => e.at >= start! && e.at <= until)) { questIDs.push(name.slice(0, -6)); journals.set(name.slice(0, -6), events) }
    }
  }

  type Run = { questID: string; runID: string; callID: string; title?: string; sessionID?: string; parentID?: string; model?: string }
  const runs: Run[] = []
  for (const [id, events] of journals) for (const e of events) {
    const p = e.payload ?? {}
    if (e.type === "session-planned" && (p.role ?? "worker") === "worker") runs.push({ questID: id, runID: p.runID ?? p.callID, callID: p.callID, title: p.sessionTitle, parentID: p.parentID })
    if ((e.type === "session-claimed" || e.type === "session-bound") && p.sessionID) { const run = runs.find(r => r.questID === id && r.callID === p.callID); if (run) run.sessionID = p.sessionID }
    if (e.type === "session-state" && p.model) { const run = runs.find(r => r.questID === id && r.callID === p.callID); if (run) run.model = p.model }
  }
  const givers = new Set(runs.map(r => r.parentID).filter((s): s is string => !!s))

  const db = await openDatabase(sources.hostDB)
  try {
    const hostRows = (sessionID: string, from: number, to: number) => {
      const before = db.prepare("select seq from session_message where session_id = ? and type in ('user', 'idle') and time_created < ? order by seq desc limit 1").get(sessionID, from) as { seq: number } | undefined
      return (db.prepare("select seq, type, time_created as time, data from session_message where session_id = ? and seq >= ? and time_created <= ? order by seq").all(sessionID, before?.seq ?? 0, to) as any[]).map(row => ({ ...row, data: json(row.data) ?? {} }))
    }
    if (input.quest && start === undefined) {
      const events = journals.get(questIDs[0])!, created = events.find(e => e.type === "created")?.at ?? events[0].at
      const giver = [...givers][0]
      const turn = giver ? db.prepare("select time_created as t from session_message where session_id = ? and type = 'user' and time_created <= ? order by time_created desc limit 1").get(giver, created) as { t: number } | undefined : undefined
      start = turn?.t ?? created
    }
    if (input.quest && end === undefined) {
      const events = journals.get(questIDs[0])!, archived = events.findLast(e => e.type === "patched" && e.payload?.archive && e.payload.archive !== null)
      end = archived?.at ?? now
    }
    start = round(start!); end = round(Math.max(start, end ?? now))
    const windowStart = start, windowEnd = end

    const sessionIDs = new Set<string>([...givers, ...runs.map(r => r.sessionID).filter((s): s is string => !!s)])
    if (!input.quest) for (const row of db.prepare("select distinct session_id as id from session_message where time_created between ? and ?").all(windowStart, windowEnd) as { id: string }[]) sessionIDs.add(row.id)
    const sessions = new Map<string, any>()
    for (const id of sessionIDs) { const row = db.prepare("select id, title, agent, directory, parent_id as parentID, time_created as created from session_v2 where id = ?").get(id); if (row) sessions.set(id, row) }

    const plainWindow = !input.quest
    const requestLines = linesBetween(sources.requests, windowStart - 5 * 60_000, windowEnd + 30 * 60_000, requestKey, plainWindow ? undefined : [...sessionIDs].map(id => '"sessionID":"' + id + '"'))
    const records = new Map<string, RequestRecord>()
    for (const line of requestLines.lines) { const r = json(line)?.request; if (r?.id && (plainWindow || sessionIDs.has(r.sessionID))) records.set(r.id, r) }
    const requests = [...records.values()].filter(r => r.startedAt <= windowEnd && (r.completedAt ?? now) >= windowStart)
    if (plainWindow) for (const r of requests) if (!sessions.has(r.sessionID)) { const row = db.prepare("select id, title, agent, directory, parent_id as parentID, time_created as created from session_v2 where id = ?").get(r.sessionID); sessions.set(r.sessionID, row ?? { id: r.sessionID }) }
    const runIDs = new Set(runs.map(r => r.runID))
    const spanNeedles = [...[...sessions.keys()].map(id => '"sessionID":"' + id + '"'), '"dispatch.']
    const spanLines = [sources.spans, ...spanFiles(sources.spans, { from: windowStart - 86_400_000, to: windowEnd + 10 * 60_000 })].flatMap(file => linesBetween(file, windowStart - 60_000, windowEnd + 10 * 60_000, spanKey, spanNeedles).lines)
    const spanRows = spanLines.map(json).filter(row => row?.v === 1)
    const logText = sources.hostLog ? linesBetween(sources.hostLog, windowStart - 1000, windowEnd + 1000, logKey, ["spawning process"]).lines.join("\n") : ""

    const lanes: Lane[] = [], spans: Span[] = [], out: WaterfallRequest[] = []
    const accounted: Waterfall["accounted"] = { lanes: {} }
    const addLane = (lane: Lane, laneSpans: Span[]) => {
      lanes.push(lane); spans.push(...laneSpans)
      const byCategory: Record<string, number> = {}
      for (const s of laneSpans) byCategory[s.category] = (byCategory[s.category] ?? 0) + s.end - s.start
      accounted.lanes[lane.id] = { totalMs: laneSpans.reduce((n, s) => n + s.end - s.start, 0), byCategory }
    }

    const sessionLane = (sessionID: string, kind: "giver" | "worker", run?: Run) => {
      const info = sessions.get(sessionID) ?? { id: sessionID }, laneID = kind + ":" + sessionID
      const rows = hostRows(sessionID, windowStart, windowEnd)
      const intervals: Interval[] = [], boundaries: Boundary[] = []
      const boundary = (t: unknown, kind: string, label: string) => { if (typeof t === "number" && Number.isFinite(t)) boundaries.push({ t: round(t), kind, label }) }
      if (Number.isFinite(info.created)) boundary(info.created, "created", "session created")
      for (const m of rows) {
        const t = m.data.time ?? {}
        if (m.type === "user") boundary(m.time, "user", m.data.metadata?.questWorkerReturn ? "Quest update" : "user message")
        if (m.type === "idle") boundary(m.time, "idle", "idle")
        if (m.type !== "assistant") continue
        boundary(t.created, "step.start", "step started"); boundary(t.streamed, "step.streamed", "step streamed"); boundary(t.completed, "step.end", "step ended")
        for (const part of m.data.content ?? []) {
          if (part.type !== "tool") continue
          const pt = part.time ?? {}, began = pt.ran ?? pt.created
          if (!Number.isFinite(began)) continue
          const ops = [...new Set((part.state?.metadata?.toolCalls ?? []).map((call: any) => call.tool))]
          boundary(began, "tool.ran", "tool " + part.name + " started"); boundary(pt.completed, "tool.done", "tool " + part.name + " finished")
          intervals.push({ start: round(began), end: round(pt.completed ?? windowEnd), category: "tool", priority: PRIORITY.tool, label: `tool ${part.name}${ops.length ? ": " + ops.join(", ") : ""}`, detail: { status: String(part.state?.status ?? "?"), callID: String(part.id ?? "") } })
        }
      }
      const mine = requests.filter(r => r.sessionID === sessionID).sort((a, b) => a.startedAt - b.startedAt)
      for (const r of mine) {
        const first = r.firstResponseAt, done = r.completedAt ?? now, name = route(r.route) + (r.kind && r.kind !== "primary" ? " " + r.kind : "")
        boundary(r.startedAt, "request.start", "request sent"); boundary(first, "request.first", "first response"); boundary(r.completedAt, "request.end", "request done")
        intervals.push({ start: round(r.startedAt), end: round(first ?? done), category: "model-wait", priority: PRIORITY["model-wait"], label: `${name}: waiting for first token`, requestID: r.id, detail: { state: r.state } })
        if (first !== undefined) intervals.push({ start: round(first), end: round(done), category: "model-stream", priority: PRIORITY["model-stream"], label: `${name}: streaming`, requestID: r.id, detail: { state: r.state } })
        out.push(modelRequest(r, laneID, now))
      }
      const requested = mine.map(r => [r.startedAt, r.completedAt ?? now])
      for (const m of rows) {
        const t = m.data.time ?? {}, stop = t.streamed ?? t.completed, k = m.data.tokens
        if (m.type !== "assistant" || !Number.isFinite(t.created) || !Number.isFinite(stop) || requested.some(([s, e]) => s < stop && e > t.created)) continue
        const model = m.data.model ?? {}, id = String(m.id ?? sessionID + ":" + m.seq)
        intervals.push({ start: round(t.created), end: round(stop), category: "model-stream", priority: PRIORITY["model-stream"], label: `${route({ providerID: model.providerID, modelID: model.id, variant: model.variant })}: host step (no request record, so waiting and streaming are not split)`, requestID: id })
        if (t.created <= windowEnd && stop >= windowStart) out.push({ id, lane: laneID, start: round(t.created), end: round(stop), route: { providerID: String(model.providerID ?? "?"), modelID: String(model.id ?? "?"), ...(model.variant ? { variant: model.variant } : {}) },
          tokens: { input: k?.input ?? 0, output: k?.output ?? 0, reasoning: k?.reasoning ?? 0, cacheRead: k?.cache?.read ?? 0, cacheWrite: k?.cache?.write ?? 0 }, ...(typeof m.data.cost === "number" ? { costUSD: m.data.cost } : {}) })
      }
      for (const row of spanRows) {
        if (row.sessionID !== sessionID) continue
        if (row.kind === "host") {
          const t = row.created ?? row.observed, kind = /^session\.execution\.(succeeded|failed|interrupted)$/.test(row.type) ? "execution.end" : String(row.type).replace(/^session\./, "")
          if (["inbox.enqueued", "inbox.delivered", "execution.started", "execution.end", "compaction.started", "compaction.ended", "retry.scheduled"].includes(kind)) boundary(t, kind, String(row.type).replace(/^session\./, ""))
          continue
        }
        if (row.kind !== "span") continue
        const tool = row.name === "tool.execute" || row.name === "quests.api", end = row.name === "event" ? row.start + (row.sync ?? 0) : row.end
        if (row.name === "session.context") boundary(row.end, "context", "context hook done")
        intervals.push({ start: round(row.start), end: round(end), category: tool ? "tool" : row.name.startsWith("dispatch.") ? "dispatch" : "plugin", priority: tool ? PRIORITY["tool-span"] : PRIORITY.plugin, label: `${row.plugin} ${row.name}${row.op ? " " + row.op : ""}`, ...(row.sync !== undefined ? { detail: { syncMs: Math.round(row.sync) } } : {}) })
      }
      if (run) for (const row of spanRows) if (row.kind === "span" && String(row.name).startsWith("dispatch.") && row.op === run.runID)
        intervals.push({ start: round(row.start), end: round(row.end), category: "dispatch", priority: PRIORITY.dispatch, label: "dispatch " + String(row.name).slice(9), detail: { runID: row.op } })
      if (info.directory && logText) {
        const busy = intervals.filter(i => i.priority <= PRIORITY.tool), rounds: { at: number; commands: string[] }[] = []
        for (const s of hostGitSpawns(logText, info.directory, windowStart, windowEnd).filter((s: any) => s.snapshot)) { const last = rounds.at(-1); if (last && s.at - last.at < 100) last.commands.push(s.command); else rounds.push({ at: s.at, commands: [s.command] }) }
        const ours = rounds.filter(r => !busy.some(i => r.at > i.start && r.at < i.end))
        for (const r of ours) boundary(r.at, "git", "git " + r.commands.join(" + "))
        const marks = boundaries.filter(b => b.kind !== "git").map(b => b.t).sort((a, b) => a - b)
        ours.forEach((r, i) => intervals.push({ start: r.at, end: Math.min(ours[i + 1]?.at ?? Infinity, marks.find(t => t > r.at) ?? windowEnd), category: "host", priority: PRIORITY.host, label: "host snapshot git " + r.commands.join(" + ") }))
      }
      boundaries.sort((a, b) => a.t - b.t)
      const IDLE = new Set(["idle", "execution.end"]), TURN = new Set(["user", "inbox.enqueued", "inbox.delivered", "execution.started"])
      const gap = (s: number, e: number): { category: Category; label: string; detail?: Record<string, string> } => {
        const prev = boundaries.findLast(b => b.t <= s + 1), next = boundaries.find(b => b.t >= e - 1), to = next?.label ?? "window end"
        const last = boundaries.findLast(b => b.t <= s + 1 && (IDLE.has(b.kind) || TURN.has(b.kind) || b.kind === "created"))
        if (Number.isFinite(info.created) && e <= info.created + 1) return { category: "gap", label: "not started: window start → session created" }
        if (!last || IDLE.has(last.kind)) return { category: "gap", label: `idle: ${prev?.label ?? "window start"} → ${to}` }
        if (last.kind === "created") return { category: "gap", label: `waiting for its first message: ${prev?.label ?? "session created"} → ${to}` }
        const idled = boundaries.findLast(b => b.t <= s + 1 && IDLE.has(b.kind)), opened = boundaries.find(b => TURN.has(b.kind) && b.t <= s + 1 && (!idled || b.t >= idled.t))
        const phasePrev = boundaries.findLast(b => b.t <= s + 1 && (!b.kind.startsWith("inbox.") || b === opened)), phaseNext = boundaries.find(b => b.t >= e - 1 && !b.kind.startsWith("inbox."))
        const phase = phasePrev && phaseNext ? phaseName(phasePrev.kind, phaseNext.kind) : undefined
        return phase ? { category: "host", label: "host " + phase, detail: { from: prev?.label ?? "window start", to } } : { category: "unaccounted", label: `unaccounted: ${prev?.label ?? "window start"} → ${to}` }
      }
      const model = run?.model ?? (mine[0] ? route(mine[0].route) : undefined)
      addLane({ id: laneID, label: kind === "giver" ? "Quest Giver" : run?.title ?? info.title ?? sessionID, kind, sessionID, ...(run ? { questID: run.questID, runID: run.runID } : {}), ...(model ? { model } : {}) }, partition(laneID, windowStart, windowEnd, intervals, gap, boundaries.map(b => b.t)))
    }

    const questLane = (id: string) => {
      const events = journals.get(id) ?? [], mineRuns = runs.filter(r => r.questID === id), laneID = "quest:" + id
      const title = (runID: string) => mineRuns.find(r => r.runID === runID || r.callID === runID)?.title ?? runID
      const marks: Boundary[] = []
      for (const e of events) {
        const p = e.payload ?? {}, run = p.callID ? " (" + title(p.callID) + ")" : ""
        const closing = e.type === "patched" && (!!p.archive || !!p.delivered), by = String(e.source ?? "").replace(/^quest:/, "")
        const label = e.type === "created" ? "Quest created" : e.type === "session-planned" ? "run planned" + run : e.type === "session-claimed" ? "worker session claimed" + run : e.type === "session-bound" ? "prompt admitted" + run
          : e.type === "session-state" ? (p.state === "planned" ? "run routed" : "run " + p.state) + run : e.type === "stage-state" ? "step " + p.stageID + " " + p.status
          : closing ? (by === "turn-in" ? "Quest turned in automatically" : "Quest closed (" + by + ")") : e.type === "patched" ? (p.reward !== undefined ? "reward saved" : p.stages || p.stagesPatch ? "steps saved" : "Quest updated") + " (" + by + ")" : e.type
        marks.push({ t: round(e.at), kind: closing ? "closed" : e.type, label })
      }
      for (const giver of givers) for (const row of db.prepare("select time_created as t, data from session_message where session_id = ? and type = 'user' and time_created between ? and ?").all(giver, windowStart, windowEnd) as any[]) {
        const d = json(row.data), delivered = deliveredRunIDs(d?.metadata)
        const returned = mineRuns.filter(r => delivered.includes(r.runID))
        if (!returned.length) continue
        marks.push({ t: row.t, kind: "return", label: "return delivered to giver (" + returned.map(r => r.title ?? r.runID).join(", ") + ")" })
        const seen = requests.filter(r => r.sessionID === giver && r.startedAt > row.t).sort((a, b) => a.startedAt - b.startedAt)[0]
        if (seen) marks.push({ t: round(seen.startedAt), kind: "pickup", label: "giver picked up the return" })
      }
      marks.sort((a, b) => a.t - b.t)
      const intervals: Interval[] = []
      for (let i = 0; i + 1 < marks.length; i++) intervals.push({ start: marks[i].t, end: marks[i + 1].t, category: "quest", priority: PRIORITY.quest, label: `${marks[i].label} → ${marks[i + 1].label}` })
      const closed = marks.findLast(m => m.kind === "closed")
      if (marks.length && !(closed && closed === marks.at(-1))) intervals.push({ start: marks.at(-1)!.t, end: windowEnd, category: "quest", priority: PRIORITY.quest, label: `open: ${marks.at(-1)!.label} → window end` })
      for (const row of spanRows) if (row.kind === "span" && String(row.name).startsWith("dispatch.") && runIDs.has(row.op) && mineRuns.some(r => r.runID === row.op))
        intervals.push({ start: round(row.start), end: round(row.end), category: "dispatch", priority: PRIORITY.dispatch, label: `dispatch ${String(row.name).slice(9)} (${title(row.op)})`, detail: { runID: row.op } })
      const gap = (s: number, e: number): { category: Category; label: string } => marks.length && e <= marks[0].t + 1 ? { category: "gap", label: "before the Quest: window start → " + marks[0].label } : closed && s >= closed.t - 1 ? { category: "gap", label: "after the Quest closed" } : { category: "unaccounted", label: "unaccounted" }
      addLane({ id: laneID, label: options.titleOf?.(id) ?? questTitle(sources.questDir, id) ?? id, kind: "quest", questID: id }, partition(laneID, windowStart, windowEnd, intervals, gap))
    }

    const giverSessions = [...sessions.values()].filter(s => givers.has(s.id) || s.agent === "quest-giver")
    for (const s of giverSessions) sessionLane(s.id, "giver")
    for (const id of questIDs) {
      questLane(id)
      for (const run of runs.filter(r => r.questID === id && r.sessionID && sessions.has(r.sessionID!))) sessionLane(run.sessionID!, "worker", run)
    }
    const placed = new Set(lanes.map(l => l.sessionID).filter(Boolean))
    for (const s of sessions.values()) if (!placed.has(s.id)) sessionLane(s.id, "worker")
    out.sort((a, b) => a.start - b.start)
    return { window: { start: windowStart, end: windowEnd }, lanes, spans, accounted, requests: out }
  } finally { db.close() }
}

export type WaterfallView = "summary" | "timeline"
export type AnswerRequest = Omit<WaterfallRequest, "composition"> & { composition?: WaterfallRequest["composition"]; parts?: number }
export type WaterfallAnswer = Omit<Waterfall, "spans" | "requests"> & { spans?: Omit<Span, "id">[]; requests: AnswerRequest[]; spanCount: number; toolCalls: number }

export async function waterfallAnswer(input: WaterfallInput & { view?: WaterfallView; request?: string }, options: WaterfallOptions = {}): Promise<WaterfallAnswer> {
  if (input.request) return waterfallRequest(input.request, input, options)
  const data = await questWaterfall(input, options)
  const answer: WaterfallAnswer = {
    window: data.window, lanes: data.lanes, accounted: data.accounted,
    requests: data.requests.map(({ composition, ...request }) => composition ? { ...request, parts: partCount(composition) } : request),
    spanCount: data.spans.length,
    toolCalls: data.spans.filter(span => span.category === "tool" && span.detail?.callID !== undefined).length,
  }
  if (input.view === "timeline") answer.spans = data.spans.map(({ id: _, ...span }) => span)
  return answer
}

function waterfallRequest(id: string, input: WaterfallInput, options: WaterfallOptions): WaterfallAnswer {
  const sources = options.sources ?? waterfallSources(options.env), now = options.now ?? Date.now()
  if (!input.from) throw Error("Name the request's window with from and to, as the summary answered it")
  const start = parseTime(input.from, now), end = input.to ? parseTime(input.to, now) : now
  let found: RequestRecord | undefined
  for (const line of linesBetween(sources.requests, start - 5 * 60_000, end + 30 * 60_000, requestKey, ['"id":' + JSON.stringify(id)]).lines) { const r = json(line)?.request; if (r?.id === id) found = r }
  if (!found) throw Error("No request " + id + " between " + new Date(start).toISOString() + " and " + new Date(end).toISOString())
  return { window: { start: round(start), end: round(end) }, lanes: [], accounted: { lanes: {} }, requests: [modelRequest(found, "", now)], spanCount: 0, toolCalls: 0 }
}
