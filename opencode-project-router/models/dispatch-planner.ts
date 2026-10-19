import { accountPriceKey, withRouteEconomics, type EconomyPolicy } from "./route-economics"
import {measuredOutcomeRoutes,type MeasuredOutcomes} from "./measured-outcomes"
import {join,dirname,isAbsolute} from "node:path"
import { calibratedRoutes,type DispatchForecasts } from "./calibrated-dispatch"
import { readCalibrations,accountRegime,updateBurnControls,readQuotaObservations } from "../usage/telemetry-api"
import { assertChatModel, assertConfiguredModel, assertConfiguredSelection } from "./access-policy"
import { accountsForRoute, relevantAccountWindows, getAccountUsage, ACCOUNT_USAGE_FILE, refreshProxyOwners } from "../usage-service/on-computer"
import { liveDispatchRoutes } from "./live-routes"
import { TASK_CLASSES, applyTaskDemand, classifyDispatch, describeDemand, depthBand, migrateSizeBands, validateDepthBands, validateTaskDemands, type DispatchFacts, type DepthBands, type TaskDemands } from "./task-demand"
import { STATED_PROFILE, type Depth } from "./work-profile"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import type { AccountSnapshot } from "../usage-service/on-computer"
import { RouteReservations } from "./route-reservations"
import { gateDispatchRoutes } from "./dispatch-gate"
import { aheadOfClock, applicableQuotaWindows, finishText, judgedRuns, learnedText, planRoutes, groupedRefusal, rankedByVerifiedFinish, reworkText, routeSpeed, strongFirst, unbenched, verifiedFinishes, type Candidate, type PlannerInput, type Route, type RoutingRequest, type VerifiedFinish } from "./route-planner"
import { measuredModels, recentRequests } from "./observed-route-health"
import { canonicalModelID } from "./model-catalog"
import { readPlanCapacity, routeCapacity } from "../usage/plan-capacity-store"
import { TELEMETRY_FILE } from "../usage/telemetry-store"
import { ROUTE_HEALTH, blockedRoutes, probingRoutes, readRouteLimits, routeLimitsFile } from "../usage/route-limits"
import { learnedRoutes, workKind } from "./route-outcomes"
import { UnregisteredPolicyRouteError, automaticPoolProblem, configuredDispatchPolicyFile, primaryRouteSource, readDispatchPolicy } from "./dispatch-policy"
import { ASSUMED_DEPTH, automaticRouting, benchmarkOfWorkType, depthSettings, describeSpeed, exclusionOf, servedMatches, servedOf, type RoutingSettings } from "./routing-settings"
import { measuredRouteSpeeds, speedFor, speedKey } from "../usage/route-speeds"
import { publishedTasks, readPublishedSpeed } from "./published-speed"
import { allowanceCostOf } from "./allowance-cost"
import { priorWord, readAnalysisSafely, withAnalysis } from "./artificial-analysis"
import { modelRetirement } from "./benchmark-table"
import { timed } from "../scripts/plugin-spans"
import { configuredModelsFile, keylessAccountID, keylessAccounts } from "./live-routes"
import { profileFromAnswers, type ProfileAsk, type ProfileInference } from "../quest/routing/work-profile"
import { BRIEF_CHARACTERS, OPTION_CHARACTERS, QUESTION_CHARACTERS, clip, traceEstimates, type DecisionTrace, type TraceJudge } from "./decision-trace"
export { configuredDispatchPolicyFile }
export function dispatchReservationFile(runtimeRoot:string){const pin=process.env.OPENCODE_ROUTE_RESERVATIONS;if(pin&&!isAbsolute(pin))throw new Error('OPENCODE_ROUTE_RESERVATIONS must be absolute');return pin??join(runtimeRoot,'route-reservations.json')}
export type DispatchPolicy = { version:1; economy?:EconomyPolicy; outcomesFile?:string; calibration?:DispatchForecasts; request:Omit<RoutingRequest,"now"|"explicitRouteID">&{byTask?:TaskDemands;byDepth?:DepthBands;bySize?:Record<string,unknown>;judgedPool?:"allowlist"|"connected"}; routes:Route[]; billing:Record<string,PlannerInput["accounts"][number]["billing"]>; bootstrapByProject:Record<string,string[]>; commandsByProject?:Record<string,Record<string,import("../quest/command-runtime").CommandSpec>> }
export type Withheld=(route:{providerID:string;modelID:string})=>string|undefined
export type SelectorResult={code:string;route?:Route;candidates:{selector:string;model:string;accountID:string;serviceTier:string}[]}
export function resolveDispatchSelector(policy: DispatchPolicy, selector: string, snapshot?: AccountSnapshot, excludedRouteIDs: ReadonlySet<string> = new Set()): SelectorResult {
 const permitted=(route:Route)=>{try{assertChatModel(route);assertConfiguredSelection(route);return true}catch{return false}}
 const allowed=policy.routes.filter(r=>permitted(r)&&policy.request.allowedRouteIDs?.includes(r.id)&&!excludedRouteIDs.has(r.id))
 const candidates=allowed.map(r=>({selector:'route:'+r.id,model:`${r.providerID}/${r.modelID}#${r.reasoning}`,accountID:r.accountID,serviceTier:r.serviceTier}))
 if(selector.startsWith('route:')){const route=policy.routes.find(r=>r.id===selector.slice(6));return route&&!permitted(route)?{code:'MODEL_SELECTION_PROHIBITED',candidates}:route?{code:'ROUTE_CONFIGURED',route,candidates}:{code:'AUTHORIZED_ROUTE_UNAVAILABLE',candidates}}
 const [identity,reasoning,...extra]=selector.split('#')
 if(extra.length)return {code:'INVALID_ROUTE_SELECTOR',candidates}
 const models=policy.routes.filter(r=>`${r.providerID}/${r.modelID}`===identity)
 if(models.length&&!reasoning)return {code:'REASONING_REQUIRED',candidates:candidates.filter(c=>c.model.startsWith(identity+'#'))}
 const matches=models.filter(r=>r.reasoning===reasoning)
 if(matches.length>1)return {code:'AMBIGUOUS_ACCOUNT_SERVICE_ROUTE',candidates}
 if(matches.length===1)return permitted(matches[0])?{code:'ROUTE_CONFIGURED',route:matches[0],candidates}:{code:'MODEL_SELECTION_PROHIBITED',candidates}
 const slash=identity.indexOf('/'),providerID=identity.slice(0,slash),modelID=identity.slice(slash+1)
 if(slash<1||!modelID)return {code:'INVALID_ROUTE_SELECTOR',candidates}
 try{assertChatModel({providerID,id:modelID})}catch{return {code:'MODEL_SELECTION_PROHIBITED',candidates}}
 if(!snapshot)return {code:'AUTHORIZED_ROUTE_UNAVAILABLE',candidates}
 try{assertConfiguredModel({providerID,id:modelID})}catch{return {code:'AUTHORIZED_ROUTE_UNAVAILABLE',candidates}}
 const linked=accountsForRoute(snapshot,providerID,modelID)
 if(linked.length!==1)return {code:linked.length?'AMBIGUOUS_ACCOUNT_SERVICE_ROUTE':'AUTHORIZED_ROUTE_UNAVAILABLE',candidates}
 if(!reasoning)return {code:'REASONING_REQUIRED',candidates}
 try{assertConfiguredSelection({providerID,id:modelID,reasoning})}catch{return {code:'MODEL_SELECTION_PROHIBITED',candidates}}
 return {code:'ROUTE_CONFIGURED',candidates,route:{id:'chosen-'+providerID+'-'+modelID+'-'+reasoning,accountID:linked[0].id,providerID,modelID,harness:'native',agent:'worker',reasoning,serviceTier:'default',verified:true,admission:'configured-choice',evidence:[],quotaPerTask:{}}}
}
const UNMEASURED_TRIAL = "Unmeasured: its trial budget is " + ROUTE_HEALTH.trialRequests + " requests on routine steps only, until it has " + ROUTE_HEALTH.trialRequests + " recorded requests"
export function measuredRouteAvailable(routes:{id:string;providerID:string;modelID:string;accountID:string}[],accounts:{id:string;state?:string}[],measured:(model:string)=>boolean,blocked:ReadonlySet<string>,excluded:(route:{id:string})=>string|undefined,pool:ReadonlySet<string>){
 const available=new Set(accounts.filter(account=>account.state!=="exhausted"&&account.state!=="auth-required").map(account=>account.id))
 return routes.some(route=>{
  const model=route.providerID+"/"+route.modelID
  return pool.has(route.id)&&!blocked.has(model)&&!excluded(route)&&(available.has(route.accountID)||route.accountID.startsWith("keyless:"))&&measured(model)
 })
}
export function unusableRoutes(maxAgeMs = 6 * 60 * 60 * 1000, now = Date.now(), telemetryFile = TELEMETRY_FILE, limitsFile = telemetryFile === TELEMETRY_FILE ? routeLimitsFile() : telemetryFile + ".route-limits.json") {
  const byModel = new Map<string, string>()
  let measured: Set<string> | undefined
  let blocked = new Map<string, string>()
  try {
    const records = recentRequests(telemetryFile, { sinceMs: now - maxAgeMs }), limits = readRouteLimits(limitsFile).routes
    measured = measuredModels(records, now, maxAgeMs, limits)
  } catch {}
  try { blocked = blockedRoutes(now, limitsFile) } catch {}
  for (const [model, reason] of blocked) byModel.set(model, reason)
  try { for (const [model, reason] of probingRoutes(now, limitsFile)) if (!byModel.has(model)) byModel.set(model, reason) } catch {}
  const known = measured
  return { byModel, failing: new Set(blocked.keys()), measured: (model: string) => known?.has(model) ?? true }
}

