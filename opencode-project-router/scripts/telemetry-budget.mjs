import { appendFileSync, closeSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { basename, join } from "node:path"
import { backwardChunks, localDay, spanFiles } from "./span-files.mjs"
import { writeFileDurable } from "../quest/core/durable-file.mjs"

const MB = 1024 * 1024
const DAY = 86_400_000

export const TELEMETRY_BUDGET = {
  retentionDays: 14,
  analysisRefreshDays: 1,
  analysisBytes: 2 * MB,
  analysisHistoryBytes: 8 * MB,
  analysisCredentialBytes: 16 * 1024,
  spansBytes: 13 * MB,
  spanDayBytes: 8 * MB,
  spanDayKeepBytes: 6 * MB,
  checksBytes: 1 * MB,
  requestsBytes: 20 * MB,
  ledgerBytes: 15 * MB,
  ledgerSummaryBytes: 256 * 1024,
  contextBytes: 1 * MB,
  observationsBytes: 2 * MB,
  decisionsBytes: 1 * MB,
  permissionDecisionsBytes: 1.5 * MB,
  approvedCommandsBytes: 256 * 1024,
  usageConnectionsBytes: 64 * 1024,
  hostDatabaseBytes: 40 * MB,
  hostHistoryDays: 3,
  hostToolOutputBytes: 2 * 1024,
  questAssetsBytes: 30 * MB,
  journalsBytes: 5 * MB,
  journalSnapshotEvents: 5000,
  settledJournalDays: 14,
  historyEntries: 50,
  sessionsPerStep: 20,
  routingDecisionsBytes: 8 * MB,
  runTracesBytes: 32 * MB,
  runTraceBytes: 256 * 1024,
  routingAlternatives: 3,
  reviewRecordBytes: 24 * 1024,
  questSnapshotsBytes: 16 * MB,
  spanAggregateBytes: 8 * MB,
  boardSummaryBytes: 4 * MB,
  backupsBytes: 5 * MB,
  reloadRecordsBytes: 1 * MB,
  reloadRecordsRetention: "pending until settled; results until consumed",
  driftBytes: 64 * 1024,
  appUpdatesLogBytes: 256 * 1024,
  routeOutagesBytes: 1 * MB,
  keepRatio: 0.8,
}

export const TELEMETRY_STORE_WRITERS = [
  { file: "models/artificial-analysis.ts", budget: "analysisBytes", retention: "one snapshot; refresh daily and at host start in the background; retain last good snapshot on failure" },
  { file: "models/artificial-analysis.ts", budget: "analysisHistoryBytes", retention: "append-only history, one line per refresh attempt with changed values; oldest lines dropped past the budget" },
  { file: "models/artificial-analysis.ts", budget: "analysisCredentialBytes", retention: "one Windows-protected key until replaced or disconnected" },
  { file: "scripts/plugin-spans.ts", budget: "spansBytes" },
  { file: "scripts/telemetry-budget.mjs", budget: "spansBytes", retention: "older day files drop first, then the base file's oldest lines; a current day over 8 MB keeps only its newest 6 MB; a telemetry.budget line records a trimmed day or a day over the total" },
  { file: "scripts/check-spans.mjs", budget: "checksBytes" },
  { file: "usage/telemetry-store.ts", budget: "requestsBytes" },
  { file: "usage/passive-ledger.ts", budget: "ledgerBytes" },
  { file: "usage/context-events.ts", budget: "contextBytes" },
  { file: "usage/calibration-store.ts", budget: "observationsBytes" },
  { file: "quest/giver/giver-compaction.ts", budget: "decisionsBytes" },
  { file: "quest/permissions/decision-log.ts", budget: "permissionDecisionsBytes" },
  { file: "quest/permissions/approved-commands.ts", budget: "approvedCommandsBytes" },
  { file: "scripts/host-database-budget.mjs", budget: "hostDatabaseBytes" },
  { file: "quest/artifacts/artifacts.ts", budget: "questAssetsBytes" },
  { file: "quest/core/journal.ts", budget: "journalsBytes" },
  { file: "quest/routing/routing-history.ts", budget: "routingDecisionsBytes" },
  { file: "usage/telemetry-store.ts", budget: "runTracesBytes", retention: "one JSONL trace per run beside its routing decision: written once when the run ends, oldest files drop at the budget and retention days" },
  { file: "quest/store.ts", budget: "questSnapshotsBytes" },
  { file: "quest/board/span-aggregate.ts", budget: "spanAggregateBytes" },
  { file: "quest/board/board-summary.ts", budget: "boardSummaryBytes" },
  { file: "models/dispatch-policy.ts", budget: "backupsBytes" },
  { file: "scripts/landing-quiet.mjs", budget: "reloadRecordsBytes", retention: TELEMETRY_BUDGET.reloadRecordsRetention },
  { file: "scripts/version-drift.mjs", budget: "driftBytes", retention: "one snapshot of the current versions and alerts, plus the last 20 transitions" },
  { file: "scripts/landing-quiet.mjs", budget: "checksBytes", retentionDays: TELEMETRY_BUDGET.retentionDays },
  { file: "usage/route-limits.ts", budget: "routeOutagesBytes", retention: "append-only outage starts, failed probes and recoveries, trimmed to the budget and retention days" },
  { file: "scripts/app-updates.mjs", budget: "appUpdatesLogBytes", retention: "one line per step of each weekly run; oldest lines drop at the budget" },
]

export const retentionFrom = (now = Date.now()) => now - TELEMETRY_BUDGET.retentionDays * DAY

export function rowTime(row) {
  return [row?.request?.startedAt, row?.startedAt, row?.start, row?.at, row?.created, row?.observed].find(value => typeof value === "number" && Number.isFinite(value))
}

function firstRowTime(file) {
  const fd = openSync(file, "r")
  try {
    const buffer = Buffer.alloc(Math.min(1 << 16, statSync(file).size))
    const first = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8").split("\n", 1)[0]
    try { return rowTime(JSON.parse(first)) } catch { return undefined }
  } finally { closeSync(fd) }
}

function keepNewest(file, keep, cutoff = -Infinity) {
  const before = statSync(file).size
  let kept = 0
  scan: for (const lines of backwardChunks(file)) {
    for (const line of lines) {
      const bytes = Buffer.byteLength(line) + 1
      let time
      try { time = rowTime(JSON.parse(line)) } catch {}
      if (kept + bytes > keep || (time !== undefined && time < cutoff)) break scan
      kept += bytes
    }
  }
  if (kept >= before) return 0
  const temporary = file + ".trim-" + process.pid, buffer = Buffer.alloc(1 << 20)
  const source = openSync(file, "r"), out = openSync(temporary, "w", 0o600)
  try {
    for (let at = before - kept; at < before;) {
      const n = readSync(source, buffer, 0, Math.min(buffer.length, before - at), at)
      if (!n) break
      writeSync(out, buffer, 0, n)
      at += n
    }
  } finally { closeSync(source); closeSync(out) }
  renameSync(temporary, file)
  return before - kept
}

export function trimJsonlTail(file, budget, cutoff) {
  keepNewest(file, Math.floor(budget * TELEMETRY_BUDGET.keepRatio), cutoff)
}

export function enforceJsonlBudget(file, budget, cutoff = retentionFrom()) {
  let size
  try { size = statSync(file).size } catch { return }
  if (size > budget || (firstRowTime(file) ?? Infinity) < cutoff) trimJsonlTail(file, budget, cutoff)
}

export function enforceTextBudget(file, budget = TELEMETRY_BUDGET.appUpdatesLogBytes) {
  let text
  try { text = readFileSync(file, "utf8") } catch { return }
  if (Buffer.byteLength(text) <= budget) return
  const kept = []
  let size = 0
  for (const line of text.split("\n").reverse()) {
    size += Buffer.byteLength(line) + 1
    if (size > budget * TELEMETRY_BUDGET.keepRatio) break
    kept.unshift(line)
  }
  writeFileDurable(file, kept.join("\n"))
}

const sizeOf = file => { try { return statSync(file).size } catch { return 0 } }

const budgetLine = (now, fields) => JSON.stringify({ v: 1, kind: "span", plugin: "telemetry", name: "telemetry.budget", start: now, end: now, ...fields }) + "\n"

export function enforceSpanBudget(file, now = Date.now(), budget = TELEMETRY_BUDGET.spansBytes) {
  const cutoff = retentionFrom(now), cutoffDay = localDay(cutoff), today = localDay(now)
  const days = spanFiles(file).map(path => ({ path, day: basename(path).match(/\.(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1] ?? "", size: sizeOf(path) }))
  let total = sizeOf(file) + days.reduce((sum, day) => sum + day.size, 0), next = 0
  for (; next < days.length; next++) {
    const day = days[next]
    if (day.day >= today || (day.day >= cutoffDay && total <= budget)) break
    rmSync(day.path, { force: true })
    total -= day.size
  }
  const kept = days.slice(next)
  const current = kept.find(day => day.day === today)
  if (current && current.size > TELEMETRY_BUDGET.spanDayBytes) {
    const dropped = keepNewest(current.path, TELEMETRY_BUDGET.spanDayKeepBytes)
    appendFileSync(current.path, budgetLine(now, { overBytes: dropped, action: "trim-day" }), { mode: 0o600 })
    current.size = sizeOf(current.path)
  }
  const keptBytes = kept.reduce((sum, day) => sum + day.size, 0)
  enforceJsonlBudget(file, Math.max(0, budget - keptBytes), cutoff)
  const overBytes = sizeOf(file) + keptBytes - budget
  if (overBytes > 0) appendFileSync(file, budgetLine(now, { overBytes, files: kept.map(day => basename(day.path)), action: "kept the current day; no older span data left to trim" }), { mode: 0o600 })
}

const SWEEP_EVERY = 10 * 60_000
const lastSweep = new Map()

function treeBytes(path) {
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.size
  return readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name)), 0)
}

