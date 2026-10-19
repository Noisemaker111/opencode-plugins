import { outputIncludingReasoning } from "./telemetry"
import { validateWorkloads, type UsageWorkload } from "./credit-rates"
import type { LedgerRow } from "./passive-ledger"
import type { AccountUsage } from "../usage-service/on-computer"
import { accountRegime } from "./calibration-store"
import type { Observation } from "./calibration"

export type MeasuredInterval = { provider?:string;planName?:string;windowLabel?:string;accountID:string;regime:string;windowID:string;resetAt:number;from:number;to:number;usedPoints:number;precisionPoints:number|null;reportingDelayMilliseconds:number|null;requests:number;missingRequests:number;unboundRequests:number;features:Record<string,number[]>;tokens:number[];basis:"coincident-observations";limitations:string[] }
export const empiricalRoute=(r:Pick<LedgerRow,"route">)=>JSON.stringify([r.route.providerID,r.route.modelID,r.route.reasoning??r.route.variant??"unknown",r.route.serviceTier??"unknown",r.route.harness??"native"])
export function ledgerFeatures(r:LedgerRow):number[]|null {
 const output=outputIncludingReasoning(r)
 const values=[r.tokens.input,r.tokens.cacheRead,r.tokens.cacheWrite,output]
 return values.every(n=>n!==null&&Number.isFinite(n)&&n>=0)?values as number[]:null
}
export function measuredIntervals(accounts:AccountUsage[],observations:Observation[],records:LedgerRow[],coverage:{from?:number|null;gaps?:{at:number}[];diagnostics?:string[]}={}) {
 const result:MeasuredInterval[]=[]
 for(const account of accounts)for(const window of account.windows){
  const regime=accountRegime(account),reset=Date.parse(window.resetAt??"")
  if(!Number.isFinite(reset)||window.scope==="unknown")continue
  const points=observations.filter(o=>o.accountID===account.id&&o.windowID===window.id&&o.regime===regime&&o.resetAt===reset&&!o.replenishing&&o.at<reset).sort((a,b)=>a.at-b.at)
  let before=points[0]
  for(const after of points.slice(1)){
   if(after.usedPoints<before.usedPoints){before=after;continue}
   if(after.at-before.at<300000)continue
   if(coverage.from!==undefined&&coverage.from!==null&&before.at<coverage.from){before=after;continue}
   const rows=records.filter(r=>r.at>before.at&&r.at<=after.at&&(r.accountID===account.id&&r.regime===regime||!r.accountID&&r.source==="codex"&&account.provider==="openai"&&accounts.filter(a=>a.provider==="openai").length===1)&&
    (window.scope==="shared"||window.scope==="model"&&r.route.modelID===window.model))
   const features:Record<string,number[]>={},tokens=[0,0,0,0];let missingRequests=(coverage.gaps??[]).filter(g=>g.at>before.at&&g.at<=after.at).length+(coverage.diagnostics?.length?1:0)
   for(const r of rows){const values=ledgerFeatures(r);if(!values){missingRequests++;continue}const target=features[empiricalRoute(r)]??=[0,0,0,0];values.forEach((v,i)=>{target[i]+=v;tokens[i]+=v})}
   const unboundRequests=rows.filter(r=>!r.accountID).length
   const limitations=["Other devices and unrecorded account activity are not observable"]
   if(unboundRequests)limitations.push("Codex account association is inferred from one connected OpenAI account")
   if(before.reportingDelayMilliseconds===null||after.reportingDelayMilliseconds===null)limitations.push("Provider reporting delay is unknown")
   if(before.precisionPoints===null||after.precisionPoints===null)limitations.push("Provider meter precision is unknown")
   if(missingRequests)limitations.push("Some requests, counter gaps, or collector coverage lack complete token components")
   if(rows.some(r=>r.startedAt<=before.at||r.source==="codex"))limitations.push("Request accounting may cross quota interval boundaries")
   result.push({provider:account.provider,planName:account.plan.name??account.plan.rateLimitTier??"unknown plan",windowLabel:window.label,accountID:account.id,regime,windowID:window.id,resetAt:reset,from:before.at,to:after.at,usedPoints:after.usedPoints-before.usedPoints,precisionPoints:before.precisionPoints!==null&&after.precisionPoints!==null?(before.precisionPoints+after.precisionPoints)/2:null,reportingDelayMilliseconds:before.reportingDelayMilliseconds!==null&&after.reportingDelayMilliseconds!==null?Math.max(before.reportingDelayMilliseconds,after.reportingDelayMilliseconds):null,requests:rows.length,missingRequests,unboundRequests,features,tokens,basis:"coincident-observations",limitations})
   before=after
  }
 }
 return result
}
const dot=(a:number[],b:number[])=>a.reduce((n,v,i)=>n+v*b[i],0)
function rank(matrix:number[][]) {
 const a=matrix.map(r=>[...r]);let rank=0
 for(let col=0;col<(a[0]?.length??0);col++){
  let pivot=rank;for(let j=rank;j<a.length;j++)if(Math.abs(a[j][col])>Math.abs(a[pivot]?.[col]??0))pivot=j
  if(!a[pivot]||Math.abs(a[pivot][col])<1e-5)continue
  ;[a[rank],a[pivot]]=[a[pivot],a[rank]];const divisor=a[rank][col];for(let k=col;k<a[rank].length;k++)a[rank][k]/=divisor
  for(let j=rank+1;j<a.length;j++){const f=a[j][col];for(let k=col;k<a[j].length;k++)a[j][k]-=f*a[rank][k]}
  rank++;if(rank===a.length)break
 }return rank
}
export function learnEmpiricalModel(intervals:MeasuredInterval[]) {
 const first=intervals[0],scope=first?{accountID:first.accountID,windowID:first.windowID,regime:first.regime,resetAt:first.resetAt}:null
 const unavailable=(reason:string)=>({state:"collecting" as const,scope,reason,intervals:intervals.length,completeIntervals:intervals.filter(i=>i.requests>0&&!i.missingRequests).length,coefficients:null,validation:null})
 if(!first||intervals.some(i=>i.accountID!==first.accountID||i.windowID!==first.windowID||i.regime!==first.regime||i.resetAt!==first.resetAt))return unavailable("Need intervals from one account, plan and quota pool")
 const usable=intervals.filter(i=>i.requests>0&&!i.missingRequests).sort((a,b)=>a.from-b.from)
 if(usable.length<8)return unavailable("Need at least eight complete nonoverlapping intervals")
 if(usable.some((v,i)=>i>0&&v.from<usable[i-1].to))return unavailable("Overlapping intervals are not independent evidence")
 const training=usable.slice(0,-3),heldOut=usable.slice(-3),names=[...new Set(training.flatMap(s=>Object.entries(s.features).flatMap(([route,v])=>v.flatMap((n,i)=>n>0?[route+"|"+i]:[]))))].sort()
 if(!names.length||names.length>32||training.length<2*names.length)return unavailable("Need more independent token mixes for the active models and token categories")
 const vector=(s:MeasuredInterval)=>names.map(name=>{const index=name.lastIndexOf("|");return s.features[name.slice(0,index)]?.[Number(name.slice(index+1))]??0})
 const scale=names.map((_,i)=>Math.max(...training.map(s=>vector(s)[i]),1)),x=training.map(s=>vector(s).map((n,i)=>n/scale[i])),y=training.map(s=>s.usedPoints)
 if(rank(x)<names.length)return unavailable("Token categories are correlated; separate rates are not identifiable")
 if(heldOut.some(s=>Object.entries(s.features).some(([route,v])=>v.some((n,i)=>n>0&&!names.includes(route+"|"+i)))))return unavailable("Held-out activity includes an unseen model or token category")
 const w=names.map(()=>0)
 for(let iteration=0;iteration<1000;iteration++){let change=0;for(let i=0;i<w.length;i++){const denom=x.reduce((n,r)=>n+r[i]*r[i],0);const next=Math.max(0,w[i]+x.reduce((n,r,j)=>n+r[i]*(y[j]-dot(r,w)),0)/denom);change=Math.max(change,Math.abs(next-w[i]));w[i]=next}if(change<1e-8)break}
 const weights=w.map((n,i)=>n/scale[i]),errors=heldOut.map(s=>dot(vector(s),weights)-s.usedPoints),mae=errors.reduce((n,e)=>n+Math.abs(e),0)/errors.length
 const baseline=y.reduce((n,v)=>n+v,0)/y.length,baselineMAE=heldOut.reduce((n,s)=>n+Math.abs(s.usedPoints-baseline),0)/heldOut.length
 const upperErrorPoints=Math.max(...errors.map(Math.abs)),precisionKnown=usable.every(i=>i.precisionPoints!==null)
 if(mae>Math.max(.5,baselineMAE)||upperErrorPoints>Math.max(2,baselineMAE*2))return unavailable("Recent held-out error is too large; collect a new stable sample")
 const routeEvidence=[...new Set(names.map(name=>name.slice(0,name.lastIndexOf("|"))))].map(route=>{
  const values=training.map(s=>s.features[route]).filter((v):v is number[]=>!!v&&v.reduce((a,b)=>a+b,0)>0)
  const totals=values.map(v=>v.reduce((a,b)=>a+b,0))
  return {route,maxTokensPerInterval:Math.max(...totals),mixRange:[0,1,2,3].map(i=>({low:Math.min(...values.map((v,j)=>v[i]/totals[j])),high:Math.max(...values.map((v,j)=>v[i]/totals[j]))}))}
 })
 return {state:"provisional" as const,scope,reason:"Empirical association; external usage and reporting lag prevent verified charge attribution",intervals:intervals.length,completeIntervals:usable.length,routeEvidence,coefficients:names.map((name,i)=>({feature:name,pointsPerMillionTokens:weights[i]*1e6})),validation:{trainingIntervals:training.length,heldOutIntervals:3,meanAbsoluteErrorPoints:mae,upperErrorPoints,baselineMeanAbsoluteErrorPoints:baselineMAE,precisionKnown,from:usable[0].from,to:usable.at(-1)!.to},mixExample:{usedPoints:usable.reduce((n,s)=>n+s.usedPoints,0),tokens:usable.reduce((a,s)=>a.map((n,i)=>n+s.tokens[i]),[0,0,0,0]),tokenOrder:["uncachedInput","cachedInput","cacheWrite","outputIncludingReasoning"]}}
}
export function empiricalModels(intervals:MeasuredInterval[]) {
 const groups=new Map<string,MeasuredInterval[]>();for(const i of intervals){const k=JSON.stringify([i.accountID,i.regime,i.windowID,i.resetAt]);groups.set(k,[...(groups.get(k)??[]),i])}
 return [...groups.values()].map(learnEmpiricalModel)
}

