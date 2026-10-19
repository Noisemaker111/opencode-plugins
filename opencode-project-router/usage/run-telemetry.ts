import type { Price, RequestRecord, Tokens } from "./telemetry"
import { outputIncludingReasoning, requestTiming, valueRequest } from "./telemetry"
import { listPriceOf, structuralHostKind } from "./price-book"
import { planAllowanceOf } from "../models/allowance-cost"

export const RUN_POINTS = ["created", "routed", "planned", "claimed", "bound", "workerStart", "finished"] as const
export type RunPoint = typeof RUN_POINTS[number]
export type RunPoints = Partial<Record<RunPoint, string>>
export type RunRoute = { id: string; model?: string; effort?: string }
export type RunDecision = { chosenBy?: string; considered: string[]; excluded: { routeID: string; model?: string; effort?: string; reasons: string[] }[] }
export type RunLanding = { state: "landed" | "blocked"; method?: string; head?: string; at?: string }
export type RunGap = { from: RunPoint; to: RunPoint; milliseconds: number }
export type RouteFailures = { routeID: string; modelID: string; requests: number; failed: number; failures: Record<string, number> }

export type RoleTokens = { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null; reasoning: number | null }
export type RoleCost = { listUSD: number | null; planUSD: number | null; allowanceShare: number | null; plan: string | null; reason: string | null }
export type WorkerTokens = RoleTokens & { requests: number }
export type StartContext = Pick<RoleTokens, "input" | "cacheRead" | "cacheWrite">
export type GiverTokens = { turns: number; requests: number | null; modelMs: number | null; route: string | null; tokens: RoleTokens; cost: RoleCost; unmapped: string[] }
export type RouterTokens = { model: string; calls: number; tokens: RoleTokens; cost: RoleCost; matched: "time" }
export type PermissionTokens = { calls: number; tokens: RoleTokens | null; reason: string | null }
export type RunRoleCosts = { worker: RoleCost; giver: RoleCost | null; router: RoleCost | null }
export type ToolCounts = { calls: number; failed: number }
export type RunSpeed = {
  turns: number; wallMs: number | null
  turnMs: { p50: number | null; p95: number | null }
  firstTokenMs: { p50: number | null; known: number }
  tokensPerSecond: number | null; tokensPerSecondTurns: number
  retries: number | null; toolCalls: number | null; toolFailures: number | null
}
export type RunTelemetry = {
  version: 3; questID: string; runID: string; callID: string; state: string; partial: boolean; workType: string | null
  points: RunPoints; gaps: RunGap[]
  tokens: { worker: WorkerTokens; startContext: StartContext | null; giver: GiverTokens | null; router: RouterTokens | null; permission: PermissionTokens | null }
  cost: RunRoleCosts
  speed: RunSpeed
  route: RunRoute | null
  decision: RunDecision | null
  routes: RouteFailures[]
  outcome: { state: string; landed: boolean | null; commit: string | null; pushed: boolean | null; pr: boolean | null }
  missing: string[]
}
export type RunTelemetryInput = {
  questID: string; runID: string; callID: string; state: string
  points: RunPoints
  workType?: string | null
  route?: RunRoute
  decision?: RunDecision
  requests: RequestRecord[]
  tools?: ToolCounts | null
  landing?: RunLanding
  giverRequests?: RequestRecord[]
  giver?: { turns: number; requests: number; modelMs: number; unmapped: string[] } | null
  router?: RouterTokens | null
  permission?: PermissionTokens | null
}
export type SpeedRun = { route: string | null; workType: string | null; state: string; landed: boolean | null; wallMs: number | null; planUSD: number | null }
export type SpeedGroup = { key: string; runs: number; landed: number; landedShare: number | null; stepWallMs: { n: number; median: number | null; p90: number | null }; costKnown: number; costPerLandedUSD: number | null }
export type PriceLookup = (request: RequestRecord) => Price | undefined

const noPriceOverride: PriceLookup = () => undefined

export function pricedRequest(request: RequestRecord, lookup: PriceLookup = noPriceOverride): RequestRecord {
  return { ...request, price: lookup(request) ?? listPriceOf(request)?.price }
}

function timeline(points: RunPoints): { point: RunPoint; at: number; text: string }[] {
  return RUN_POINTS.flatMap(point => {
    const text = points[point]
    const at = text === undefined ? NaN : Date.parse(text)
    return Number.isFinite(at) ? [{ point, at, text }] : []
  }).sort((a, b) => a.at - b.at || RUN_POINTS.indexOf(a.point) - RUN_POINTS.indexOf(b.point))
}

export function phaseGaps(points: RunPoints): RunGap[] {
  const ordered = timeline(points)
  return ordered.slice(1).map((later, index) => ({ from: ordered[index].point, to: later.point, milliseconds: later.at - ordered[index].at }))
}

