import {evaluateTrials,type Trial} from "../usage/benchmark-evaluation"
import {routeKey,type RequestRecord} from "../usage/telemetry-api"
import type {Route,TaskClass,RouteEvidence} from "./route-planner"
export type MeasuredOutcomes={trials:Trial[];requests:RequestRecord[];task:TaskClass;currency:string;source:string}
export function measuredOutcomeRoutes(routes:Route[],input:MeasuredOutcomes){
 if(!input.source?.trim()||!input.currency?.trim()||!["coding","review","planning","utility"].includes(input.task))throw Error("Measured outcomes require task, currency and source provenance")
 const report=evaluateTrials(input.trials,input.requests),records=new Map(input.requests.map(r=>[r.id,r])),diagnostics:{routeID:string;reason:string}[]=[]
 const updated=routes.map(route=>{
  const trials=report.trials.filter(t=>t.routeID===route.id);if(!trials.length)return route
  const requests=trials.flatMap(t=>t.requestIDs.map(id=>records.get(id)!)),expected=routeKey({route:{providerID:route.providerID,modelID:route.modelID,reasoning:route.reasoning,variant:route.reasoning==="unknown"?undefined:route.reasoning,harness:route.harness,serviceTier:route.serviceTier}} as RequestRecord)
  const issues=[...new Set(trials.flatMap(t=>t.measurementIssues))]
  if(trials.some(t=>t.accepted===null))issues.push("Unjudged outcomes")
  if(requests.some(r=>r.accountID!==route.accountID||routeKey(r)!==expected))issues.push("Requests do not match the exact account/model/harness/reasoning/service route")
  if(requests.some(r=>r.actualCharge&&(r.actualCharge.currency!==input.currency||!Number.isFinite(r.actualCharge.value)||r.actualCharge.value<0)))issues.push("Invalid or incompatible actual charge currency")
  const cashComplete=requests.every(r=>!!r.actualCharge)
  if(!cashComplete)diagnostics.push({routeID:route.id,reason:"Actual charges unavailable; API-equivalent value is not a charge"})
  if(trials.some(t=>t.wallMilliseconds<=0))issues.push("Trial duration must be positive")
  if(issues.length){const reason=issues.join("; ");diagnostics.push({routeID:route.id,reason});return {...route,outcomeIssue:{task:input.task,reason}}}
  const group=report.routes.find(g=>g.routeID===route.id)!,durations=trials.map(t=>t.wallMilliseconds).sort((a,b)=>a-b),latest=Math.max(...input.trials.filter(t=>t.routeID===route.id).map(t=>t.completedAt))
  const evidence:RouteEvidence={task:input.task,source:input.source,measuredAt:new Date(latest).toISOString(),trials:group.trials,passed:group.accepted,totalMilliseconds:group.totalMilliseconds,totalCash:cashComplete?(group.actualCharges[input.currency]??0):null,currency:input.currency,p95Milliseconds:durations[Math.ceil(durations.length*0.95)-1]}
  return {...route,outcomeIssue:undefined,evidence:[...route.evidence.filter(e=>e.source!==input.source||e.task!==input.task),evidence]}
 })
 return {routes:updated,diagnostics,report}
}
