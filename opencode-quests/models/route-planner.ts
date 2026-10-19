import { capabilityOf, capabilityRuns, priorRuns, unbenched, judgedRuns, scoreEarned, unbenchedText, replaysText, unlimitedSubscriptionConcurrency, aheadOfClock, applicableQuotaWindows, pacedSubscriptionAdmission, startsStrong, type QuotaWindow, type Account, type LearnedOutcomes, type Route, type RoutingRequest, type DepthBand, type PlannerInput, type Candidate, type RoutingDecision, type AllowanceSpend, type VerifiedFinish } from "./route-vocabulary"
export * from "./route-vocabulary"
import { finishEstimates, speedSuccess, type FinishBasis } from "./time-to-finish"
const finite = (n: number) => typeof n === "number" && Number.isFinite(n)
const nonnegative = (n: number) => finite(n) && n >= 0
const positive = (n: number) => finite(n) && n > 0
const date = (s: string) => typeof s === "string" ? Date.parse(s) : NaN
function quotaRefusal(account: Pick<Account, "id">, window: QuotaWindow, cause: string) {
  const reset = date(window.resetAt)
  return cause + " on account " + account.id + " window " + window.id +
    (finite(reset) ? " (resets " + window.resetAt + ")" : " (reset unknown; refresh the account observation)")
}

function validateRequest(r: RoutingRequest) {
  if (r.missingSubscriptionUsage !== undefined && !["wait", "attempt"].includes(r.missingSubscriptionUsage)) throw new Error("Invalid missing subscription usage policy")
  if (r.economyPriceTolerance !== undefined && (!nonnegative(r.economyPriceTolerance) || r.economyPriceTolerance > 1)) throw new Error("Invalid economical price tolerance")
  if (r.qualitySelection !== undefined && !["near-best", "floor"].includes(r.qualitySelection)) throw new Error("Invalid quality selection")
  if (r.subscriptionConcurrency !== undefined && !["unlimited", "calibrated"].includes(r.subscriptionConcurrency)) throw new Error("Invalid subscription concurrency policy")
  if(r.cashCurrency!==undefined&&(!r.cashCurrency.trim()||r.cashBudget&&r.cashBudget.currency!==r.cashCurrency))throw new Error("Invalid or conflicting cash currency")
  if(r.cashBudget){const b=r.cashBudget;if(!b.id?.trim()||!b.currency?.trim()||![b.limit,b.spent,b.reserved??0].every(nonnegative)||!finite(date(b.startsAt))||!finite(date(b.endsAt))||date(b.startsAt)>=date(b.endsAt))throw new Error("Invalid cash budget")}
  if (r.judging !== undefined && typeof r.judging !== "boolean") throw new Error("Invalid judging flag")
  if (r.depthBand !== undefined && (!r.depthBand || typeof r.depthBand.depth !== "string" || !r.depthBand.depth.trim() ||
      (r.depthBand.efforts !== undefined && (!Array.isArray(r.depthBand.efforts) || !r.depthBand.efforts.length || r.depthBand.efforts.some(e => typeof e !== "string" || !e.trim()))) ||
      (r.depthBand.maxCostWeight !== undefined && !(finite(r.depthBand.maxCostWeight) && r.depthBand.maxCostWeight >= 1)) ||
      (r.depthBand.maxAllowanceShare !== undefined && !(positive(r.depthBand.maxAllowanceShare) && r.depthBand.maxAllowanceShare <= 1)) ||
      (r.depthBand.maxCapabilityGap !== undefined && !(nonnegative(r.depthBand.maxCapabilityGap) && r.depthBand.maxCapabilityGap <= 1)))) throw new Error("Invalid depth band")
  if (r.judged !== undefined) {
    const j = r.judged
    if (!j || typeof j !== "object" || typeof j.model !== "string" || typeof j.reason !== "string" ||
        !j.probabilities || typeof j.probabilities !== "object" || Array.isArray(j.probabilities) ||
        Object.values(j.probabilities).some(v => !nonnegative(v))) throw new Error("Invalid routing judgment")
    if (j.order !== undefined && (!Array.isArray(j.order) || j.order.some(id => typeof id !== "string" || !id.trim()) || new Set(j.order).size !== j.order.length)) throw new Error("Invalid routing judgment order")
    if (j.groups !== undefined && (typeof j.groups !== "object" || Array.isArray(j.groups) ||
        Object.values(j.groups).some(g => !g || typeof g !== "object" || !nonnegative(g.share) || !Array.isArray(g.routeIDs)))) throw new Error("Invalid routing judgment groups")
  }
  if (r.automatic !== undefined && (!r.automatic || typeof r.automatic !== "object" ||
      (r.automatic.exclude !== undefined && (typeof r.automatic.exclude !== "object" || Array.isArray(r.automatic.exclude) || Object.values(r.automatic.exclude).some(p => typeof p !== "string" || !p.trim()))) ||
      (r.automatic.fastestWithin !== undefined && (!nonnegative(r.automatic.fastestWithin) || r.automatic.fastestWithin > 1)) ||
      (r.automatic.allowanceWeight !== undefined && !nonnegative(r.automatic.allowanceWeight)) ||
      (r.automatic.preferFree !== undefined && typeof r.automatic.preferFree !== "boolean") ||
      (r.automatic.ratings !== undefined && (typeof r.automatic.ratings !== "object" || Object.values(r.automatic.ratings).some(v => !v || !["strong", "good"].includes(v.rating) || typeof v.basis !== "string"))) ||
      (r.automatic.explore !== undefined && (!Array.isArray(r.automatic.explore.routeIDs) || r.automatic.explore.routeIDs.some(id => typeof id !== "string") || typeof r.automatic.explore.note !== "string")))) throw new Error("Invalid automatic routing settings")
  if (r.automatic?.value !== undefined) {
    const v = r.automatic.value
    if (!v || !finite(v.bar) || v.bar < 0 || v.bar > 1 || !nonnegative(v.tie) || v.tie > 0.2 || !v.weights || [v.weights.cost, v.weights.time, v.weights.score].some(w => !nonnegative(w)) || !positive(v.weights.cost + v.weights.time + v.weights.score)) throw new Error("Invalid value rule")
  }
  if (r.preference !== undefined && !["capacity", "latency", "cash", "economy"].includes(r.preference)) throw new Error("Invalid routing preference")
  if (r.allowedRouteIDs !== undefined && (!Array.isArray(r.allowedRouteIDs) || r.allowedRouteIDs.some(id => typeof id !== "string"))) throw new Error("Invalid route allowlist")
  if (r.minBenchmarkPassAt1 !== undefined && (!nonnegative(r.minBenchmarkPassAt1) || r.minBenchmarkPassAt1 > 1)) throw new Error("Invalid benchmark floor")
  if (r.maxBenchmarkAgeDays !== undefined && !positive(r.maxBenchmarkAgeDays)) throw new Error("Invalid published-prior max age")
  if (r.borrowedPriorRuns !== undefined && !positive(r.borrowedPriorRuns)) throw new Error("Invalid borrowed prior weight")
  if (!["coding", "review", "planning", "utility"].includes(r.task) || !finite(date(r.now)) ||
      !positive(r.minTrials) || !Number.isInteger(r.minTrials) ||
      !nonnegative(r.minSuccessRate) || r.minSuccessRate > 1 ||
      !nonnegative(r.qualityTolerance) || r.qualityTolerance > 1 ||
      !positive(r.maxUsageAgeSeconds) || !positive(r.maxEvidenceAgeDays) ||
      (r.maxCashPerSuccess !== undefined && !nonnegative(r.maxCashPerSuccess)) ||
      !nonnegative(r.reserveFraction) || r.reserveFraction >= 1 ||
      (r.maxTaskMilliseconds !== undefined && !positive(r.maxTaskMilliseconds))) {
    throw new Error("Invalid routing request")
  }
}

