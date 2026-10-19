import { appendFileSync, mkdirSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { SPANS_FILE, hostIdentity, normalizeSpan, type SpanRow } from "./span-store"
import { dayFile, spanStart } from "./span-files.mjs"
import { enforceSpanBudget } from "./telemetry-budget.mjs"
import { observeLockWaits } from "../quest/locking.mts"
export { SPANS_FILE, readSpanRows, type SpanRow } from "./span-store"

type Aggregate = { plugin: string; name: string; op: string; count: number; total: number; max: number; from: number; to: number }

export const now = () => Math.round((performance.timeOrigin + performance.now()) * 10) / 10
const round = (ms: number) => Math.round(ms * 10) / 10

type ProcessMemory = ReturnType<typeof process.memoryUsage>
type ProcessCPU = ReturnType<typeof process.cpuUsage>
export type HostPerformanceSource = {
  now: () => number
  cpu: (previous?: ProcessCPU) => ProcessCPU
  memory: () => ProcessMemory
  defer: (measure: () => void) => unknown
  host: string
  pid: number
}

export class HostPerformanceRecorder {
  private pending = false
  private previousCPU: ProcessCPU
  private previousAt: number
  constructor(private readonly write: (row: Record<string, unknown>) => void, private readonly source: HostPerformanceSource = {
    now,
    cpu: previous => process.cpuUsage(previous),
    memory: () => process.memoryUsage(),
    defer: measure => setImmediate(measure).unref?.(),
    host: hostIdentity(),
    pid: process.pid,
  }) {
    this.previousCPU = source.cpu()
    this.previousAt = source.now()
  }
  measure() {
    if (this.pending) return
    this.pending = true
    const start = this.source.now()
    this.source.defer(() => {
      const end = this.source.now()
      const cpu = this.source.cpu(this.previousCPU)
      const elapsedMicroseconds = Math.max(1, (end - this.previousAt) * 1000)
      const memory = this.source.memory()
      this.previousCPU = this.source.cpu()
      this.previousAt = end
      this.pending = false
      this.write({
        v: 1,
        pid: this.source.pid,
        kind: "span",
        plugin: "host",
        name: "performance",
        op: "process",
        host: this.source.host,
        start: round(start),
        end: round(end),
        outcome: "ok",
        cpuPercent: round((cpu.user + cpu.system) / elapsedMicroseconds * 100),
        cpuUserMicroseconds: cpu.user,
        cpuSystemMicroseconds: cpu.system,
        memoryRssBytes: memory.rss,
        memoryHeapTotalBytes: memory.heapTotal,
        memoryHeapUsedBytes: memory.heapUsed,
        memoryExternalBytes: memory.external,
        memoryArrayBuffersBytes: memory.arrayBuffers,
        eventLoopLagMilliseconds: round(end - start),
      })
    })
  }
}

const BATCH_MS = 250
const BUDGET_CHECK_BYTES = 1 << 20
const locationID = (location: string) => createHash("sha1").update(location).digest("hex").slice(0, 16)

export class SpanWriter {
  private rows: { file: string; row: Record<string, unknown> }[] = []
  private aggregates = new Map<string, Aggregate>()
  private defined = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> | undefined
  private failed = false
  private unchecked = Infinity
  private readonly performance: HostPerformanceRecorder
  constructor(readonly file = SPANS_FILE, private readonly delay = BATCH_MS, performanceSource?: HostPerformanceSource) {
    this.performance = new HostPerformanceRecorder(row => { this.enqueue(row); this.schedule() }, performanceSource)
  }
  push(row: Record<string, unknown>) { this.enqueue(row); this.performance.measure(); this.schedule() }
  private enqueue(row: Record<string, unknown>) {
    const stamp = { v: 1, pid: process.pid, host: hostIdentity() }
    const full: Record<string, unknown> = { ...stamp, ...(row.kind === "span" ? normalizeSpan(row) : row) }
    this.rows.push({ file: dayFile(this.file, spanStart(full) ?? (typeof full.from === "number" ? full.from : Date.now())), row: full })
  }
  aggregate(plugin: string, name: string, op: string, start: number, ms: number) {
    const key = plugin + "\0" + name + "\0" + op
    const row = this.aggregates.get(key) ?? this.aggregates.set(key, { plugin, name, op, count: 0, total: 0, max: 0, from: start, to: start }).get(key)!
    row.count++; row.total = round(row.total + ms); row.max = Math.max(row.max, round(ms)); row.to = start + ms
    this.schedule()
  }
  private drain(): [string, string][] {
    for (const row of this.aggregates.values()) this.rows.push({ file: dayFile(this.file, row.from), row: { v: 1, pid: process.pid, kind: "agg", ...row } })
    this.aggregates.clear()
    const lines = new Map<string, string[]>()
    for (const { file, row } of this.rows) {
      const out = lines.get(file) ?? []
      lines.set(file, out)
      const { location, ...rest } = row
      if (typeof location !== "string") { out.push(JSON.stringify(row)); continue }
      const id = locationID(location), key = file + "\0" + id
      if (!this.defined.has(key)) { this.defined.add(key); out.push(JSON.stringify({ v: 1, kind: "location", id, location })) }
      out.push(JSON.stringify({ ...rest, loc: id }))
    }
    this.rows = []
    return [...lines].map(([file, out]) => [file, out.join("\n") + "\n"])
  }
  private schedule() {
    if (this.timer || this.writing) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, this.delay)
    this.timer.unref?.()
  }
  async flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.writing) await this.writing
    const batches = this.drain()
    if (!batches.length) return
    const writing = this.writing = (async () => {
      try { await mkdir(dirname(this.file), { recursive: true }); for (const [file, text] of batches) await appendFile(file, text, { encoding: "utf8", mode: 0o600 }); this.budget(batches) }
      catch (error) { if (!this.failed) console.error("[plugin-spans] span rows could not be written:", error instanceof Error ? error.message : error); this.failed = true }
    })()
    await writing
    if (this.writing === writing) this.writing = undefined
    if (this.rows.length || this.aggregates.size) this.schedule()
  }
  async written() {
    await this.writing
    this.flushSync()
  }
  flushSync() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const batches = this.drain()
    if (!batches.length) return
    try { mkdirSync(dirname(this.file), { recursive: true }); for (const [file, text] of batches) appendFileSync(file, text, { encoding: "utf8", mode: 0o600 }); this.budget(batches) } catch {}
  }
  private budget(batches: [string, string][]) {
    this.unchecked = (this.unchecked === Infinity ? 0 : this.unchecked) + batches.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0)
    if (this.unchecked < BUDGET_CHECK_BYTES) return
    this.unchecked = 0
    enforceSpanBudget(this.file)
  }
}

