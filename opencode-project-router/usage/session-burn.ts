import {outputIncludingReasoning} from "./telemetry"
import type {AccountUsage} from "../usage-service/on-computer"
import type {Observation} from "./calibration"
import {accountRegime} from "./calibration-store"
import {empiricalRoute,ledgerFeatures,learnEmpiricalModel,measuredIntervals} from "./empirical-usage"
import type {LedgerRow} from "./passive-ledger"

const ORDER=["uncachedInput","cachedInput","cacheWrite","outputIncludingReasoning"] as const
const minutes=(from:number,to:number)=>(to-from)/60000
const sum=(rows:LedgerRow[])=>{
 const known=[0,0,0,0],missing=[0,0,0,0];let visibleOutput=0,reasoningOutput=0,missingVisibleOutput=0,missingReasoningOutput=0
 for(const row of rows){if(row.tokens.output===null)missingVisibleOutput++;else visibleOutput+=row.tokens.output;if(row.tokens.reasoning===null)missingReasoningOutput++;else reasoningOutput+=row.tokens.reasoning;const values=[row.tokens.input,row.tokens.cacheRead,row.tokens.cacheWrite,outputIncludingReasoning(row)];values.forEach((v,i)=>{if(v===null||!Number.isFinite(v)||v<0)missing[i]++;else known[i]+=v})}
 return {known,missing,visibleOutput,reasoningOutput,missingVisibleOutput,missingReasoningOutput}
}
type Model=ReturnType<typeof learnEmpiricalModel>
function estimate(rows:LedgerRow[],model:Model,now:number){
 const unavailable=(reason:string)=>({points:null as number|null,reason,components:null as number[]|null})
 if(model.state!=="provisional")return unavailable(model.reason)
 if(!rows.length)return {points:0,components:[0,0,0,0],reason:"No completed requests in this interval"}
 if(model.validation.to>now||now-model.validation.to>30*60000||model.scope.resetAt<=now)return unavailable("Calibration is stale or the quota window expired")
 const components=[0,0,0,0]
 for(const row of rows){const values=ledgerFeatures(row),route=empiricalRoute(row),evidence=model.routeEvidence.find(e=>e.route===route)
  if(!values)return unavailable("Incomplete token components")
  if(!evidence)return unavailable("Exact route has no identified rates")
  const total=values.reduce((a,b)=>a+b,0)
  if(total&&values.some((n,i)=>n/total<evidence.mixRange[i].low-.02||n/total>evidence.mixRange[i].high+.02))return unavailable("Token mix is outside calibration evidence")
  for(let i=0;i<4;i++){const coefficient=model.coefficients.find(c=>c.feature===route+"|"+i);if(values[i]&&!coefficient)return unavailable("Token category has no identified rate");components[i]+=values[i]*(coefficient?.pointsPerMillionTokens??0)/1e6}
 }
 return {points:components.reduce((a,b)=>a+b,0),components,reason:"Provisional token-weighted association, not a provider charge receipt"}
}
function scopedRows(rows:LedgerRow[],accounts:AccountUsage[],account:AccountUsage,window:AccountUsage["windows"][number]){
 const regime=accountRegime(account),singleOpenAI=accounts.filter(a=>a.provider==="openai").length===1
 return rows.filter(r=>r.source!=="opencode-host"&&(r.accountID===account.id&&r.regime===regime||!r.accountID&&r.source==="codex"&&account.provider==="openai"&&singleOpenAI)&&(window.scope==="shared"||window.scope==="model"&&r.route.modelID===window.model))
}
export type BurnCoverage={from?:number|null;gaps?:{at:number}[];diagnostics?:string[];observedAt?:number|null}
export function sessionBurn(accounts:AccountUsage[],observations:Observation[],records:LedgerRow[],now:number,coverage:BurnCoverage={}){
 if(!Number.isFinite(now))throw Error("Invalid session burn clock")
 const unique=new Map<string,LedgerRow>();for(const r of records){const old=unique.get(r.id);if(!old||(r.recordedAt??r.at)>=(old.recordedAt??old.at)&&!(old.state!=="running"&&r.state==="running"))unique.set(r.id,r)}
 const rows=[...unique.values()].filter(r=>r.at<=now),primary=rows.filter(r=>r.source!=="opencode-host"),completed=primary.filter(r=>r.state!=="running")
 const intervals=measuredIntervals(accounts,observations,completed,coverage)
 const pools=accounts.flatMap(account=>account.windows.flatMap(window=>{
  const resetAt=Date.parse(window.resetAt??"");if(!Number.isFinite(resetAt)||window.scope==="unknown")return []
  const scope={accountID:account.id,regime:accountRegime(account),windowID:window.id,resetAt}
  const matching=intervals.filter(i=>i.accountID===scope.accountID&&i.regime===scope.regime&&i.windowID===scope.windowID&&i.resetAt===scope.resetAt)
  const model=learnEmpiricalModel(matching.slice(-96)),all=scopedRows(primary,accounts,account,window),done=all.filter(r=>r.state!=="running")
  const groups=new Map<string,LedgerRow[]>();for(const r of all){const key=JSON.stringify([r.source,r.sessionID,empiricalRoute(r)]);const group=groups.get(key)??[];group.push(r);groups.set(key,group)}
  const sessions=[...groups.values()].map(group=>{
   const settled=group.filter(r=>r.state!=="running"),latest=Math.max(...group.map(r=>r.at)),totals=sum(settled)
   return {source:group[0].source,sessionID:group[0].sessionID,parentID:group[0].parentID??null,route:group[0].route,accountBinding:group.some(r=>!r.accountID)?"inferred-single-account":"recorded",lastCounterAt:latest,pendingRequests:group.filter(r=>r.state==="running").length,completedRequests:settled.length,totals,recentRequests:settled.slice().sort((a,b)=>b.at-a.at).slice(0,20).map(r=>({requestID:r.id,startedAt:r.startedAt,completedAt:r.at,kind:r.kind,tokens:sum([r]),allowance:estimate([r],model,now)})),
    rates:[1,5,15].map(duration=>{const from=now-duration*60000,recent=settled.filter(r=>r.at>from),tokens=sum(recent),allowance=estimate(recent,model,now),covered=coverage.from!==undefined&&coverage.from!==null&&coverage.from<=from&&coverage.observedAt!=null&&now>=coverage.observedAt&&now-coverage.observedAt<=90000&&!coverage.diagnostics?.length&&!coverage.gaps?.some(g=>g.at>from&&g.at<=now)
     return {minutes:duration,from,to:now,completedRequests:recent.length,tokens,knownTokensPerMinute:tokens.known.map(n=>n/duration),coverageComplete:covered,allowance:covered?{...allowance,pointsPerMinute:allowance.points===null?null:allowance.points/duration}:{points:null,components:null,pointsPerMinute:null,reason:"Collector coverage is stale or incomplete"}}
    })}
  }).sort((a,b)=>b.lastCounterAt-a.lastCounterAt)
  const series=matching.slice(-48).map(interval=>{
   const earlier=matching.filter(i=>i.to<=interval.from).slice(-96),prior=learnEmpiricalModel(earlier)
   const observedRows=done.filter(r=>r.at>interval.from&&r.at<=interval.to),predicted=interval.missingRequests?{points:null,components:null,reason:"Incomplete interval coverage"}:estimate(observedRows,prior,interval.from)
   const residual=predicted.points===null?null:interval.usedPoints-predicted.points
   return {from:interval.from,to:interval.to,observedPoints:interval.usedPoints,predictedPoints:predicted.points,residualPoints:residual,absoluteErrorPoints:residual===null?null:Math.abs(residual),reason:predicted.reason,tokens:sum(observedRows),requests:observedRows.length,missingRequests:interval.missingRequests,precisionPoints:interval.precisionPoints,reportingDelayMilliseconds:interval.reportingDelayMilliseconds,trainingThrough:prior.state==="provisional"?prior.validation.to:null,
    sessions:[...new Set(observedRows.map(r=>r.source+":"+r.sessionID))].map(key=>{const sessionRows=observedRows.filter(r=>r.source+":"+r.sessionID===key);return {source:sessionRows[0].source,sessionID:sessionRows[0].sessionID,tokens:sum(sessionRows),estimatedPoints:interval.missingRequests?null:estimate(sessionRows,prior,interval.from).points}})}
  })
  const tested=series.filter(s=>s.absoluteErrorPoints!==null),errors=tested.map(s=>s.absoluteErrorPoints!),last=series.at(-1)
  const usable=matching.slice(-96).filter(i=>i.requests>0&&!i.missingRequests),activeFeatures=new Set(usable.slice(0,-3).flatMap(i=>Object.entries(i.features).flatMap(([route,values])=>values.flatMap((n,k)=>n>0?[route+"|"+k]:[])))).size
  return [{scope,evidence:{calibrationIntervalLimit:96,displayIntervalLimit:48,completeIntervals:usable.length,activeTokenFeatures:activeFeatures,minimumCompleteIntervals:Math.max(8,2*activeFeatures+3),counterCoverageIsNotAccountCoverage:true},provider:account.provider,plan:account.plan.name??account.plan.rateLimitTier??"unknown",label:window.label,model, sessions,series,accuracy:{targetAbsoluteErrorPoints:.01,chronologicalTestedIntervals:tested.length,meanAbsoluteErrorPoints:errors.length?errors.reduce((a,b)=>a+b,0)/errors.length:null,maximumAbsoluteErrorPoints:errors.length?Math.max(...errors):null,fractionWithinTarget:errors.length?errors.filter(e=>e<=.01).length/errors.length:null,state:tested.length<8?"insufficient-chronological-evidence":errors.every(e=>e<=.01)?"within-target-on-observed-tests":"outside-target",providerPrecisionPoints:last?.precisionPoints??null,reportingDelayMilliseconds:last?.reportingDelayMilliseconds??null,meaning:"Chronological replay using current captured counters; not forecasts persisted in real time, a guarantee, or per-request provider receipts"}}]
 }))
 return {at:now,tokenOrder:ORDER,rateBasis:"Completed request counters per fixed wall-clock interval; in-flight tokens arrive when the provider reports them",pools,unassignedRequests:primary.filter(r=>!accounts.some(a=>a.windows.some(w=>scopedRows([r],accounts,a,w).length))).length,excludedHostCounterRecords:rows.length-primary.length,limitations:["Cached input is charged per request; context size alone is not token usage","Output includes reasoning exactly once; missing counters stay missing","Unknown external activity, cross-host overlap and reporting delay limit quota attribution","Residual is observed quota movement minus model prediction, not a measured missing charge"]}
}
export function sessionBurnLines(report:ReturnType<typeof sessionBurn>){
 return report.pools.flatMap(pool=>[`${pool.provider} ${pool.label}: session attribution ${pool.accuracy.state}; ${pool.accuracy.chronologicalTestedIntervals} chronological tests; max error ${pool.accuracy.maximumAbsoluteErrorPoints===null?"unknown":pool.accuracy.maximumAbsoluteErrorPoints.toFixed(4)} points (target 0.01)`,...pool.sessions.filter(s=>s.rates[1].completedRequests||s.pendingRequests).slice(0,8).map(s=>{const r=s.rates[1];return `${s.source}/${s.sessionID.slice(-8)} ${s.route.modelID}: ${r.knownTokensPerMinute.map(n=>Math.round(n).toLocaleString("en-US")).join(" / ")} tokens/min uncached / cached / cache-write / output; ${r.allowance.pointsPerMinute===null?"allowance uncalibrated":r.allowance.pointsPerMinute.toFixed(4)+" estimated points/min"}; ${s.pendingRequests} pending`})])
}