export function planRoutes(input: PlannerInput): RoutingDecision {
 const req=input.request
 if(req.primaryRouteID!==undefined&&(!req.primaryRouteID.trim()||!req.allowedRouteIDs?.includes(req.primaryRouteID)))throw new Error("Primary route must be explicitly allowed")
 if(req.fallback && (!req.primaryRouteID||req.fallback.when!=="admission-unavailable"||!Array.isArray(req.fallback.routeIDs)||!req.fallback.routeIDs.length||new Set(req.fallback.routeIDs).size!==req.fallback.routeIDs.length||req.fallback.routeIDs.some(id=>id===req.primaryRouteID||!req.allowedRouteIDs?.includes(id))))throw new Error("Fallback requires a primary route and explicitly allowed alternatives")
 if(req.explicitRouteID||!req.primaryRouteID)return planEligibleRoutes(input)
 const first=planEligibleRoutes({...input,request:{...req,explicitRouteID:req.primaryRouteID}})
 if(first.selected)return first
 const reasons=first.excluded.flatMap(r=>r.reasons)
 const configured=!!req.fallback
 const pool=req.fallback?.routeIDs??(req.allowedRouteIDs??[]).filter(id=>id!==req.primaryRouteID)
 const primary="primary "+req.primaryRouteID+(req.primarySource?" (set in "+req.primarySource+")":"")+" refused: "+reasons.join("; ")
 if(!pool.length)return {...first,summary:first.summary+"; "+primary+"; no other route is allowed"}
 const alternative=planEligibleRoutes({...input,request:{...req,primaryRouteID:undefined,fallback:undefined,allowedRouteIDs:pool}})
 const excluded=[...first.excluded,...alternative.excluded.filter(r=>r.routeID!==req.primaryRouteID)]
 if(!alternative.selected)return {...alternative,excluded,summary:configured?"Configured primary and fallback routes unavailable":alternative.summary+"; "+primary}
 const fallback={fromRouteID:req.primaryRouteID,toRouteID:alternative.selected.routeID,reasons}
 return {...alternative,fallback,excluded,summary:configured?"Configured fallback "+fallback.fromRouteID+" -> "+fallback.toRouteID+": "+reasons.join("; "):primary+"; routed over the pool: "+alternative.summary}
}
const REFUSAL_GROUPS:[RegExp,string][]=[[/^automatic routing excludes /,"excluded by routing settings"],[/^route is not allowed by user policy/,"not on the allowed routes list"],[/^route transport\/entitlement is unverified/,"unverified on a connected account"],[/^account is not authenticated/,"on an account that is not signed in"],[/^account is not registered/,"on no registered account"]]
const refusalGroup=(reason:string)=>REFUSAL_GROUPS.find(([pattern])=>pattern.test(reason))?.[1]??reason.split(":")[0].trim()
export function groupedRefusal(excluded:RoutingDecision["excluded"]){
 const groups=new Map<string,string[]>()
 for(const row of excluded)for(const key of new Set((row.reasons.length?row.reasons:["no reason recorded"]).map(refusalGroup)))groups.set(key,[...(groups.get(key)??[]),row.routeID])
 return [...groups].sort((a,b)=>b[1].length-a[1].length).map(([why,ids])=>{
  const shown=ids.slice(0,3),more=ids.length-shown.length
  return ids.length+" route"+(ids.length===1?"":"s")+" "+why+": "+shown.join(", ")+(more?", and "+more+" more":"")
 }).join("; ")
}
function planEligibleRoutes(input: PlannerInput): RoutingDecision {
  const { request: req, accounts, routes } = input
  validateRequest(req)
  if (new Set(accounts.map(a => a.id)).size !== accounts.length ||
      new Set(routes.map(r => r.id)).size !== routes.length) throw new Error("Duplicate account or route identity")
  const now = date(req.now)
  const excluded: RoutingDecision["excluded"] = []
  const candidates: Candidate[] = []
  const vouched = (routeID: string) => !!req.automatic?.ratings?.[routeID] || !!req.automatic?.explore?.routeIDs.includes(routeID)
  const rated = (routeID: string) => !!req.automatic?.ratings?.[routeID]
  const explored = (routeID: string) => !req.explicitRouteID && !req.judged && !req.judging && !!req.automatic?.explore?.routeIDs.includes(routeID)
  const band = bandBaseline(req, routes)
  const byEffort = routineByEffort(req)
  for (const route of routes) {
    if (req.explicitRouteID && route.id !== req.explicitRouteID) continue
    const named = req.explicitRouteID === route.id
    const chosen = route.admission !== undefined
    const reasons: string[] = []
    const settingExclusion = req.automatic?.exclude?.[route.id]
    if (settingExclusion) reasons.push("automatic routing excludes " + settingExclusion + " (routing settings); choosing it explicitly still works")
    if (route.outcomeIssue?.task === req.task) reasons.push("Measured outcomes unavailable: " + route.outcomeIssue.reason)
    const account = accounts.find(a => a.id === route.accountID)
    const windows = account ? applicableQuotaWindows(account, route) : []
    const attemptWithoutUsage = account?.billing === "subscription" && req.missingSubscriptionUsage === "attempt"
    const usageUnknown = !!account && (account.capacity === "unknown" || !windows.length || !finite(date(account.observedAt)) || now - date(account.observedAt) >= req.maxUsageAgeSeconds * 1000)
    if (![route.id, route.accountID, route.providerID, route.modelID, route.harness, route.reasoning, route.serviceTier].every(x => typeof x === "string" && x.trim())) reasons.push("incomplete exact route identity")
    if (req.allowedRouteIDs && !req.allowedRouteIDs.includes(route.id)) reasons.push("route is not allowed by user policy")
    if(req.cashBudget){const b=req.cashBudget,c=route.cashReservation;if(now<date(b.startsAt)||now>=date(b.endsAt))reasons.push("cash budget is outside its authorized time range");if(!c||c.currency!==b.currency||!nonnegative(c.upperBound))reasons.push("route has no matching cash reservation bound");else if(c.upperBound>b.limit-b.spent-(b.reserved??0))reasons.push("insufficient unreserved cash budget")}
    if (!route.verified) reasons.push("route transport/entitlement is unverified")
    const allowance = allowanceSpend(route, account, now)
    if (req.depthBand && !named) reasons.push(...outsideBand(req.depthBand, route, req, band, account, allowance))
    if (!account) reasons.push("account is not registered")
    else {
      if (!["subscription", "free", "metered"].includes(account.billing)) reasons.push("unknown billing arrangement")
      if (chosen && windows.some(w=>!positive(route.quotaPerTask[w.id])) && (account.concurrentWorkers ?? 0) > 0 && !unlimitedSubscriptionConcurrency(account,req) && !pacedSubscriptionAdmission(account,req.now)) reasons.push("uncalibrated admission awaits existing account workers and fresh quota")
      if(account.pacing){const p=account.pacing,now=Date.parse(req.now);if(p.state==="stopped"||(!unlimitedSubscriptionConcurrency(account,req)&&now>=p.deadlineAt))reasons.push("Burn pacing stopped: "+p.reason);else if(p.state!=="ready"||p.updatedAt>now||now-p.updatedAt>=30000||(!unlimitedSubscriptionConcurrency(account,req)&&(account.concurrentWorkers??0)>=p.desiredConcurrency))reasons.push("Burn pacing hold: "+p.reason)}
      if (account.dispatchHold) reasons.push(account.dispatchHold)
      if (chosen && account.billing === "metered" && !req.cashBudget) reasons.push("configured metered choice requires a cash budget")
      if (!account.authenticated) reasons.push("account is not authenticated")
      if (account.capacity !== "available" && !(attemptWithoutUsage && account.capacity === "unknown")) {
        const drained = account.windows.filter(w => w.state === "exhausted").map(w => w.id + (finite(date(w.resetAt)) ? " resets " + w.resetAt : " reset unknown"))
        reasons.push("account " + account.id + " capacity is " + account.capacity + (drained.length ? ": " + drained.join(", ") : ""))
      }
      const age = now - date(account.observedAt)
      if (age < 0 || (!attemptWithoutUsage && (!finite(age) || age >= req.maxUsageAgeSeconds * 1000))) reasons.push("usage observation is stale or invalid")
      if (account.billing === "subscription" && !windows.length && !attemptWithoutUsage) reasons.push("subscription windows are unknown")
      if (new Set(account.windows.map(w => w.id)).size !== account.windows.length) reasons.push("duplicate quota window")
    }
    const evidence = route.evidence.filter(e => e.task === req.task)
      .sort((a, b) => date(b.measuredAt) - date(a.measuredAt))[0]
    const prior = route.benchmark
    let benchmarkPassAt1: number | null = null
    let benchmarkNote = ""
    if (prior) {
      const age = now - date(prior.measuredAt)
      if (!prior.suite?.trim() || !prior.source?.trim() || !prior.effort?.trim() || !positive(prior.passAt1) || prior.passAt1 > 1 ||
          !["independent", "vendor"].includes(prior.provenance) || !finite(age) || age < 0 ||
          (prior.intelligence !== undefined && !positive(prior.intelligence))) reasons.push("invalid benchmark prior")
      else if (age > (req.maxBenchmarkAgeDays ?? req.maxEvidenceAgeDays) * 86400000) benchmarkNote = "benchmark prior from " + prior.measuredAt + " is stale and was not ranked"
      else {
        benchmarkPassAt1 = prior.passAt1
        benchmarkNote = prior.suite + " " + (prior.passAt1 * 100).toFixed(1) + "% at effort " + prior.effort + " (" + prior.provenance + ", " + prior.measuredAt + ", " + prior.source + ")" + (prior.attribution ? "; " + prior.attribution : "")
      }
    }
    const learned = route.learned
    if (learned && (!learned.kind?.trim() || !learned.source?.trim() || !Number.isSafeInteger(learned.trials) || learned.trials <= 0 ||
        !Number.isSafeInteger(learned.delivered) || learned.delivered < 0 || learned.delivered > learned.trials ||
        !Number.isSafeInteger(learned.requests) || learned.requests < 0 || !finite(date(learned.measuredAt)) || date(learned.measuredAt) > now)) reasons.push("invalid recorded outcomes")
    const evidenceWeights = { priorWeight: priorRuns(route, req), ...(route.learnedOther ? { other: route.learnedOther } : {}) }
    const capability = capabilityOf(benchmarkPassAt1, learned, req.minTrials, evidenceWeights)
    const admissionCapability = (learned?.trials ?? 0) >= req.minTrials || benchmarkPassAt1 === null ? capability : Math.max(benchmarkPassAt1, capability ?? benchmarkPassAt1)
    if (!named && !byEffort && !vouched(route.id) && req.minBenchmarkPassAt1 !== undefined && admissionCapability !== null && admissionCapability < req.minBenchmarkPassAt1)
      reasons.push(learned && admissionCapability === capability ? "capability " + pct(admissionCapability) + " (" + learnedText(learned) + (benchmarkPassAt1 === null ? "" : ", published " + pct(benchmarkPassAt1)) + ") is below the task floor"
        : "benchmark prior " + pct(admissionCapability) + " is below the task floor")
    const scoreless = unbenched(route)
    if (scoreless && !named && !byEffort && !scoreEarned(route, req.minTrials)) {
      if (strongFirst(req)) reasons.push(unbenchedText(learned) + "; depth " + req.depthBand!.depth + " starts strong, so a route with no published score is not tried there")
      else if (!explored(route.id) && !rated(route.id)) reasons.push(unbenchedText(learned) + "; it takes work only through exploration or an explicit user rating until " + req.minTrials + " of its runs of this work type here are judged (" + judgedRuns(learned) + " are)")
    }
    let successRate = 0
    if (!evidence && !chosen && !byEffort) reasons.push("no evidence for this task and exact route")
    else if (evidence && !byEffort) {
      const age = now - date(evidence.measuredAt)
      if (!finite(age) || age < 0 || age > req.maxEvidenceAgeDays * 86400000) reasons.push("evidence is stale or invalid")
      const floorText = "below task quality floor (minSuccessRate " + pct(req.minSuccessRate) + "): " + evidence.passed + " of " + evidence.trials + " measured runs accepted"
      if (evidence.source?.trim() && Number.isInteger(evidence.trials) && evidence.passed === 0 && evidence.trials >= req.minTrials &&
          positive(evidence.totalMilliseconds) && positive(evidence.p95Milliseconds)) { if (!rated(route.id)) reasons.push(floorText) }
      else if (!evidence.source?.trim() || !Number.isInteger(evidence.trials) ||
          !Number.isInteger(evidence.passed) || evidence.trials < req.minTrials ||
          evidence.passed <= 0 || evidence.passed > evidence.trials ||
          !positive(evidence.totalMilliseconds) || (evidence.totalCash !== null && !nonnegative(evidence.totalCash)) ||
          !positive(evidence.p95Milliseconds)) reasons.push("insufficient or invalid measured outcomes")
      else {
        if(evidence.totalCash!==null&&(evidence.currency??"USD")!==(req.cashCurrency??req.cashBudget?.currency??"USD"))reasons.push("measured cash currency does not match the budget")
        successRate = evidence.passed / evidence.trials
        if (successRate < req.minSuccessRate && !rated(route.id)) reasons.push(floorText)
        if (evidence.totalCash === null && (req.maxCashPerSuccess !== undefined || req.preference === "cash")) reasons.push("actual cash per success is unavailable for the requested cash constraint")
        if (evidence.totalCash !== null && req.maxCashPerSuccess !== undefined && evidence.totalCash / evidence.passed > req.maxCashPerSuccess) reasons.push("cash per success exceeds budget")
        if (req.maxTaskMilliseconds !== undefined && evidence.p95Milliseconds > req.maxTaskMilliseconds) reasons.push("p95 latency exceeds task deadline")
      }
    }
    if (!named && !byEffort && !req.judging && req.preference === "economy" && !evidence && capability === null && !explored(route.id) && !rated(route.id)) reasons.push("no current task-quality evidence for automatic economical selection")
    let expiryOpportunity = 0
    let limitingWindow: string | undefined
    if (account) {
      const valid: { window: QuotaWindow; slots: number; reset: number }[] = []
      for (const window of windows) {
        const burn = route.quotaPerTask[window.id]
        const reset = date(window.resetAt)
        const future = !finite(reset) || reset > now
        if ((finite(window.remaining) && window.remaining < 0) || !nonnegative(window.reserved)) {
          reasons.push(quotaRefusal(account, window, "invalid allowance reading"))
          continue
        }
        if ((window.state === "exhausted" || window.remaining === 0) && future) {
          reasons.push(quotaRefusal(account, window, "allowance is exhausted"))
          continue
        }
        if (attemptWithoutUsage && (!finite(window.remaining) || !finite(reset) || reset <= now)) continue
        if ((!positive(burn) && (!chosen || burn !== undefined)) || !nonnegative(window.remaining) || !finite(reset) || reset <= now ||
            (window.nextCapacity !== undefined && !positive(window.nextCapacity)) ||
            (window.periodSeconds !== undefined && !positive(window.periodSeconds))) {
          reasons.push(quotaRefusal(account, window, "unknown or invalid quota/reset/consumption"))
          continue
        }
        const reserve = req.reserveByAccount?.[account.id]?.[window.id] ?? window.remaining * req.reserveFraction
        if (!nonnegative(reserve)) { reasons.push(quotaRefusal(account, window, "invalid reserve")); continue }
        if (chosen && !positive(burn)) {
          if (window.remaining - reserve - window.reserved <= 0) reasons.push(quotaRefusal(account, window, "insufficient unreserved quota"))
          continue
        }
        const slots = (window.remaining - reserve - window.reserved) / burn
        if (slots < 1) reasons.push(quotaRefusal(account, window, "insufficient unreserved quota"))
        valid.push({ window, slots, reset })
      }
      if (evidence && positive(evidence.p95Milliseconds)) {
        for (const short of valid) {
          const usefulNow = Math.max(0, Math.floor(Math.min(...valid.map(w => w.slots), (short.reset - now) / evidence.p95Milliseconds)))
          let pressure = usefulNow / Math.max(1, (short.reset - now) / 3600000)
          for (const long of valid.filter(w => w.reset > short.reset)) {
            if (!short.window.nextCapacity || !short.window.periodSeconds) continue
            const periods = Math.ceil((long.reset - short.reset) / (short.window.periodSeconds * 1000))
            const futureSlots = Math.min(periods * short.window.nextCapacity * (1 - req.reserveFraction) / route.quotaPerTask[short.window.id], (long.reset - short.reset) / evidence.p95Milliseconds)
            const neededNow = Math.max(0, long.slots - futureSlots)
            pressure += Math.min(usefulNow, neededNow) / Math.max(1, (short.reset - now) / 3600000)
          }
          if (pressure > expiryOpportunity) { expiryOpportunity = pressure; limitingWindow = short.window.id }
        }
      }
    }
    if (reasons.length) { excluded.push({ routeID: route.id, reasons }); continue }
    const unknownConsumption = !!account && windows.some(w => !positive(route.quotaPerTask[w.id]))
    candidates.push({
      routeID: route.id, accountID: route.accountID,
      successRate: evidence ? successRate : null,
      millisecondsPerSuccess: evidence ? evidence.totalMilliseconds / evidence.passed : null,
      cashPerSuccess: evidence ? (evidence.totalCash === null ? null : evidence.totalCash / evidence.passed) : null,
      expiryOpportunity: usageUnknown || !evidence || (chosen && unknownConsumption) ? null : expiryOpportunity, limitingWindow,
      benchmarkPassAt1, benchmarkProvenance: benchmarkPassAt1 === null ? undefined : prior!.provenance, ...(benchmarkPassAt1 !== null && prior?.inheritedFrom ? { benchmarkBorrowed: true } : {}),
      capability, capabilityRuns: evidence ? evidence.trials : capabilityRuns(benchmarkPassAt1, learned, req.minTrials, evidenceWeights), ...(learned ? { learned } : {}), ...(route.learnedOther ? { learnedOther: route.learnedOther } : {}),
      intelligence: benchmarkPassAt1 === null ? null : prior!.intelligence ?? null,
      requestPerformance: route.requestPerformance ?? null,
      economics: comparableEconomics(route, req),
      ...(allowance ? { allowance } : {}), ...(scoreless ? { unbenched: true as const } : {}),
      evidenceSource: evidence ? evidence.source : scoreless ? unbenchedText(learned) : benchmarkNote || "configured choice; outcomes and consumption uncalibrated",
      note: attemptWithoutUsage && usageUnknown ? "Usage telemetry unavailable; user policy permits a subscription attempt. Capacity and task consumption remain unknown; provider limits still apply."
        : unknownConsumption
        ? (unlimitedSubscriptionConcurrency(account!, req) ? "consumption uncalibrated; user policy permits concurrent subscription workers without a fixed account cap. Fresh quota is required; unknown consumption is not a capacity guarantee."
          : pacedSubscriptionAdmission(account!, req.now) ? "consumption uncalibrated; explicit scoped pacing permits up to " + account!.pacing!.desiredConcurrency + " concurrent managed workers. Quota movement, not session count, controls pacing."
          : "consumption uncalibrated; one worker on this account, refresh after completion. Quota reserves are admission thresholds, not a task consumption guarantee.")
        : undefined,
    })
  }
  if (req.explicitRouteID && !routes.some(r => r.id === req.explicitRouteID)) excluded.push({ routeID: req.explicitRouteID, reasons: ["explicit route is not registered"] })
  const gap = strongFirst(req) ? req.depthBand?.maxCapabilityGap : undefined
  if (gap !== undefined) {
    const strength = (c: Candidate) => admissionStrength(c, req.minTrials)
    const strongest = confidentStrongest(candidates, req.minTrials)
    for (const c of [...candidates]) {
      const s = strength(c)
      if (req.explicitRouteID === c.routeID || vouched(c.routeID) || strongest === null && s !== null || (s !== null && strongest !== null && strongest - s <= gap + 1e-9)) continue
      excluded.push({ routeID: c.routeID, reasons: ["depth " + req.depthBand!.depth + " band admits routes within " + Math.round(gap * 100) + " points of the best capability that is its own published score or measured over enough runs" +
        (strongest === null ? "" : " (" + pct(strongest) + ")") + "; " + (s === null ? "this route's capability is unknown, and unknown is not inside a floor" : "this route's is " + pct(s))] })
      candidates.splice(candidates.indexOf(c), 1)
    }
  }
  if (!req.explicitRouteID && !req.judging && req.automatic?.preferFree && !req.automatic?.value && candidates.some(c => accounts.find(a => a.id === c.accountID)?.billing === "free")) {
    for (const c of [...candidates]) if (accounts.find(a => a.id === c.accountID)?.billing !== "free") {
      excluded.push({ routeID: c.routeID, reasons: ["a free route meets the task requirements; your settings prefer free work before spending allowance or cash"] })
      candidates.splice(candidates.indexOf(c), 1)
    }
  }
  const compare = routingComparator(req)
  const exploring = req.explicitRouteID || req.judged || req.judging ? undefined : req.automatic?.explore
  if (exploring) {
    const tried = exploring.routeIDs.map(id => candidates.find(c => c.routeID === id)).filter((c): c is Candidate => !!c)
    if (tried.length) {
      const selected = tried[0]
      return { selected, ranked: [...tried, ...candidates.filter(c => !tried.includes(c)).sort(compare)], admitted: [...candidates].sort(compare), excluded,
        summary: withBand(selected.routeID + ": exploring " + exploring.note + "; " + (selected.unbenched ? unbenchedText(selected.learned) + (selected.capability === null ? "" : ", capability " + pct(selected.capability)) : selected.capability === null ? "capability unmeasured" : "capability " + pct(selected.capability) + (selected.learned ? " from " + learnedText(selected.learned) : "")) + "; not judged", selected, req, routes) }
    }
  }
  const valued = valueRule(req, input, candidates, excluded, compare, routes)
  if (valued) return valued
  const within = req.automatic?.fastestWithin
  if (within !== undefined && !req.judged) {
    const measured = (c: Candidate) => admissionStrength(c, req.minTrials)
    const strongest = confidentStrongest(candidates, req.minTrials)
    const rating = (c: Candidate) => req.automatic?.ratings?.[c.routeID]?.rating
    const band = candidates.filter(c => {
      const s = measured(c)
      if (req.explicitRouteID === c.routeID || rating(c) || strongest === null || (s !== null && strongest - s <= within + 1e-9)) return true
      excluded.push({ routeID: c.routeID, reasons: ["speed setting takes the fastest route within " + Math.round(within * 100) + " points of the best capability that is its own published score or measured over enough runs (" + pct(strongest) + "); " + (s === null ? "this route's capability is unknown, and unknown is not inside the band" : "this route's is " + pct(s))] })
      return false
    })
    const speed = routeSpeed(input)
    const verified = rankedByVerifiedFinish(req) ? verifiedFinishes(input, band) : undefined
    const plan = (c: Candidate) => speed.allowance(c)?.milliseconds ?? 0
    const timed = (c: Candidate) => verified ? verified.get(c.routeID)!.milliseconds + plan(c) : speed.scored(c)
    const ranked = [...band].sort((a, b) => speed.metered(a) - speed.metered(b) || difference(timed(a), timed(b)) || (verified ? difference(verified.get(a.routeID)!.cost, verified.get(b.routeID)!.cost) : 0) || (speed.estimate(a)?.milliseconds ?? Infinity) - (speed.estimate(b)?.milliseconds ?? Infinity) || (speed.request(a) ?? Infinity) - (speed.request(b) ?? Infinity) || compare(a, b))
    const selected = ranked[0] ?? null
    return { selected, ranked, admitted: [...band].sort(compare), excluded, summary: selected ? withBand(describeFastest(selected, ranked, within, strongest, speed, req, verified), selected, req, routes) : NO_ROUTE }
  }
  const admitted = [...candidates].sort(compare)
  if (req.judged && !req.explicitRouteID) {
    const judged = req.judged
    const probability = (c: Candidate) => judged.probabilities[c.routeID] ?? -1
    const placed = new Map((judged.order ?? []).map((id, index) => [id, index]))
    const rank = (c: Candidate) => placed.get(c.routeID) ?? Infinity
    const ordered = admitted.map(c => probability(c) >= 0 ? Object.assign(c, { probability: probability(c) }) : c)
      .sort((a, b) => rank(a) - rank(b) || probability(b) - probability(a) || compare(a, b))
    const bound = judgedCostBound(ordered)
    const ranked = [...ordered.filter(c => quoteOf(c) <= bound.amount), ...ordered.filter(c => quoteOf(c) > bound.amount)]
    const selected = ranked[0] ?? null
    const verified = rankedByVerifiedFinish(req) ? verifiedFinishes(input, ranked) : undefined
    const judgedSummary = (c: Candidate) => describeJudged(c, judged, admitted, ordered[0] !== c ? { passed: ordered[0], mass: bound.mass } : undefined, req.depthBand ? knownBaseline(req, routes) : undefined) + (verified ? "; " + describeFinishes(c, ranked, verified, req) : "")
    return { selected, ranked, admitted, excluded, summary: selected ? withBand(judgedSummary(selected), selected, req, routes) : NO_ROUTE }
  }
  const measured = candidates.filter(c => c.successRate !== null)
  const economical = req.preference === "economy"
  const pool = economical || !measured.length ? candidates : measured
  for (const c of candidates) if (!pool.includes(c)) excluded.push({ routeID: c.routeID, reasons: ["only a published benchmark prior; measured routes are available for this task"] })
  const quality = (c: Candidate) => c.successRate ?? c.capability ?? 0
  const bestFor = (c: Candidate) => Math.max(0, ...pool.filter(p => (p.successRate !== null) === (c.successRate !== null)).map(quality))
  const verifying = rankedByVerifiedFinish(req) && !req.explicitRouteID
  const qualified = pool.filter(c => {
    if (verifying || req.explicitRouteID || req.judging || req.qualitySelection === "floor" || quality(c) + req.qualityTolerance + 1e-12 >= bestFor(c)) return true
    excluded.push({ routeID: c.routeID, reasons: ["outside quality tolerance of best eligible route"] })
    return false
  })
  if (verifying) {
    const finishes = verifiedFinishes(input, qualified)
    const ranked = [...qualified].sort(verifiedOrder(finishes, req, compare, input))
    const selected = ranked[0] ?? null
    const allowance = req.preference === "economy" && req.automatic?.allowanceWeight ? routes.find(r => r.id === selected?.routeID)?.allowanceCost : undefined
    const rating = selected && req.automatic?.ratings?.[selected.routeID]
    return { selected, ranked, admitted, excluded, summary: selected ? withBand(selected.routeID + (allowance ? ": allowance economy, " + allowance.said + "; " : ": cheapest expected verified finish, ") + describeFinishes(selected, ranked, finishes, req) + "; " + describePrice(selected) + (rating ? "; user rated " + rating.rating + ": " + rating.basis : "") + (selected.note ? "; " + selected.note : ""), selected, req, routes) : NO_ROUTE }
  }
  const cheapest = Math.min(Infinity, ...qualified.map(quoteOf))
  const ranked = qualified.filter(c => {
    if (economical && !req.explicitRouteID && !req.judging && quoteOf(c) === Infinity) {excluded.push({routeID:c.routeID,reasons:["comparable price unavailable for automatic economical selection"]});return false}
    if (!economical || req.explicitRouteID || req.judging || !Number.isFinite(cheapest) || quoteOf(c) <= cheapest * (1 + (req.economyPriceTolerance ?? 0))) return true
    excluded.push({routeID:c.routeID,reasons:["outside configured price range of the cheapest qualified route"]})
    return false
  }).sort(compare)
  const selected = ranked[0] ?? null
  return {
    selected, ranked, admitted, excluded,
    summary: selected ? withBand(describe(selected, req, admitted, req.depthBand ? knownBaseline(req, routes) : undefined), selected, req, routes) : NO_ROUTE,
  }
}
export const strongFirst = (req: Pick<RoutingRequest, "depthBand">) => !!req.depthBand && startsStrong(req.depthBand.depth)
export const rankedByVerifiedFinish = (req: Pick<RoutingRequest, "depthBand">) => !!req.depthBand && !startsStrong(req.depthBand.depth)
const difference = (x: number, y: number) => x === y ? 0 : x - y
export function verifiedFinishes(input: Pick<PlannerInput, "routes" | "accounts" | "request">, pool: Candidate[]) {
  const speed = routeSpeed(input)
  const rate = (c: Candidate) => c.successRate ?? c.capability
  const attempt = (c: Candidate) => speed.estimate(c)?.attemptMilliseconds ?? Infinity
  const rated = pool.filter(c => rate(c) !== null)
  const strongest = rated.length ? [...rated].sort((a, b) => rate(b)! - rate(a)! || difference(quoteOf(a), quoteOf(b)) || difference(attempt(a), attempt(b)) || a.routeID.localeCompare(b.routeID))[0] : null
  const finishes = new Map<string, VerifiedFinish>()
  for (const c of pool) {
    const pass = rate(c), share = c === strongest ? 0 : pass === null ? 1 : Math.min(1, Math.max(0, 1 - pass))
    const reworkCost = strongest ? quoteOf(strongest) : Infinity, reworkMilliseconds = strongest ? attempt(strongest) : Infinity
    const withRework = (own: number, rework: number) => share === 0 ? own : own + share * rework
    const finish: VerifiedFinish = { pass, attemptCost: quoteOf(c), attemptMilliseconds: attempt(c), cost: withRework(quoteOf(c), reworkCost), milliseconds: withRework(attempt(c), reworkMilliseconds),
      rework: strongest ? { routeID: strongest.routeID, pass: rate(strongest), share, cost: reworkCost, milliseconds: reworkMilliseconds } : null }
    finishes.set(c.routeID, finish)
    c.verifiedFinish = finish
  }
  return finishes
}
function verifiedOrder(finishes: Map<string, VerifiedFinish>, req: RoutingRequest, compare: (a: Candidate, b: Candidate) => number, input: PlannerInput) {
  const tolerance = req.preference === "economy" ? req.economyPriceTolerance ?? 0 : 0
  const costs = [...finishes.values()].map(f => f.cost).filter(Number.isFinite)
  const cheapest = costs.length ? Math.min(...costs) : Infinity
  const close = (f: VerifiedFinish) => Number.isFinite(f.cost) && f.cost <= cheapest * (1 + tolerance) + 1e-12
  const priced = (f: VerifiedFinish) => Number.isFinite(f.attemptCost) ? 0 : 1
  const planPoints = (c: Candidate) => {
    if (req.preference !== "economy" || !req.automatic?.allowanceWeight || input.accounts.find(a => a.id === c.accountID)?.billing !== "subscription") return null
    const own = input.routes.find(r => r.id === c.routeID)?.allowanceCost?.points
    if (own === undefined) return Infinity
    const rework = finishes.get(c.routeID)?.rework
    if (!rework?.share) return own
    const other = input.routes.find(r => r.id === rework.routeID)?.allowanceCost?.points
    return other === undefined ? Infinity : own + rework.share * other
  }
  return (a: Candidate, b: Candidate) => {
    const x = finishes.get(a.routeID)!, y = finishes.get(b.routeID)!
    const aPoints = planPoints(a), bPoints = planPoints(b)
    return (aPoints !== null && bPoints !== null ? difference(aPoints, bPoints) : 0) || priced(x) - priced(y) || (close(x) && close(y) ? difference(x.milliseconds, y.milliseconds) : 0) ||
      difference(x.cost, y.cost) || difference(x.milliseconds, y.milliseconds) || compare(a, b)
  }
}
const clockText = (ms: number) => ms >= 90000 ? Math.round(ms / 60000) + " min" : Math.round(ms / 1000) + "s"
const moneyText = (amount: number, currency: string) => currency + " " + amount.toFixed(6)
export function finishText(f: VerifiedFinish, currency: string) {
  const cost = Number.isFinite(f.cost) ? "expected " + moneyText(f.cost, currency) : Number.isFinite(f.attemptCost) ? "expected cost unknown, because the route steps are sent back to has no comparable price" : "expected cost unknown, because it has no comparable price and so ranks after every priced route"
  return cost + " and " + (Number.isFinite(f.milliseconds) ? "about " + clockText(f.milliseconds) : "time unknown") + " to a verified finish"
}
const attemptText = (cost: number, ms: number, currency: string) => (Number.isFinite(cost) ? moneyText(cost, currency) : "no comparable price") + " and " + (Number.isFinite(ms) ? "about " + clockText(ms) : "time unknown")
export function reworkText(routeID: string, f: VerifiedFinish, currency: string) {
  const r = f.rework
  if (!r) return "no admitted route has a known capability, so there is no route to send steps back to"
  const strongest = "the strongest admitted" + (r.pass === null ? "" : ", " + pct(r.pass))
  if (r.routeID === routeID) return "it is the route steps are sent back to (" + strongest + "), so its verified finish is one attempt"
  return "steps sent back go to " + r.routeID + " (" + strongest + "), which takes the " + pct(r.share) + " of tasks this route is not expected to pass, at " + attemptText(r.cost, r.milliseconds, currency) + " an attempt"
}
function describeFinishes(selected: Candidate, ranked: Candidate[], finishes: Map<string, VerifiedFinish>, req: RoutingRequest) {
  const f = finishes.get(selected.routeID)!, currency = req.cashCurrency ?? "USD", rate = selected.successRate ?? selected.capability
  const others = ranked.filter(c => c.routeID !== selected.routeID && finishes.has(c.routeID)).slice(0, 3)
  return finishText(f, currency) + " (one attempt " + attemptText(f.attemptCost, f.attemptMilliseconds, currency) + ")" +
    "; " + (rate === null ? "capability unmeasured, so every attempt is counted as sent back" : "capability " + pct(rate) + (selected.successRate === null ? capabilityBasis(selected, req) : " observed on this exact route")) +
    "; " + reworkText(selected.routeID, f, currency) +
    (others.length ? "; passed over " + others.map(c => c.routeID + " at " + finishText(finishes.get(c.routeID)!, currency)).join(", ") : "")
}
export function capabilityBasis(c: Candidate, req: RoutingRequest) {
  if (c.unbenched) return " (" + unbenchedText(c.learned) + (c.learned ? ", delivered " + c.learned.delivered + " of " + c.learned.trials + ", " + judgedRuns(c.learned) + " judged by the checks" : "") + ")"
  const priorWeight = c.capabilityRuns !== undefined ? c.capabilityRuns - (c.learned?.trials ?? 0) : req.minTrials
  const start = c.benchmarkPassAt1 === null ? "no published or borrowed score" : "starting from " + pct(c.benchmarkPassAt1) + " counted as " + priorWeight + " run" + (priorWeight === 1 ? "" : "s")
  const other = c.learnedOther ? ", moved by " + c.learnedOther.delivered + " of " + c.learnedOther.trials + " passes on other work types at this depth or deeper" : ""
  return " (" + (c.learned ? learnedText(c.learned) + "; " : "no runs of this work type here yet; ") + start + other + ")"
}
function confidentStrongest(candidates: Candidate[], minTrials: number) {
  const settled = candidates.flatMap(c => { const s = c.successRate ?? ((c.learned?.trials ?? 0) >= minTrials ? c.capability : c.benchmarkBorrowed ? null : c.benchmarkPassAt1); return s === null ? [] : [s] })
  return settled.length ? Math.max(...settled) : null
}
function admissionStrength(candidate: Candidate, minTrials: number) {
  return candidate.successRate ?? ((candidate.learned?.trials ?? 0) >= minTrials || candidate.benchmarkPassAt1 === null ? candidate.capability : Math.max(candidate.benchmarkPassAt1, candidate.capability ?? candidate.benchmarkPassAt1))
}
function comparableEconomics(route: Route, req: RoutingRequest) {
  const e = route.economics, now = date(req.now)
  return e && nonnegative(e.amount) && e.currency === (req.cashCurrency ?? "USD") && e.source?.trim() && finite(date(e.observedAt)) && now >= date(e.observedAt) && now - date(e.observedAt) <= req.maxEvidenceAgeDays * 86400000 ? e : null
}
function bandBaseline(req: RoutingRequest, routes: Route[]) {
  return req.depthBand?.maxCostWeight === undefined ? undefined : knownBaseline(req, routes)
}
function knownBaseline(req: RoutingRequest, routes: Route[]) {
  const quotes = routes.map(r => comparableEconomics(r, req)?.amount).filter((n): n is number => n !== undefined && n > 0)
  return quotes.length ? { amount: Math.min(...quotes), routeID: routes.find(r => comparableEconomics(r, req)?.amount === Math.min(...quotes))!.id } : undefined
}
function outsideBand(band: DepthBand, route: Route, req: RoutingRequest, baseline: ReturnType<typeof bandBaseline>, account?: Account, allowance?: AllowanceSpend | null) {
  const reasons: string[] = []
  if (account?.billing === "free") return reasons
  if (account?.billing === "subscription" && allowance) {
    if (allowance.expiresUnused) return reasons
    if (allowance.share !== null) {
      if (band.maxAllowanceShare !== undefined && allowance.share > band.maxAllowanceShare + 1e-12)
        reasons.push("depth " + band.depth + " band lets one task take at most " + shareText(band.maxAllowanceShare) + " of an allowance that is not expiring; this route's task takes " + shareText(allowance.share) + " (" + allowance.stated + ")")
      return reasons
    }
    if (!comparableEconomics(route, req)) return reasons
  }
  if (band.efforts && !band.efforts.map(e => e.trim().toLowerCase()).includes(route.reasoning.trim().toLowerCase()))
    reasons.push("depth " + band.depth + " band admits effort " + band.efforts.join("/") + ", not " + route.reasoning)
  if (band.maxCostWeight !== undefined && baseline) {
    const quote = comparableEconomics(route, req)
    if (!quote) reasons.push("depth " + band.depth + " band caps cost weight at " + band.maxCostWeight + "× and this route has no comparable price; unknown is not inside a ceiling")
    else if (quote.amount / baseline.amount > band.maxCostWeight + 1e-9) reasons.push("depth " + band.depth + " band caps cost weight at " + band.maxCostWeight + "×; this route is " + weightText(quote.amount / baseline.amount) + " the cheapest known quote (" + baseline.routeID + ")")
  }
  return reasons
}
const withBand = (summary: string, selected: Candidate, req: RoutingRequest, routes: Route[]) => { const band = describeBand(selected, req, routes); return band ? summary + "; " + band : summary }
const weightText = (weight: number) => (weight < 10 ? weight.toFixed(1) : String(Math.round(weight))) + "×"
function describeBand(selected: Candidate, req: RoutingRequest, routes: Route[]) {
  const band = req.depthBand
  if (!band) return ""
  const limits = [band.efforts ? "effort " + band.efforts.join("/") : "", band.maxCostWeight !== undefined ? "cost weight ≤ " + band.maxCostWeight + "×" : ""].filter(Boolean)
  const baseline = bandBaseline(req, routes)
  if (req.explicitRouteID === selected.routeID) return "depth " + band.depth + ": named route, not held to a depth band"
  if (band.maxAllowanceShare !== undefined) limits.push("allowance share ≤ " + shareText(band.maxAllowanceShare))
  if (band.maxCapabilityGap !== undefined && strongFirst(req)) limits.push("capability within " + Math.round(band.maxCapabilityGap * 100) + " points of the strongest offered")
  const spend = selected.allowance ? "; allowance " + (selected.allowance.expiresUnused ? "expires unused, so this task costs nothing" : selected.allowance.stated) : ""
  return "depth " + band.depth + " band: " + (limits.length ? limits.join(", ") : "no limits") + spend + (band.maxCostWeight !== undefined && !baseline ? " (no route has a comparable price, so the ceiling could not be applied)" : "")
}
const quoteOf = (c: Candidate) => c.allowance?.expiresUnused ? 0 : c.economics?.amount ?? Infinity
const shareText = (share: number) => share >= 0.1 ? Math.round(share * 100) + "%" : share >= 0.001 ? (share * 100).toFixed(1) + "%" : "<0.1%"
export function allowanceSpend(route: Route, account: Account | undefined, now: number): AllowanceSpend | null {
  if (!account || account.billing !== "subscription") return null
  const windows = applicableQuotaWindows(account, route)
  if (!windows.length) return { expiresUnused: null, share: null, stated: "no allowance window reported" }
  let expires: boolean | null = true, share: number | null = 0
  const said: string[] = []
  for (const w of windows) {
    const left = finite(w.remaining) && w.remaining >= 0 && w.remaining <= 100 ? Math.max(0, w.remaining - (nonnegative(w.reserved) ? w.reserved : 0)) : null
    const burn = route.quotaPerTask[w.id]
    const tasks = route.tasksLeft?.[w.id] ?? (positive(burn) && left !== null ? left / burn : undefined)
    const taskShare = tasks !== undefined && positive(tasks) ? 1 / tasks : null
    const pace = aheadOfClock({ remainingPercent: left, resetAt: date(w.resetAt), periodSeconds: w.periodSeconds ?? null }, now).ahead
    const surplusCovers = pace === null || taskShare === null || left === null ? null : pace * 100 >= taskShare * left
    const windowExpires = typeof w.expiresUnused === "boolean" ? w.expiresUnused : surplusCovers
    said.push(w.id + (windowExpires ? " expires unused" : taskShare !== null ? " " + shareText(taskShare) + " of what is left per task" : windowExpires === false ? " is being spent, share per task unmeasured" : " unmeasured"))
    if (!windowExpires) {
      if (expires !== false) expires = windowExpires
      share = share === null || taskShare === null ? null : Math.max(share, taskShare)
    }
  }
  return { expiresUnused: expires, share: expires ? 0 : share, stated: said.join(", ") }
}
function judgedCostBound(ordered: Candidate[]) {
  const weighed = ordered.filter(c => c.probability !== undefined)
  const total = weighed.reduce((n, c) => n + c.probability!, 0)
  if (!(total > 0)) return { amount: Infinity, mass: 1 }
  let mass = 0
  for (const level of [...new Set(weighed.map(quoteOf))].sort((a, b) => a - b)) {
    mass += weighed.filter(c => quoteOf(c) === level).reduce((n, c) => n + c.probability!, 0) / total
    if (mass >= 0.5 - 1e-9) return { amount: level, mass }
  }
  return { amount: Infinity, mass }
}
function costWeight(selected: Candidate, pool: Candidate[], known?: { amount: number; routeID: string }) {
  const cheapest = known?.amount ?? Math.min(Infinity, ...pool.map(quoteOf))
  if (!selected.economics || !Number.isFinite(cheapest)) return ""
  const weight = cheapest > 0 ? selected.economics.amount / cheapest : selected.economics.amount > 0 ? Infinity : 1
  const unit = known ? "the cheapest known quote (" + known.routeID + ")" : "the cheapest quote"
  return "cost weight " + (weight < 1.05 ? "1× (" + unit + ")" : (weight < 10 ? weight.toFixed(1) : String(Math.round(weight))) + "× " + unit)
}
const pct = (fraction: number) => (fraction * 100).toFixed(1) + "%"
export const learnedText = (l: LearnedOutcomes) => "measured here over " + l.trials + " run" + (l.trials === 1 ? "" : "s") + replaysText(l) + ": delivered " + l.delivered + " of " + l.trials + (l.kind === "*" ? " steps of any work type" : " " + l.kind + " step" + (l.trials === 1 ? "" : "s")) + (l.depth ? " at depth " + l.depth + " or deeper" : "") + (l.via ? " on this model and effort, some via " + l.via : " on this route") + ", " + Math.round(l.requests / l.trials) + " model calls a run"
const NO_ROUTE = "No evidenced, funded route meets the task constraints. No fallback was authorized."
const provenanceRank = (c: Candidate) => c.benchmarkProvenance === "vendor" ? 1 : 0
function routingComparator(req: RoutingRequest) {
  const economical = req.preference === "economy"
  return (a: Candidate, b: Candidate) => {
    if (economical) {
      const price = quoteOf(a) - quoteOf(b)
      const speed = (a.requestPerformance?.milliseconds ?? a.economics?.requestMilliseconds ?? Infinity) - (b.requestPerformance?.milliseconds ?? b.economics?.requestMilliseconds ?? Infinity)
      return speed || price || (b.expiryOpportunity ?? -Infinity) - (a.expiryOpportunity ?? -Infinity) ||
        provenanceRank(a) - provenanceRank(b) || (b.capability ?? 0) - (a.capability ?? 0) || a.routeID.localeCompare(b.routeID)
    }
    return (req.preference === "cash" ? (a.cashPerSuccess ?? Infinity) - (b.cashPerSuccess ?? Infinity) : req.preference === "latency" ? (a.millisecondsPerSuccess ?? a.requestPerformance?.milliseconds ?? a.economics?.requestMilliseconds ?? Infinity) - (b.millisecondsPerSuccess ?? b.requestPerformance?.milliseconds ?? b.economics?.requestMilliseconds ?? Infinity) : (b.expiryOpportunity ?? -Infinity) - (a.expiryOpportunity ?? -Infinity)) ||
      (a.millisecondsPerSuccess ?? Infinity) - (b.millisecondsPerSuccess ?? Infinity) ||
      (a.cashPerSuccess ?? Infinity) - (b.cashPerSuccess ?? Infinity) ||
      (b.successRate ?? 0) - (a.successRate ?? 0) ||
      quoteOf(a) - quoteOf(b) ||
      (b.capability ?? 0) - (a.capability ?? 0) || provenanceRank(a) - provenanceRank(b) ||
      (b.intelligence ?? 0) - (a.intelligence ?? 0) || a.routeID.localeCompare(b.routeID)
  }
}