const KEY = Symbol.for("questgiver.plugin-spans")
export function spanWriter(file = process.env.OPENCODE_SPANS_FILE ?? SPANS_FILE): SpanWriter {
  const state = globalThis as { [KEY]?: Map<string, SpanWriter> }
  const writers = state[KEY] ??= new Map()
  if (!writers.has(file)) {
    const writer = new SpanWriter(file)
    writers.set(file, writer)
    process.once("exit", () => writer.flushSync())
  }
  return writers.get(file)!
}

export function recordSpan(row: SpanRow, writer = spanWriter()) {
  writer.push({ kind: "span", ...row, start: round(row.start), end: round(row.end), ...(row.sync === undefined ? {} : { sync: round(row.sync) }) })
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200)

type SpanMeta<T> = Omit<SpanRow, "start" | "end" | "sync"> & { result?: (value: Awaited<T>) => Partial<SpanRow> }
export function timed<T>(metadata: SpanMeta<T>, operation: () => T, writer = spanWriter()): T {
  const { result: describe, ...meta } = metadata
  const start = now()
  let value: T
  try { value = operation() } catch (error) { const end = now(); recordSpan({ ...meta, start, end, sync: end - start, error: errorText(error) }, writer); throw error }
  const sync = now() - start
  if (value && typeof (value as any).then === "function") {
    return (value as any).then(
      (result: Awaited<T>) => { recordSpan({ ...meta, ...describe?.(result), start, end: now(), sync }, writer); return result },
      (error: unknown) => { recordSpan({ ...meta, start, end: now(), sync, error: errorText(error) }, writer); throw error },
    )
  }
  recordSpan({ ...meta, ...describe?.(value as Awaited<T>), start, end: start + sync, sync }, writer)
  return value
}

