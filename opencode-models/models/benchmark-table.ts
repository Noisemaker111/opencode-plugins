import { readFileSync } from "node:fs"
import { join } from "node:path"
import { canonicalModelID } from "./model-catalog"

export type BenchmarkProvenance = "independent" | "vendor"
export type BenchmarkPerTask = {
  costUSD: number
  outputTokens: number
  inputTokens: number
  seconds: number
  agentSteps: number
  costBasis?: string
}
export type BenchmarkRow = {
  passAt1: number
  provenance: BenchmarkProvenance
  source: string
  measuredAt: string
  perTask?: BenchmarkPerTask
  from?: string
}
export type BenchmarkEntry = {
  id: string
  aliases?: string[]
  provenance: BenchmarkProvenance
  source: string
  measuredAt: string
  succeeds?: string
  retiredInto?: string
  retiredAt?: string
  intelligence?: number
  passAt1: Record<string, number>
  perTask?: Record<string, BenchmarkPerTask>
  inherited?: Record<string, BenchmarkRow>
  vendorClaim?: { passAt1: number; provenance: BenchmarkProvenance; source: string; measuredAt: string }
  lineage?: string
}
export type BenchmarkTable = { version: 1; suite: string; entries: BenchmarkEntry[] }

export const benchmarkFile = () => process.env.OPENCODE_BENCHMARKS ?? join(import.meta.dir, "benchmarks.md")
const FENCE = /```json benchmark-routing\r?\n([\s\S]*?)\r?\n```/

export function readBenchmarkTable(file = benchmarkFile()): BenchmarkTable {
  let document: string
  try { document = readFileSync(file, "utf8") } catch { throw new Error("Benchmark table is unavailable; " + file + " must carry a benchmark-routing block") }
  const block = FENCE.exec(document)
  if (!block) throw new Error("No fenced benchmark-routing block in " + file)
  let table: BenchmarkTable
  try { table = JSON.parse(block[1]) } catch (error) { throw new Error("benchmark-routing block is not valid JSON: " + (error as Error).message) }
  if (table?.version !== 1 || !table.suite?.trim() || !Array.isArray(table.entries) || !table.entries.length) throw new Error("benchmark-routing must be version 1 with a named suite and at least one model")
  const seen = new Set<string>()
  for (const entry of table.entries) {
    const names = [entry?.id, ...(entry?.aliases ?? [])]
    if (!names.every(name => typeof name === "string" && name.trim())) throw new Error("Benchmark entry needs a model id")
    if (!["independent", "vendor"].includes(entry.provenance)) throw new Error(entry.id + ": provenance must be independent or vendor")
    if (!entry.source?.trim() || !Number.isFinite(Date.parse(entry.measuredAt))) throw new Error(entry.id + ": every score needs a source and a measurement date")
    if (entry.intelligence !== undefined && !(Number.isFinite(entry.intelligence) && entry.intelligence > 0)) throw new Error(entry.id + ": invalid intelligence index")
    if (entry.succeeds !== undefined && (typeof entry.succeeds !== "string" || !entry.succeeds.trim())) throw new Error(entry.id + ": succeeds must name a benchmark entry")
    if (entry.retiredInto !== undefined && (typeof entry.retiredInto !== "string" || !entry.retiredInto.trim())) throw new Error(entry.id + ": retiredInto must name a benchmark entry")
    if (entry.retiredAt !== undefined && !Number.isFinite(Date.parse(entry.retiredAt))) throw new Error(entry.id + ": retiredAt must be a date")
    const efforts = Object.entries(entry.passAt1 ?? {})
    if (!efforts.length) throw new Error(entry.id + ": no pass@1 scores")
    for (const [effort, score] of efforts) {
      if (!effort.trim()) throw new Error(entry.id + ": empty effort level")
      if (!Number.isFinite(score) || score <= 0 || score > 1) throw new Error(entry.id + " " + effort + ": pass@1 must be a fraction in (0,1]")
    }
    if ("unstated" in entry.passAt1 && efforts.length > 1) throw new Error(entry.id + ": an unstated-effort score cannot sit beside per-effort scores")
    for (const [effort, task] of Object.entries(entry.perTask ?? {})) {
      if (!(effort in entry.passAt1)) throw new Error(entry.id + " " + effort + ": per-task evidence for an effort with no published pass@1")
      for (const field of ["costUSD", "outputTokens", "inputTokens", "seconds", "agentSteps"] as const)
        if (!Number.isFinite(task?.[field]) || task[field] <= 0) throw new Error(entry.id + " " + effort + ": " + field + " must be a positive measurement")
      if (task.costBasis !== undefined && !task.costBasis.trim()) throw new Error(entry.id + " " + effort + ": an empty cost basis is not a basis; omit it")
    }
    for (const name of names) {
      const key = canonicalModelID(name)
      if (seen.has(key)) throw new Error("Duplicate benchmark identity: " + name)
      seen.add(key)
    }
  }
  resolveSuccession(table)
  return table
}

