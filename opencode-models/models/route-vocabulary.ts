import type { BenchmarkPerTask } from "./benchmark-table"
import type { PublishedTask } from "./published-speed"
import type { RouteSpeed } from "../usage/route-speeds"
import type { AllowanceCost } from "./allowance-cost"
import type { AAFacts } from "./artificial-analysis"
export type TaskClass = "coding" | "review" | "planning" | "utility"
export type QuotaWindow = {
  routeIDs?: string[]
  id: string
  remaining: number
  resetAt: string
  state?: "available" | "exhausted" | "unknown"
  reserved: number
  nextCapacity?: number
  periodSeconds?: number
  expiresUnused?: boolean | null
}
export type Account = {
  id: string
  billing: "subscription" | "free" | "metered"
  authenticated: boolean
  observedAt: string
  capacity: "available" | "exhausted" | "unknown"
  concurrentWorkers?: number
  dispatchHold?: string
  pacing?: {state:"ready"|"hold"|"stopped";desiredConcurrency:number;deadlineAt:number;updatedAt:number;reason:string}
  windows: QuotaWindow[]
}
export function pacedSubscriptionAdmission(account:Account,at:string){
 const p=account.pacing,now=Date.parse(at)
 return account.billing==="subscription"&&!!p&&p.state==="ready"&&Number.isInteger(p.desiredConcurrency)&&p.desiredConcurrency>0&&p.desiredConcurrency<=16&&Number.isFinite(now)&&now<p.deadlineAt&&p.updatedAt<=now&&now-p.updatedAt<30000&&(account.concurrentWorkers??0)<p.desiredConcurrency
}
export type RouteEvidence = {
  task: TaskClass
  source: string
  measuredAt: string
  trials: number
  passed: number
  totalMilliseconds: number
  totalCash: number | null
  currency?: string
  p95Milliseconds: number
}
export type RouteBenchmark = {
  suite: string
  passAt1: number
  effort: string
  provenance: "independent" | "vendor"
  source: string
  measuredAt: string
  intelligence?: number
  attribution?: string
  inheritedFrom?: string
  perTask?: BenchmarkPerTask
}
export type LearnedOutcomes = {
  kind: string
  trials: number
  replays?: number
  delivered: number
  requests: number
  measuredAt: string
  source: string
  medianMilliseconds?: number
  reworked?: number
  judged?: number
  via?: string
  depth?: string
}
export type FinishedRuns = { kind: string; completed: number; medianMilliseconds: number; medianOutputTokens?: number; medianRequests?: number; via?: string }
export type RunTimes = { kind: string; reasoning: string; sameModel: boolean; completed: number; medianMilliseconds: number }
export type Route = {
  id: string
  accountID: string
  providerID: string
  modelID: string
  harness: string
  agent?: string
  reasoning: string
  serviceTier: string
  verified: boolean
  admission?: "configured-choice" | "benchmark-ranked" | "unbenched"
  outcomeIssue?: {task:TaskClass;reason:string}
  failing?: string
  evidence: RouteEvidence[]
  benchmark?: RouteBenchmark
  analysis?: AAFacts
  learned?: LearnedOutcomes
  learnedOverall?: LearnedOutcomes
  learnedOther?: LearnedOutcomes
  routineOutcomes?: { effort: string; passed: boolean }[]
  finished?: FinishedRuns
  finishedOverall?: FinishedRuns
  runTimes?: RunTimes[]
  speed?: RouteSpeed
  publishedTask?: PublishedTask
  requestPerformance?: { milliseconds: number; samples: number }
  economics?: { amount: number; currency: string; basis: "account-price" | "catalog-equivalent" | "artificial-analysis"; source: string; observedAt: string; requestMilliseconds?: number; samples?: number; workload?: string; taskProfile?: "observed" | "pooled" }
  quotaPerTask: Record<string, number>
  tasksLeft?: Record<string, number>
  allowanceCost?: AllowanceCost
  cashReservation?: { currency:string; upperBound:number }
}
export type RoutingRequest = {
  task: TaskClass
  now: string
  minSuccessRate: number
  minTrials: number
  qualityTolerance: number
  maxUsageAgeSeconds: number
  maxEvidenceAgeDays: number
  maxBenchmarkAgeDays?: number
  minBenchmarkPassAt1?: number
  maxTaskMilliseconds?: number
  maxCashPerSuccess?: number
  cashCurrency?: string
  subscriptionConcurrency?: "unlimited" | "calibrated"
  missingSubscriptionUsage?: "wait" | "attempt"
  reserveFraction: number
  cashBudget?: { id:string; currency:string; limit:number; spent:number; startsAt:string; endsAt:string; reserved?:number }
  explicitRouteID?: string
  primaryRouteID?: string
  primarySource?: string
  fallback?: { when:"admission-unavailable"; routeIDs:string[] }
  allowedRouteIDs?: string[]
  preference?: "capacity" | "latency" | "cash" | "economy"
  qualitySelection?: "near-best" | "floor"
  economyPriceTolerance?: number
  reserveByAccount?: Record<string, Record<string, number>>
  judged?: {
    probabilities: Record<string, number>
    model: string
    reason: string
    order?: string[]
    groups?: Record<string, { share: number; routeIDs: string[] }>
  }
  judging?: boolean
  depthBand?: DepthBand
  borrowedPriorRuns?: number
  automatic?: { preferFree?: boolean; exclude?: Record<string, string>; fastestWithin?: number; allowanceWeight?: number; ratings?: Record<string, { rating: "strong" | "good"; basis: string }>; explore?: { routeIDs: string[]; note: string }; value?: { weights: ValueWeights; bar: number; tie: number } }
}
export type ValueWeights = { cost: number; time: number; score: number }
export type ValueTerms = { bar: number; quality: number; costRaw: number | null; timeMilliseconds: number | null; timeBasis?: string; cost: number; time: number; score: number; penalty: number; listUSD?: number | null; multiplier?: number | null; effectiveUSD?: number | null }
export type DepthBand = { depth: string; efforts?: string[]; maxCostWeight?: number; maxAllowanceShare?: number; maxCapabilityGap?: number }
export const startsStrong = (depth: string) => depth === "deep" || depth === "frontier"
export type CapabilityEvidence = { priorWeight?: number; other?: Pick<LearnedOutcomes, "trials" | "delivered"> }
export function priorRuns(route: Pick<Route, "benchmark">, request: Pick<RoutingRequest, "minTrials" | "borrowedPriorRuns">) {
  return route.benchmark?.inheritedFrom && request.borrowedPriorRuns !== undefined ? request.borrowedPriorRuns : request.minTrials
}
export function capabilityOf(prior: number | null, learned: Pick<LearnedOutcomes, "trials" | "delivered"> | undefined, minTrials: number, evidence: CapabilityEvidence = {}): number | null {
  const trials = learned?.trials ?? 0, delivered = learned?.delivered ?? 0, weight = evidence.priorWeight ?? minTrials, other = evidence.other
  if (prior !== null) {
    const start = other && other.trials > 0 ? (prior * weight + other.delivered) / (weight + other.trials) : prior
    return (delivered + weight * start) / (trials + weight)
  }
  return trials >= minTrials && trials > 0 ? delivered / trials : null
}
export const unbenched = (route: Pick<Route, "admission" | "benchmark">) => route.admission === "unbenched" && !route.benchmark
export const judgedRuns = (learned: Pick<LearnedOutcomes, "judged"> | undefined) => learned?.judged ?? 0
export const scoreEarned = (route: Pick<Route, "admission" | "benchmark" | "learned">, minTrials: number) => !unbenched(route) || judgedRuns(route.learned) >= minTrials
export const replaysText = (learned: Pick<LearnedOutcomes, "replays"> | undefined) => learned?.replays ? " (" + learned.replays + " of them benches)" : ""
export function unbenchedText(learned: Pick<LearnedOutcomes, "trials" | "replays"> | undefined) {
  const runs = learned?.trials ?? 0
  return runs ? "no published score; measured here over " + runs + " run" + (runs === 1 ? "" : "s") + replaysText(learned) : "no published score yet; explored to earn one"
}
export function capabilityRuns(prior: number | null, learned: Pick<LearnedOutcomes, "trials"> | undefined, minTrials: number, evidence: CapabilityEvidence = {}) {
  const trials = learned?.trials ?? 0
  return prior !== null ? trials + (evidence.priorWeight ?? minTrials) : trials >= minTrials ? trials : 0
}
export function unlimitedSubscriptionConcurrency(account: Pick<Account, "billing">, request: Pick<RoutingRequest, "subscriptionConcurrency">) {
  return account.billing === "subscription" && request.subscriptionConcurrency === "unlimited"
}
export function aheadOfClock(window:{remainingPercent:number|null;resetAt:number;periodSeconds:number|null},now:number){
 const remaining=window.remainingPercent
 const left=remaining!==null&&Number.isFinite(remaining)&&remaining>=0&&remaining<=100?remaining/100:null
 const period=window.periodSeconds
 const timeLeft=Number.isFinite(window.resetAt)&&period!==null&&period>0?Math.min(1,Math.max(0,(window.resetAt-now)/(period*1000))):null
 return left===null||timeLeft===null?{ahead:null,timeLeft:null,left}:{ahead:left-timeLeft,timeLeft,left}
}
export type PlannerInput = { request: RoutingRequest; accounts: Account[]; routes: Route[] }
export function applicableQuotaWindows(account: Account, route: Route) {
  return account.windows.filter(w => w.routeIDs === undefined || w.routeIDs.includes(route.id))
}

