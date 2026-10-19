import { readFileSync } from "node:fs"
import { benchmarkFile, benchmarkFor, type BenchmarkEntry, type BenchmarkTable } from "./benchmark-table"
import { canonicalModelID, slugModel } from "./model-catalog"

export type PublishedSpeedRow = {
  model: string
  effort: string
  suite: string
  outputTokensPerSecond?: number
  firstAnswerSeconds?: number
  suiteOutputTokens?: number
  secondsPerTask?: number
  costPerTaskUSD?: number
  source: string
  measuredAt: string
}
export type PublishedSpeed = { version: 1; rows: PublishedSpeedRow[] }
export type PublishedTask = {
  outputTokens: number
  seconds: number
  calls: number | null
  basis: "published" | "borrowed"
  from?: string
  suite: string
  source: string
  said: string
}

const FENCE = /```json speed-published\r?\n([\s\S]*?)\r?\n```/
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0
const same = (a: string, b: string) => slugModel(canonicalModelID(a)) === slugModel(canonicalModelID(b))
const median = (values: number[]) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : null }

export function readPublishedSpeed(file = benchmarkFile()): PublishedSpeed {
  let document = ""
  try { document = readFileSync(file, "utf8") } catch { return { version: 1, rows: [] } }
  const block = FENCE.exec(document)
  if (!block) return { version: 1, rows: [] }
  const value = JSON.parse(block[1]) as PublishedSpeed
  const problem = publishedSpeedProblem(value)
  if (problem) throw new Error("speed-published block in " + file + ": " + problem)
  return value
}
export function publishedSpeedProblem(value: PublishedSpeed): string | undefined {
  if (value?.version !== 1 || !Array.isArray(value.rows)) return "must be version 1 with a rows list"
  for (const [index, row] of value.rows.entries()) {
    const at = "rows[" + index + "]"
    if (![row?.model, row?.effort, row?.suite, row?.source].every(text => typeof text === "string" && text.trim())) return at + " needs model, effort, suite and source"
    if (!Number.isFinite(Date.parse(row.measuredAt))) return at + " needs a measurement date"
    const figures = ["outputTokensPerSecond", "firstAnswerSeconds", "suiteOutputTokens", "secondsPerTask", "costPerTaskUSD"] as const
    if (figures.some(field => row[field] !== undefined && !positive(row[field]))) return at + " has a figure that is not a positive number"
    if (![row.outputTokensPerSecond, row.suiteOutputTokens, row.secondsPerTask].some(positive)) return at + " states no speed, tokens or time"
  }
  return undefined
}

export function speedRowsFor(published: PublishedSpeed, modelID: string, effort: string) {
  return published.rows.filter(row => same(row.model, modelID) && row.effort.toLowerCase() === effort.toLowerCase())
}

function ownPerTask(entry: BenchmarkEntry | undefined, effort: string) {
  const task = entry?.perTask?.[effort]
  return task && positive(task.outputTokens) && positive(task.seconds) ? task : undefined
}

export function publishedTasks(table: BenchmarkTable, published: PublishedSpeed) {
  const names = (entry: BenchmarkEntry) => [entry.id, ...(entry.aliases ?? [])]
  const pairs = published.rows.flatMap(row => {
    const task = ownPerTask(benchmarkFor(table, row.model), row.effort)
    return task ? [{ row, task }] : []
  })
  const bridge = (suite: string) => {
    const mine = pairs.filter(pair => pair.row.suite === suite)
    return {
      tokens: median(mine.flatMap(({ row, task }) => positive(row.suiteOutputTokens) ? [task.outputTokens / row.suiteOutputTokens] : [])),
      wall: median(mine.flatMap(({ row, task }) => positive(row.outputTokensPerSecond) ? [task.seconds / (task.outputTokens / row.outputTokensPerSecond)] : [])),
      seconds: median(mine.flatMap(({ row, task }) => positive(row.secondsPerTask) ? [task.seconds / row.secondsPerTask] : [])),
      models: [...new Set(mine.map(pair => pair.row.model))],
    }
  }
  const direct = (entry: BenchmarkEntry | undefined, modelID: string, effort: string): Omit<PublishedTask, "basis" | "from"> | null => {
    const task = ownPerTask(entry, effort)
    if (task) return { outputTokens: task.outputTokens, seconds: task.seconds, calls: positive(task.agentSteps) ? task.agentSteps : null, suite: table.suite, source: entry!.source, said: table.suite + " per-task figures" }
    for (const row of speedRowsFor(published, modelID, effort)) {
      const b = bridge(row.suite)
      if (!positive(row.suiteOutputTokens) || b.tokens === null) continue
      const tokens = row.suiteOutputTokens * b.tokens
      const seconds = positive(row.secondsPerTask) && b.seconds !== null ? row.secondsPerTask * b.seconds
        : positive(row.outputTokensPerSecond) && b.wall !== null ? tokens / row.outputTokensPerSecond * b.wall : null
      if (seconds === null) continue
      return { outputTokens: tokens, seconds, calls: null, suite: row.suite, source: row.source,
        said: row.suite + " figures converted to " + table.suite + " per-task terms through " + b.models.join(", ") + ", which have rows in both" }
    }
    return null
  }
  const ancestors = (entry: BenchmarkEntry | undefined) => {
    const found: BenchmarkEntry[] = [], seen = new Set<BenchmarkEntry>()
    while (entry?.succeeds && !seen.has(entry)) { seen.add(entry); entry = benchmarkFor(table, entry.succeeds); if (entry) found.push(entry) }
    return found
  }
  return (modelID: string, effort: string): PublishedTask | null => {
    let entry = benchmarkFor(table, modelID)
    const own = direct(entry, modelID, effort)
    if (own && own.calls === null) {
      const steps = ancestors(entry).map(predecessor => ({ predecessor, task: ownPerTask(predecessor, effort) })).find(found => positive(found.task?.agentSteps))
      if (steps) return { ...own, calls: steps.task!.agentSteps, basis: "published", said: own.said + "; model calls borrowed from " + steps.predecessor.id }
    }
    if (own) return { ...own, basis: "published" }
    const seen = new Set<BenchmarkEntry>()
    while (entry?.succeeds && !seen.has(entry)) {
      seen.add(entry)
      const predecessor = benchmarkFor(table, entry.succeeds)
      if (!predecessor) break
      const found = direct(predecessor, predecessor.id, effort) ?? names(predecessor).map(name => direct(predecessor, name, effort)).find(Boolean) ?? null
      if (found) return { ...found, basis: "borrowed", from: predecessor.id, said: "borrowed from " + predecessor.id + ": " + found.said }
      entry = predecessor
    }
    return null
  }
}