export function unconsideredRoutes(routes:{id:string;outcomeIssue?:{reason:string}}[],pool:string[],settingsExclusion:(route:{id:string})=>string|undefined){
 const inPool=new Set(pool)
 return routes.flatMap(route=>{
  if(inPool.has(route.id))return []
  const setting=settingsExclusion(route)
  const reasons=[...(setting?["automatic routing excludes "+setting]:[]),...(route.outcomeIssue?[route.outcomeIssue.reason]:[])]
  return [{routeID:route.id,reasons:reasons.length?reasons:["route is not in the allowed pool for this task (policy allowlist or live catalog)"]}]
 })
}

export async function dispatchPlanInput(input:{model?:string;policyFile:string;now?:number;routing?:RoutingSettings;brief?:string;withheld?:Withheld}&DispatchFacts,loadUsage:typeof getAccountUsage=getAccountUsage) {
 let policy:DispatchPolicy
 try{policy=readDispatchPolicy(input.policyFile)}catch(error){if(error instanceof UnregisteredPolicyRouteError)throw error;throw new Error("Configure the dispatch policy with authorized routes, quality evidence, budgets and project bootstrap before running a Quest")}
 if(policy.version!==1||!Array.isArray(policy.routes)||!policy.request?.allowedRouteIDs?.length)throw new Error("Invalid dispatch policy: version 1 and an explicit route allowlist are required")
 validateTaskDemands(policy.request.byTask)
 const bands=validateDepthBands(policy.request.byDepth??migrateSizeBands(policy.request.bySize))
 await refreshProxyOwners(configuredModelsFile()).catch(()=>undefined)
 const snapshot=await loadUsage({refresh:true}),now=input.now??Date.now()
 const live=await liveDispatchRoutes(policy,snapshot,now)
 policy.routes=[...live.curated,...live.derived]
 const classification=classifyDispatch(input)
 const excluded=(route:Route)=>input.routing?exclusionOf(input.routing,classification.depth,route,classification.workType):undefined
 const registered=new Set(policy.routes.filter(route=>!excluded(route)).map(route=>route.id)),allowed=[...new Set(policy.request.allowedRouteIDs??[])].filter(id=>registered.has(id)),primaryRouteID=allowed.includes(policy.request.primaryRouteID??"")?policy.request.primaryRouteID:undefined
 const connected=policy.request.judgedPool==="connected",pool=connected?[...new Set([...allowed,...registered])]:allowed
 const poolProblem=automaticPoolProblem(policy,route=>excluded(route as Route))
 const {primaryRouteID:_primaryRouteID,primarySource:_primarySource,fallback:_fallback,...demand}=applyTaskDemand(policy.request,policy.request.byTask,classification.task)
 policy.request={...demand,allowedRouteIDs:pool,depthBand:depthBand(classification,bands),...(primaryRouteID?{primaryRouteID,primarySource:primaryRouteSource(input.policyFile)}:{})}
 const alternatives=allowed.filter(id=>id!==policy.request.primaryRouteID)
 if(!connected&&policy.request.primaryRouteID&&alternatives.length)policy.request={...policy.request,fallback:{when:"admission-unavailable",routeIDs:alternatives}}
 let explicitRouteID:string|undefined
 if(input.model){
  const result=resolveDispatchSelector({...policy,request:{...policy.request,allowedRouteIDs:allowed}},input.model,snapshot)
  if(!result.route)throw new Error(result.code+': explicit model must resolve to one account/reasoning/service route the access policy permits on a single connected account; use project_route_status candidates, no replacement selected')
  explicitRouteID=result.route.id
  if(!policy.routes.some(r=>r.id===explicitRouteID))policy.routes=[...policy.routes,result.route]
  if(!(policy.request.allowedRouteIDs??[]).includes(explicitRouteID))policy.request={...policy.request,allowedRouteIDs:[...(policy.request.allowedRouteIDs??[]),explicitRouteID]}
 }
 const unusable=unusableRoutes()
 const anyMeasured=measuredRouteAvailable(policy.routes,snapshot.accounts,unusable.measured,new Set(unusable.byModel.keys()),excluded,new Set(pool))
 const gate=(model:string)=>(classification.depth??ASSUMED_DEPTH)==="routine"||!anyMeasured||unusable.measured(model)?undefined:UNMEASURED_TRIAL
 policy.routes=policy.routes.map(route=>{const model=route.providerID+"/"+route.modelID,probed=unusable.byModel.get(model),retiredAt=modelRetirement(live.table,route.modelID,now),reason=retiredAt?"Model retired on "+retiredAt:probed??input.withheld?.(route)??gate(model);return reason?{...route,verified:false,...(!retiredAt&&unusable.failing.has(model)?{failing:probed}:{}),outcomeIssue:{task:policy.request.task,reason}}:route})
 policy.routes=policy.routes.map(route=>{try{assertConfiguredSelection(route)}catch(error){return {...route,verified:false,outcomeIssue:{task:policy.request.task,reason:String(error)}}};const linked=accountsForRoute(snapshot,route.providerID,route.modelID),keyless=!linked.length&&route.accountID===keylessAccountID(route.providerID)&&!!policy.billing[route.accountID];return keyless||linked.length===1&&linked[0].id===route.accountID?route:{...route,verified:false}})
 const pacing=updateBurnControls(snapshot.accounts,readQuotaObservations(ACCOUNT_USAGE_FILE+".observations").observations,input.now)
 const accounts:PlannerInput["accounts"]=[...snapshot.accounts.filter(a=>policy.routes.some(r=>r.accountID===a.id)).map(a=>({id:a.id,pacing:pacing.find(p=>p.accountID===a.id),billing:policy.billing[a.id],authenticated:a.state!=="auth-required"&&a.connections.length>0,observedAt:a.observedAt??"",capacity:a.state==="available"?"available":a.state==="exhausted"?"exhausted":"unknown",windows:a.windows.filter(w=>(w.scope==="shared"||w.scope==="model")&&!(w.state==="available"&&(w.remainingPercent==null||!w.resetAt))).map(w=>({id:w.id,state:w.state,...(w.scope==="model"?{routeIDs:policy.routes.filter(r=>r.accountID===a.id&&relevantAccountWindows(a,r.modelID).includes(w)).map(r=>r.id)}:{}),remaining:w.state==="unknown"?NaN:w.state==="exhausted"?0:w.remainingPercent??NaN,reserved:0,resetAt:w.resetAt??"",periodSeconds:w.durationSeconds??undefined}))})),...keylessAccounts(policy.routes,policy.billing,snapshot.accounts,now)]
 const unbilled=accounts.filter(a=>!a.billing).map(a=>a.id)
 if(unbilled.length)throw new Error("Dispatch policy must identify billing for connected accounts: "+unbilled.join(", "))
 const observedRoutes=policy.outcomesFile?measuredOutcomeRoutes(policy.routes,JSON.parse(readFileSync(isAbsolute(policy.outcomesFile)?policy.outcomesFile:join(dirname(input.policyFile),policy.outcomesFile),"utf8")) as MeasuredOutcomes).routes:policy.routes
 const priced=withRouteEconomics(calibratedRoutes(observedRoutes,readCalibrations().calibrations,Object.fromEntries(snapshot.accounts.map(a=>[a.id,accountRegime(a)])),policy.calibration,now),live.catalog,policy.economy,now,classification.task)
 const learned=learnedRoutes(withAllowance(priced,accounts,now,policy.economy),workKind(classification.workType),now,policy.request.maxEvidenceAgeDays,classification.depth??ASSUMED_DEPTH)
 const timed=await withSpeedEvidence(learned.routes,live.table,now,policy.request.maxEvidenceAgeDays)
 const routes=withAnalysis(timed.routes,readAnalysisSafely(),policy.billing,now,policy.economy?.comparisonTokens,benchmarkOfWorkType(input.routing,classification.workType))
 const request={...policy.request,now:new Date(input.now??Date.now()).toISOString(),explicitRouteID}
 const diagnostics=[...(poolProblem?["THE DISPATCH POLICY "+input.policyFile+" LEAVES AUTOMATIC ROUTING NO ROUTE: "+poolProblem]:[]),...snapshot.diagnostics,...live.diagnostics,describeDemand(classification,request),"Comparable prices for "+routes.filter(r=>r.economics).length+" routes; estimates are not actual account charges",learned.diagnostic,timed.diagnostic]
 const dropped=unconsideredRoutes(policy.routes,pool,route=>excluded(route as Route))
 return {policy,request,routes,accounts,snapshot,live,classification,diagnostics,explicitRouteID,dropped}
}