const sessionOf = (value: any): string | undefined => {
  const id = value?.sessionID ?? value?.data?.sessionID ?? value?.properties?.sessionID
  return typeof id === "string" ? id : undefined
}

const WRAPPED = Symbol.for("questgiver.plugin-spans.wrapped")
const ROUTES = Symbol.for("questgiver.plugin-spans.routes")
const routes = ((globalThis as { [ROUTES]?: Map<string, string> })[ROUTES] ??= new Map())
export function rememberSessionRoute(sessionID: string, route: string) { routes.set(sessionID, route) }
function routeOf(value: any): string | undefined {
  const model = value?.model, provider = model?.providerID ?? value?.providerID, id = model?.id ?? value?.modelID
  return typeof provider === "string" && typeof id === "string" ? provider + "/" + id : routes.get(sessionOf(value) ?? value?.id)
}
function timedTool(tool: any, plugin: string, location: string | undefined, writer: SpanWriter, id?: unknown) {
  const execute = tool?.execute
  if (typeof execute !== "function" || execute[WRAPPED]) return
  const op = String(tool.name ?? tool.id ?? id ?? "tool")
  const wrapped = function (this: unknown, input: unknown, context: any) {
    return timed({ plugin, name: "tool.execute", op, sessionID: sessionOf(context), route: routeOf(context), location, result: value => ({ outcome: (value as any)?.isError ? "failed" : "completed" }) }, () => execute.call(this, input, context), writer)
  }
  Object.defineProperty(wrapped, WRAPPED, { value: true })
  tool.execute = wrapped
}

