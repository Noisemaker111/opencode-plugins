import { availabilityOf, notUpReason, readRouteLimits, routeLimitKey, routeLimitsFile } from "../usage/route-limits"
import { freeBudgetOf, type FreeBudget } from "./free-budget-cache"

type Gated = { id: string; providerID: string; modelID: string; verified: boolean; outcomeIssue?: { task: string; reason: string } }

export function gateDispatchRoutes<R extends Gated>(routes: R[], now = Date.now(), file = routeLimitsFile(), budgetOf: (key: string, now: number) => FreeBudget | undefined = freeBudgetOf, task = ""): R[] {
  const saved = readRouteLimits(file)
  return routes.map(route => {
    const key = routeLimitKey(route.providerID, route.modelID)
    const reason = notUpReason(availabilityOf(key, now, saved)) ?? spentReason(budgetOf(key, now))
    return reason ? { ...route, verified: false, outcomeIssue: { task, reason } } : route
  })
}

function spentReason(budget: FreeBudget | undefined): string | null {
  if (!budget?.spent) return null
  return "Free allowance spent" + (budget.nextReset?.at ? "; next reset " + budget.nextReset.at : "")
}
