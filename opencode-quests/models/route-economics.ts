import { countsForRoute, valueRequest, recentRequests, requestTiming, readWorkflowOutcomes, requestMetrics, TELEMETRY_FILE, type Tokens, type Price } from "../usage/telemetry-api"
import type { Route } from "./route-planner"
import type { LiveCatalog } from "./live-routes"
import { proxyOwners } from "../usage-service/on-computer"
import { slugModel } from "./model-catalog"

export type EconomyPolicy = {
  useCatalogPrices?: boolean
  comparisonTokens: Tokens
  maxPriceAgeDays: number
  minSpeedSamples: number
  minTaskSamples?: number
  accountPrices?: Record<string, Price>
  accountAllowances?: Record<string, { date: string; source: string; windows: Record<string, number> }>
}
export const accountPriceKey = (r: Route) => [r.accountID, r.providerID, r.modelID, r.serviceTier].join("|")
const exactRequestKey = (r: Route) => [accountPriceKey(r), r.reasoning].join("|")

export const PROXY_PROVIDER = "cliproxyapi"

export function catalogPriceRow(catalog: LiveCatalog, route: Pick<Route, "providerID" | "modelID">, owners: Record<string, string>) {
  const own = catalog.models.find(m => m.providerID === route.providerID && m.modelID === route.modelID)
  if (own?.cost || route.providerID !== PROXY_PROVIDER) return own ? { model: own } : undefined
  const vendor = owners[route.modelID]
  const owned = vendor ? catalog.models.find(m => m.providerID === vendor && slugModel(m.modelID) === slugModel(route.modelID) && m.cost) : undefined
  return owned ? { model: owned, vendor } : own ? { model: own } : undefined
}