export function roleTokens(requests: RequestRecord[]): RoleTokens {
  const keys: (keyof Tokens)[] = ["input", "cacheRead", "cacheWrite", "output", "reasoning"]
  return Object.fromEntries(keys.map(key => {
    const counts = requests.map(request => request.tokens[key])
    return [key, counts.every(count => count !== null) ? counts.reduce<number>((total, count) => total + (count ?? 0), 0) : null]
  })) as RoleTokens
}

const routeName = (request: RequestRecord) => request.route.providerID + "/" + request.route.modelID
const listed = (names: Set<string>) => [...names].slice(0, 3).join(", ") + (names.size > 3 ? " and " + (names.size - 3) + " more" : "")

function unpricedReason(request: RequestRecord): string {
  const host = structuralHostKind(request)
  if (host === "flat-rate") return "flat-rate host, its $0 is not a price"
  if (host === "zero-priced") return "host lists $0, no price in the price book"
  return "no price schedule"
}

export function permissionTokensOf(decisions: { actor?: string; jevCall?: { sessionID: string } }[], requests: RequestRecord[]): PermissionTokens {
  const jevSessions = decisions.flatMap(decision => decision.jevCall ? [decision.jevCall.sessionID] : [])
  const unlinked = decisions.filter(decision => decision.actor === "jev" && !decision.jevCall).length
  const calls = jevSessions.length + unlinked
  if (!calls) return { calls: 0, tokens: roleTokens([]), reason: null }
  const rows = requests.filter(request => jevSessions.includes(request.sessionID))
  const answered = new Set(rows.map(request => request.sessionID))
  const gaps = jevSessions.filter(id => !answered.has(id)).length + unlinked
  return gaps
    ? { calls, tokens: null, reason: gaps + " of " + calls + " Jev calls have no token counts (no request record yet, or the decision predates the Jev link)" }
    : { calls, tokens: roleTokens(rows), reason: null }
}

export function roleCost(requests: RequestRecord[], lookup: PriceLookup = noPriceOverride): RoleCost {
  if (!requests.length) return { listUSD: null, planUSD: null, allowanceShare: null, plan: null, reason: "no requests" }
  let list = 0, plan = 0, share = 0, unpriced = 0, unplanned = 0
  const unpricedRoutes = new Set<string>(), unplannedRoutes = new Set<string>(), plans = new Set<string>(), reasons = new Set<string>()
  for (const request of requests) {
    const priced = pricedRequest(request, lookup)
    const value = request.cost?.listUSD ?? (priced.price ? valueRequest(priced).value : null)
    if (value === null || value === undefined) { unpriced++; unpricedRoutes.add(routeName(request)); reasons.add(unpricedReason(request)); continue }
    list += value
    const allowance = planAllowanceOf(request.route.providerID, request.route.modelID, request.accountID)
    if (!allowance) { unplanned++; unplannedRoutes.add(routeName(request)); continue }
    plans.add(allowance.planID)
    plan += value / allowance.multiplier
    share += value / allowance.monthlyUSD
  }
  const reason = unpriced
    ? unpriced + " of " + requests.length + " requests unpriced (" + listed(unpricedRoutes) + "): " + [...reasons][0]
    : unplanned
      ? "no plan table entry for " + listed(unplannedRoutes) + " (" + unplanned + " of " + requests.length + " requests)"
      : null
  return {
    listUSD: unpriced ? null : list,
    planUSD: unpriced || unplanned ? null : plan,
    allowanceShare: unpriced || unplanned ? null : share,
    plan: plans.size ? [...plans].join(", ") : null,
    reason,
  }
}

function routeFailures(requests: RequestRecord[]): RouteFailures[] {
  const groups = new Map<string, RouteFailures>()
  for (const request of requests) {
    const key = routeName(request)
    const group = groups.get(key) ?? { routeID: request.route.providerID, modelID: request.route.modelID, requests: 0, failed: 0, failures: {} }
    group.requests++
    if (request.state === "failed" || request.failure) {
      group.failed++
      const cause = request.failure ?? request.state
      group.failures[cause] = (group.failures[cause] ?? 0) + 1
    }
    groups.set(key, group)
  }
  return [...groups.values()]
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

export function requestSpeed(requests: RequestRecord[], wallMs: number | null, tools: ToolCounts | null): RunSpeed {
  const timings = requests.map(requestTiming)
  const turnMs = timings.flatMap(timing => timing.elapsedMilliseconds === null ? [] : [timing.elapsedMilliseconds])
  const firstToken = timings.flatMap(timing => timing.firstVisibleMilliseconds === null ? [] : [timing.firstVisibleMilliseconds])
  let generated = 0, seconds = 0, measured = 0
  requests.forEach((request, index) => {
    const generation = timings[index].generationMilliseconds, total = outputIncludingReasoning(request)
    if (generation !== null && generation > 0 && total !== null) { generated += total; seconds += generation / 1000; measured++ }
  })
  const counted = requests.filter(request => request.retries !== undefined)
  return {
    turns: requests.length, wallMs,
    turnMs: { p50: percentile(turnMs, 0.5), p95: percentile(turnMs, 0.95) },
    firstTokenMs: { p50: percentile(firstToken, 0.5), known: firstToken.length },
    tokensPerSecond: seconds > 0 ? generated / seconds : null, tokensPerSecondTurns: measured,
    retries: counted.length ? counted.reduce((sum, request) => sum + (request.retries ?? 0), 0) : null,
    toolCalls: tools?.calls ?? null, toolFailures: tools?.failed ?? null,
  }
}

export function speedSummary(runs: SpeedRun[], by: "route" | "workType"): SpeedGroup[] {
  const groups = new Map<string, SpeedRun[]>()
  for (const run of runs) {
    const key = (by === "route" ? run.route : run.workType) ?? "unknown"
    ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(run)
  }
  return [...groups].map(([key, rows]) => {
    const landed = rows.filter(row => row.landed === true).length
    const walls = rows.flatMap(row => row.wallMs === null ? [] : [row.wallMs])
    const costs = rows.flatMap(row => row.planUSD === null ? [] : [row.planUSD])
    return {
      key, runs: rows.length, landed,
      landedShare: rows.length ? landed / rows.length : null,
      stepWallMs: { n: walls.length, median: percentile(walls, 0.5), p90: percentile(walls, 0.9) },
      costKnown: costs.length,
      costPerLandedUSD: costs.length === rows.length && landed ? costs.reduce((sum, cost) => sum + cost, 0) / landed : null,
    }
  }).sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key))
}

