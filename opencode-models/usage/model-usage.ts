import { requestMetrics } from "./request-metrics"
import type { RequestRecord } from "./telemetry"
import { routeKey, tokenFeatures } from "./calibration"
export function modelUsage(records: RequestRecord[], now: number, from = now - 28*86400000) {
  const groups = new Map<string, RequestRecord[]>()
  for (const r of new Map(records.map(r => [r.id,r])).values()) {
    if (r.startedAt < from || r.startedAt > now) continue
    const key = JSON.stringify([r.accountID,routeKey(r)])
    const group = groups.get(key) ?? []; group.push(r); groups.set(key,group)
  }
  return [...groups.values()].map(rows => {
    const complete = rows.filter(r => r.state === "completed" && tokenFeatures(r))
    const metrics = requestMetrics(rows)
    const round = (value: number | null) => value === null ? null : Math.round(value * 10) / 10
    return {accountID:rows[0].accountID,route:rows[0].route,requests:rows.length,sessions:new Set(rows.map(r => r.sessionID)).size,
      firstAt:Math.min(...rows.map(r=>r.startedAt)),lastAt:Math.max(...rows.map(r=>r.startedAt)),
      tokens:metrics.tokens.knownTotals,missingTokenRequests:metrics.tokens.outputIncludingReasoning.missingRequests,
      activeSeconds:round(metrics.timing.activeMilliseconds/1000),outputTokensPerSecond:round(metrics.speed.outputIncludingReasoningPerSecond),visibleOutputTokensPerSecond:round(metrics.speed.visibleOutputTokensPerSecond),
      cost:metrics.cost.map(c=>({currency:c.currency,actual:c.actualCharge,estimated:c.estimatedCost})),
      meanRequestTokens:complete.length ? {input:Math.round(complete.reduce((n,r)=>n+tokenFeatures(r)![0],0)/complete.length),cacheRead:Math.round(complete.reduce((n,r)=>n+tokenFeatures(r)![1],0)/complete.length),cacheWrite:Math.round(complete.reduce((n,r)=>n+tokenFeatures(r)![2],0)/complete.length),outputIncludingReasoning:Math.round(complete.reduce((n,r)=>n+tokenFeatures(r)![3],0)/complete.length)} : null}
  })
}
export const MODEL_USAGE_NOTE="Recent measured requests, not completed-session costs or a quota conversion. Work outside OpenCode may be missing."
