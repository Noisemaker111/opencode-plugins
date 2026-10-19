import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { dirname, join } from "node:path"
import { TELEMETRY_FILE } from "../scripts/span-store"
import { forwardLines } from "../scripts/span-files.mjs"
import { recordSpan, spanWriter } from "../scripts/plugin-spans"
import { knownTokenTotal } from "./telemetry"
import { acquireLock } from "../quest/locking.mts"
import { enforceDirectoryBudget, enforceJsonlBudget, retentionFrom, TELEMETRY_BUDGET } from "../scripts/telemetry-budget.mjs"
import type { RequestRecord } from "./telemetry"
import type { QuestRollupRow } from "../quest/runs/quest-rollup"
import { channelRegistry, channelStateRoot, dataChannel, WORK_BRANCH } from "../quest/channel.mjs"
export { TELEMETRY_FILE } from "../scripts/span-store"
export function readerFiles(env: NodeJS.ProcessEnv = process.env, registry = channelRegistry()): { requests: string; host: string } {
  let state: string | undefined
  try { state = join(channelStateRoot(registry), dataChannel(registry, WORK_BRANCH)) } catch { state = undefined }
  const requests = env.OPENCODE_TELEMETRY_FILE ?? (state ? join(state, "requests.jsonl") : TELEMETRY_FILE)
  const host = env.OPENCODE_DB ?? join(env.OPENCODE_TELEMETRY_FILE || !state ? dirname(requests) : state, "host.db")
  return { requests, host }
}
const tokensKnown = (request: RequestRecord) => request.tokens.input !== null && request.tokens.cacheRead !== null && request.tokens.cacheWrite !== null && (request.outputTotal !== undefined || request.tokens.output !== null && request.tokens.reasoning !== null)
function validRequest(request: RequestRecord) {
  if (!request.id || !request.sessionID || !Number.isFinite(request.startedAt)) throw new Error("Invalid telemetry identity or timestamp")
}
export function cacheRequest(request: RequestRecord, file = TELEMETRY_FILE) {
  requestCaches.get(file)?.set(request.id, request)
}
export const spanFile = (file: string) => file === TELEMETRY_FILE ? process.env.OPENCODE_SPANS_FILE ?? file + ".spans.jsonl" : file + ".spans.jsonl"
export function appendRequests(requests: RequestRecord[], file = TELEMETRY_FILE, lock: { timeoutMs?: number } = {}) {
  if (!requests.length) return
  for (const request of requests) validRequest(request)
  const held = acquireLock(dirname(file), "request-telemetry", lock)
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, requests.map(request => JSON.stringify({ version: 1, request })).join("\n") + "\n", { encoding: "utf8", mode: 0o600 })
    enforceJsonlBudget(file, TELEMETRY_BUDGET.requestsBytes)
  } finally { held.release() }
  const writer = spanWriter(spanFile(file))
  for (const request of requests) {
    const end = request.completedAt ?? request.lastOutputAt ?? request.recordedAt ?? Date.now()
    recordSpan({ plugin: "models", name: "model.call", id: "model:" + request.id, op: request.kind, sessionID: request.sessionID, start: request.startedAt, end, recordedAt: request.recordedAt ?? Date.now(), route: request.route.providerID + "/" + request.route.modelID, harness: request.route.harness, accountID: request.accountID, outcome: request.state, tokens: tokensKnown(request) ? knownTokenTotal(request) : null }, writer)
  }
  writer.flushSync()
}
export function recordRequest(request: RequestRecord, file = TELEMETRY_FILE) {
  validRequest(request)
  appendRequests([request], file)
  cacheRequest(request, file)
  spanWriter(spanFile(file)).flushSync()
}
function parseInto(text: string, records: Map<string, RequestRecord>, diagnostics: string[], lineOffset: number) {
  for (const [index, raw] of text.split("\n").entries()) {
    const nulls = raw.split("\0").length - 1, line = nulls ? raw.replaceAll("\0", "") : raw
    if (nulls) diagnostics.push("Skipped " + nulls + " null bytes at line " + (lineOffset + index + 1) + ", writes that never reached the disk")
    if (!line.trim()) continue
    try { const row = JSON.parse(line); if (row.version !== 1 || !row.request?.id || !row.request?.sessionID) throw new Error("invalid record"); records.set(row.request.id, row.request) }
    catch { diagnostics.push("Unreadable telemetry record at line " + (lineOffset + index + 1)) }
  }
}
export function readRequests(file = TELEMETRY_FILE): { records: RequestRecord[]; diagnostics: string[] } {
  if (!existsSync(file)) return { records: [], diagnostics: [] }
  const records = new Map<string, RequestRecord>(), diagnostics: string[] = []
  let line = 0
  for (const text of forwardLines(file)) parseInto(text, records, diagnostics, line++)
  return { records: [...records.values()], diagnostics }
}
type SessionLineIndex = { identity: string; offset: number; lines: number; anchor: Buffer; sessions: Map<string, number[]>; nulls?: string[] }
const sessionIndexes = new Map<string, SessionLineIndex>()
const sessionIndexPriming = new Map<string, Promise<void>>()
const requestCaches = new Map<string, Map<string, RequestRecord>>()
const requestCachePriming = new Map<string, Promise<void>>()
const SESSION_KEY = Buffer.from('"sessionID":"')
const fileIdentity = (stat: { dev: number; ino: number; birthtimeMs: number }) => [stat.dev, stat.ino, stat.birthtimeMs].join(":")
function indexLines(index: SessionLineIndex, data: Buffer, base: number): number {
  let start = 0
  for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) {
    const seen = new Set<string>()
    let nulls = 0
    const row = data.subarray(start, end)
    for (let at = row.indexOf(0); at >= 0; at = row.indexOf(0, at + 1)) nulls++
    if (nulls) (index.nulls ??= []).push("Skipped " + nulls + " null bytes at line " + (index.lines + 1) + ", writes that never reached the disk")
    for (let at = data.indexOf(SESSION_KEY, start); at >= 0 && at < end; at = data.indexOf(SESSION_KEY, at + 1)) {
      const from = at + SESSION_KEY.length, quote = data.indexOf(34, from)
      if (quote < 0 || quote > end) break
      const id = data.toString("utf8", from, quote)
      if (seen.has(id)) continue
      seen.add(id)
      const rows = index.sessions.get(id) ?? index.sessions.set(id, []).get(id)!
      rows.push(base + start, end - start, index.lines)
    }
    index.lines++
    start = end + 1
  }
  return start
}
function catchUpSessionIndex(index: SessionLineIndex, fd: number): boolean {
  const stat = fstatSync(fd)
  if (fileIdentity(stat) !== index.identity || stat.size < index.offset) return false
  if (index.anchor.length) { const check = Buffer.alloc(index.anchor.length); if (readSync(fd, check, 0, check.length, index.offset - check.length) !== check.length || !check.equals(index.anchor)) return false }
  const buffer = Buffer.alloc(1024 * 1024)
  let carry = Buffer.alloc(0), offset = index.offset
  while (offset < stat.size) {
    const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
    if (!n) break
    offset += n
    const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, n)]) : buffer.subarray(0, n)
    const used = indexLines(index, data, index.offset)
    index.offset += used
    carry = Buffer.from(data.subarray(used))
  }
  index.anchor = sessionIndexAnchor(fd, index.offset)
  return true
}
function sessionIndexAnchor(fd: number, offset: number): Buffer {
  const size = Math.min(64, offset), anchor = Buffer.alloc(size)
  return readSync(fd, anchor, 0, size, offset - size) === size ? anchor : Buffer.alloc(0)
}
export const sessionRequestsIndexed = (file = TELEMETRY_FILE) => sessionIndexes.has(file) || !existsSync(file)
export function primeSessionRequests(file = TELEMETRY_FILE): Promise<void> {
  if (sessionIndexes.has(file)) return Promise.resolve()
  const running = sessionIndexPriming.get(file)
  if (running) return running
  const task = (async () => {
    let handle: FileHandle
    try { handle = await open(file, "r") } catch { return }
    try {
      const stat = await handle.stat(), index: SessionLineIndex = { identity: fileIdentity(stat), offset: 0, lines: 0, anchor: Buffer.alloc(0), sessions: new Map() }
      const buffer = Buffer.alloc(1024 * 1024)
      let carry = Buffer.alloc(0), offset = 0
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
        if (!bytesRead) break
        offset += bytesRead
        const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
        const used = indexLines(index, data, index.offset)
        index.offset += used
        carry = Buffer.from(data.subarray(used))
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      const tail = Buffer.alloc(Math.min(64, index.offset))
      if ((await handle.read(tail, 0, tail.length, index.offset - tail.length)).bytesRead === tail.length) index.anchor = tail
      sessionIndexes.set(file, index)
    } finally { await handle.close() }
  })().finally(() => sessionIndexPriming.delete(file))
  sessionIndexPriming.set(file, task)
  return task
}
export function recentRequests(file = TELEMETRY_FILE): RequestRecord[] {
  const cached = requestCaches.get(file)
  if (cached) return [...cached.values()]
  if (!requestCachePriming.has(file)) {
    const priming = readRequestsSinceAsync(null, file).then(result => {
      requestCaches.set(file, new Map(result.records.map(record => [record.id, record])))
    }).catch(() => {}).finally(() => requestCachePriming.delete(file))
    requestCachePriming.set(file, priming)
  }
  return []
}
function indexedSessionRequests(sessionID: string, file: string): { records: RequestRecord[]; diagnostics: string[] } | undefined {
  const index = sessionIndexes.get(file)
  if (!index) return undefined
  let fd: number
  try { fd = openSync(file, "r") } catch { sessionIndexes.delete(file); return undefined }
  try {
    if (!catchUpSessionIndex(index, fd)) { sessionIndexes.delete(file); return undefined }
    const rows = index.sessions.get(sessionID) ?? [], records = new Map<string, RequestRecord>(), diagnostics: string[] = []
    for (let i = 0; i < rows.length; i += 3) {
      const line = Buffer.alloc(rows[i + 1])
      readSync(fd, line, 0, line.length, rows[i])
      parseInto(line.toString("utf8"), records, diagnostics, rows[i + 2])
    }
    return { records: [...records.values()].filter(record => record.sessionID === sessionID), diagnostics }
  } finally { closeSync(fd) }
}
export function readSessionRequests(sessionID: string, file = TELEMETRY_FILE): { records: RequestRecord[]; diagnostics: string[] } {
  if (!existsSync(file)) return { records: [], diagnostics: [] }
  const indexed = indexedSessionRequests(sessionID, file)
  if (indexed) return indexed
  void primeSessionRequests(file)
  const key = '"sessionID":' + JSON.stringify(sessionID), records = new Map<string, RequestRecord>(), diagnostics: string[] = []
  let line = 0
  for (const text of forwardLines(file)) { if (text.includes(key)) parseInto(text, records, diagnostics, line); line++ }
  return { records: [...records.values()].filter(record => record.sessionID === sessionID), diagnostics }
}
export function readSessionsRequests(sessionIDs: Iterable<string>, file = TELEMETRY_FILE): { records: RequestRecord[]; diagnostics: string[] } {
  const records: RequestRecord[] = [], diagnostics: string[] = []
  if (!existsSync(file)) return { records, diagnostics }
  if (!sessionIndexes.has(file)) {
    const index: SessionLineIndex = { identity: "", offset: 0, lines: 0, anchor: Buffer.alloc(0), sessions: new Map() }
    let fd: number | undefined
    try { fd = openSync(file, "r"); index.identity = fileIdentity(fstatSync(fd)); if (catchUpSessionIndex(index, fd)) sessionIndexes.set(file, index) } catch {} finally { if (fd !== undefined) closeSync(fd) }
  }
  for (const sessionID of new Set(sessionIDs)) { const read = readSessionRequests(sessionID, file); records.push(...read.records); diagnostics.push(...read.diagnostics) }
  const index = sessionIndexes.get(file)
  if (index?.nulls) diagnostics.push(...index.nulls)
  return { records, diagnostics }
}
export type TelemetryCursor = { identity: string; offset: number; lines: number; anchor: string }
export function readRequestsSince(cursor: TelemetryCursor | null, file = TELEMETRY_FILE): { records: RequestRecord[]; diagnostics: string[]; cursor: TelemetryCursor; restarted: boolean; bytesRead: number } {
  const empty: TelemetryCursor = { identity: "", offset: 0, lines: 0, anchor: "" }
  if (!existsSync(file)) return { records: [], diagnostics: [], cursor: empty, restarted: false, bytesRead: 0 }
  const fd = openSync(file, "r")
  try {
    const stat = fstatSync(fd), identity = [stat.dev, stat.ino, stat.birthtimeMs].join(":")
    let from = cursor && cursor.identity === identity && cursor.offset <= stat.size ? cursor : null
    if (from && from.offset > 0) {
      const anchor = Buffer.from(from.anchor, "base64")
      const check = Buffer.alloc(anchor.length)
      if (!anchor.length || readSync(fd, check, 0, anchor.length, from.offset - anchor.length) !== anchor.length || !check.equals(anchor)) from = null
    }
    const restarted = !from
    const start = from?.offset ?? 0, lineOffset = from?.lines ?? 0
    const records = new Map<string, RequestRecord>(), diagnostics: string[] = []
    let offset = start, text = ""
    const buffer = Buffer.alloc(1024 * 1024)
    while (offset < stat.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
      if (!n) break
      offset += n
      text += buffer.subarray(0, n).toString("utf8")
    }
    const lastBreak = text.lastIndexOf("\n")
    const complete = lastBreak === -1 ? "" : text.slice(0, lastBreak + 1)
    const consumed = start + Buffer.byteLength(complete, "utf8")
    parseInto(complete, records, diagnostics, lineOffset)
    const lines = lineOffset + (complete ? complete.split("\n").length - 1 : 0)
    let anchor = ""
    if (consumed > 0) {
      const size = Math.min(256, consumed)
      const tail = Buffer.alloc(size)
      if (readSync(fd, tail, 0, size, consumed - size) === size) anchor = tail.toString("base64")
    }
    return { records: [...records.values()], diagnostics, cursor: { identity, offset: consumed, lines, anchor }, restarted, bytesRead: offset - start }
  } finally { closeSync(fd) }
}
export async function readRequestsSinceAsync(cursor: TelemetryCursor | null, file = TELEMETRY_FILE, chunk = 1024 * 1024): Promise<ReturnType<typeof readRequestsSince>> {
  const empty: TelemetryCursor = { identity: "", offset: 0, lines: 0, anchor: "" }
  let handle: FileHandle
  try { handle = await open(file, "r") } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], diagnostics: [], cursor: empty, restarted: false, bytesRead: 0 }; throw error }
  try {
    const stat = await handle.stat(), identity = [stat.dev, stat.ino, stat.birthtimeMs].join(":")
    let from = cursor && cursor.identity === identity && cursor.offset <= stat.size ? cursor : null
    if (from && from.offset > 0) {
      const anchor = Buffer.from(from.anchor, "base64"), check = Buffer.alloc(anchor.length)
      if (!anchor.length || (await handle.read(check, 0, anchor.length, from.offset - anchor.length)).bytesRead !== anchor.length || !check.equals(anchor)) from = null
    }
    const restarted = !from, start = from?.offset ?? 0
    const records = new Map<string, RequestRecord>(), diagnostics: string[] = [], buffer = Buffer.alloc(chunk)
    let offset = start, consumed = start, lines = from?.lines ?? 0, carry = Buffer.alloc(0)
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(chunk, stat.size - offset), offset)
      if (!bytesRead) break
      offset += bytesRead
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
      const end = data.lastIndexOf(10)
      if (end < 0) { carry = Buffer.from(data); continue }
      const complete = data.subarray(0, end + 1).toString("utf8")
      parseInto(complete, records, diagnostics, lines)
      lines += complete.split("\n").length - 1
      consumed += end + 1
      carry = Buffer.from(data.subarray(end + 1))
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    let anchor = ""
    if (consumed > 0) {
      const size = Math.min(256, consumed), tail = Buffer.alloc(size)
      if ((await handle.read(tail, 0, size, consumed - size)).bytesRead === size) anchor = tail.toString("base64")
    }
    return { records: [...records.values()], diagnostics, cursor: { identity, offset: consumed, lines, anchor }, restarted, bytesRead: offset - start }
  } finally { await handle.close() }
}
export function telemetryFileSize(file = TELEMETRY_FILE): number {
  try { return statSync(file).size } catch { return 0 }
}
export const runTraceFile = (runtime: string, runID: string) => join(runtime, "run-traces", runID + ".jsonl")
export function writeRunTrace(file: string, rows: object[], budget: number = TELEMETRY_BUDGET.runTraceBytes): boolean {
  mkdirSync(dirname(file), { recursive: true })
  let text = ""
  for (const row of rows) {
    const line = JSON.stringify(row) + "\n"
    if (Buffer.byteLength(text) + Buffer.byteLength(line) > budget) break
    text += line
  }
  try { writeFileSync(file, text, { encoding: "utf8", flag: "wx", mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error }
  enforceDirectoryBudget(dirname(file), TELEMETRY_BUDGET.runTracesBytes, { cutoff: retentionFrom() })
  return true
}
export function readJsonlRows(file: string): unknown[] | undefined {
  if (!existsSync(file)) return undefined
  const rows: unknown[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch {}
  }
  return rows
}
const questRollupFile = (runtime: string, finishedAt: string) => join(runtime, "quest-rollups", finishedAt.slice(0, 10) + ".jsonl")
export function writeQuestRollup(runtime: string, row: QuestRollupRow): boolean {
  const file = questRollupFile(runtime, row.finishedAt)
  const held = acquireLock(runtime, "quest-rollups", { timeoutMs: 5_000 })
  try {
    const written = (readJsonlRows(file) ?? []) as QuestRollupRow[]
    if (written.some(item => item.questID === row.questID && item.finishedAt === row.finishedAt)) return false
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(row) + "\n", { encoding: "utf8", mode: 0o600 })
    enforceDirectoryBudget(dirname(file), TELEMETRY_BUDGET.runTracesBytes, { cutoff: retentionFrom() })
    return true
  } finally { held.release() }
}
export function readQuestRollups(runtime: string): QuestRollupRow[] {
  const dir = join(runtime, "quest-rollups")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith(".jsonl")).sort().flatMap(name => (readJsonlRows(join(dir, name)) ?? []) as QuestRollupRow[])
}