function publishedRows(entry: BenchmarkEntry): Record<string, BenchmarkRow> {
  const rows: Record<string, BenchmarkRow> = {}
  for (const [effort, passAt1] of Object.entries(entry.passAt1)) {
    if (effort === "unstated") continue
    rows[effort] = { passAt1, provenance: entry.provenance, source: entry.source, measuredAt: entry.measuredAt, ...(entry.perTask?.[effort] ? { perTask: entry.perTask[effort] } : {}) }
  }
  return rows
}
export function benchmarkRows(entry: BenchmarkEntry): Record<string, BenchmarkRow> {
  return { ...(entry.inherited ?? {}), ...publishedRows(entry) }
}
export function modelRetirement(table: BenchmarkTable, modelID: string, now: number) {
  const entry = benchmarkFor(table, modelID)
  return entry?.retiredAt && Date.parse(entry.retiredAt) <= now ? entry.retiredAt : undefined
}
function resolveSuccession(table: BenchmarkTable) {
  const byIdentity = new Map<string, BenchmarkEntry>()
  for (const entry of table.entries) for (const name of [entry.id, ...(entry.aliases ?? [])]) byIdentity.set(canonicalModelID(name), entry)
  for (const entry of table.entries) {
    if (entry.retiredInto === undefined) continue
    const successor = byIdentity.get(canonicalModelID(entry.retiredInto))
    if (!successor) throw new Error(entry.id + ": retiredInto names " + entry.retiredInto + ", which is not in this block")
    if (canonicalModelID(successor.succeeds ?? "") !== canonicalModelID(entry.id)) throw new Error(entry.id + ": retiredInto names " + entry.retiredInto + ", which does not declare succeeds back to it")
  }
  const resolved = new Set<BenchmarkEntry>(), open = new Set<BenchmarkEntry>()
  const resolve = (entry: BenchmarkEntry): Record<string, BenchmarkRow> => {
    if (resolved.has(entry)) return benchmarkRows(entry)
    if (open.has(entry)) throw new Error(entry.id + ": succeeds forms a cycle")
    open.add(entry)
    try {
      if (entry.succeeds) {
        const predecessor = byIdentity.get(canonicalModelID(entry.succeeds))
        if (!predecessor) throw new Error(entry.id + ": succeeds names " + entry.succeeds + ", which is not in this block")
        if (predecessor === entry) throw new Error(entry.id + ": an entry cannot succeed itself")
        const ancestor = resolve(predecessor)
        const own = publishedRows(entry)
        const inherited: Record<string, BenchmarkRow> = {}
        for (const [effort, row] of Object.entries(ancestor)) if (!own[effort]) inherited[effort] = { ...row, from: row.from ?? predecessor.id }
        if (Object.keys(inherited).length) entry.inherited = inherited
        const unstated = entry.passAt1.unstated
        if (unstated !== undefined && Object.keys(inherited).length) {
          entry.vendorClaim = { passAt1: unstated, provenance: entry.provenance, source: entry.source, measuredAt: entry.measuredAt }
        }
      }
      resolved.add(entry)
      return benchmarkRows(entry)
    } finally { open.delete(entry) }
  }
  for (const entry of table.entries) resolve(entry)
}

export type CatalogLineageModel = { modelID: string; family?: string; releaseDate?: string }
export const versionlessName = (modelID: string) => canonicalModelID(modelID).split(/[^a-z0-9]+/).map(part => part.replace(/[0-9]+/g, "")).filter(Boolean).join(" ")
export function withCatalogLineage(table: BenchmarkTable, catalog: CatalogLineageModel[]) {
  const released = (value: string | undefined) => { const at = Date.parse(value ?? ""); return Number.isFinite(at) ? at : undefined }
  const known = new Map<string, { family: string; at: number; date: string }>()
  for (const model of catalog) {
    const at = released(model.releaseDate), family = model.family?.trim()
    if (at === undefined || !family) continue
    const key = canonicalModelID(model.modelID), prior = known.get(key)
    if (!prior || at < prior.at) known.set(key, { family, at, date: model.releaseDate! })
  }
  const placed = table.entries.flatMap(entry => {
    const listed = [entry.id, ...(entry.aliases ?? [])].map(name => known.get(canonicalModelID(name))).filter(x => x !== undefined)
    return listed.length ? [{ entry, family: listed[0].family, at: Math.min(...listed.map(x => x.at)), date: listed.sort((a, b) => a.at - b.at)[0].date }] : []
  })
  const entries: BenchmarkEntry[] = [], diagnostics: string[] = []
  for (const [id, model] of known) {
    if (benchmarkFor(table, id)) continue
    const earlier = placed.filter(p => p.family === model.family && p.at < model.at && [p.entry.id, ...(p.entry.aliases ?? [])].some(name => versionlessName(name) === versionlessName(id)))
    if (!earlier.length) continue
    const latest = Math.max(...earlier.map(p => p.at)), nearest = earlier.filter(p => p.at === latest)
    if (nearest.length > 1) { diagnostics.push(id + ": catalog family " + model.family + " has " + nearest.length + " entries released " + nearest[0].date + " (" + nearest.map(p => p.entry.id).join(", ") + "), so no predecessor is inherited"); continue }
    const predecessor = nearest[0]
    const rows = benchmarkRows(predecessor.entry)
    if (!Object.keys(rows).length) continue
    const lineage = "lineage from the models.dev catalog: family " + model.family + ", same name without version numbers, released " + model.date + " after " + predecessor.entry.id + " (" + predecessor.date + ")"
    entries.push({ id, succeeds: predecessor.entry.id, provenance: predecessor.entry.provenance, source: predecessor.entry.source, measuredAt: predecessor.entry.measuredAt, passAt1: {}, lineage,
      inherited: Object.fromEntries(Object.entries(rows).map(([effort, row]) => [effort, { ...row, from: row.from ?? predecessor.entry.id }])) })
    diagnostics.push(id + ": no benchmark entry; inherits " + predecessor.entry.id + "'s rows as a floor (" + lineage + ")")
  }
  return { table: entries.length ? { ...table, entries: [...table.entries, ...entries] } : table, diagnostics }
}

export function benchmarkFor(table: BenchmarkTable, modelID: string): BenchmarkEntry | undefined {
  const want = canonicalModelID(modelID)
  return table.entries.find(entry => [entry.id, ...(entry.aliases ?? [])].some(name => canonicalModelID(name) === want))
}