function describe(selected: Candidate, req: RoutingRequest, pool: Candidate[], known?: { amount: number; routeID: string }) {
  const parts = [selected.successRate === null
    ? (selected.learned ? "capability " + pct(selected.capability!) + " from " + learnedText(selected.learned) + (selected.benchmarkPassAt1 === null ? "" : " and the published prior " + selected.evidenceSource)
      : selected.benchmarkPassAt1 === null ? "quality uncalibrated" : "no local outcomes; ranked on " + selected.evidenceSource)
    : "observed success " + (selected.successRate * 100).toFixed(1) + "%; " +
      (selected.cashPerSuccess === null ? "actual cash unavailable" : (req.cashCurrency ?? req.cashBudget?.currency ?? "USD") + " " + selected.cashPerSuccess.toFixed(4) + "/success") + "; " +
      (selected.millisecondsPerSuccess === null ? "speed unavailable" : Math.round(selected.millisecondsPerSuccess / 1000) + "s/success") + "; " +
      (selected.expiryOpportunity === null ? "expiry pressure unavailable" : "expiry pressure " + selected.expiryOpportunity.toFixed(2) + " task slots/hour")]
  const quote = selected.economics
  parts.push(describePrice(selected))
  const weight = costWeight(selected, pool, known)
  if (weight) parts.push(weight)
  const speed=selected.requestPerformance??(quote?.requestMilliseconds!==undefined?{milliseconds:quote.requestMilliseconds,samples:quote.samples}:undefined)
  parts.push(speed ? Math.round(speed.milliseconds) + "ms/observed request over " + speed.samples + " exact-account/effort samples; task latency uncalibrated" : "request speed unknown")
  if (selected.note) parts.push(selected.note)
  return selected.routeID + ": " + parts.join("; ")
}
export type SpeedEstimate = { milliseconds: number; attemptMilliseconds: number; success: number | null; basis: FinishBasis; said: string }
export function routeSpeed(input: Pick<PlannerInput, "routes" | "accounts" | "request">) {
  const finish = finishEstimates(input.routes, input.request.minTrials)
  const route = (c: Candidate) => input.routes.find(r => r.id === c.routeID)
  const estimate = (c: Candidate): SpeedEstimate | null => {
    const found = finish.get(c.routeID), r = route(c)
    if (!found || !r) return null
    const success = c.successRate ?? speedSuccess(r, input.request)
    return { milliseconds: success ? found.attemptMilliseconds / success : found.attemptMilliseconds, attemptMilliseconds: found.attemptMilliseconds, success, basis: found.basis, said: found.said }
  }
  const weight = (input.request.automatic?.allowanceWeight ?? 0) * 60000
  const allowance = (c: Candidate) => { const cost = route(c)?.allowanceCost; return cost ? { milliseconds: weight * cost.points, cost } : null }
  return {
    metered: (c: Candidate) => input.accounts.find(a => a.id === c.accountID)?.billing === "metered" ? 1 : 0,
    estimate, finish, allowance,
    scored: (c: Candidate) => (estimate(c)?.milliseconds ?? Infinity) + (allowance(c)?.milliseconds ?? 0),
    request: (c: Candidate) => c.requestPerformance?.milliseconds ?? c.economics?.requestMilliseconds ?? null,
  }
}
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
const ROUTINE_START = EFFORT_ORDER.indexOf("low")
const routineByEffort = (req: RoutingRequest) => req.depthBand?.depth === "routine" && !!req.automatic?.value && !req.explicitRouteID && !req.judged && !req.judging
function routineEfforts(candidates: Candidate[], routes: Route[], quality: (c: Candidate) => number | null, floor: number | undefined, minTrials: number) {
  const routeOf = (c: Candidate) => routes.find(r => r.id === c.routeID)!
  const effortOf = (c: Candidate) => routeOf(c).reasoning
  const clears = (c: Candidate) => floor === undefined || (quality(c) !== null && quality(c)! + 1e-9 >= floor)
  const models = new Map<string, Candidate[]>()
  for (const c of candidates) models.set(routeOf(c).modelID, [...(models.get(routeOf(c).modelID) ?? []), c])
  const admitted = new Set<Candidate>(), moved: string[] = [], reasons = new Map<Candidate, string>()
  for (const [model, group] of models) {
    const efforts = [...new Set(group.map(effortOf))].filter(e => EFFORT_ORDER.includes(e)).sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
    const timeline = group.map(routeOf).find(r => r.routineOutcomes)?.routineOutcomes ?? []
    const blocked: string[] = []
    let picked: string | undefined
    for (const effort of efforts) {
      if (!group.some(c => effortOf(c) === effort && clears(c))) { blocked.push(effort + " is below your " + pct(floor!) + " routine bar"); continue }
      const at = timeline.map(row => row.effort).lastIndexOf(effort), last = at >= 0 ? timeline[at] : undefined
      if (last && !last.passed) {
        const passesAbove = timeline.slice(at + 1).filter(row => row.passed && EFFORT_ORDER.indexOf(row.effort) > EFFORT_ORDER.indexOf(effort)).length
        if (passesAbove < minTrials) { blocked.push(effort + " failed its last routine run (" + passesAbove + " of " + minTrials + " passes above it since)"); continue }
      }
      if (!last?.passed && EFFORT_ORDER.indexOf(effort) < ROUTINE_START) continue
      picked = effort
      break
    }
    picked = picked ?? efforts[efforts.length - 1]
    if (blocked.length) moved.push(model + " moved up to " + picked + " after " + blocked.join(", "))
    for (const c of group) {
      const e = effortOf(c), ladder = EFFORT_ORDER.includes(e)
      if ((!ladder || e === picked) && clears(c)) admitted.add(c)
      else reasons.set(c, ladder && e !== picked ? "routine work uses " + picked + " for " + model + (blocked.length ? " after " + blocked.join(", ") : "")
        : quality(c) === null ? "value rule: quality unknown, and unknown does not clear the " + pct(floor!) + " quality bar"
        : "value rule: quality " + pct(quality(c)!) + " is below the " + pct(floor!) + " quality bar for this depth")
    }
  }
  return { admitted: candidates.filter(c => admitted.has(c)), moved, reason: (c: Candidate) => reasons.get(c) ?? "routine work" }
}
function valueRule(req: RoutingRequest, input: PlannerInput, candidates: Candidate[], excluded: RoutingDecision["excluded"], compare: (a: Candidate, b: Candidate) => number, routes: Route[]): RoutingDecision | undefined {
  const value = req.automatic?.value
  if (!value || req.explicitRouteID || req.judged || req.judging) return undefined
  const quality = (c: Candidate) => c.successRate ?? c.capability
  const billing = (c: Candidate) => input.accounts.find(a => a.id === c.accountID)?.billing
  const floor = value.bar > 0 ? value.bar : undefined
  const effort = routineByEffort(req) && (floor === undefined || candidates.some(c => quality(c) !== null && quality(c)! + 1e-9 >= floor)) ? routineEfforts(candidates, routes, quality, floor, req.minTrials) : undefined
  const rated = candidates.filter(c => quality(c) !== null)
  const best = rated.length ? Math.max(...rated.map(c => quality(c)!)) : null
  const clearing = rated.filter(c => quality(c)! + 1e-9 >= value.bar)
  const pool = effort ? effort.admitted : clearing.length ? clearing : best === null ? [] : rated.filter(c => quality(c)! >= best - value.tie)
  for (const c of candidates) if (!pool.includes(c)) {
    const q = quality(c)
    excluded.push({ routeID: c.routeID, reasons: [effort ? effort.reason(c) : q === null ? "value rule: quality unknown, and unknown does not clear the " + pct(value.bar) + " quality bar"
      : clearing.length ? "value rule: quality " + pct(q) + " is below the " + pct(value.bar) + " quality bar for this depth"
      : "value rule: no admitted route clears the " + pct(value.bar) + " quality bar for this depth; this route is below the strongest offered (" + pct(best!) + ")"] })
  }
  if (!pool.length) return { selected: null, ranked: [], admitted: [...candidates].sort(compare), excluded, summary: NO_ROUTE }
  const speed = routeSpeed(input)
  const routeOf = (c: Candidate) => routes.find(r => r.id === c.routeID)
  const planOf = (c: Candidate) => routeOf(c)?.allowanceCost
  const scarceOf = (c: Candidate) => {
    const windows = planOf(c)?.windows
    if (!windows?.length || windows.some(w => w.leftPercent === null)) return null
    return Math.max(...windows.map(w => w.leftPercent! > 0 ? w.scarcePoints / w.leftPercent! : Infinity))
  }
  const costRaw = (c: Candidate) => billing(c) === "free" || c.allowance?.expiresUnused ? 0 : scarceOf(c) ?? (c.allowance && c.allowance.share !== null ? c.allowance.share : c.economics?.amount ?? Infinity)
  const tokensPerTask = 1000
  const NO_SPEED_DATA = { tokensPerSecond: 91.5, firstTokenSeconds: 2.4 }
  const aaMilliseconds = (c: Candidate) => {
    const r = routeOf(c), tps = r?.speed?.tokensPerSecond ?? r?.analysis?.outputTokensPerSecond
    if (!tps || !(tps > 0)) return null
    return tokensPerTask / tps * 1000 + (r?.speed?.firstTokenMilliseconds ?? (r?.analysis?.firstTokenSeconds ?? 0) * 1000)
  }
  const tpsOf = (c: Candidate) => { const r = routeOf(c), tps = r?.speed?.tokensPerSecond ?? r?.analysis?.outputTokensPerSecond; return tps && tps > 0 ? tps : null }
  const taskMs = (c: Candidate) => speed.estimate(c)?.milliseconds ?? null
  const median = (values: (number | null)[]) => { const sorted = values.filter((v): v is number => v !== null && Number.isFinite(v) && v > 0).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null }
  const referenceTaskMs = median(pool.map(taskMs))
  const referenceTps = median(pool.filter(c => taskMs(c) !== null).map(tpsOf))
  const borrowedMs = (c: Candidate) => referenceTaskMs === null ? null : referenceTps !== null && tpsOf(c) !== null ? referenceTaskMs * referenceTps / tpsOf(c)! : referenceTaskMs
  const neutralMs = tokensPerTask / NO_SPEED_DATA.tokensPerSecond * 1000 + NO_SPEED_DATA.firstTokenSeconds * 1000
  const finishMs = (c: Candidate) => taskMs(c) ?? borrowedMs(c) ?? aaMilliseconds(c) ?? neutralMs
  const timeRaw = (c: Candidate) => finishMs(c) + (speed.allowance(c)?.milliseconds ?? 0)
  const timeBasis = (c: Candidate) => taskMs(c) !== null ? "finish estimate" : borrowedMs(c) !== null ? "pool's finish estimates, scaled by AA speed" : aaMilliseconds(c) !== null ? "one AA call, as no route in the pool has a finish estimate" : "no speed data, so the Artificial Analysis median"
  const fastest = Math.min(...pool.map(timeRaw).filter(Number.isFinite))
  const timeTerm = (ms: number) => !Number.isFinite(ms) ? 1 : Math.min(1, Math.max(0, Math.log(ms / fastest) / Math.log(4)))
  const payable = pool.map(costRaw).filter(raw => Number.isFinite(raw) && raw > 0)
  const spareAllowance = pool.some(c => costRaw(c) <= 0 && billing(c) !== "free")
  const anchor = payable.length ? Math.min(...payable) / (spareAllowance ? 4 : 1) : 0
  const costTerm = (raw: number) => !Number.isFinite(raw) ? 1 : raw <= 0 || anchor <= 0 ? 0 : Math.min(1, Math.log(raw / anchor) / Math.log(4))
  const bestQuality = Math.max(...pool.map(c => quality(c)!))
  const span = Math.max(bestQuality - value.bar, value.tie, 1e-9)
  const scoreTerm = (c: Candidate) => effort ? 0 : Math.min(1, Math.max(0, bestQuality - quality(c)! - value.tie) / span)
  const scored = pool.map(c => {
    const cost = costTerm(costRaw(c)), time = timeTerm(timeRaw(c)), score = scoreTerm(c)
    const penalty = value.weights.cost * cost + value.weights.time * time + value.weights.score * score
    const raw = costRaw(c), ms = timeRaw(c)
    c.valueTerms = { bar: value.bar, quality: quality(c) ?? 0, costRaw: Number.isFinite(raw) ? raw : null, timeMilliseconds: ms !== null && Number.isFinite(ms) ? ms : null, timeBasis: timeBasis(c), cost, time, score, penalty,
      listUSD: planOf(c)?.listUSD ?? c.economics?.amount ?? null, multiplier: planOf(c)?.multiplier ?? null, effectiveUSD: planOf(c)?.effectiveUSD ?? null }
    return { c, penalty }
  }).sort((a, b) => a.penalty - b.penalty || a.c.routeID.localeCompare(b.c.routeID))
  const selected = scored[0].c, next = scored[1]?.c
  const planText = (c: Candidate) => { const a = planOf(c); return a && a.listUSD != null && a.multiplier != null && a.effectiveUSD != null ? "list $" + a.listUSD.toFixed(6) + " a task ÷ " + (a.multiplier < 10 ? a.multiplier.toFixed(1) : Math.round(a.multiplier)) + "× on " + a.plan?.planID + " = $" + a.effectiveUSD.toFixed(6) + " of plan a task, " : "" }
  const costWords = (c: Candidate) => billing(c) === "free" ? "free" : c.allowance?.expiresUnused ? "spare allowance, expires unused" : c.allowance && c.allowance.share !== null ? planText(c) + shareText(c.allowance.share) + " of what is left per task" : c.economics ? c.economics.currency + " " + c.economics.amount.toFixed(6) + " per comparison task (no plan multiplier, so list price)" : "no comparable cost"
  const timeWords = (c: Candidate) => timeRaw(c) !== null && Number.isFinite(timeRaw(c)!) ? "about " + clockText(timeRaw(c)!) + " (" + timeBasis(c) + ")" : "time unknown"
  const t = selected.valueTerms!
  const head = effort ? selected.routeID + ": value rule for routine work, lowest combined penalty among each model's effort"
    : selected.routeID + ": value rule, lowest combined penalty among routes that clear the " + pct(value.bar) + " quality bar" + (clearing.length ? "" : " (none clears it, so the strongest offered is used)")
  const qualityText = effort ? "" : ", quality " + pct(t.quality) + " (term " + t.score.toFixed(2) + ")"
  const summary = head + "; cost " + costWords(selected) + " (term " + t.cost.toFixed(2) + "), time " + timeWords(selected) + " (term " + t.time.toFixed(2) + ")" + qualityText + "; penalty " + t.penalty.toFixed(3) +
    " with weights cost " + value.weights.cost + ", time " + value.weights.time + ", quality " + value.weights.score +
    (next ? "; next " + next.routeID + " penalty " + next.valueTerms!.penalty.toFixed(3) : "") + (effort && effort.moved.length ? "; " + effort.moved.join("; ") : "")
  return { selected, ranked: [...scored.map(x => x.c), ...candidates.filter(c => !pool.includes(c))], admitted: [...candidates].sort(compare), excluded, summary: withBand(summary, selected, req, routes) }
}
function describeFastest(selected: Candidate, ranked: Candidate[], within: number, strongest: number | null, speed: ReturnType<typeof routeSpeed>, req: RoutingRequest, verified?: Map<string, VerifiedFinish>) {
  const seconds = (ms: number) => ms >= 90000 ? Math.round(ms / 60000) + " min" : Math.round(ms / 1000) + "s"
  const estimate = speed.estimate(selected), request = speed.request(selected), strength = selected.successRate ?? selected.capability
  const runnerUp = ranked[1], rated = req.automatic?.ratings?.[selected.routeID]
  const said = (e: SpeedEstimate) => "about " + seconds(e.milliseconds) + " per finished task (" + e.basis + ": " + e.said + (e.success ? "; " + pct(e.success) + " finish without being sent back" : "; success rate unknown") + ")"
  const currency = req.cashCurrency ?? "USD", finish = verified?.get(selected.routeID)
  const pace = finish ? finishText(finish, currency) + " (one attempt " + (estimate ? estimate.basis + ": " + estimate.said : "time unknown") + "); " + reworkText(selected.routeID, finish, currency)
    : estimate ? said(estimate) : request !== null ? "time to finish unknown; " + Math.round(request) + "ms per observed request" : "no measured or published time to finish, and no route in the band had one"
  const plan = (c: Candidate) => { const a = speed.allowance(c); return a ? "; plan cost " + a.cost.said + (a.milliseconds ? ", counted as " + seconds(a.milliseconds) + " at your setting" : "") : "" }
  const next = (c: Candidate) => verified ? " at " + finishText(verified.get(c.routeID)!, currency) + (speed.allowance(c)?.milliseconds ? " plus " + seconds(speed.allowance(c)!.milliseconds) + " for plan cost" : "")
    : speed.estimate(c) ? " at about " + seconds(speed.estimate(c)!.milliseconds) + " (" + speed.estimate(c)!.basis + ")" + (speed.allowance(c)?.milliseconds ? " plus " + seconds(speed.allowance(c)!.milliseconds) + " for plan cost" : "") : ""
  return selected.routeID + ": speed setting, the " + (verified ? "fastest expected verified finish among routes" : "fastest route") + " within " + Math.round(within * 100) + " points of the best capability that is its own published score or measured over enough runs" + (strongest === null ? "" : " (" + pct(strongest) + ")") +
    "; " + pace + plan(selected) + (strength === null ? "" : "; capability " + pct(strength) + (selected.successRate === null ? capabilityBasis(selected, req) : "")) + (rated ? "; in the band because " + rated.basis : "") +
    (runnerUp ? "; next " + runnerUp.routeID + next(runnerUp) : "") +
    (speed.metered(selected) ? "; metered, because no already-paid route was in the band" : "") + "; not judged"
}
function describePrice(selected: Candidate) {
  const quote = selected.economics
  return quote ? quote.currency + " " + quote.amount.toFixed(6) + "/" + (quote.workload ?? "comparison workload") + " (" + quote.basis + ", " + quote.source + "); estimate, not an actual charge" : "comparable price unavailable; unknown is not free"
}
function describeJudged(selected: Candidate, judged: NonNullable<RoutingRequest["judged"]>, pool: Candidate[], bounded?: { passed: Candidate; mass: number }, known?: { amount: number; routeID: string }) {
  const group = Object.entries(judged.groups ?? {}).find(([, g]) => g.routeIDs.includes(selected.routeID))
  const share = group ? group[0] + " " + Math.round(group[1].share * 100) + "% of the judgment; this route " : ""
  const weight = costWeight(selected, pool, known)
  const quote = selected.economics ? " (" + selected.economics.currency + " " + selected.economics.amount.toFixed(6) + " per " + (selected.economics.workload ?? "comparison workload") + ")" : ""
  const passed = bounded ? costWeight(bounded.passed, pool, known) : ""
  return selected.routeID + ": judged " + share + Math.round((selected.probability ?? 0) * 100) + "% by " + judged.model + (judged.reason ? " — " + judged.reason : "") +
    (weight ? "; " + weight + quote : "") +
    (bounded ? "; cost-bounded: " + Math.round(bounded.mass * 100) + "% of the judgment sat at or below this price, so its top pick " + bounded.passed.routeID + (passed ? " at " + passed : "") + " was not taken" : "")
}