export function measuredIntervalLines(intervals:MeasuredInterval[]) {
 const groups=new Map<string,MeasuredInterval[]>()
 for(const i of intervals){const k=JSON.stringify([i.accountID,i.regime,i.windowID]);const rows=groups.get(k)??[];rows.push(i);groups.set(k,rows)}
 return [...groups.values()].slice(0,6).flatMap(rows=>{
  const recent=rows.slice(-12),last=recent.at(-1)!,rates=recent.map(i=>i.usedPoints/((i.to-i.from)/60000)),high=Math.max(...rates,0),marks="▁▂▃▄▅▆▇█",spark=rates.map(r=>marks[high>0?Math.round(r/high*7):0]).join("")
  const label=`${last.provider??"account"} ${last.planName??last.accountID} ${last.windowLabel??last.windowID}`
  return [`${label}: ${spark} observed quota pace`,`${last.usedPoints.toFixed(2)} points alongside ${last.tokens[0].toLocaleString("en-US")} uncached / ${last.tokens[1].toLocaleString("en-US")} cached / ${last.tokens[3].toLocaleString("en-US")} output incl. reasoning${last.missingRequests?"; incomplete counters":""}; association, not attributed charges`]
 })
}

export function empiricalWorkloadScenario(model:ReturnType<typeof learnEmpiricalModel>|undefined,workload:UsageWorkload,scope:{accountID:string;windowID:string;regime:string;resetAt:number},now:number) {
 validateWorkloads([workload])
 const unavailable=(reason:string)=>({state:"unavailable" as const,reason,points:null,observedErrorScenario:null})
 if(!model||model.state!=="provisional")return unavailable(model?.reason??"No learned model for this account and pool")
 if(!model.scope||model.scope.accountID!==scope.accountID||model.scope.windowID!==scope.windowID||model.scope.regime!==scope.regime||model.scope.resetAt!==scope.resetAt||workload.accountID!==scope.accountID)return unavailable("Account, plan, pool or reset does not match the learned evidence")
 if(!Number.isFinite(now)||model.validation.to>now||now-model.validation.to>30*60000||scope.resetAt<=now)return unavailable("Learned evidence is stale or belongs to an expired pool")
 const route=empiricalRoute(workload),evidence=model.routeEvidence.find(r=>r.route===route),features=[workload.tokens.input,workload.tokens.cacheRead,0,workload.tokens.outputIncludingReasoning],total=features.reduce((a,b)=>a+b,0)
 if(!evidence)return unavailable("Exact provider, model, reasoning, tier and host were not observed")
 if(total===0)return unavailable("Zero-token work cannot establish session capacity")
 if(features.some((n,i)=>n/total<evidence.mixRange[i].low-.02||n/total>evidence.mixRange[i].high+.02))return unavailable("Requested token proportions are outside the measured mix")
 const rates=features.map((n,i)=>{const c=model.coefficients.find(c=>c.feature===route+"|"+i);return c?.pointsPerMillionTokens??(n===0?0:null)})
 if(rates.some(r=>r===null))return unavailable("A requested token category has no identifiable rate")
 const points=features.reduce((sum,n,i)=>sum+n*rates[i]!/1e6,0)*workload.requests
 const intervalEquivalents=Math.max(1,total*workload.requests/evidence.maxTokensPerInterval),error=model.validation.upperErrorPoints*intervalEquivalents
 return {state:"provisional" as const,reason:"Assumes the measured token mix and learned linear association continue; not a verified charge or capacity guarantee",points,
  observedErrorScenario:{low:Math.max(0,points-error),high:points+error,heldOutMaximumErrorPoints:model.validation.upperErrorPoints,intervalEquivalents,meaning:"Scaled historical held-out error, not a confidence bound"},
  evidence:{from:model.validation.from,to:model.validation.to,trainingIntervals:model.validation.trainingIntervals,heldOutIntervals:model.validation.heldOutIntervals,meanAbsoluteErrorPoints:model.validation.meanAbsoluteErrorPoints,precisionKnown:model.validation.precisionKnown},scope:model.scope}
}