export async function withSpeedEvidence(routes:Route[],table:import("./benchmark-table").BenchmarkTable,now:number,maxAgeDays:number){
 let speeds:Awaited<ReturnType<typeof measuredRouteSpeeds>>["speeds"]=new Map(),problem=""
 let pooledChannels=0
 try{const read=await measuredRouteSpeeds({now,maxAgeDays});speeds=read.speeds;pooledChannels=read.pooledChannels}catch(error){problem="measured speeds unreadable ("+(error instanceof Error?error.message:String(error))+")"}
 let tasks:ReturnType<typeof publishedTasks>=()=>null
 try{tasks=publishedTasks(table,readPublishedSpeed())}catch(error){problem=[problem,"published speed unreadable ("+(error instanceof Error?error.message:String(error))+")"].filter(Boolean).join("; ")}
 const timed=routes.map(route=>{const speed=speedFor(speeds,speedKey(route)),task=tasks(route.modelID,route.reasoning);return {...route,...(speed?{speed}:{}),...(task?{publishedTask:task}:{})}})
 const measured=timed.filter(r=>r.speed?.basis==="measured").length,calibrated=timed.filter(r=>r.speed?.basis==="calibration").length
 return {routes:timed,diagnostic:problem||measured+" route"+(measured===1?"":"s")+" with speed measured from requests here, "+calibrated+" from a calibration request"+(pooledChannels?", pooled with "+pooledChannels+" other channel"+(pooledChannels===1?"":"s"):"")}
}
export { aheadOfClock }
export function allowanceTaskCostUSD(route:Route){
 const e=route.economics
 return e?.taskProfile&&e.currency==="USD"&&e.amount>0?e.amount:route.benchmark?.perTask?.costUSD??null
}
export function withAllowance(routes:Route[],accounts:PlannerInput["accounts"],now=Date.now(),economy?:EconomyPolicy){
 const observedAt=accounts.map(a=>Date.parse(a.observedAt??"")).filter(n=>Number.isFinite(n))
 const capacity=readPlanCapacity({newestObservationAt:observedAt.length?Math.max(...observedAt):null})
 for(const account of accounts)for(const window of account.windows){const measured=capacity?.windows.find(w=>w.accountID===account.id&&w.windowID===window.id);if(measured&&typeof measured.expiresUnused==="boolean")window.expiresUnused=measured.expiresUnused}
 const sameModel=(route:Route)=>routes.filter(other=>other.accountID===route.accountID&&other.modelID===route.modelID).map(allowanceTaskCostUSD).filter((n):n is number=>n!==null)
 return routes.map(route=>{
  const known=allowanceTaskCostUSD(route),account=accounts.find(a=>a.id===route.accountID),perTask=known??(sameModel(route).length?Math.max(...sameModel(route)):null)
  if(!account||account.billing!=="subscription")return route
  const tasksLeft=Object.fromEntries(applicableQuotaWindows(account,route).map(window=>[window.id,routeCapacity(capacity,{accountID:account.id,windowID:window.id,modelID:route.modelID,remainingPercent:Number.isFinite(window.remaining)?Math.max(0,window.remaining-window.reserved):null,costPerTaskUSD:perTask})?.tasksLeftOnRoute]).filter(([,n])=>typeof n==="number"&&Number.isFinite(n)&&n>0))
  const allowance=economy?.accountAllowances?.[accountPriceKey(route)]
  const age=allowance?now-Date.parse(allowance.date):Infinity
  const published=allowance&&allowance.source?.trim()&&Number.isFinite(age)&&age>=0&&age<=Math.min(economy!.maxPriceAgeDays,3)*86400000?allowance:undefined
  const allowanceCost=allowanceCostOf(route,account,capacity,perTask,now,published)
  for(const window of allowanceCost?.windows??[])if(window.leftPercent!==null&&window.pointsPerTask>0)tasksLeft[window.windowID]=window.leftPercent/window.pointsPerTask
  return {...route,...(Object.keys(tasksLeft).length?{tasksLeft}:{}),...(allowanceCost?{allowanceCost}:{})}
 })
}
export type ModelRouterAnswer={answers?:Record<string,any>;probabilities:Record<string,number>;model:string;reason:string;order?:string[];groups?:Record<string,number>;milliseconds?:number;usage?:{calls:number;inputTokens:number;cost:number};stability?:{winnerShare:number;spread:number};orderings?:{order:string[];probabilities:Record<string,number>;winner:string;confidence:number|null}[]}
export type DispatchModelRouter=(question:{question:string;options:{id:string;facts:unknown}[];profile?:ProfileAsk})=>Promise<ModelRouterAnswer|undefined>
export function judgeOptions(plan:{request:RoutingRequest;routes:Route[];accounts:PlannerInput["accounts"]},admitted:Candidate[]){
 const now=Date.parse(plan.request.now)
 const number=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:null
 const percent=(fraction:number)=>Math.round(fraction*100)+"%"
 const points=(fraction:number)=>{const whole=Math.round(Math.abs(fraction)*100);return whole+(whole===1?" point":" points")}
 const compact=<T extends Record<string,unknown>>(value:T)=>Object.fromEntries(Object.entries(value).filter(([,v])=>v!==null&&v!==undefined)) as T
 const evidenced=(routeID:string)=>{
  const benchmark=plan.routes.find(r=>r.id===routeID)?.benchmark
  const candidate=admitted.find(c=>c.routeID===routeID)
  return candidate?.benchmarkPassAt1!==null&&benchmark?.perTask&&benchmark.passAt1>0
   ?{...benchmark.perTask,passAt1:benchmark.passAt1,costPerSolved:benchmark.perTask.costUSD/benchmark.passAt1,secondsPerSolved:benchmark.perTask.seconds/benchmark.passAt1}:null
 }
 const solved=admitted.map(c=>evidenced(c.routeID)?.costPerSolved).filter((n):n is number=>typeof n==="number"&&Number.isFinite(n)&&n>0),bestValue=solved.length?Math.min(...solved):null
 const quotes=admitted.map(c=>c.economics?.amount).filter((n):n is number=>typeof n==="number"&&Number.isFinite(n)&&n>0),cheapest=quotes.length?Math.min(...quotes):null
 const rates=admitted.map(c=>c.successRate??c.capability).filter((n):n is number=>typeof n==="number"&&Number.isFinite(n)&&n>0),strongest=rates.length?Math.max(...rates):null
 const observedAt=plan.accounts.map(a=>Date.parse(a.observedAt??"")).filter(n=>Number.isFinite(n))
 const capacity=readPlanCapacity({newestObservationAt:observedAt.length?Math.max(...observedAt):null})
 const capacityWindows=(candidate:Candidate)=>{
  const route=plan.routes.find(r=>r.id===candidate.routeID)!
  const account=plan.accounts.find(a=>a.id===candidate.accountID)
  if(!account||!candidate.accountID)return []
  return applicableQuotaWindows(account,route).map(window=>{
   const remaining=number(window.remaining),reserved=number(window.reserved)
   return {window,worth:routeCapacity(capacity,{accountID:candidate.accountID!,windowID:window.id,modelID:route.modelID,
    remainingPercent:remaining===null||reserved===null?remaining:Math.max(0,remaining-reserved),
    costPerTaskUSD:evidenced(candidate.routeID)?.costUSD??null})}
  })
 }
 const roomFor=(candidate:Candidate)=>{
  const rooms=capacityWindows(candidate).map(w=>w.worth?.tasksLeftOnRoute).filter((n):n is number=>typeof n==="number"&&Number.isFinite(n))
  return rooms.length?Math.min(...rooms):null
 }
 const room=new Map(admitted.map(c=>[c.routeID,roomFor(c)]))
 const solvedRoom=(routeID:string)=>{const r=room.get(routeID)??null,p=evidenced(routeID)?.passAt1;return r!==null&&typeof p==="number"&&p>0?r*p:null}
 const rooms=admitted.map(c=>solvedRoom(c.routeID)).filter((n):n is number=>typeof n==="number"&&Number.isFinite(n))
 const roomiest=rooms.length?Math.max(...rooms):null
 const times=(weight:number)=>weight<1.5?"about the same as":(weight<10?weight.toFixed(1):String(Math.round(weight)))+" times"
 const thousands=(count:number)=>count>=10000?Math.round(count/1000)+"k":count>=1000?(count/1000).toFixed(1)+"k":String(Math.round(count))
 const clock=(seconds:number)=>seconds>=90?Math.round(seconds/60)+" min":Math.round(seconds)+"s"
 const money=(amount:number)=>"$"+(amount<10?amount.toFixed(2):String(Math.round(amount)))
 const finishing=routeSpeed({routes:plan.routes,accounts:plan.accounts,request:plan.request})
 const finishes=rankedByVerifiedFinish(plan.request)?verifiedFinishes({routes:plan.routes,accounts:plan.accounts,request:plan.request},admitted):undefined
 const currency=plan.request.cashCurrency??"USD"
 const known=(value:number)=>Number.isFinite(value)?value:null
 return admitted.map(candidate=>{
  const route=plan.routes.find(r=>r.id===candidate.routeID)!
  const account=plan.accounts.find(a=>a.id===candidate.accountID)
  const evidence=route.evidence.filter(e=>e.task===plan.request.task).sort((a,b)=>Date.parse(b.measuredAt)-Date.parse(a.measuredAt))[0]
  const strength=candidate.successRate!==null&&evidence
   ?{kind:"measured",stated:"measured "+percent(candidate.successRate)+" success over "+evidence.trials+" trials on this exact route",successRate:candidate.successRate,trials:evidence.trials}
   :candidate.learned&&candidate.capability!==null
   ?{kind:"learned",stated:learnedText(candidate.learned)+"; with "+(candidate.benchmarkPassAt1!==null&&route.benchmark?"the "+priorWord(route.benchmark)+" "+route.benchmark.suite+" "+percent(candidate.benchmarkPassAt1)+" at effort "+route.benchmark.effort:"no published score")+" that estimates "+percent(candidate.capability)+" on this kind of work",
     capability:candidate.capability,trials:candidate.learned.trials,delivered:candidate.learned.delivered,requestsPerRun:Math.round(candidate.learned.requests/candidate.learned.trials),...(candidate.benchmarkPassAt1!==null?{passAt1:candidate.benchmarkPassAt1}:{})}
   :candidate.benchmarkPassAt1!==null&&route.benchmark
   ?{kind:"benchmark",stated:"no local measurement; "+priorWord(route.benchmark)+" "+route.benchmark.suite+" "+percent(route.benchmark.passAt1)+" at effort "+route.benchmark.effort+" ("+route.benchmark.provenance+")",suite:route.benchmark.suite,passAt1:route.benchmark.passAt1,provenance:route.benchmark.provenance,effort:route.benchmark.effort}
   :{kind:"unmeasured",stated:"unmeasured: neither a local outcome nor a published score"}
  const why=(strength.kind==="benchmark"||strength.kind==="learned"&&candidate.benchmarkPassAt1!==null)&&route.benchmark?.attribution?" — "+route.benchmark.attribution:""
  const rate=candidate.successRate??candidate.capability
  const gap=rate!==null&&strongest!==null?strongest-rate:null
  const verified=finishes?.get(candidate.routeID)
  const standing=gap===null||verified?"":gap<0.005?", the strongest rate offered":", "+points(gap)+" below the strongest rate offered ("+percent(strongest!)+")"
  const price=candidate.economics?{amount:candidate.economics.amount,currency:candidate.economics.currency,basis:candidate.economics.basis,workload:candidate.economics.workload??null}:null
  const quote=price?price.currency+" "+price.amount.toFixed(6)+" per "+(price.workload??"comparison workload")+" ("+price.basis+")":"comparable price unknown"
  const billing=account?.billing==="metered"?"metered: real money per token, "+quote
   :account?.billing==="subscription"?"subscription: already paid for, and whatever is not spent before the reset is lost"
   :account?.billing==="free"?"free: this route costs nothing"
   :"billing arrangement unknown"
  const costWeight=price&&cheapest!==null?price.amount/cheapest:null
  const task=evidenced(candidate.routeID)
  const valueWeight=task&&bestValue!==null?task.costPerSolved/bestValue:null
  const metered=account?.billing==="metered"
  const held=solvedRoom(candidate.routeID)
  const unbilled=metered?"":"; those dollars are not billed on this account — what is scarce is the allowance"+
   (held===null?", and that many tokens per task is how fast it eats it"
    :", which still holds about "+(held<10?held.toFixed(1):String(Math.round(held)))+" solved tasks of this size"+
      (roomiest===null||held>=roomiest*0.95?" — the most of any option offered here"
       :", against "+String(Math.round(roomiest))+" on the best-provisioned option offered here"))
  const value=task
   ?"Value: on the published benchmark this exact model and effort solves "+percent(task.passAt1)+" of tasks"+standing+", and one task costs "+money(task.costUSD)+" and "+thousands(task.outputTokens)+" output tokens in "+clock(task.seconds)+", which at that solve rate is "+money(task.costPerSolved)+" and "+clock(task.secondsPerSolved)+" per solved task"+
     ((valueWeight===null||!metered&&held!==null)?"":valueWeight<1.05?" — the best cost per solved task offered":" — "+times(valueWeight)+" the best cost per solved task offered")+unbilled
   :"Value: no per-task cost or time is published for this model and effort"+(standing?" (it solves "+percent(rate!)+" of tasks"+standing+")":"")+
     (costWeight===null?", and no comparable price either, so what one task takes here is unknown"
      :"; the only proxy is its per-token price, "+(costWeight<1.05?"the cheapest quoted here":times(costWeight)+" the cheapest quoted here")+" ("+quote+") — a weaker signal, because a price per token says nothing about how many tokens one task needs"+(metered?"":", and nothing is billed per token on this account anyway"))
  const speed=number(candidate.requestPerformance?.milliseconds)??number(candidate.economics?.requestMilliseconds)
  const finish=finishing.estimate(candidate)
  const windows=account?capacityWindows(candidate).map(({window,worth})=>{
   const burn=number(route.quotaPerTask[window.id]),remaining=number(window.remaining),reserved=number(window.reserved),reset=Date.parse(window.resetAt)
   const pace=aheadOfClock({remainingPercent:remaining,resetAt:reset,periodSeconds:number(window.periodSeconds)},now)
   const tasksLeft=burn!==null&&burn>0&&remaining!==null&&reserved!==null?(remaining-reserved)/burn:null
   const stated=window.id+" "+(worth?worth.stated
    :(pace.left===null?"allowance unknown":percent(pace.left)+" left")+
     (pace.ahead===null?", and no window length or reset to pace it against"
      :" with "+percent(pace.timeLeft!)+" of the window still to run: "+
        (Math.round(Math.abs(pace.ahead)*100)===0?"level with the clock"
         :pace.ahead>0?points(pace.ahead)+" ahead of the clock, that much will expire unused at this pace"
         :points(pace.ahead)+" behind the clock, it is being spent faster than it refills")))+
    (tasksLeft===null?"":"; this account's own pacing fits about "+(tasksLeft<10?tasksLeft.toFixed(1):String(Math.round(tasksLeft)))+" more tasks in it")
   return {stated,fields:compact({id:window.id,remaining,reserved,
    resetAt:Number.isFinite(reset)?window.resetAt:null,
    hoursUntilReset:Number.isFinite(reset)?(reset-now)/3600000:null,
    periodSeconds:number(window.periodSeconds),
    aheadOfClock:pace.ahead,
    quotaPerTask:burn,
    tasksLeft,
    windowWorthUSD:worth?Number(worth.windowWorthUSD.toFixed(2)):null,
    leftUSD:worth&&worth.leftUSD!==null?Number(worth.leftUSD.toFixed(2)):null,
    tasksLeftOnRoute:worth&&worth.tasksLeftOnRoute!==null?Number(worth.tasksLeftOnRoute.toFixed(1)):null,
    expiresUnused:worth?worth.expiresUnused:null,
    evidence:worth?worth.evidence:null,
    assumedPrice:worth?.assumed?true:null})}
  }):[]
  const description=[
   route.providerID+"/"+route.modelID+" at "+route.reasoning+" reasoning effort",
   value,
   "Strength: "+strength.stated+why,
   ...(verified?["Verified finish: "+finishText(verified,currency)+", its own attempt plus the tasks it is not expected to pass sent back to the strongest admitted route; "+reworkText(candidate.routeID,verified,currency)]:[]),
   ...(plan.request.automatic?.ratings?.[candidate.routeID]?["The user's own rating: "+plan.request.automatic.ratings[candidate.routeID].basis+", which counts as evidence it can do this work"]:[]),
   "Billing: "+billing,
   ...(finish?["Time to finish: about "+clock(finish.milliseconds/1000)+" per task finished without being sent back ("+finish.basis+": "+finish.said+")"]:[]),
   ...(speed!==null?["Speed: about "+Math.round(speed)+"ms per observed request"]:[]),
   "Allowance: "+(windows.length?windows.map(w=>w.stated).join("; "):"no quota window is reported for this account"),
  ].map(part=>part.replace(/\s*\.\s*$/,"")).join(". ")+"."
  return {id:candidate.routeID,group:canonicalModelID(route.modelID),facts:compact({
   description,
   model:route.providerID+"/"+route.modelID,
   reasoningEffort:route.reasoning,
   strength,
   billing:account?.billing??null,
   price,
   costPerTaskUSD:task?Number(task.costUSD.toFixed(4)):null,
   costPerSolvedTaskUSD:task?Number(task.costPerSolved.toFixed(4)):null,
   costPerSolvedWeight:valueWeight,
   solveRateBelowStrongest:verified?null:gap,
   expectedVerifiedCost:verified?known(verified.cost):null,
   expectedVerifiedSeconds:verified&&Number.isFinite(verified.milliseconds)?Math.round(verified.milliseconds/1000):null,
   reworkRoute:verified?.rework?.routeID??null,
   reworkShare:verified?.rework?verified.rework.share:null,
   tokensPerTask:task?{output:task.outputTokens,input:task.inputTokens}:null,
   secondsPerTask:task?task.seconds:null,
   secondsPerSolvedTask:task?Math.round(task.secondsPerSolved):null,
   agentStepsPerTask:task?task.agentSteps:null,
   costBasis:task?.costBasis??null,
   costWeight,
   observedRequestMilliseconds:speed,
   estimatedSecondsPerFinishedTask:finish?Math.round(finish.milliseconds/1000):null,
   finishEstimateBasis:finish?.basis??null,
   windows:windows.map(w=>w.fields),
   pacing:account?.pacing?{state:account.pacing.state,desiredConcurrency:account.pacing.desiredConcurrency,reason:account.pacing.reason}:null,
   concurrentWorkers:number(account?.concurrentWorkers),
   expiryOpportunity:number(candidate.expiryOpportunity),
   note:candidate.note??null,
  })}
 })
}

