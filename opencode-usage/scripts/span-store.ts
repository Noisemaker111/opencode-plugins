import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { backwardChunks, forwardLines, spanEnd, spanFiles } from "./span-files.mjs"

export const TELEMETRY_FILE = process.env.OPENCODE_TELEMETRY_FILE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "opencode", "requests.jsonl")
export const SPANS_FILE = TELEMETRY_FILE + ".spans.jsonl"
export type SpanRow = { plugin: string; name: string; op?: string; id?: string; sessionID?: string; start: number; end: number; duration?: number; sync?: number; location?: string; error?: string; route?: string; host?: string; outcome?: string; tokens?: number | null; harness?: string; accountID?: string; recordedAt?: number }
export type SpanWindow = { from?: number; to?: number }
export const hostIdentity = () => process.env.QUEST_HOST ?? process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "local"
const round = (ms: number) => Math.round(ms * 10) / 10

export function normalizeSpan(row: Record<string, any>) {
  const start = round(row.start), end = round(row.end)
  return { ...row, kind: "span", start, end, duration: round(Math.max(0, end - start)), host: row.host ?? hostIdentity(), pid: row.pid ?? process.pid, route: row.route ?? [row.plugin, row.op ?? row.name].filter(Boolean).join("/"), outcome: row.outcome ?? (row.error ? "failed" : "completed"), tokens: row.tokens ?? null }
}

function spanCollector() {
  const rows: Record<string, any>[] = [], identified = new Map<string, Record<string, any>>(), locations = new Map<string, string>()
  return {
    add(line: string) {
      let row: Record<string, any>
      try { row = JSON.parse(line) } catch { return }
      if (row?.v !== 1) return
      if (row.kind === "location") { locations.set(row.id, row.location); return }
      if (typeof row.loc === "string") { const { loc, ...rest } = row; row = { ...rest, location: locations.get(loc) } }
      if (row.kind === "span") row = normalizeSpan(row)
      if (row.kind !== "span" || typeof row.id !== "string") { rows.push(row); return }
      const previous = identified.get(row.id)
      if (!previous || (row.recordedAt ?? row.end) >= (previous.recordedAt ?? previous.end)) identified.set(row.id, row)
    },
    rows: () => [...rows, ...identified.values()],
  }
}

const lineEnd = (line: string) => { try { return spanEnd(JSON.parse(line)) ?? -Infinity } catch { return -Infinity } }

function* legacyLines(file: string, from: number | undefined): Generator<string> {
  for (const lines of backwardChunks(file)) {
    let newest = -Infinity
    for (const line of lines) { if (from !== undefined) newest = Math.max(newest, lineEnd(line)); yield line }
    if (from !== undefined && lines.length && newest < from) return
  }
}

export function readSpanRows(file = process.env.OPENCODE_SPANS_FILE ?? SPANS_FILE, window: SpanWindow = {}): Record<string, any>[] {
  const collector = spanCollector()
  for (const day of spanFiles(file, window)) for (const line of forwardLines(day)) collector.add(line)
  if (existsSync(file)) for (const line of window.from === undefined ? forwardLines(file) : legacyLines(file, window.from)) collector.add(line)
  return collector.rows()
}
