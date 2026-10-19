import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import {writeFileDurable} from "../quest/core/durable-file.mjs"
import { dirname } from "node:path"
import { proxyOwners } from "../usage-service/on-computer"
import { TELEMETRY_FILE } from "./telemetry-store"
import type { Price, PriceSource, RequestRecord } from "./telemetry"

export type CatalogCost = { input?: number; output?: number; cache?: { read?: number; write?: number }; tier?: { type?: string; size?: number } }[]

export function catalogPrice(cost: unknown, provider: string, model: string, startedAt: number): Price | undefined {
  const prices = (Array.isArray(cost) ? cost : []) as CatalogCost
  const base = prices.find(p => !p.tier)
  if (!base) return undefined
  const rates = (p: CatalogCost[number]) => ({ input: p?.input, output: p?.output, reasoning: p?.output, cacheRead: p?.cache?.read, cacheWrite: p?.cache?.write })
  return { version: createHash("sha256").update(JSON.stringify(prices)).digest("hex"), provider, model, date: new Date(startedAt).toISOString(), currency: "USD", perMillion: rates(base),
    tiers: prices.filter(p => p.tier?.type === "context" && Number.isFinite(p.tier.size)).map(p => ({ above: p.tier!.size!, perMillion: rates(p) })) }
}

type Book = { since: number; costs: Record<string, CatalogCost> }
const UNPRICED_FROM = Date.parse("2026-09-26T04:00:52.400Z")
export const priceBookFile = (telemetry = TELEMETRY_FILE) => telemetry + ".prices.json"

let saved: { file: string; text: string } | undefined
export function saveHostPriceBook(models: unknown, file = priceBookFile(), now = Date.now()) {
  if (!Array.isArray(models) || !models.length) return
  const costs: Record<string, CatalogCost> = {}
  for (const m of models) if (Array.isArray(m?.cost) && m.cost.some((p: any) => !p?.tier) && m.providerID && (m.id ?? m.modelID)) costs[m.providerID + "/" + (m.id ?? m.modelID)] = m.cost
  const text = JSON.stringify(costs)
  if (saved?.file === file && saved.text === text) return
  let since = now
  try { const prior = JSON.parse(readFileSync(file, "utf8")) as Book; since = prior.since; if (JSON.stringify(prior.costs) === text) { saved = { file, text }; return } } catch {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileDurable(file, JSON.stringify({ since, costs } satisfies Book))
  saved = { file, text }
}

let read: { file: string; stamp: string; book?: Book } | undefined
function bookOf(file: string): Book | undefined {
  let stamp = ""
  try { const s = statSync(file); stamp = s.size + ":" + s.mtimeMs } catch { return undefined }
  if (read?.file !== file || read.stamp !== stamp) { let book: Book | undefined; try { book = JSON.parse(readFileSync(file, "utf8")) } catch {} read = { file, stamp, book } }
  return read.book
}

export const FALLBACK_PRICE_ROWS: Record<string, CatalogCost> = {
  "openai/gpt-6-luna": [{ input: 0.1, output: 0.5, cache: { read: 0.01, write: 0.125 } }],
}

export function gapPriceOf(request: RequestRecord, file = priceBookFile()): { price: Price; source: "price-book" | "fallback-row" } | undefined {
  const key = request.route.providerID + "/" + request.route.modelID
  const book = request.startedAt > UNPRICED_FROM ? bookOf(file) : undefined
  const fromBook = book && request.startedAt < book.since ? book.costs[key] : undefined
  const price = catalogPrice(fromBook ?? FALLBACK_PRICE_ROWS[key], request.route.providerID, request.route.modelID, request.startedAt)
  return price && { price, source: fromBook ? "price-book" : "fallback-row" }
}

export function gapPrice(request: RequestRecord, file = priceBookFile()): Price | undefined {
  return gapPriceOf(request, file)?.price
}

export const structuralHostKind = (request: RequestRecord): "flat-rate" | "zero-priced" | undefined =>
  request.route.providerID === "cliproxyapi" ? "flat-rate" : request.price && Object.values(request.price.perMillion).every(rate => rate === 0) ? "zero-priced" : undefined

export function listPriceOf(request: RequestRecord, file = priceBookFile(), owners: Record<string, string> = proxyOwners()): { price: Price; source: PriceSource } | undefined {
  const book = gapPriceOf(request, file)
  if (book) return book
  const owner = ownerCatalogPrice(request, file, owners)
  if (owner) return { price: owner, source: "owner-catalog" }
  return request.price && !structuralHostKind(request) ? { price: request.price, source: "host-catalog" } : undefined
}

export function ownerCatalogPrice(request: RequestRecord, file = priceBookFile(), owners: Record<string, string> = proxyOwners()): Price | undefined {
  if (request.route.providerID !== "cliproxyapi") return undefined
  const vendor = owners[request.route.modelID]
  const book = vendor ? bookOf(file) : undefined
  return book && vendor ? catalogPrice(book.costs[vendor + "/" + request.route.modelID], vendor, request.route.modelID, request.startedAt) : undefined
}