export function collapseDuplicateOffers(candidates:Candidate[],routes:Route[],catalog:{providerID:string;modelID:string}[]){
 const listed=new Set(catalog.map(m=>m.providerID+"/"+m.modelID))
 const routeOf=(c:Candidate)=>routes.find(r=>r.id===c.routeID)
 const rank=(c:Candidate)=>{const r=routeOf(c);return r?(listed.has(r.providerID+"/"+r.modelID)?0:2)+(r.harness==="native"?0:1):4}
 const collapsed:string[]=[]
 const admitted=candidates.filter(candidate=>{
  const route=routeOf(candidate)
  if(!route)return true
  const twins=candidates.filter(other=>{const o=routeOf(other);return o&&o.accountID===route.accountID&&canonicalModelID(o.modelID)===canonicalModelID(route.modelID)&&o.reasoning===route.reasoning})
  if(twins.length<2)return true
  const winner=[...twins].sort((a,b)=>rank(a)-rank(b)||a.routeID.localeCompare(b.routeID))[0]
  if(winner.routeID===candidate.routeID)return true
  collapsed.push(candidate.routeID+" (same account, model and effort as "+winner.routeID+")")
  return false
 })
 return {admitted,collapsed}
}

export function routineRequest<T extends RoutingRequest>(plan:{classification:{task:string;depth?:Depth};routes:Route[];accounts:PlannerInput["accounts"]},pool:T){
 const {task,depth}=plan.classification
 if(task!=="utility"&&depth!=="routine")return undefined
 const request={...pool,qualitySelection:"floor" as const}
 const preview=planRoutes({request,routes:plan.routes,accounts:plan.accounts})
 if(!preview.selected)return undefined
 return {request,note:"routine work ("+(task==="utility"?"task utility":"depth routine")+"): "+(rankedByVerifiedFinish(request)?"the cheapest expected verified finish among routes clearing the floor":"the cheapest route clearing the floor")+", not judged"}
}

