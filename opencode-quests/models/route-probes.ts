import { Effect, Schema } from "effect"
import { ROUTE_HEALTH, observeHealthRow, probingRoutes, readRouteLimits, responseObservation, routeLimitsFile, checkBalances, type HealthRow } from "../usage/route-limits"
import { creditsOf } from "../usage/plan-allowance"
import { openRouterKey } from "./jev-bridge"
import { modelRetirement, readBenchmarkTable, type BenchmarkTable } from "./benchmark-table"

export class RouteProbeError extends Schema.TaggedError<RouteProbeError>()("RouteProbeError", { route: Schema.String, reason: Schema.String }) {}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export const probeAnswered = (key: string, probe: (key: string) => Promise<boolean>): Effect.Effect<boolean, RouteProbeError> =>
  Effect.tryPromise({ try: () => probe(key), catch: error => new RouteProbeError({ route: key, reason: errorText(error) }) })

export async function openRouterRemainingUSD(env: Record<string, string | undefined> = process.env): Promise<number | null> {
  const key = openRouterKey(env)
  if (key === undefined) return null
  const credits = await creditsOf(key, globalThis.fetch)
  return credits.answered ? credits.remainingUSD : null
}

export async function checkBalanceHolds(read: () => Promise<number | null>, now = Date.now(), file = routeLimitsFile()): Promise<boolean> {
  if (!Object.values(readRouteLimits(file).routes).some(state => state.demotion?.wait === "balance")) return false
  return checkBalances("openrouter", await read().catch(() => null), now, file)
}

export function probeRow(key: string, answered: boolean, at: number): HealthRow {
  const slash = key.indexOf("/")
  return {
    route: { providerID: key.slice(0, slash), modelID: key.slice(slash + 1) }, startedAt: at, state: answered ? "completed" : "failed",
    tokens: { input: null, output: answered ? 1 : 0, reasoning: null, cacheRead: null, cacheWrite: null },
    response: responseObservation(answered ? 200 : 500, new Headers(), at),
  }
}

const probesInFlight = new Set<string>()

function liveProbingKeys(now: number, file: string): string[] {
  let table: BenchmarkTable | undefined
  try { table = readBenchmarkTable() } catch { table = undefined }
  return [...probingRoutes(now, file).keys()].filter(key => !(table && modelRetirement(table, key.slice(key.indexOf("/") + 1), now) !== undefined))
}

export async function probeProbingRoutes(probe: (key: string) => Promise<boolean>, now = Date.now(), file = routeLimitsFile()): Promise<{ key: string; answered: boolean }[]> {
  const results: { key: string; answered: boolean }[] = []
  for (const key of liveProbingKeys(now, file)) {
    const claim = file + "\u0000" + key
    if (probesInFlight.has(claim)) continue
    probesInFlight.add(claim)
    let answered: boolean
    try { answered = await Effect.runPromise(probeAnswered(key, probe).pipe(Effect.catch(() => Effect.succeed(false)))) } finally { probesInFlight.delete(claim) }
    observeHealthRow(probeRow(key, answered, now), file)
    results.push({ key, answered })
  }
  return results
}

export function nextProbeAt(now = Date.now(), file = routeLimitsFile()): number | undefined {
  if (liveProbingKeys(now, file).length) return now
  const waits = Object.values(readRouteLimits(file).routes).flatMap(state => {
    if (state.demotion?.awaiting) return [now + ROUTE_HEALTH.balanceCheckMs]
    const until = state.demotion ? Date.parse(state.demotion.until) : NaN
    return Number.isFinite(until) && until > now ? [until] : []
  })
  return waits.length ? Math.min(...waits) : undefined
}
