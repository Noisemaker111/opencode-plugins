import { readFileSync } from "node:fs"
import { canonicalModelID } from "../models/model-catalog"
import { planCapacityFile } from "./plan-capacity-scan"

export type CapacityEvidence = "solid" | "thin"
export type WindowCapacity = {
  accountID: string
  windowID: string
  label: string
  windowWorthUSD: number
  dollarsPerPoint: number
  perModel: { model: string; dollarsPerPoint: number; intervals: number }[]
  evidence: CapacityEvidence
  assumed: boolean
  attributedShare: number | null
  spread: number | null
  cleanIntervals: number
  expiresUnused: boolean | null
  hoursToExhaustion: number | null
  hoursToReset: number | null
  burnSpan: "24h" | "7d"
}
export type PlanCapacity = {
  generatedAt: number
  windows: WindowCapacity[]
  assumptions: { model: string; pricedAs: string; justification: string }[]
  diagnostics: string[]
}

function evidenceOf(window: { attributedShare: number | null; spread: number | null; dollarsPerPoint: number }, bucket?: { intervals: number }): CapacityEvidence {
  if (window.attributedShare !== null && window.attributedShare < 0.5) return "thin"
  if (bucket) return bucket.intervals >= MIN_BUCKET_INTERVALS ? "solid" : "thin"
  return window.spread !== null && window.spread > window.dollarsPerPoint ? "thin" : "solid"
}

const MIN_BUCKET_INTERVALS = 3

export function readPlanCapacity(options: { file?: string; now?: number; newestObservationAt?: number | null } = {}): PlanCapacity | null {
  let report: any
  try { report = JSON.parse(readFileSync(options.file ?? planCapacityFile(), "utf8")) } catch { return null }
  if (report?.schema !== 1 || !Array.isArray(report.accounts)) return null
  const generatedAt = Date.parse(report.generatedAt ?? "")
  if (!Number.isFinite(generatedAt)) return null
  const validity = Number(report.validForMilliseconds)
  const newest = options.newestObservationAt
  if (Number.isFinite(validity) && typeof newest === "number" && Number.isFinite(newest) && newest - generatedAt > validity) return null
  const diagnostics: string[] = []
  const windows: WindowCapacity[] = []
  for (const account of report.accounts) {
    for (const window of account.windows ?? []) {
      const dollarsPerPoint = window?.estimate?.unitsPerPoint
      if (typeof dollarsPerPoint !== "number" || !Number.isFinite(dollarsPerPoint) || dollarsPerPoint <= 0) continue
      const perModel = (window.priceRatioTest?.byModel ?? [])
        .filter((b: any) => typeof b?.unitsPerPoint === "number" && b.unitsPerPoint > 0)
        .map((b: any) => ({ model: String(b.model), dollarsPerPoint: b.unitsPerPoint, intervals: Number(b.intervals) || 0 }))
      const periodSeconds = Number(window.periodSeconds)
      const burnSpan: WindowCapacity["burnSpan"] = window.burn?.day?.resetsBeforeExhausted !== null && Number.isFinite(periodSeconds) && periodSeconds * 1000 <= 86400_000 ? "24h" : "7d"
      const burn = burnSpan === "24h" ? window.burn?.day : window.burn?.week
      const attributedShare = typeof window.estimate?.attributedShare === "number" ? window.estimate.attributedShare : null
      const spread = typeof window.estimate?.q1 === "number" && typeof window.estimate?.q3 === "number" ? window.estimate.q3 - window.estimate.q1 : null
      windows.push({
        accountID: account.id, windowID: window.id, label: window.label ?? window.id,
        windowWorthUSD: dollarsPerPoint * 100, dollarsPerPoint, perModel,
        evidence: evidenceOf({ attributedShare, spread, dollarsPerPoint }),
        assumed: Number(window.estimate?.assumedPoints) > 0,
        attributedShare, spread,
        cleanIntervals: Number(window.estimate?.cleanIntervals) || 0,
        expiresUnused: typeof burn?.resetsBeforeExhausted === "boolean" ? burn.resetsBeforeExhausted : null,
        hoursToExhaustion: typeof burn?.hoursToExhaustion === "number" ? burn.hoursToExhaustion : null,
        hoursToReset: typeof burn?.hoursToReset === "number" ? burn.hoursToReset : null,
        burnSpan,
      })
    }
  }
  if (!windows.length) return null
  const assumptions = (report.assumedPrices ?? []).filter((a: any) => a?.applied).map((a: any) => ({ model: a.model, pricedAs: a.pricedAs, justification: a.justification }))
  if (assumptions.length) diagnostics.push("Plan capacity applies " + assumptions.length + " recorded price assumption(s): " + assumptions.map((a: any) => a.model + " priced as " + a.pricedAs).join(", "))
  return { generatedAt, windows, assumptions, diagnostics }
}