const EFFORTS=["none","minimal","low","medium","high","xhigh","max"]
const draw=(text:string)=>Number.parseInt(createHash("sha256").update(text).digest("hex").slice(0,8),16)/4294967296
export function explorationCandidates(plan:{request:RoutingRequest;routes:Route[]},exclude:Record<string,string>,runID:string,ratings:NonNullable<RoutingRequest["automatic"]>["ratings"]={}){
 const floor=plan.request.minBenchmarkPassAt1??0
 const clears=(route:Route)=>!!ratings[route.id]||unbenched(route)||(route.benchmark?.passAt1??-1)>=floor
 const thin=(route:Route)=>(unbenched(route)?judgedRuns(route.learned):route.learned?.trials??0)<plan.request.minTrials
 const reworking=(route:Route)=>(route.learned?.reworked??0)>(1-floor)*Math.max(judgedRuns(route.learned),plan.request.minTrials)
 const price=(route:Route)=>typeof route.economics?.amount==="number"&&Number.isFinite(route.economics.amount)?route.economics.amount:Infinity
 return plan.routes.filter(route=>route.verified&&!exclude[route.id]&&(!route.benchmark||!!route.benchmark.inheritedFrom)&&thin(route)&&clears(route)&&!reworking(route)&&!(unbenched(route)&&strongFirst(plan.request)))
  .sort((a,b)=>price(a)-price(b)||Number(!unbenched(a))-Number(!unbenched(b))||(a.learned?.trials??0)-(b.learned?.trials??0)||draw(runID+a.id)-draw(runID+b.id))
}
export function automaticRequest<R extends RoutingRequest>(plan:{policy:{request:{judgedPool?:"allowlist"|"connected"}};request:R;routes:Route[];accounts:PlannerInput["accounts"];classification:{task:string;depth?:Depth;workType?:string}},routing?:RoutingSettings,runID?:string):{request:R;routine?:string;speed?:string;exploring?:string}{
 const opened=plan.request
 const automatic=routing?automaticRouting(routing,plan.routes,plan.classification):undefined
 const setting=routing?depthSettings(routing,plan.classification.depth):undefined
 if(automatic&&setting&&runID&&setting.exploration>0&&draw(runID)<setting.exploration){
  const thin=explorationCandidates({request:opened,routes:plan.routes},automatic.exclude??{},runID,automatic.ratings)
  if(thin.length){
   const floor=Math.round((opened.minBenchmarkPassAt1??0)*100)
   const note="a route with thin evidence for "+(plan.classification.workType??"this work")+" (no published score at all, or none of its own at its effort with its predecessor's score at that effort or your rating clearing the "+floor+"% floor; fewer than "+opened.minTrials+" measured runs here, judged ones when it has no published score; and not sent back so often that it falls below the "+floor+"% floor), because depth "+(plan.classification.depth??ASSUMED_DEPTH)+" sends "+Math.round(setting.exploration*100)+"% of its work to measure such routes, the cheapest by comparable price first and, at the same price, those with no score yet"
   return {request:{...opened,automatic:{...automatic,explore:{routeIDs:thin.map(r=>r.id),note}}},exploring:note}
  }
 }
 const pool=automatic?{...opened,automatic}:opened
 if(automatic?.value)return {request:pool,speed:describeSpeed(setting!.speed,plan.classification.depth)+", not judged"}
 if(automatic?.fastestWithin!==undefined)return {request:pool,speed:"speed setting ("+describeSpeed(setting!.speed,plan.classification.depth)+"), not judged"}
 const routine=routineRequest(plan,pool)
 return routine?{request:routine.request,routine:routine.note}:{request:pool}
}
export type PassedOver={routeID:string;model?:string;effort?:string;why:string}
export type ChosenBy="jon"|"giver"|"resume"
export const CHOOSER_WORDS:Record<ChosenBy,string>={jon:"the user",giver:"the Quest Giver",resume:"a resume"}
export type RoutingRecord={automatic:boolean;chosenBy?:ChosenBy;refusedByName?:string;replayOf?:string;task:string;workType?:string;depth?:string;profileSource?:string;evidence:string;speed?:string;exclude:string[];explicitExcludedBy?:string;exclusions?:{applied:string[];matchedNothing:string[]};expectedFinishMs?:number;considered:string[];passedOver:PassedOver[];excluded:{routeID:string;model?:string;effort?:string;reasons:string[]}[];trace?:DecisionTrace}

