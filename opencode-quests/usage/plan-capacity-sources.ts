import { createReadStream, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"
import { HOST_USAGE_DB } from "./host-counters"
import { totalTokens, valueTokensAt, type CapacityEvent } from "./plan-capacity"
import type { priceBook } from "./plan-capacity-prices"
import type { Tokens } from "./telemetry"

const CODEX_SESSIONS = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "sessions") : join(homedir(), ".codex", "sessions")
const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects")
const OPENCODE_DB = HOST_USAGE_DB
const DATABASE_KEY = "opencode.db"

async function eachMatchingLine(path: string, needles: string[], visit: (line: string) => void): Promise<number> {
  const marks = needles.map(n => Buffer.from(n))
  let leftover = Buffer.alloc(0), bytes = 0
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 4 << 20 })
    stream.on("error", reject)
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      const buffer = leftover.length ? Buffer.concat([leftover, chunk]) : chunk
      const end = buffer.lastIndexOf(10)
      if (end < 0) { leftover = buffer; return }
      leftover = buffer.subarray(end + 1)
      const body = buffer.subarray(0, end + 1)
      if (marks.some(m => body.includes(m))) {
        let begin = 0
        for (let i = body.indexOf(10); i >= 0; i = body.indexOf(10, begin)) {
          const line = body.subarray(begin, i)
          begin = i + 1
          if (line.length > 2 && marks.some(m => line.includes(m))) visit(line.toString("utf8"))
        }
      }
    })
    stream.on("end", () => resolve())
  })
  if (leftover.length > 2 && marks.some(m => leftover.includes(m))) visit(leftover.toString("utf8"))
  return bytes
}

const walk = (root: string, suffix: string): string[] => {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, suffix))
    else if (entry.name.endsWith(suffix)) out.push(path)
  }
  return out
}

export type ScanCursor = { size: number; mtimeMs: number }
export type SourceStat = { files: number; bytes: number; rows: number; events: number; from: number | null; to: number | null; milliseconds: number; skipped: number }

export type ScanInput = {
  since?: number | null
  skip?: { codex?: boolean; claude?: boolean; opencode?: boolean }
  cursors?: Record<string, ScanCursor>
  databaseFrom?: number
  price: ReturnType<typeof priceBook>
  accountFor: (provider: string, model: string) => string | null
  excluded: Map<string, number>
  progress?: (text: string) => void
}
export type ScanResult = { byFile: Record<string, CapacityEvent[]>; skipped: string[]; sources: Record<string, SourceStat>; cursors: Record<string, ScanCursor> }

function priced(price: ScanInput["price"], at: number, accountID: string, harness: string, provider: string, model: string, tokens: Tokens, sessionID?: string, effort?: string): CapacityEvent {
  const found = price.rates(provider, model, (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0))
  return { at, accountID, harness, provider, model, effort, sessionID, tokens, units: found ? valueTokensAt(tokens, found.perMillion) : null, ...(found?.assumed ? { assumedPrice: true } : {}) }
}

