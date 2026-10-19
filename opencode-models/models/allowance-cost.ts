import { readFileSync } from "node:fs"
import { join } from "node:path"
import { applicableQuotaWindows, type Account, type Route } from "./route-vocabulary"
import { canonicalModelID } from "./model-catalog"
import type { PlanCapacity } from "../usage/plan-capacity-store"

export type WindowCost = { accountID: string; windowID: string; label: string; pointsPerTask: number; spare: number; pace: number; scarcePoints: number; leftPercent: number | null; resetAt: string | null; said: string; rate: string }
export type PlanMultiplier = { planID: string; planPriceUSD: number; monthlyUSD: number; multiplier: number; source: string }
export type AllowanceCost = { points: number; costPerTaskUSD: number | null; listUSD: number | null; multiplier: number | null; effectiveUSD: number | null; plan: PlanMultiplier | null; windows: WindowCost[]; said: string }
export type WindowPace = { pace: number; spare: number; said: string }

type PlanTable = {
  provider: string
  windows: Record<string, number>
  plans: Record<string, { name: string; priceUSD: number; source: string }>
  accounts: Record<string, { plan: string; source: string }>
  models: Record<string, { monthlyUSD: Record<string, number> | null; source: string }>
}
const PLAN_TABLE: PlanTable = JSON.parse(readFileSync(join(import.meta.dir, "allowance-plans.json"), "utf8"))

const round = (n: number) => n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2)

export function planAllowanceOf(providerID: string, modelID: string, accountID: string | undefined): PlanMultiplier | null {
  if (!accountID || providerID !== PLAN_TABLE.provider) return null
  const planID = PLAN_TABLE.accounts[accountID]?.plan
  const plan = planID ? PLAN_TABLE.plans[planID] : undefined
  const model = PLAN_TABLE.models[canonicalModelID(modelID)]
  const monthlyUSD = planID ? model?.monthlyUSD?.[planID] : undefined
  if (!planID || !plan || !model || !monthlyUSD || !(plan.priceUSD > 0)) return null
  return { planID, planPriceUSD: plan.priceUSD, monthlyUSD, multiplier: monthlyUSD / plan.priceUSD, source: plan.name + ", " + model.source }
}

export function planMultiplierOf(route: Route, account: Account | undefined): PlanMultiplier | null {
  if (!account || account.billing !== "subscription") return null
  return planAllowanceOf(route.providerID, route.modelID, account.id)
}

function planWindowUSD(plan: PlanMultiplier, windowID: string): number | null {
  const share = PLAN_TABLE.windows[windowID]
  return share === undefined ? null : plan.monthlyUSD * share
}

export function windowPace(window: Pick<PlanCapacity["windows"][number], "expiresUnused" | "hoursToExhaustion" | "hoursToReset" | "burnSpan">, left: number | null): WindowPace {
  if (window.expiresUnused === true) return { pace: 1, spare: left ?? 0, said: "resets before it is spent at the pace of the last " + window.burnSpan }
  if (window.expiresUnused === false && window.hoursToExhaustion && window.hoursToReset)
    return { pace: window.hoursToReset / window.hoursToExhaustion, spare: 0, said: "runs out about " + Math.round(window.hoursToExhaustion) + "h from now but resets in " + Math.round(window.hoursToReset) + "h, pace ×" + (window.hoursToReset / window.hoursToExhaustion).toFixed(2) }
  return { pace: 1, spare: 0, said: "pace unmeasured" }
}

const clock = (at: number) => new Date(at).toISOString().slice(5, 16).replace("T", " ") + " UTC"
export function windowAveragePace(window: { remaining: number; resetAt: string; periodSeconds?: number }, observedAt: string, now: number): WindowPace | null {
  const reset = Date.parse(window.resetAt), at = Date.parse(observedAt), period = window.periodSeconds
  if (!Number.isFinite(reset) || !Number.isFinite(at) || !period || !Number.isFinite(window.remaining) || window.remaining <= 0 || reset <= now) return null
  const start = reset - period * 1000, used = 100 - window.remaining
  if (at <= start || at >= reset || used <= 0) return null
  const rate = used / (at - start), projected = used + rate * (reset - at)
  if (projected < 100) return { pace: 1, spare: 100 - projected, said: "about " + Math.round(100 - projected) + "% unused at reset at this window's average pace" }
  const exhausts = at + window.remaining / rate, pace = (reset - now) / Math.max(1, exhausts - now)
  return { pace, spare: 0, said: "runs out " + clock(exhausts) + " before its " + clock(reset) + " reset at this window's average pace, pace ×" + pace.toFixed(2) }
}