function timedToolDraft(draft: any, plugin: string, location: string | undefined, writer: SpanWriter) {
  if (!draft || typeof draft !== "object") return draft
  return new Proxy(draft, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (key === "add" && typeof value === "function") return (tool: any, ...rest: unknown[]) => {
        if (tool && typeof tool === "object" && typeof tool.execute === "function") { tool = { ...tool }; timedTool(tool, plugin, location, writer) }
        return value.call(target, tool, ...rest)
      }
      if (key === "update" && typeof value === "function") return (id: unknown, edit: unknown, ...rest: unknown[]) =>
        value.call(target, id, typeof edit === "function" ? (tool: any, ...more: unknown[]) => { const result = edit(tool, ...more); timedTool(tool, plugin, location, writer, id); return result } : edit, ...rest)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

const DELTA = /\.delta$|^session\.tool\.progress$/

function timedStream(stream: AsyncIterable<any>, plugin: string, writer: SpanWriter): AsyncIterableIterator<any> {
  const source = stream[Symbol.asyncIterator]()
  let open: { event: any; start?: number } | undefined
  const settle = () => {
    const slot = open
    open = undefined
    if (slot?.start === undefined) return
    const ms = now() - slot.start, op = String(slot.event?.type ?? "event")
    recordSpan({ plugin, name: "event", op, sessionID: sessionOf(slot.event), route: routeOf(slot.event.data), start: slot.start, end: slot.start + ms, sync: ms }, writer)
  }
  return {
    [Symbol.asyncIterator]() { return this },
    async next(...args: [] | [unknown]) {
      settle()
      const result = await source.next(...args)
      if (result.done) return result
      const slot: { event: any; start?: number } = { event: result.value }
      open = slot
      return { get done() { slot.start ??= now(); return false as const }, value: result.value }
    },
    async return(value?: unknown) { settle(); return source.return ? source.return(value) : { done: true as const, value } },
    async throw(error?: unknown) { settle(); if (source.throw) return source.throw(error); throw error },
  }
}

const DOMAINS = Symbol.for("questgiver.plugin-spans.domains")
export function instrumentPluginContext<T extends object>(context: T, plugin: string, writer = spanWriter()): T {
  const location: string | undefined = (context as any)?.location?.directory
  const state = globalThis as { [DOMAINS]?: WeakMap<object, Map<string, unknown>> }
  const wrappers = state[DOMAINS] ??= new WeakMap()
  const registration = (label: string, call: () => unknown) => timed({ plugin, name: label, location }, call, writer)
  const domain = (name: string, target: any) => {
    const cache = new Map<PropertyKey, unknown>()
    return new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key, object)
        if (value && typeof value === "object") {
          if (!cache.has(key)) cache.set(key, domain(name + "." + String(key), value))
          return cache.get(key)
        }
        if (typeof value !== "function") return value
        if (cache.has(key)) return cache.get(key)
        let result: unknown
        if (key === "hook") result = (hook: string, callback: unknown, ...rest: unknown[]) => registration(`${name}.${hook} registration`, () => value.call(object, hook,
          typeof callback === "function" ? function (this: unknown, ...args: unknown[]) {
            const sessionID = sessionOf(args[0]), route = routeOf(args[0])
            if (sessionID && route) rememberSessionRoute(sessionID, route)
            return timed({ plugin, name: `${name}.${hook}`, sessionID: sessionOf(args[0]), route: routeOf(args[0]), location }, () => (callback as Function).apply(this, args), writer)
          } : callback, ...rest))
        else if (key === "transform") result = (callback: unknown, ...rest: unknown[]) => registration(`${name}.transform registration`, () => value.call(object,
          typeof callback === "function" ? function (this: unknown, draft: unknown, ...more: unknown[]) {
            return timed({ plugin, name: `${name}.transform`, location }, () => (callback as Function).call(this, name === "tool" ? timedToolDraft(draft, plugin, location, writer) : draft, ...more), writer)
          } : callback, ...rest))
        else if (key === "subscribe" && name === "event") result = (...args: unknown[]) => {
          const stream = registration("event.subscribe registration", () => value.apply(object, args)) as any
          const wrap = (s: any) => s && typeof s[Symbol.asyncIterator] === "function" ? timedStream(s, plugin, writer) : s
          return stream && typeof stream.then === "function" ? stream.then(wrap) : wrap(stream)
        }
        else result = (...args: any[]) => timed({ plugin, name: "request", op: `${name}.${String(key)}`, sessionID: sessionOf(args[0]), route: routeOf(args[0]) ?? `${name}.${String(key)}`, location, result: out => {
          const session = (out as any)?.data ?? out, route = routeOf(session) ?? routeOf(args[0])
          if (name === "session" && route && typeof (session?.id ?? args[0]?.sessionID) === "string") rememberSessionRoute(session?.id ?? args[0].sessionID, route)
          return { ...(route ? { route } : {}) }
        } }, () => value.apply(object, args), writer)
        cache.set(key, result)
        return result
      },
    })
  }
  return new Proxy(context, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (!value || typeof value !== "object" || typeof key !== "string") return value
      if (["location", "options", "app"].includes(key)) return value
      const byPlugin = wrappers.get(value) ?? wrappers.set(value, new Map()).get(value)!
      if (!byPlugin.has(plugin)) byPlugin.set(plugin, domain(key, value))
      return byPlugin.get(plugin)
    },
  })
}

export function hostEventRow(event: any, observed: number, location?: string): Record<string, unknown> | undefined {
  const type = event?.type
  if (typeof type !== "string" || DELTA.test(type)) return
  const data = event.data ?? {}, created = typeof event.created === "number" ? event.created : Date.parse(event.created)
  const start = Number.isFinite(created) ? created : observed
  const row: Record<string, unknown> = { kind: "span", plugin: "host", name: "host.event", op: type, type, id: event.id, sessionID: sessionOf(event), start, end: observed, created: Number.isFinite(created) ? created : undefined, observed, location, outcome: "observed" }
  if (typeof data.assistantMessageID === "string") row.message = data.assistantMessageID
  if (typeof data.id === "string" && type.startsWith("session.tool.")) row.call = data.id
  if (typeof data.name === "string") row.tool = data.name
  if (typeof data.started === "number") row.started = data.started
  if (typeof data.finish === "string") row.finish = data.finish
  if (typeof data.reason === "string") row.reason = data.reason
  if (typeof data.item?.type === "string") row.item = data.item.type
  if (typeof data.status?.type === "string") row.status = data.status.type
  if (typeof data.error?.type === "string") row.error = data.error.type
  const route = routeOf(data)
  if (route) row.route = route
  return normalizeSpan(row)
}