export async function scanSources(input: ScanInput): Promise<ScanResult> {
  const byFile: Record<string, CapacityEvent[]> = {}
  const skipped: string[] = []
  const sources: Record<string, SourceStat> = {}
  const cursors: Record<string, ScanCursor> = {}
  const progress = input.progress ?? (() => {})
  const blank = (): SourceStat => ({ files: 0, bytes: 0, rows: 0, events: 0, from: null, to: null, milliseconds: 0, skipped: 0 })
  const note = (source: string, path: string, event: CapacityEvent | null) => {
    const s = sources[source]
    s.rows++
    if (!event) return
    ;(byFile[path] ??= []).push(event); s.events++
    s.from = s.from === null ? event.at : Math.min(s.from, event.at)
    s.to = s.to === null ? event.at : Math.max(s.to, event.at)
  }
  const unchanged = (path: string, stat: { size: number; mtimeMs: number }) => {
    const prior = input.cursors?.[path]
    return Boolean(prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs)
  }

  if (!input.skip?.opencode) {
    const started = Date.now()
    const stat = sources.opencode = blank()
    stat.files = 1
    stat.bytes = existsSync(OPENCODE_DB) ? statSync(OPENCODE_DB).size : 0
    if (existsSync(OPENCODE_DB)) {
      const db = new Database(OPENCODE_DB, { readonly: true })
      const seen = new Set<string>()
      const take = (id: string, sessionID: string, provider: string, model: string, variant: string | undefined, raw: any, created: number) => {
        if (seen.has(id)) return
        seen.add(id)
        const tokens: Tokens = { input: raw?.input ?? 0, cacheRead: raw?.cache?.read ?? 0, cacheWrite: raw?.cache?.write ?? 0, output: raw?.output ?? 0, reasoning: raw?.reasoning ?? 0 }
        if (totalTokens(tokens) === 0 || !Number.isFinite(created)) return
        const account = input.accountFor(provider, model)
        note("opencode", DATABASE_KEY, account ? priced(input.price, created, account, "opencode", provider, model, tokens, sessionID, variant) : null)
      }
      const recent = input.databaseFrom === undefined ? "" : " and json_extract(data, '$.time.created') >= " + Math.floor(input.databaseFrom)
      for (const row of db.query("select id, session_id as s, data from session_message where type = 'assistant'" + recent).iterate() as any) {
        const data = JSON.parse(row.data), model = data?.model ?? {}
        take(row.id, row.s, model.providerID ?? "", model.id ?? "", model.variant, data?.tokens, data?.time?.created)
      }
      const legacy = db.query("select 1 from sqlite_master where type = 'table' and name = 'message'").get()
      if (legacy) for (const row of db.query("select id, session_id as s, data from message" + (input.databaseFrom === undefined ? "" : " where json_extract(data, '$.time.created') >= " + Math.floor(input.databaseFrom))).iterate() as any) {
        const data = JSON.parse(row.data)
        if (data?.role !== "assistant") continue
        take(row.id, row.s, data.providerID ?? "", data.modelID ?? "", undefined, data?.tokens, data?.time?.created)
      }
      db.close()
    }
    stat.milliseconds = Date.now() - started
    progress("  opencode.db: " + stat.events + " events")
  }

  if (!input.skip?.claude) {
    const started = Date.now()
    const stat = sources["claude-code"] = blank()
    const files = walk(CLAUDE_PROJECTS, ".jsonl").sort()
    for (const [index, path] of files.entries()) {
      const fact = statSync(path)
      cursors[path] = { size: fact.size, mtimeMs: fact.mtimeMs }
      if (unchanged(path, fact)) { stat.skipped++; skipped.push(path); continue }
      const best = new Map<string, CapacityEvent>()
      stat.bytes += await eachMatchingLine(path, ['"usage"'], line => {
        let row: any
        try { row = JSON.parse(line) } catch { return }
        const message = row?.message, usage = message?.usage
        if (row?.type !== "assistant" || !usage || typeof message?.model !== "string" || message.model === "<synthetic>") return
        if (!message.model.startsWith("claude-")) { input.excluded.set("claude-transcript:" + message.model, (input.excluded.get("claude-transcript:" + message.model) ?? 0) + 1); return }
        const when = Date.parse(row.timestamp ?? "")
        if (!Number.isFinite(when)) return
        const reasoning = usage.output_tokens_details?.thinking_tokens ?? 0
        const tokens: Tokens = { input: usage.input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, output: Math.max(0, (usage.output_tokens ?? 0) - reasoning), reasoning }
        const account = input.accountFor("claude-code", message.model)
        const event = account ? priced(input.price, when, account, "claude-code", "anthropic", message.model, tokens, row.sessionId, undefined) : null
        stat.rows++
        if (!event) return
        const key = (message.id ?? row.uuid) + "|" + (row.requestId ?? "")
        const prior = best.get(key)
        if (!prior || totalTokens(event.tokens) > totalTokens(prior.tokens)) best.set(key, event)
      })
      stat.files++
      for (const event of best.values()) {
        ;(byFile[path] ??= []).push(event); stat.events++
        stat.from = Math.min(stat.from ?? event.at, event.at)
        stat.to = Math.max(stat.to ?? event.at, event.at)
      }
      if (index % 50 === 0) progress("  claude " + index + "/" + files.length + " files, " + (stat.bytes / 1e6).toFixed(0) + " MB")
    }
    stat.milliseconds = Date.now() - started
  }

  if (!input.skip?.codex) {
    const started = Date.now()
    const stat = sources.codex = blank()
    const files = walk(CODEX_SESSIONS, ".jsonl").sort()
    const seen = new Set<string>()
    for (const [index, path] of files.entries()) {
      const fact = statSync(path)
      if (input.since != null && fact.mtimeMs < input.since) continue
      cursors[path] = { size: fact.size, mtimeMs: fact.mtimeMs }
      if (unchanged(path, fact)) { stat.skipped++; skipped.push(path); continue }
      const turns = new Map<string, { model: string; effort?: string }>()
      let session = "", provider = "openai", latest: { model: string; effort?: string } | undefined
      stat.bytes += await eachMatchingLine(path, ['"token_usage_record"', '"turn_context"', '"session_meta"'], line => {
        let row: any
        try { row = JSON.parse(line) } catch { return }
        const payload = row?.payload
        if (row?.type === "session_meta") { session = payload?.session_id ?? session; provider = payload?.model_provider ?? "openai"; return }
        if (row?.type === "turn_context") {
          if (typeof payload?.model === "string") { latest = { model: payload.model, effort: payload.effort }; if (payload.turn_id) turns.set(payload.turn_id, latest) }
          return
        }
        if (row?.type !== "token_usage_record") return
        const usage = payload?.usage, when = Date.parse(row.timestamp ?? "")
        if (!usage || !Number.isFinite(when)) return
        const key = payload.response_id ?? payload.turn_id + ":" + row.timestamp
        if (seen.has(key)) return
        seen.add(key)
        const route = turns.get(payload.turn_id) ?? latest
        if (!route) return
        if (provider !== "openai") { input.excluded.set("codex:" + provider, (input.excluded.get("codex:" + provider) ?? 0) + 1); return }
        const cacheRead = usage.cached_input_tokens ?? 0, cacheWrite = usage.cache_write_input_tokens ?? 0, reasoning = usage.reasoning_output_tokens ?? 0
        const tokens: Tokens = { input: Math.max(0, (usage.input_tokens ?? 0) - cacheRead - cacheWrite), cacheRead, cacheWrite, output: Math.max(0, (usage.output_tokens ?? 0) - reasoning), reasoning }
        const account = input.accountFor("openai", route.model)
        note("codex", path, account ? priced(input.price, when, account, "codex", "openai", route.model, tokens, payload.session_id ?? session, route.effort) : null)
      })
      stat.files++
      if (index % 250 === 0) progress("  codex " + index + "/" + files.length + " files, " + (stat.bytes / 1e9).toFixed(2) + " GB, " + stat.events + " events")
    }
    stat.milliseconds = Date.now() - started
  }

  return { byFile, skipped, sources, cursors }
}
