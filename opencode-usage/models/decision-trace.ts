import type { Candidate, PlannerInput, Route, RoutingRequest, ValueTerms } from "./route-planner"
import { capabilityBasis, routeSpeed } from "./route-planner"

export type ProfileShares = { confidence: number | null; shares: Record<string, number>; note?: string }
export type ProfileAnswer = { model: string; milliseconds: number; calls: number; inputTokens: number; cost: number; workType?: ProfileShares; depth?: ProfileShares }
export type TraceEstimate = {
  routeID: string; model: string; effort: string; billing: string | null
  capability: number | null; basis: "measured" | "learned" | "published" | "unmeasured"; source: string
  finishMs: number | null; finishBasis: string | null
  costPerTaskUSD: number | null; allowance: string | null; allowanceMs?: number
  inputs: string[]
  value?: ValueTerms
  share?: number
  unbenched?: number
  replays?: number
  verified?: { cost: number | null; ms: number | null; reworkRouteID: string | null; reworkShare: number | null }
}
export type TraceOrdering = { order: string[]; shares: Record<string, number>; winner: string; confidence: number | null }
export type TraceJudge = {
  model: string; milliseconds: number | null; calls: number | null; inputTokens: number | null; cost: number | null
  question: string; options: { routeID: string; said: string }[]
  orderings: TraceOrdering[]; shares: Record<string, number>; groups: Record<string, number>
  confidence: number | null; spread: number | null; agreement: number | null; reason: string
}
export type DecisionTrace = {
  version: 1
  simulated?: true
  brief: string
  profile: { task: string; workType: string | null; depth: string | null; setBy: { workType: string; depth: string }; jev?: ProfileAnswer; failed?: string }
  how: string
  speed: string | null
  exploration: number | null
  estimates: TraceEstimate[]
  judge?: TraceJudge
  unjudged?: string
  pick: { routeID: string; model: string; effort: string } | null
  stages: { stage: string; ms: number }[]
}

export const clip = (text: string, characters: number) => { const flat = text.trim(); return flat.length > characters ? flat.slice(0, characters - 1).trimEnd() + "…" : flat }
export const BRIEF_CHARACTERS = 1200
export const QUESTION_CHARACTERS = 1500
export const OPTION_CHARACTERS = 700
export const SOURCE_CHARACTERS = 240

const percentOf = (fraction: number) => (fraction * 100).toFixed(1) + "%"
const PRICE_BASIS: Record<string, string> = { "account-price": "account price", "catalog-equivalent": "catalog price", "artificial-analysis": "Artificial Analysis list price" }
export function inputsUsed(candidate: Candidate, route: Route | undefined): string[] {
  const used: string[] = []
  if (candidate.successRate !== null) used.push("measured record " + percentOf(candidate.successRate) + " on this route")
  else if (candidate.learned) used.push("measured record here: " + candidate.learned.trials + " runs")
  if (route?.benchmark?.inheritedFrom === "Artificial Analysis") used.push("Artificial Analysis index " + route.benchmark.intelligence + " as an estimated prior")
  else if (route?.benchmark && candidate.benchmarkPassAt1 !== null) used.push(route.benchmark.suite + " " + percentOf(route.benchmark.passAt1))
  if (route?.speed?.basis === "published" && route.speed.tokensPerSecond) used.push("Artificial Analysis speed " + Math.round(route.speed.tokensPerSecond) + " tokens/s")
  else if (route?.speed?.tokensPerSecond) used.push("measured speed on this machine")
  if (candidate.economics) used.push(PRICE_BASIS[candidate.economics.basis] ?? candidate.economics.basis)
  if (candidate.allowance) used.push("plan allowance")
  if (candidate.valueTerms) used.push("value terms: cost, time and quality against the bar")
  return used
}
export function traceEstimates(plan: { request: RoutingRequest; routes: Route[]; accounts: PlannerInput["accounts"] }, ranked: Candidate[], costPerTask: (route: Route) => number | null): TraceEstimate[] {
  const finishing = routeSpeed(plan)
  return ranked.map(candidate => {
    const route = plan.routes.find(each => each.id === candidate.routeID)
    const finish = finishing.estimate(candidate)
    const basis = candidate.successRate !== null ? "measured" : candidate.learned || candidate.learnedOther ? "learned" : candidate.benchmarkPassAt1 !== null ? "published" : "unmeasured"
    const source = basis === "learned" ? capabilityBasis(candidate, plan.request).trim().slice(1, -1) : candidate.evidenceSource
    return {
      routeID: candidate.routeID, model: route ? route.providerID + "/" + route.modelID : candidate.routeID, effort: route?.reasoning ?? "", inputs: inputsUsed(candidate, route),
      ...(candidate.valueTerms ? { value: candidate.valueTerms } : {}),
      billing: plan.accounts.find(account => account.id === candidate.accountID)?.billing ?? null,
      capability: candidate.successRate ?? candidate.capability, basis, source: clip(source, SOURCE_CHARACTERS),
      finishMs: finish ? Math.round(finish.milliseconds) : null, finishBasis: finish?.basis ?? null,
      costPerTaskUSD: route ? costPerTask(route) : null, allowance: route?.allowanceCost ? clip(route.allowanceCost.said, SOURCE_CHARACTERS) : candidate.allowance ? clip(candidate.allowance.expiresUnused ? "expires unused" : candidate.allowance.stated, SOURCE_CHARACTERS) : null,
      ...(finishing.allowance(candidate)?.milliseconds ? { allowanceMs: Math.round(finishing.allowance(candidate)!.milliseconds) } : {}),
      ...(candidate.probability !== undefined ? { share: candidate.probability } : {}), ...(candidate.unbenched ? { unbenched: candidate.learned?.trials ?? 0 } : {}), ...(candidate.learned?.replays ? { replays: candidate.learned.replays } : {}),
      ...(candidate.verifiedFinish ? { verified: { cost: Number.isFinite(candidate.verifiedFinish.cost) ? candidate.verifiedFinish.cost : null, ms: Number.isFinite(candidate.verifiedFinish.milliseconds) ? Math.round(candidate.verifiedFinish.milliseconds) : null, reworkRouteID: candidate.verifiedFinish.rework?.routeID ?? null, reworkShare: candidate.verifiedFinish.rework?.share ?? null } } : {}),
    }
  })
}