export function buildRunTelemetry(input: RunTelemetryInput, lookup: PriceLookup = noPriceOverride): RunTelemetry {
  const landing = input.landing
  const giverRequests = input.giverRequests ?? []
  const noGiverCost: RoleCost = { listUSD: null, planUSD: null, allowanceShare: null, plan: null, reason: "no Giver turn recorded" }
  const hosted = input.giver ?? null
  const giver: GiverTokens | null = hosted || giverRequests.length
    ? { turns: hosted?.turns ?? giverRequests.length, requests: hosted?.requests ?? null, modelMs: hosted?.modelMs ?? null, route: giverRequests[0] ? routeName(giverRequests[0]) : null, tokens: { ...roleTokens(giverRequests), reasoning: null }, cost: giverRequests.length ? roleCost(giverRequests, lookup) : noGiverCost, unmapped: hosted?.unmapped ?? [] }
    : null
  const wall = Date.parse(input.points.finished ?? ""), start = Date.parse(input.points.workerStart ?? "")
  const speed = requestSpeed(input.requests, Number.isFinite(wall) && Number.isFinite(start) && wall >= start ? wall - start : null, input.tools ?? null)
  const firstRequest = input.requests.reduce<RequestRecord | undefined>((first, request) => !first || request.startedAt < first.startedAt ? request : first, undefined)
  const startContext: StartContext | null = firstRequest ? { input: firstRequest.tokens.input, cacheRead: firstRequest.tokens.cacheRead, cacheWrite: firstRequest.tokens.cacheWrite } : null
  const costs: RunRoleCosts = { worker: roleCost(input.requests, lookup), giver: giver?.cost ?? null, router: input.router?.cost ?? null }
  const missing: string[] = []
  if (!input.requests.length) missing.push("worker requests: none captured for this run's session")
  if (!input.decision) missing.push("route decision: no saved decision for this run")
  if (!landing) missing.push("outcome: no landing recorded")
  if (!giver) missing.push("giver tokens: the host database is not readable")
  else {
    if (giver.requests === null) missing.push("giver requests and model time: not counted, the host database is not readable")
    for (const reason of giver.unmapped) missing.push("giver tokens: " + reason)
  }
  if (!input.router) missing.push("router tokens: no router (jev/auto) request completed before this run's routing decision")
  if (input.permission && input.permission.calls && !input.permission.tokens) missing.push("permission tokens: " + (input.permission.reason ?? "not counted"))
  if (input.requests.length && speed.toolCalls === null) missing.push("speed: tool calls not read, the host database has no session parts for this run")
  if (input.requests.length && speed.retries === null) missing.push("speed: retries not counted, the request rows predate retry counting")
  for (const [role, cost] of Object.entries(costs) as [keyof RunRoleCosts, RoleCost | null][])
    if (cost?.reason) missing.push("allowance share (" + role + "): unknown, " + cost.reason)
  return {
    version: 3, questID: input.questID, runID: input.runID, callID: input.callID, state: input.state, partial: input.state !== "completed", workType: input.workType ?? null,
    points: input.points, gaps: phaseGaps(input.points),
    tokens: { worker: { ...roleTokens(input.requests), requests: input.requests.length }, startContext, giver, router: input.router ?? null, permission: input.permission ?? null },
    cost: costs, speed,
    route: input.route ?? null, decision: input.decision ?? null,
    routes: routeFailures(input.requests),
    outcome: { state: input.state, landed: landing ? landing.state === "landed" : null, commit: landing?.head ?? null, pushed: landing ? landing.method === "push" || landing.method === "pull-request" : null, pr: landing ? landing.method === "pull-request" : null },
    missing,
  }
}