export type DispatchStage="profile"|"routes"|"judge"|"pick"
export type DispatchInput={runID:string;model?:string;chosenBy?:ChosenBy;policyFile:string;reservationFile:string;now?:number;brief?:string;modelRouter?:DispatchModelRouter;routing?:RoutingSettings;simulate?:boolean;profileSetBy?:{workType?:string;depth?:string};progress?:(stage:DispatchStage,trace:DecisionTrace)=>void;withheld?:Withheld}&DispatchFacts
type DispatchPlan=Awaited<ReturnType<typeof dispatchPlanInput>>
function releaseNamedRoute(plan:DispatchPlan,routing:RoutingSettings|undefined,chosenBy:ChosenBy|undefined,reservationFile:string){
 let refusedByName=""
 if(plan.explicitRouteID&&routing&&chosenBy!=="jon"){
  const named=plan.routes.find(r=>r.id===plan.explicitRouteID),by=named?exclusionOf(routing,plan.classification.depth,named,plan.classification.workType):undefined
  if(by){
   refusedByName="Route excluded by routing settings ("+by+" at depth "+(plan.classification.depth??ASSUMED_DEPTH)+"); chosen by "+CHOOSER_WORDS[chosenBy??"giver"]+", not by the user, so routing picked another route"
   plan.diagnostics.push(refusedByName)
  }
 }
 if(plan.explicitRouteID&&chosenBy&&chosenBy!=="jon"){
  const preview=new RouteReservations(reservationFile).preview({request:plan.request,routes:plan.routes,accounts:plan.accounts})
  if(!preview.selected){
   const named=plan.explicitRouteID,why=preview.excluded.find(x=>x.routeID===named)?.reasons.join(", ")||preview.summary
   const refused="named route refused: "+named+" "+why+"; chosen by "+CHOOSER_WORDS[chosenBy]+", not by the user, so routed automatically"
   refusedByName=refusedByName?refusedByName+"; "+refused:refused
   plan.diagnostics.push(refused)
  }
 }
 if(refusedByName){
  plan.explicitRouteID=undefined
  plan.request={...plan.request,explicitRouteID:undefined}
 }
 return refusedByName
}
export type DispatchAdmission={admitted:true}|{admitted:false;reason:string}
export async function admitDispatch(input:Omit<DispatchInput,"runID"|"modelRouter"|"progress"|"simulate"|"replay">,loadUsage:typeof getAccountUsage=getAccountUsage):Promise<DispatchAdmission>{
 const plan=await dispatchPlanInput(input,loadUsage)
 const chosenBy:ChosenBy|undefined=input.model?input.chosenBy??"giver":undefined
 releaseNamedRoute(plan,input.routing,chosenBy,input.reservationFile)
 const request=plan.explicitRouteID?plan.request:automaticRequest(plan,input.routing).request
 const ledger=new RouteReservations(input.reservationFile),preview=(each:RoutingRequest)=>ledger.preview({request:each,routes:plan.routes,accounts:plan.accounts})
 const decision=preview(request)
 const automatic=!plan.explicitRouteID&&input.routing?automaticRouting(input.routing,plan.routes,plan.classification):undefined
 const explorable=automatic?explorationCandidates({request,routes:plan.routes},automatic.exclude??{},"admission",automatic.ratings).map(route=>route.id):[]
 if(decision.selected||!plan.explicitRouteID&&preview({...request,judging:true}).selected||explorable.length&&preview({...request,automatic:{...automatic!,explore:{routeIDs:explorable,note:"admission"}}}).selected)return {admitted:true}
 return {admitted:false,reason:decision.summary+": "+groupedRefusal(decision.excluded)+" | candidates: "+plan.diagnostics.join(" | ")}
}
export async function reserveDispatch(input:DispatchInput,loadUsage:typeof getAccountUsage=getAccountUsage) {
 return timed({plugin:'models',name:'admission',op:input.runID,route:input.model,result:value=>({route:value.route.providerID+'/'+value.route.modelID,harness:value.route.harness,accountID:value.route.accountID,outcome:'admitted'})},()=>reserveDispatchDecision(input,loadUsage))
}
async function reserveDispatchDecision(input:DispatchInput,loadUsage:typeof getAccountUsage) {
 const stages:DecisionTrace["stages"]=[]
 const setter=(field:"workType"|"depth")=>input[field]!==undefined?input.profileSetBy?.[field]??"giver":"not stated"
 const trace:DecisionTrace={version:1,...(input.simulate?{simulated:true as const}:{}),brief:clip(input.brief??"",BRIEF_CHARACTERS),profile:{task:String(input.task??""),workType:input.workType??null,depth:input.depth??null,setBy:{workType:setter("workType"),depth:setter("depth")}},how:"",speed:null,exploration:null,estimates:[],pick:null,stages}
 const tell=(stage:DispatchStage)=>{try{input.progress?.(stage,trace)}catch(error){console.error("[dispatch] routing progress not recorded",error)}}
  let early:EarlyJudgment|undefined,inferred:ProfileInference|undefined,unsized=""
  const stated=String(input.task??"").trim().toLowerCase()
  const routing=input.routing,modelRouter=input.modelRouter
  const profileAsk:ProfileAsk|undefined=routing&&modelRouter&&input.brief?.trim()&&!input.model&&(input.depth===undefined||input.workType===undefined)&&(input.task===undefined||(TASK_CLASSES as string[]).includes(stated))&&stated!=="utility"?{workTypes:routing.workTypes,ask:{workType:input.workType===undefined&&routing.workTypes.length>0,depth:input.depth===undefined}}:undefined
  let began=Date.now()
  if(profileAsk&&modelRouter){
   tell("profile")
   const statedPlan=await dispatchPlanInput(input,loadUsage)
   const pool=judgingPool(statedPlan)
   if(pool.admitted.length>=2){
    const question=judgeQuestion(statedPlan.classification,input.brief,true)
    const options=judgeOptions({...statedPlan,request:pool.request},pool.admitted)
    tell("judge")
    early={question,options}
    try{early.judgment=await modelRouter({question,options,profile:profileAsk})}catch(error){early.failure=String(error instanceof Error?error.message:error).slice(0,200)}
   }
   const answered=early?.judgment
   try{if(answered?.answers)inferred=profileFromAnswers(answered.answers,{...profileAsk,frontierSure:routing?.frontierSure,model:answered.model,milliseconds:answered.milliseconds??0})}
   catch(error){unsized="work profile inference failed ("+String(error instanceof Error?error.message:error).slice(0,200)+"), so what was not stated stays unstated"}
   stages.push({stage:"work profile",ms:Date.now()-began})
  }
  const profiled=inferred?{...input,depth:input.depth??inferred.depth,workType:input.workType??inferred.workType,profileSource:input.depth!==undefined||input.workType!==undefined?STATED_PROFILE+" where stated, otherwise "+inferred.source:inferred.source}:input
  tell("routes")
 began=Date.now()
 const plan=await dispatchPlanInput(profiled,loadUsage)
 stages.push({stage:"accounts and routes",ms:Date.now()-began})
 const chosenBy:ChosenBy|undefined=input.model?input.chosenBy??"giver":undefined
 const refusedByName=releaseNamedRoute(plan,input.routing,chosenBy,input.reservationFile)
 const {workType,depth,profileSource}=plan.classification
 const settledBy=(field:"workType"|"depth")=>input[field]!==undefined?setter(field):inferred?.[field]!==undefined?"Jev":"not stated"
 trace.profile={task:plan.classification.task,workType:workType??null,depth:depth??null,setBy:{workType:settledBy("workType"),depth:settledBy("depth")},
  ...(inferred?.answer?{jev:inferred.answer}:{}),...(unsized?{failed:unsized}:{})}
 if(unsized)plan.diagnostics.push(unsized)
 let judgment:ModelRouterAnswer|undefined
 const automatic=plan.explicitRouteID?undefined:automaticRequest(plan,input.routing,input.runID)
 const routine=automatic?.routine,speed=automatic?.speed,exploring=automatic?.exploring
 if(automatic)plan.request=automatic.request
 if(routine)plan.diagnostics.push(routine)
 const setting=input.routing?depthSettings(input.routing,depth):undefined
 if(setting){trace.speed=describeSpeed(setting.speed,depth);trace.exploration=setting.exploration}
 const explicitRoute=plan.explicitRouteID?plan.routes.find(r=>r.id===plan.explicitRouteID):undefined
 const explicitExcludedBy=explicitRoute&&input.routing?exclusionOf(input.routing,plan.classification.depth,explicitRoute,plan.classification.workType):undefined
 const chosenNote=explicitExcludedBy?"The user chose this route by name, so the exclusion "+explicitExcludedBy+" does not apply":""
  let unjudged=""
  if(!plan.explicitRouteID&&!routine&&!speed&&!exploring){
   const pool=judgingPool(plan)
   if(early){
    const ranked=early.judgment
    if(early.failure)unjudged="the model router failed, so this pool was ranked on capability without one"
    else if(!ranked)unjudged="the model router gave no answer, so this pool was ranked on capability without one"
    else if(pool.admitted.length<2)trace.unjudged="only "+pool.admitted.length+" route"+(pool.admitted.length===1?" was":"s were")+" left, so there was nothing to judge"
    else{judgment=ranked;trace.judge=applyJudgment(plan,pool.request,ranked,early.question,early.options)}
   }else if(modelRouter&&pool.admitted.length>=2)try{
    const question=judgeQuestion(plan.classification,input.brief,false)
    const options=judgeOptions({...plan,request:pool.request},pool.admitted)
    tell("judge")
    began=Date.now()
    try{judgment=await modelRouter({question,options})}finally{stages.push({stage:"judge",ms:Date.now()-began})}
    if(judgment)trace.judge=applyJudgment(plan,pool.request,judgment,question,options)
    else unjudged="the model router gave no answer, so this pool was ranked on capability without one"
   }catch{judgment=undefined;unjudged="the model router failed, so this pool was ranked on capability without one"}
   else if(modelRouter)trace.unjudged="only "+pool.admitted.length+" route"+(pool.admitted.length===1?" was":"s were")+" left, so there was nothing to judge"
  }
 tell("pick")
 began=Date.now()
 const ledger=new RouteReservations(input.reservationFile),gateNow=input.now??Date.now(),planned={request:plan.request,routes:input.simulate?plan.routes:gateDispatchRoutes(plan.routes,gateNow,undefined,undefined,String(plan.request.task??"")),accounts:plan.accounts}
 const result=input.simulate?(preview=>({reservation:preview.selected?{routeID:preview.selected.routeID}:null,decision:preview}))(ledger.preview(planned)):ledger.reserve(input.runID,planned)
 stages.push({stage:"pick",ms:Date.now()-began})
 if(!result.reservation)throw new Error(result.decision?.summary+": "+groupedRefusal(result.decision?.excluded??[])+" | candidates: "+plan.diagnostics.join(" | "))
 const route=plan.policy.routes.find(r=>r.id===result.reservation!.routeID)
 if(!route)throw new Error("Reserved route was removed; reconcile the existing run before retrying")
 const served=servedOf(plan.routes),exclusions=setting?.exclude.length?{applied:setting.exclude.filter(pattern=>servedMatches(pattern,served).length),matchedNothing:setting.exclude.filter(pattern=>!servedMatches(pattern,served).length)}:undefined
 const exclusionNote=exclusions?"exclusions at depth "+(depth??ASSUMED_DEPTH)+(exclusions.applied.length?" that applied: "+exclusions.applied.join(", "):" applied to no route")+(exclusions.matchedNothing.length?"; matched nothing served: "+exclusions.matchedNothing.join(", "):""):""
 const decision=result.decision?{...result.decision,summary:(refusedByName?refusedByName+"; ":"")+result.decision.summary+(exclusionNote?"; "+exclusionNote:"")+"; "+describeDemand(plan.classification,plan.request)+(routine?"; "+routine:"")+(unsized?"; "+unsized:"")+(unjudged?"; "+unjudged:"")+(chosenNote?"; "+chosenNote:"")}:result.decision
 const described=(routeID:string)=>{const r=plan.routes.find(each=>each.id===routeID);return r?{model:r.providerID+"/"+r.modelID,effort:r.reasoning}:{}}
 const evidence=plan.explicitRouteID?"chosen by name":exploring?"exploration":speed?(setting?.speed.mode==="value"?"value rule":"speed setting"):routine?"routine floor":judgment?"model router":"capability ranking"
 const passedOver=(result.decision?.ranked??[]).filter(c=>c.routeID!==result.reservation!.routeID).slice(0,5).map(c=>{const strength=c.successRate??c.capability;return {routeID:c.routeID,...described(c.routeID),why:(c.probability!==undefined?"judged "+Math.round(c.probability*100)+"%; ":"")+(strength===null?"capability unmeasured":"capability "+Math.round(strength*1000)/10+"%")+(c.verifiedFinish?"; "+passedFinish(c.routeID,c.verifiedFinish,plan.request.cashCurrency??"USD"):"")}})
 trace.how=evidence
 if(unjudged)trace.unjudged=unjudged
 trace.estimates=traceEstimates(plan,result.decision?.ranked??[],allowanceTaskCostUSD)
 trace.pick={routeID:route.id,model:route.providerID+"/"+route.modelID,effort:route.reasoning}
 const expectedFinishMs=trace.estimates.find(estimate=>estimate.routeID===route.id)?.finishMs??undefined
 const record:RoutingRecord={automatic:!plan.explicitRouteID,...(chosenBy?{chosenBy}:{}),...(refusedByName?{refusedByName}:{}),task:plan.classification.task,...(workType?{workType}:{}),...(depth?{depth}:{}),...(profileSource?{profileSource}:{}),evidence,...(speed||exploring?{speed:exploring?"exploring "+exploring:speed}:{}),exclude:setting?setting.exclude:[],...(explicitExcludedBy?{explicitExcludedBy}:{}),...(exclusions?{exclusions}:{}),...(expectedFinishMs!==undefined&&expectedFinishMs>0?{expectedFinishMs}:{}),
  considered:result.decision?.ranked.map(c=>c.routeID)??[result.reservation.routeID],passedOver,excluded:[...(result.decision?.excluded??[]),...plan.dropped].map(x=>({routeID:x.routeID,...described(x.routeID),reasons:x.reasons})),trace}
 return {route,bootstrapByProject:plan.policy.bootstrapByProject??{},ledger,decision,judgment,classification:plan.classification,record,candidates:{derived:plan.live.derived.length,curated:plan.live.curated.length,catalog:plan.live.catalog.source,diagnostics:plan.diagnostics}}
}