export type Candidate = {
  routeID: string
  accountID: string
  successRate: number | null
  millisecondsPerSuccess: number | null
  cashPerSuccess: number | null
  expiryOpportunity: number | null
  limitingWindow?: string
  benchmarkPassAt1: number | null
  capability: number | null
  capabilityRuns?: number
  learned?: LearnedOutcomes
  learnedOther?: LearnedOutcomes
  benchmarkProvenance?: "independent" | "vendor"
  benchmarkBorrowed?: boolean
  intelligence: number | null
  requestPerformance: Route["requestPerformance"] | null
  economics: Route["economics"] | null
  evidenceSource: string
  note?: string
  probability?: number
  allowance?: AllowanceSpend
  verifiedFinish?: VerifiedFinish
  unbenched?: true
  valueTerms?: ValueTerms
}
export type VerifiedFinish = {
  pass: number | null
  attemptCost: number
  attemptMilliseconds: number
  cost: number
  milliseconds: number
  rework: { routeID: string; pass: number | null; share: number; cost: number; milliseconds: number } | null
}
export type RoutingDecision = {
  selected: Candidate | null
  ranked: Candidate[]
  admitted: Candidate[]
  excluded: { routeID: string; reasons: string[] }[]
  summary: string
  fallback?: { fromRouteID:string; toRouteID:string; reasons:string[] }
}
export type AllowanceSpend = { expiresUnused: boolean | null; share: number | null; stated: string }
