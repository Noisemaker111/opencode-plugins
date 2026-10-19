import { priceProviders, type Catalog } from "./price-aliases"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Tokens } from "./telemetry"

const ASSUMED_PRICES = join(import.meta.dir, "assumed-prices.json")

export type PriceAssumption = { model: string; pricedAs: string; recordedAt: string; justification: string }
export function readAssumedPrices(file = ASSUMED_PRICES): PriceAssumption[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"))
    if (data?.version !== 1 || !Array.isArray(data.assumptions)) return []
    return data.assumptions.filter((a: any) => typeof a?.model === "string" && a.model.includes("/") && typeof a?.pricedAs === "string" && a.pricedAs.includes("/")
      && typeof a?.recordedAt === "string" && typeof a?.justification === "string" && a.justification.trim().length > 0)
  } catch { return [] }
}

const aliasModel = (provider: string, model: string) => provider === "claude-code" && !model.startsWith("claude-") ? null : model

export function priceBook(catalog: Catalog, assumptions: PriceAssumption[], overrides: Record<string, string> = {}) {
  const recorded = new Map<string, { provider: string; model: string }>()
  for (const a of assumptions) {
    const slash = a.pricedAs.indexOf("/")
    recorded.set(a.model, { provider: a.pricedAs.slice(0, slash), model: a.pricedAs.slice(slash + 1) })
  }
  for (const [from, to] of Object.entries(overrides)) recorded.set(from, { provider: "", model: to })
  const unpriced = new Map<string, number>()
  const assumedRoutes = new Set<string>()
  const rates = (provider: string, model: string, inputTotal: number, record = true): { perMillion: Partial<Record<keyof Tokens, number>>; assumed: boolean } | null => {
    const key = provider + "/" + model
    const substitute = recorded.get(key) ?? recorded.get(model)
    const lookFor = substitute ? [{ provider: substitute.provider || provider, model: substitute.model }]
      : model.endsWith("-fast") ? [{ provider, model }, { provider, model: model.slice(0, -5) }] : [{ provider, model }]
    for (const want of lookFor) {
      const id = aliasModel(want.provider, want.model)
      if (!id) continue
      for (const p of priceProviders(catalog, want.provider, id)) {
        const cost = catalog[p]?.models?.[id]?.cost
        if (!cost) continue
        const tier = cost.tiers?.filter(t => t.tier?.type === "context" && typeof t.tier.size === "number" && inputTotal > t.tier.size!).sort((a, b) => b.tier!.size! - a.tier!.size!)[0] ?? cost
        if (substitute && record) assumedRoutes.add(key)
        return { perMillion: { input: tier.input, output: tier.output, reasoning: tier.output, cacheRead: tier.cache_read ?? 0, cacheWrite: tier.cache_write ?? tier.input }, assumed: Boolean(substitute) }
      }
    }
    if (record) unpriced.set(key, (unpriced.get(key) ?? 0) + 1)
    return null
  }
  return { rates, unpriced, assumedRoutes }
}