type Plan=Awaited<ReturnType<typeof dispatchPlanInput>>
type EarlyJudgment={question:string;options:ReturnType<typeof judgeOptions>;judgment?:ModelRouterAnswer;failure?:string}
function judgingPool(plan:Plan){
 const request={...plan.request,judging:true}
 const {admitted,collapsed}=collapseDuplicateOffers(planRoutes({request,routes:plan.routes,accounts:plan.accounts}).admitted,plan.routes,plan.live.catalog.models)
 if(collapsed.length)plan.diagnostics.push("Collapsed "+collapsed.length+" duplicate route"+(collapsed.length===1?"":"s")+" before judging: "+collapsed.join("; "))
 return {request,admitted}
}
function judgeQuestion(classification:Plan["classification"],brief:string|undefined,profiling:boolean){
 return "Task class "+classification.task+" ("+classification.source+")."+
  (profiling?"\nThe work type and depth are not stated; answer them in this same reply.":classification.workType||classification.depth?"\nWork "+(classification.workType??"of an unstated type")+" at depth "+(classification.depth??ASSUMED_DEPTH)+" ("+(classification.profileSource??STATED_PROFILE)+").":"")+
  (brief?.trim()?"\nThe work:\n"+brief.trim():"")
}
function applyJudgment(plan:{request:RoutingRequest},request:RoutingRequest,judgment:ModelRouterAnswer,question:string,options:ReturnType<typeof judgeOptions>){
 const groups=Object.fromEntries(Object.entries(judgment.groups??{}).map(([name,share])=>[name,{share,routeIDs:options.filter(option=>option.group===name).map(option=>option.id)}]))
 plan.request={...request,judged:{probabilities:judgment.probabilities,model:judgment.model,reason:judgment.reason,...(judgment.order?{order:judgment.order}:{}),...(Object.keys(groups).length?{groups}:{})}}
 return judgeTrace(judgment,question,options)
}
function passedFinish(routeID:string,finish:VerifiedFinish,currency:string){
 const rework=finish.rework
 return finishText(finish,currency)+(!rework?"":rework.routeID===routeID?"; it is the route steps are sent back to, the strongest admitted":", with "+Math.round(rework.share*1000)/10+"% sent back to "+rework.routeID)
}
function judgeTrace(judgment:ModelRouterAnswer,question:string,options:{id:string;facts:{description?:string}}[]):TraceJudge{
 const confidences=(judgment.orderings??[]).map(ordering=>ordering.confidence).filter((n):n is number=>typeof n==="number")
 return {model:judgment.model,milliseconds:judgment.milliseconds??null,calls:judgment.usage?.calls??null,inputTokens:judgment.usage?.inputTokens??null,cost:judgment.usage?.cost??null,
  question:clip(question,QUESTION_CHARACTERS),options:options.map(option=>({routeID:option.id,said:clip(String(option.facts.description??""),OPTION_CHARACTERS)})),
  orderings:(judgment.orderings??[]).map(ordering=>({order:ordering.order,shares:ordering.probabilities,winner:ordering.winner,confidence:ordering.confidence})),
  shares:judgment.probabilities,groups:judgment.groups??{},
  confidence:confidences.length?confidences.reduce((sum,n)=>sum+n,0)/confidences.length:null,
  spread:judgment.stability?.spread??null,agreement:judgment.stability?.winnerShare??null,reason:judgment.reason}
}