export function enforceSnapshotBudget(state, budget) {
  const text = JSON.stringify(state, null, 2) + "\n"
  return text.length <= budget ? text : JSON.stringify({ ...state, events: [] }, null, 2) + "\n"
}

/** @type {(dir: string, budget: number, options?: { cutoff?: number, deletable?: (entry: { name: string, path: string, bytes: number, mtime: number }) => boolean, now?: number }) => void} */
export function enforceDirectoryBudget(dir, budget, { cutoff = -Infinity, deletable = () => true, now = Date.now() } = {}) {
  let entries
  try {
    entries = readdirSync(dir).map(name => {
      const path = join(dir, name)
      return { name, path, bytes: treeBytes(path), mtime: statSync(path).mtimeMs }
    })
  } catch { return }
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const expired = entries.some(entry => entry.mtime < cutoff)
  if (total <= budget && !(expired && now - (lastSweep.get(dir) ?? -Infinity) >= SWEEP_EVERY)) return
  lastSweep.set(dir, now)
  const oldestFirst = [...entries].sort((a, b) => a.mtime - b.mtime), removed = new Set()
  const drop = entry => {
    if (removed.has(entry) || !deletable(entry)) return
    rmSync(entry.path, { recursive: true, force: true })
    removed.add(entry)
    total -= entry.bytes
  }
  for (const entry of oldestFirst) if (entry.mtime < cutoff) drop(entry)
  if (total > budget) for (const entry of oldestFirst) {
    if (total <= budget * TELEMETRY_BUDGET.keepRatio) break
    drop(entry)
  }
}
