import type { RequestRecord } from "./telemetry"
import { tokenFeatures } from "./calibration"

export const CREDIT_RATE_CARD = {
  source: "https://learn.chatgpt.com/docs/pricing", speedSource: "https://learn.chatgpt.com/docs/agent-configuration/speed",
  checkedAt: "2026-09-07", validUntil: "2026-09-21T00:00:00Z",
  rates: { "gpt-6-astra": [250,25,1250], "gpt-5.6-sol": [100,10,500], "gpt-5.6-terra": [50,5,300], "gpt-5.6-luna": [5,.5,30] } as Record<string, number[]>,
}
export type UsageWorkload = { label: string; accountID: string; route: RequestRecord["route"]; requests: number; tokens: { input: number; cacheRead: number; outputIncludingReasoning: number } }
export function validateWorkloads(workloads: UsageWorkload[]) {
  if (!Array.isArray(workloads) || workloads.length > 20) throw new Error("At most 20 workload alternatives are allowed")
  for (const w of workloads) if (!w?.label || !w.accountID || !w.route?.providerID || !w.route.modelID || !Number.isInteger(w.requests) || w.requests < 1 || w.requests > 1000000 ||
    !w.tokens || [w.tokens.input,w.tokens.cacheRead,w.tokens.outputIncludingReasoning].some(n => !Number.isFinite(n) || n < 0 || n > 1e9)) throw new Error("Invalid workload: supply exact route, request count and nonnegative per-request tokens")
}
export function workloadRequest(w: UsageWorkload, regime: string, now: number): RequestRecord {
  return { id: "forecast", sessionID: "forecast", accountID: w.accountID, accountRegime: regime, route: w.route, kind: "forecast", state: "completed", startedAt: now,
    tokens: {input:w.tokens.input,cacheRead:w.tokens.cacheRead,cacheWrite:0,output:null,reasoning:null},outputTotal:w.tokens.outputIncludingReasoning }
}
export function creditValue(r: RequestRecord, now: number) {
  const rates = CREDIT_RATE_CARD.rates[r.route.modelID], features = tokenFeatures(r), tier = r.route.serviceTier
  const reason = now >= Date.parse(CREDIT_RATE_CARD.validUntil) ? "Published rate card needs rechecking" : !rates ? "No published rate for this exact model" :
    !["default","standard","fast"].includes(tier ?? "unknown") ? "Service tier is unknown or unmapped" : !features || features[2] !== 0 ? "Token components unavailable or unsupported cache writes" : null
  return { credits: reason ? null : (features![0]*rates[0]+features![1]*rates[1]+features![3]*rates[2])/1e6*(tier === "fast" ? 2.5 : 1),
    reason, basis: "published-credit-equivalent" as const, source: CREDIT_RATE_CARD.source, checkedAt: CREDIT_RATE_CARD.checkedAt,
    note: "Not an actual charge or measured included-allowance consumption." }
}
