export type BenchmarkStatus = "all" | "matched" | "no route yet"
export type RouteState = "run in 28 days" | "not run in 28 days" | "never run"

export const routeLabel = (route: string, state?: RouteState) => state && state !== "run in 28 days" ? route + " (" + state + ")" : route

export type BenchmarkModel = {
  aaID: string | null
  name: string
  slug: string
  creator: string | null
  releaseDate: string | null
  status: "matched" | "no route yet"
  routes: string[]
  routeStates: Record<string, RouteState>
  effort: string | null
  score: { category: string; label: string; value: number; fellBack: boolean } | null
  benchmarks: Record<string, number | null>
  speed: { outputTokensPerSecond: number | null; firstTokenSeconds: number | null; firstAnswerSeconds: number | null; endToEndSeconds: number | null }
  price: { inputPer1M: number | null; outputPer1M: number | null; cacheHitPer1M: number | null; cacheWritePer1M: number | null; indexRunUSD: number | null }
  measured: { route: string; stepSeconds: number | null; stepSamples: number; firstTokenSeconds: number | null; tokensPerSecond: number | null; costPerStepUSD: number | null; costReason: string | null } | null
  disagreements: string[]
}

export type BenchmarksReadout = {
  at: string
  benchmark: { category: string; label: string }
  source: { fetchedAt: string | null; ageHours: number | null; stale: boolean; tier: string | null; indexVersion: number | null; error: string | null; lastChangeAt: string | null; lastErrorAt: string | null; refreshAttempts: number }
  counts: { aaModels: number; models: number; matched: number; noRouteYet: number; routes: number; routesWithAA: number; routesRun: number; neverRun: number; disagreements: number }
  models: BenchmarkModel[]
  watch: BenchmarkModel[]
  routes: { route: string; model: string; effort: string | null; aaID: string | null; aaName: string | null; state: RouteState }[]
  diagnostics: string[]
}