export function withRouteEconomics(routes: Route[], catalog: LiveCatalog, policy: EconomyPolicy | undefined, now: number, task?: string, owners: Record<string, string> = proxyOwners()): Route[] {
  if (!policy) return routes
  if (!Number.isFinite(policy.maxPriceAgeDays) || policy.maxPriceAgeDays <= 0 || !Number.isInteger(policy.minSpeedSamples) || policy.minSpeedSamples < 1 ||
      !policy.comparisonTokens || ["input", "cacheRead", "cacheWrite", "output", "reasoning"].some(k => typeof policy.comparisonTokens[k as keyof Tokens] !== "number" || !Number.isFinite(policy.comparisonTokens[k as keyof Tokens]) || policy.comparisonTokens[k as keyof Tokens]! < 0)) throw Error("Invalid economical routing comparison policy")
  const fresh = (at: string | undefined) => !!at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= now && now - Date.parse(at) <= policy.maxPriceAgeDays * 86400000
  if (policy.minTaskSamples !== undefined && (!Number.isInteger(policy.minTaskSamples) || policy.minTaskSamples < 1)) throw Error("Invalid task profile sample requirement")
  const minimum=policy.minTaskSamples ?? policy.minSpeedSamples
  const taskRuns=(()=>{try{return readWorkflowOutcomes(process.env.OPENCODE_WORKFLOW_OUTCOMES_FILE ?? TELEMETRY_FILE+".workflows.json").runs.filter(r=>task && r.taskTags.includes(task) && r.observation && r.observation.state!=="running" && r.observation.routeConsistent!==false && r.observation.endedBy!=="host" && r.startedAt<=now && now-r.startedAt<=policy.maxPriceAgeDays*86400000 && Object.values(r.observation.tokens).every(v=>typeof v==="number"&&Number.isFinite(v)&&v>=0))}catch{return []}})()
  const profile=(rows:typeof taskRuns):Tokens|undefined=>rows.length<minimum?undefined:Object.fromEntries(["input","cacheRead","cacheWrite","output","reasoning"].map(k=>[k,rows.reduce((n,r)=>n+r.observation!.tokens[k as keyof Tokens]!,0)/rows.length])) as Tokens
  const pooled=profile(taskRuns)
  const speeds = new Map<string, number[]>()
  const requests=(()=>{try{return recentRequests()}catch{return []}})()
  try {
    for (const r of requests) {
      if (!r.accountID || !r.route.reasoning || !r.route.serviceTier || r.state !== "completed" || r.startedAt > now || now - r.startedAt > policy.maxPriceAgeDays * 86400000) continue
      const ms = requestTiming(r).elapsedMilliseconds
      if (ms === null || ms <= 0) continue
      const key = [r.accountID,r.route.providerID,r.route.modelID,r.route.serviceTier,r.route.reasoning].join("|")
      const rows = speeds.get(key) ?? []; rows.push(ms); speeds.set(key, rows)
    }
  } catch {}
  return routes.map(route => {
    const samples = speeds.get(exactRequestKey(route)) ?? []
    const requestMilliseconds = samples.length >= policy.minSpeedSamples ? [...samples].sort((a,b) => a-b)[Math.floor(samples.length / 2)] : undefined
    if(requestMilliseconds!==undefined)route={...route,requestPerformance:{milliseconds:requestMilliseconds,samples:samples.length}}
    const personal = policy.accountPrices?.[accountPriceKey(route)]
    const row = catalogPriceRow(catalog, route, owners)
    const cost = row?.model.cost
    const vendorRow = row?.vendor ? row.vendor + "/" + row.model.modelID : undefined
    const price: Price | undefined = personal ?? (policy.useCatalogPrices && cost && fresh(catalog.at) ? {
      version: "models.dev:" + catalog.at + (vendorRow ? ":" + vendorRow : ""), provider: route.providerID, model: route.modelID, date: catalog.at!, currency: "USD",
      perMillion: {input:cost.input, cacheRead:cost.cache_read, cacheWrite:cost.cache_write, output:cost.output, reasoning:cost.output},
    } : undefined)
    const observed=taskRuns.filter(r=>r.route.accountID===route.accountID&&r.route.providerID===route.providerID&&r.route.modelID===route.modelID&&r.route.reasoning===route.reasoning&&r.route.harness===route.harness&&r.route.serviceTier===route.serviceTier)
    const judged=observed.filter(r=>r.judgment!==null&&r.judgment.judgedAt<=now&&countsForRoute(r))
    if (judged.length>=minimum && task && ["coding","utility","planning","review"].includes(task)) {
      const durations=judged.map(r=>(r.observation!.completedAt??r.observation!.observedAt)-r.startedAt).sort((a,b)=>a-b)
      const accepted=judged.filter(r=>r.judgment!.accepted).length
      const cash=judged.map(r=>requestMetrics(requests.filter(p=>p.sessionID===r.sessionID&&p.startedAt>=r.startedAt-1000&&p.startedAt<=(r.observation!.completedAt??r.observation!.observedAt))).cost.find(c=>c.currency===(price?.currency??"USD"))?.actualCharge??null)
      if (durations.every(ms=>ms>0)) route={...route,evidence:[...route.evidence,{task:task as "coding"|"utility"|"planning"|"review",source:"verified task outcomes",measuredAt:new Date(Math.max(...judged.map(r=>r.judgment!.judgedAt))).toISOString(),trials:judged.length,passed:accepted,totalMilliseconds:durations.reduce((n,v)=>n+v,0),totalCash:cash.every(v=>v!==null)?cash.reduce<number>((n,v)=>n+v!,0):null,currency:price?.currency??"USD",p95Milliseconds:durations[Math.ceil(durations.length*.95)-1]}]}
    }
    if (!price || !fresh(price.date) || price.provider !== route.providerID || price.model !== route.modelID) return route
    const own=profile(observed),tokens=own??pooled??policy.comparisonTokens
    const workload=own?"observed "+task+" task profile ("+observed.length+" tasks)":pooled?"pooled "+task+" task profile ("+taskRuns.length+" tasks)":"configured comparison workload"
    const value = valueRequest({id:"comparison",sessionID:"comparison",kind:"price-comparison",route,startedAt:now,state:"completed",tokens,price})
    if (!value.complete || value.value === null || value.currency === null) return route
    return {...route,economics:{amount:value.value,currency:value.currency,basis:personal ? "account-price" as const : "catalog-equivalent" as const,source:personal ? "user account pricing" : vendorRow ? "https://models.dev/api.json, the owning vendor's row " + vendorRow + " for this proxied model" : "https://models.dev/api.json",observedAt:price.date,requestMilliseconds,samples:samples.length,workload,...(own?{taskProfile:"observed" as const}:pooled?{taskProfile:"pooled" as const}:{})}}
  })
}
