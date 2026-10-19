import { accountRegime } from "./calibration-store"
import type { AccountUsage } from "../usage-service/on-computer"
import type { Observation } from "./calibration"

export function resetPlan(accounts: AccountUsage[], observations: Observation[], now = Date.now(), reservePoints = 0, deadlineAt?: number) {
  if (!Number.isFinite(reservePoints) || reservePoints < 0 || reservePoints > 100) throw new Error("Reserve must be between 0 and 100 percentage points")
  if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || deadlineAt <= now)) throw new Error("Target deadline must be in the future")
  return accounts.flatMap(account => account.windows.map(window => {
    const reset = Date.parse(window.resetAt ?? ""), at = Date.parse(window.observedAt)
    const fresh = ["available", "exhausted"].includes(account.state) && !account.error && !account.freshness?.stale && !account.freshness?.resetPending &&
      Number.isFinite(at) && at <= now && now - at < 30_000 && window.state !== "unknown"
    const used = window.usedPercent
    const ready = fresh && Number.isFinite(reset) && reset > now && used !== null && Number.isFinite(used) && used >= 0 && used <= 100 && (window.state === "available" || used === 100)
    const targetAt = ready ? Math.min(reset, deadlineAt ?? reset) : null
    const minutes = ready ? (reset - now) / 60000 : null
    const targetMinutes = targetAt === null ? null : (targetAt-now)/60000
    const spendable = ready ? Math.max(0, 100 - used! - reservePoints) : null
    const rows = observations.filter(o => o.accountID === account.id && o.regime === accountRegime(account) && o.windowID === window.id && o.resetAt === reset &&
      o.at <= at && o.at >= at - 30 * 60000 && Number.isFinite(o.usedPoints) && o.usedPoints >= 0 && o.usedPoints <= 100 && !o.replenishing).sort((a,b) => a.at-b.at)
    const last = rows.at(-1)
    const before = last && rows.find(o => o.regime === last.regime && last.at - o.at >= 60_000)
    const segment = before && last ? rows.filter(o => o.at >= before.at && o.regime === last.regime) : []
    const monotonic = segment.every((o,i) => i === 0 || o.usedPoints >= segment[i-1].usedPoints)
    const rate = ready && last && before && last.at === at && last.usedPoints === used && monotonic
      ? (last.usedPoints - before.usedPoints) / ((last.at-before.at)/60000) : null
    const required = spendable !== null && targetMinutes !== null ? spendable/targetMinutes : null
    const slopes = rate === null ? [] : [5,15,30].flatMap(span=>{
      const b=segment.findLast(o=>last!.at-o.at>=span*60000)
      return b?[(last!.usedPoints-b.usedPoints)/((last!.at-b.at)/60000)]:[]
    })
    if(rate!==null)slopes.push(rate)
    const exhaustion=(r:number)=>ready&&used===100?now:r>0&&ready&&at+(100-used!)/r*60000<reset?Math.max(now,at+(100-used!)/r*60000):null
    const projectedExhaustionAt=rate===null?null:exhaustion(rate)
    const forecast=rate===null?null:{basis:"recent-account-pace" as const,projectedExhaustionAt,
      earliestExhaustionAt:exhaustion(Math.max(...slopes)),latestExhaustionAt:exhaustion(Math.min(...slopes)),
      rangeMeaning:"Scenarios from recent 5/15/30-minute pace; not a confidence interval",
      resetOccursFirst:rate>0&&projectedExhaustionAt===null,
      precisionPoints:window.precisionPoints??null,reportingDelayMilliseconds:window.reportingDelayMilliseconds??null,
      assumptions:"Future work keeps the observed pace; provider lag and external activity can change the result"}
    return { accountID: account.id, provider: account.provider, windowID: window.id, label: window.label, scope: window.scope, model: window.model,
      resetAt: window.resetAt, observedAt: window.observedAt, state: ready ? "ready" as const : "unavailable" as const,
      reason: ready ? null : !fresh ? "Refresh the account observation" : "No current percentage and future reset for this pool",
      deadlineAt: deadlineAt ?? null, targetAt, minutesToTarget: targetMinutes, deadlineCrossesReset: ready && deadlineAt !== undefined && deadlineAt > reset, forecast,
      remainingPoints: ready ? 100-used! : null, reservePoints, spendablePoints: spendable, minutesToReset: minutes,
      requiredPointsPerMinute: required, observedPointsPerMinute: rate,
      rateInterval: rate !== null ? { from: before!.at, to: last!.at } : null,
      projectedUsedAtTarget: rate !== null && targetMinutes !== null ? Math.min(100,used!+rate*targetMinutes) : null,
      projectedUsedAtReset: rate !== null ? Math.min(100, used! + rate*(reset-now)/60000) : null,
      paceMultiplier: rate !== null && rate > 0 ? required!/rate : null,
      pace: spendable === 0 ? "target-reached" : required === null || rate === null ? "unknown" : rate < required ? "below-target" : "at-or-above-target",
      basis: "all-account-activity" as const }
  }))
}
export function resetPlanLines(plans: ReturnType<typeof resetPlan>): string[] {
  return plans.flatMap(p => {
    const name = `${p.provider} ${p.accountID.slice(-6)} ${p.label}${p.model ? " " + p.model : ""}`
    if (p.state !== "ready") return [`${name}: planning unavailable`, `  ${p.reason}`]
    return [
      `${name}: Usage left: ${p.remainingPoints!.toFixed(1)}% / Resets in: ${Math.ceil(p.minutesToReset!)}m`,
      `  Usage burn per hour: ${p.observedPointsPerMinute === null ? "Still measuring" : (p.observedPointsPerMinute * 60).toFixed(2) + "%/hour"}; needed: ${(p.requiredPointsPerMinute! * 60).toFixed(2)}%/hour to finish in ${Math.ceil(p.minutesToTarget!)}m`,
      `  Max-out estimate: ${p.forecast?.projectedExhaustionAt ? new Date(p.forecast.projectedExhaustionAt).toISOString() : p.forecast?.resetOccursFirst ? "reset occurs first at current pace" : "unresolved"}`,
      `  ${p.pace}${p.paceMultiplier === null ? "" : ` / ${p.paceMultiplier.toFixed(2)}x current pace`}; reserve ${p.reservePoints}%`,
    ]
  })
}
