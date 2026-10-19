import { empiricalWorkloadScenario, type learnEmpiricalModel } from "./empirical-usage"
import type { AccountUsage } from "../usage-service/on-computer"
import { accountRegime } from "./calibration-store"
import { canonicalRouteKey, predictAllowance, routeKey, type Calibration } from "./calibration"
import { creditValue, validateWorkloads, workloadRequest, type UsageWorkload } from "./credit-rates"
import type { resetPlan } from "./reset-planner"

export function compareWorkloads(accounts: AccountUsage[], plans: ReturnType<typeof resetPlan>, calibrations: Calibration[], workloads: UsageWorkload[], now: number, empirical:ReturnType<typeof learnEmpiricalModel>[] = []) {
  validateWorkloads(workloads)
  return workloads.map(w => {
    const account = accounts.find(a => a.id === w.accountID)
    const regime = account ? accountRegime(account) : "unknown", request = workloadRequest(w,regime,now)
    const credits = account?.provider === "openai" ? creditValue(request,now) : null
    const windows = plans.filter(p => p.accountID === w.accountID && (p.scope === "shared" || p.scope === "model" && p.model === w.route.modelID)).map(p => {
      const calibration = calibrations.filter(c => c.accountID === w.accountID && c.regime === regime && c.windowID === p.windowID && canonicalRouteKey(c.routeKey) === routeKey(request)).sort((a,b) => b.trainedAt-a.trainedAt)[0]
      const prediction = p.state === "ready" && calibration ? predictAllowance(calibration,request,{now,regime}) : null
      const estimate = prediction ? {points:prediction.points*w.requests,low:prediction.low*w.requests,high:prediction.high*w.requests,version:prediction.version} : null
      const learned=empirical.filter(m=>m.scope?.accountID===w.accountID&&m.scope?.windowID===p.windowID&&m.scope?.regime===regime).sort((a,b)=>(b.validation?.to??0)-(a.validation?.to??0))[0]
      const empiricalScenario=p.state==="ready"?empiricalWorkloadScenario(learned,w,{accountID:w.accountID,windowID:p.windowID,regime,resetAt:Date.parse(p.resetAt!)},now):{state:"unavailable" as const,reason:"Pool observation is not current",points:null,observedErrorScenario:null}
      return {windowID:p.windowID,resetAt:p.resetAt,targetAt:p.targetAt,spendablePoints:p.spendablePoints,estimate,empiricalScenario,
        requestsWithinUpperEstimate: prediction && prediction.high > 0 ? Math.floor(p.spendablePoints!/prediction.high) : null,
        fit: !estimate ? "unknown" : estimate.high <= p.spendablePoints! ? "within-estimate" : estimate.low > p.spendablePoints! ? "over-budget" : "uncertain"}
    })
    return { ...w, creditEquivalent: credits ? {...credits,credits:credits.credits === null ? null : credits.credits*w.requests} : {credits:null,reason:"No verified OpenAI account for this workload"}, windows,
      note: "Each alternative repeats the supplied per-request tokens. Session counts and concurrency do not define token volume. Check every applicable pool; this is not dispatch authorization." }
  })
}