const SEEN = Symbol.for("questgiver.plugin-spans.seen")
export class HostSpanRecorder {
  private tools = new Map<string, { start: number; name?: string; route?: string }>()
  private toolNames = new Map<string, string>()
  private executions = new Map<string, { start: number; route?: string }>()
  constructor(private readonly writer = spanWriter(), private readonly location?: string) {}
  observe(event: any, observed = now()) {
    const data = event?.data ?? {}, sessionID = sessionOf(event), route = routeOf(data)
    if (sessionID && route) rememberSessionRoute(sessionID, route)
    const created = typeof event?.created === 'number' ? event.created : Date.parse(event?.created)
    const at = Number.isFinite(created) ? created : observed
    const row = hostEventRow(event, observed, this.location)
    if (row) this.writer.push(row)
    const key = sessionID + ':' + data.id
    if (event?.type === 'session.tool.input.started') this.toolNames.set(key, data.name)
    if (event?.type === 'session.tool.called') this.tools.set(key, { start: at, name: this.toolNames.get(key), route })
    if (event?.type === 'session.tool.success' || event?.type === 'session.tool.failed') {
      const tool = this.tools.get(key)
      if (tool) recordSpan({ plugin: 'host', name: 'tool.call', op: tool.name ?? data.id, id: 'tool:' + key, sessionID, route: tool.route ?? route, location: this.location, start: tool.start, end: at, outcome: event.type === 'session.tool.success' ? 'completed' : 'failed' }, this.writer)
      this.tools.delete(key); this.toolNames.delete(key)
    }
    if (event?.type === 'session.execution.started' && sessionID) this.executions.set(sessionID, { start: at, route })
    if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event?.type) && sessionID) {
      const execution = this.executions.get(sessionID)
      if (execution) recordSpan({ plugin: 'host', name: 'request', op: 'session.execution', id: 'execution:' + event.id, sessionID, route: execution.route ?? route, location: this.location, start: execution.start, end: at, outcome: event.type.split('.').at(-1) }, this.writer)
      this.executions.delete(sessionID)
      for (const [key, tool] of this.tools) if (key.startsWith(sessionID + ':')) {
        recordSpan({ plugin: 'host', name: 'tool.call', op: tool.name, id: 'tool:' + key, sessionID, route: tool.route ?? route, location: this.location, start: tool.start, end: at, outcome: 'interrupted' }, this.writer)
        this.tools.delete(key); this.toolNames.delete(key)
      }
    }
    if (event?.type === 'session.removed' && sessionID) routes.delete(sessionID)
  }
}
export function recordHostEvents(context: any, writer = spanWriter()): () => void {
  const subscribe = context?.event?.subscribe
  if (typeof subscribe !== "function") return () => {}
  const controller = new AbortController(), location = context?.location?.directory
  const state = globalThis as { [SEEN]?: Set<string> }
  const seen = state[SEEN] ??= new Set<string>()
  const recorder = new HostSpanRecorder(writer, location)
  queueMicrotask(async () => {
    try {
      const stream = await subscribe.call(context.event, { signal: controller.signal })
      for await (const event of stream) {
        if (controller.signal.aborted) break
        if (typeof event.id === "string") {
          if (seen.has(event.id)) continue
          if (seen.size >= 4096) seen.clear()
          seen.add(event.id)
        }
        recorder.observe(event)
      }
    } catch (error) { if (!controller.signal.aborted) console.error("[plugin-spans] host event recording stopped:", error instanceof Error ? error.message : error) }
  })
  return () => controller.abort()
}

observeLockWaits(wait => recordSpan({ plugin: "quests", name: "lock.wait", op: wait.name, start: wait.start, end: wait.start + wait.waitedMs, outcome: wait.outcome }))