export function allowanceCostOf(route: Route, account: Account | undefined, capacity: PlanCapacity | null, costPerTaskUSD: number | null, now = Date.now(), published?: { source: string; windows: Record<string, number> }): AllowanceCost | null {
  if (!account || account.billing !== "subscription") return null
  const want = canonicalModelID(route.modelID)
  const applicable = applicableQuotaWindows(account, route)
  const plan = planMultiplierOf(route, account)
  const listUSD = costPerTaskUSD ?? (route.economics?.currency === "USD" && route.economics.amount > 0 ? route.economics.amount : null)
  const windows = applicable.flatMap(window => {
    const measured = capacity?.windows.find(w => w.accountID === account.id && w.windowID === window.id)
    const bucket = measured?.perModel.find(b => canonicalModelID(b.model.slice(b.model.indexOf("/") + 1)) === want)
    const planUSD = plan ? planWindowUSD(plan, window.id) : null
    const limit = published?.windows[window.id]
    const dollarsPerPoint = bucket?.dollarsPerPoint ?? (planUSD && planUSD > 0 ? planUSD / 100 : limit && Number.isFinite(limit) && limit > 0 ? limit / 100 : measured?.dollarsPerPoint)
    const rate = bucket ? "measured per-model rate" : planUSD && planUSD > 0 ? "plan table" : limit && Number.isFinite(limit) && limit > 0 ? "saved allowance" : measured ? "measured window rate" : "none"
    const burn = route.quotaPerTask[window.id]
    const pointsPerTask = Number.isFinite(burn) && burn > 0 ? burn : dollarsPerPoint && dollarsPerPoint > 0 && listUSD !== null && listUSD > 0 ? listUSD / dollarsPerPoint : null
    if (pointsPerTask === null) return []
    const left = Number.isFinite(window.remaining) ? Math.max(0, window.remaining - window.reserved) : null
    const pace = windowAveragePace({ ...window, remaining: left ?? NaN }, account.observedAt, now) ?? (measured ? windowPace(measured, left) : { pace: 1, spare: 0, said: "pace unmeasured" })
    const scarcePoints = Math.max(0, pointsPerTask - pace.spare) * pace.pace
    return [{ accountID: account.id, windowID: window.id, label: measured?.label ?? window.id, pointsPerTask, spare: pace.spare, pace: pace.pace, scarcePoints,
      leftPercent: left, resetAt: window.resetAt || null, rate,
      said: (measured?.label ?? window.id) + ": " + round(pointsPerTask) + "% of the window a task" + (left !== null ? ", " + Math.round(left) + "% left" : "") + ", " + pace.said + " → " + round(scarcePoints) + " scarce" }]
  })
  if (!windows.length || windows.length !== applicable.length) return null
  const points = windows.reduce((n, w) => n + w.scarcePoints, 0)
  const multiplier = plan?.multiplier ?? null
  const effectiveUSD = listUSD !== null && multiplier ? listUSD / multiplier : null
  const priced = effectiveUSD !== null && listUSD !== null
    ? "list $" + listUSD.toFixed(6) + " a task ÷ " + round(multiplier!) + "× on " + plan!.planID + " = $" + effectiveUSD.toFixed(6) + " of plan a task; "
    : ""
  return { points, costPerTaskUSD, listUSD, multiplier, effectiveUSD, plan, windows,
    said: priced + round(points) + " scarce points a task (" + windows.map(w => w.said).join("; ") + ")" + (published ? "; saved allowance: " + published.source : "") }
}