export type RouteCapacity = {
  windowID: string
  windowWorthUSD: number
  leftUSD: number | null
  tasksLeftOnRoute: number | null
  dollarsPerPoint: number
  perModelRate: boolean
  evidence: CapacityEvidence
  assumed: boolean
  expiresUnused: boolean | null
  stated: string
}

const percent = (fraction: number) => Math.round(fraction * 100) + "%"
const grouped = (whole: number) => String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
const money = (amount: number) => amount >= 1000 ? "$" + grouped(Math.round(amount / 100) * 100) : amount >= 10 ? "$" + Math.round(amount) : amount >= 1 ? "$" + amount.toFixed(1) : "$" + amount.toFixed(2)
const about = (n: number) => n >= 10 ? String(Math.round(n)) : n >= 1 ? n.toFixed(1) : n.toFixed(2)

export function routeCapacity(capacity: PlanCapacity | null, input: { accountID: string; windowID: string; modelID: string; remainingPercent: number | null; costPerTaskUSD: number | null }): RouteCapacity | null {
  const window = capacity?.windows.find(w => w.accountID === input.accountID && w.windowID === input.windowID)
  if (!window) return null
  const want = canonicalModelID(input.modelID)
  const bucket = window.perModel.find(b => canonicalModelID(b.model.slice(b.model.indexOf("/") + 1)) === want)
  const dollarsPerPoint = bucket?.dollarsPerPoint ?? window.dollarsPerPoint
  const evidence = evidenceOf(window, bucket)
  const left = input.remainingPercent !== null && Number.isFinite(input.remainingPercent) && input.remainingPercent >= 0 && input.remainingPercent <= 100 ? input.remainingPercent : null
  const leftUSD = left === null ? null : left * dollarsPerPoint
  const perTask = input.costPerTaskUSD !== null && Number.isFinite(input.costPerTaskUSD) && input.costPerTaskUSD > 0 ? input.costPerTaskUSD : null
  const tasksLeftOnRoute = leftUSD === null || perTask === null ? null : leftUSD / perTask
  const windowWorthUSD = dollarsPerPoint * 100
  const tasksPerWindow = perTask === null ? null : windowWorthUSD / perTask
  const worth = left === null
    ? "the whole window is worth about " + money(windowWorthUSD) + " of work" + (tasksPerWindow === null ? "" : " — about " + about(tasksPerWindow) + " tasks of this size on this route")
    : percent(left / 100) + " left ≈ " + money(leftUSD!) + " of work" + (tasksLeftOnRoute === null ? "" : " ≈ about " + about(tasksLeftOnRoute) + " more tasks of this size on this route") +
      " (a whole window is " + money(windowWorthUSD) + ")"
  const pace = window.expiresUnused === null ? ""
    : window.expiresUnused ? "; at the pace measured over the last " + window.burnSpan + " it resets before it is spent, so what is left expires unused"
    : "; at the pace measured over the last " + window.burnSpan + " it runs out before it resets" +
      (window.hoursToExhaustion !== null ? ", in about " + about(window.hoursToExhaustion) + "h" : "")
  const caveat = (evidence === "thin" ? "; thin evidence — " + (window.attributedShare !== null ? percent(window.attributedShare) + " of this window's metered movement could be valued" : "few usable intervals") : "") +
    (window.assumed ? "; assumed — part of this window's value rests on a recorded price substitution" : "")
  return { windowID: input.windowID, windowWorthUSD, leftUSD, tasksLeftOnRoute, dollarsPerPoint, perModelRate: Boolean(bucket), evidence, assumed: window.assumed,
    expiresUnused: window.expiresUnused, stated: worth + pace + caveat }
}
