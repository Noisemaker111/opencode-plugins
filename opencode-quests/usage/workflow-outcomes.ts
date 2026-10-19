import {requestMetrics} from "./request-metrics"
import {readSessionsRequests,TELEMETRY_FILE} from "./telemetry-store"
import {copyFileSync,existsSync,readFileSync,mkdirSync} from "node:fs"
import {writeFileDurable,readJsonRecord} from "../quest/core/durable-file.mjs"
import {dirname} from "node:path"
import {createHash} from "node:crypto"
import {acquireLock} from "../quest/locking.mts"
import {outageAt,readHostOutages,type HostOutage} from "./host-outages"
import {readDisqualifiedRuns,type DisqualifiedRun} from "./disqualified-runs"
import type {RunTelemetry} from "./run-telemetry"

export type WorkflowRoute={planRegime?:string;accountID:string;providerID:string;modelID:string;reasoning:string;harness:string;version:string;serviceTier:string}
export type WorkflowTokens={input:number|null;cacheRead:number|null;cacheWrite:number|null;output:number|null;reasoning:number|null}
export type WorkflowBegin={projectID?:string;workflowTitle?:string;replayOf?:string;runID:string;workflowID:string;stepID:string;sessionID:string;route:WorkflowRoute;taskTags:string[];startedAt:number}
export type WorkflowOutcome="delivered"|"work-failed"|"empty"|"environment"|"dependency"|"permission"|"cancelled"|"unverified"
export const WORKFLOW_OUTCOMES:WorkflowOutcome[]=["delivered","work-failed","empty","environment","dependency","permission","cancelled","unverified"]
export type WorkflowEnding="work"|"host"
export type WorkflowObservation={outcome?:WorkflowOutcome;endedBy?:WorkflowEnding;hostEnding?:string;routeConsistent?:boolean;delivered?:boolean;requests?:number;runID:string;observedAt:number;completedAt?:number;state:"running"|"completed"|"failed"|"cancelled";tokens:WorkflowTokens;reviewMilliseconds:number|null;integrationMilliseconds:number|null}
export type WorkflowJudgment={runID:string;judgedAt:number;accepted:boolean;reviewer:string;firstPass:boolean|null;verification:{command:string;exitCode:number;artifact:string}[]}
export type WorkflowRun=WorkflowBegin & {observation:WorkflowObservation|null;judgment:WorkflowJudgment|null;telemetry?:RunTelemetry}
export type WorkflowStore={version:1;runs:WorkflowRun[]}
export function countsForRoute(run:Pick<WorkflowRun,"observation">):boolean{const o=run.observation;return !!o&&o.state!=="running"&&o.routeConsistent!==false&&o.endedBy!=="host"&&(o.outcome===undefined||o.outcome==="delivered"||o.outcome==="work-failed"||o.outcome==="empty")}
const tokenFields=["input","cacheRead","cacheWrite","output","reasoning"] as const
const text=(x:unknown)=>typeof x==="string"&&x.trim().length>0&&x.length<=2048
const time=(x:unknown)=>typeof x==="number"&&Number.isFinite(x)&&x>=0&&x<=8640000000000000
const canonical=(x:unknown):string=>JSON.stringify(x,(_k,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)
function validBegin(r:WorkflowBegin){if(!r||(r.projectID!==undefined&&!text(r.projectID))||(r.replayOf!==undefined&&(!text(r.replayOf)||r.replayOf===r.runID))||(r.workflowTitle!==undefined&&!text(r.workflowTitle))||![r.runID,r.workflowID,r.stepID,r.sessionID].every(text)||!r.route||(r.route.planRegime!==undefined&&!text(r.route.planRegime))||!["accountID","providerID","modelID","reasoning","harness","version","serviceTier"].every(k=>text(r.route[k as keyof WorkflowRoute]))||!Array.isArray(r.taskTags)||!r.taskTags.length||r.taskTags.some(t=>!text(t))||new Set(r.taskTags).size!==r.taskTags.length||!time(r.startedAt))throw Error("Invalid workflow identity or start time")}
function validObservation(o:WorkflowObservation,r:WorkflowBegin){if(!o||(o.outcome!==undefined&&!WORKFLOW_OUTCOMES.includes(o.outcome))||(o.endedBy!==undefined&&(!["work","host"].includes(o.endedBy)||o.state==="running"))||(o.hostEnding!==undefined&&(o.endedBy!=="host"||!text(o.hostEnding)))||(o.routeConsistent!==undefined&&typeof o.routeConsistent!=="boolean")||(o.delivered!==undefined&&(typeof o.delivered!=="boolean"||o.state==="running"))||(o.requests!==undefined&&(!Number.isSafeInteger(o.requests)||o.requests<0))||(o.completedAt!==undefined&&(!time(o.completedAt)||o.completedAt<r.startedAt||o.completedAt>o.observedAt||o.state==="running"))||o.runID!==r.runID||!time(o.observedAt)||o.observedAt<r.startedAt||!["running","completed","failed","cancelled"].includes(o.state)||!o.tokens||tokenFields.some(k=>o.tokens[k]!==null&&(!Number.isSafeInteger(o.tokens[k])||o.tokens[k]!<0))||[o.reviewMilliseconds,o.integrationMilliseconds].some(v=>v!==null&&!time(v)))throw Error("Invalid workflow observation")}
function validJudgment(j:WorkflowJudgment,r:WorkflowRun){if(!j||j.runID!==r.runID||!r.observation||r.observation.state==="running"||!time(j.judgedAt)||j.judgedAt<(r.observation.completedAt??r.observation.observedAt)||typeof j.accepted!=="boolean"||!text(j.reviewer)||![true,false,null].includes(j.firstPass)||!Array.isArray(j.verification)||j.verification.some(v=>!text(v.command)||!text(v.artifact)||!Number.isInteger(v.exitCode)))throw Error("Invalid workflow judgment")
 if(j.accepted&&(r.observation.state!=="completed"||!j.verification.length||j.verification.some(v=>v.exitCode!==0)))throw Error("Acceptance requires completed work and successful verification evidence")
 if(!j.accepted&&j.firstPass===true)throw Error("Rejected work cannot be first-pass accepted")
}
export const workflowOutcomesFile=()=>process.env.OPENCODE_WORKFLOW_OUTCOMES_FILE??TELEMETRY_FILE+".workflows.json"
export function readWorkflowOutcomes(file:string):WorkflowStore{return readWorkflowOutcomesChecked(file).store}
export function readWorkflowOutcomesChecked(file:string):{store:WorkflowStore;diagnostics:string[]}{
 if(!existsSync(file))return {store:{version:1,runs:[]},diagnostics:[]}
 const raw=readFileSync(file,"utf8"),nulls=raw.split("\0").length-1,body=nulls?raw.replaceAll("\0",""):raw
 if(nulls&&!body.trim()){readJsonRecord(file);return {store:{version:1,runs:[]},diagnostics:["The outcome ledger "+file+" holds only "+nulls+" null bytes, a write that never reached the disk; read as no runs"]}}
 const diagnostics=nulls?["Skipped "+nulls+" null bytes in the outcome ledger "+file+", a write that never fully reached the disk"]:[]
 return {store:withDisqualifiedRuns(withHostOutages(validStore(JSON.parse(body) as WorkflowStore),readHostOutages(file)),readDisqualifiedRuns(file)),diagnostics}
}
export function withDisqualifiedRuns(store:WorkflowStore,rows:DisqualifiedRun[]):WorkflowStore{
 if(!rows.length)return store
 const reasons=new Map(rows.map(row=>[row.runID,row.reason]))
 for(const r of store.runs){const o=r.observation,reason=reasons.get(r.runID);if(!o||o.state==="running"||!reason||o.endedBy==="host")continue;r.observation={...o,endedBy:"host",hostEnding:reason}}
 return store
}
export function withHostOutages(store:WorkflowStore,outages:HostOutage[]):WorkflowStore{
 if(!outages.length)return store
 for(const r of store.runs){const o=r.observation;if(!o||o.state==="running"||o.endedBy==="host")continue;const outage=outageAt(outages,o.completedAt??o.observedAt);if(outage)r.observation={...o,endedBy:"host",hostEnding:outage.reason}}
 return store
}
function validStore(data:WorkflowStore):WorkflowStore{
 if(!data||data.version!==1||!Array.isArray(data.runs))throw Error("Unreadable workflow outcomes")
 const ids=new Set<string>(),sessions=new Set<string>()
 for(const r of data.runs){validBegin(r);if(r.observation!==null&&(typeof r.observation!=="object"||!r.observation)||r.judgment!==null&&(typeof r.judgment!=="object"||!r.judgment))throw Error("Missing or invalid observation/judgment state");if(ids.has(r.runID)||sessions.has(r.sessionID))throw Error("Duplicate workflow run or session");ids.add(r.runID);sessions.add(r.sessionID);if(r.observation)validObservation(r.observation,r);if(r.judgment)validJudgment(r.judgment,r)}return data
}
function mutate<T>(file:string,fn:(data:WorkflowStore)=>T):T{
 const lock=acquireLock(dirname(file),"workflow-outcomes-"+createHash("sha256").update(file).digest("hex").slice(0,16))
 try{const {store:data,diagnostics}=readWorkflowOutcomesChecked(file),result=fn(data);mkdirSync(dirname(file),{recursive:true});if(diagnostics.length)copyFileSync(file,file+".damaged-"+Date.now());writeFileDurable(file,JSON.stringify(data),{mode:0o600});return result}finally{lock.release()}
}
export function beginWorkflowRun(file:string,input:WorkflowBegin):WorkflowRun{
 validBegin(input);return mutate(file,data=>{const old=data.runs.find(r=>r.runID===input.runID);if(old){const {observation,judgment,telemetry,...rest}=old,{support:_retired,...identity}=rest as typeof rest&{support?:unknown};if(canonical(identity)!==canonical(input))throw Error("Run identity is immutable");return old}if(data.runs.some(r=>r.sessionID===input.sessionID))throw Error("Session already attributed to another run");const run={...input,observation:null,judgment:null};data.runs.push(run);return run})
}
export function observeWorkflowRun(file:string,input:WorkflowObservation):WorkflowRun{
 return mutate(file,data=>{const r=data.runs.find(r=>r.runID===input.runID);if(!r)throw Error("Unknown workflow run");validObservation(input,r);const old=r.observation;if(old){if(canonical(old)===canonical(input))return r;if(old.routeConsistent===false&&input.routeConsistent!==false)throw Error("Mixed route attribution cannot be upgraded");if(input.observedAt<=old.observedAt)throw Error("Observation is stale");if(r.judgment&&input.routeConsistent!==old.routeConsistent&&input.routeConsistent!==false)throw Error("Judged route attribution can only be downgraded");if(r.judgment&&(input.reviewMilliseconds!==old.reviewMilliseconds||input.integrationMilliseconds!==old.integrationMilliseconds))throw Error("Judged review and integration effort are immutable");if(old.state!=="running"&&(input.state!==old.state||input.completedAt!==(old.completedAt??old.observedAt)))throw Error("Terminal state and completion time are immutable");if(tokenFields.some(k=>old.tokens[k]!==null&&input.tokens[k]!==null&&input.tokens[k]!<old.tokens[k]!))throw Error("Cumulative counters cannot decrease");if(["reviewMilliseconds","integrationMilliseconds"].some(k=>old[k as "reviewMilliseconds"]!==null&&input[k as "reviewMilliseconds"]!==null&&input[k as "reviewMilliseconds"]!<old[k as "reviewMilliseconds"]!))throw Error("Cumulative effort cannot decrease")}
 r.observation=input;return r})
}
export function judgeWorkflowRun(file:string,input:WorkflowJudgment):WorkflowRun{
 return mutate(file,data=>{const r=data.runs.find(r=>r.runID===input.runID);if(!r)throw Error("Unknown workflow run");validJudgment(input,r);if(r.judgment&&canonical(r.judgment)!==canonical(input))throw Error("Judgment already recorded");r.judgment=input;return r})
}
export function attachWorkflowTelemetry(file:string,runID:string,telemetry:RunTelemetry):WorkflowRun{
 return mutate(file,data=>{const r=data.runs.find(r=>r.runID===runID);if(!r)throw Error("Unknown workflow run");if(!r.observation||r.observation.state==="running")throw Error("Telemetry attaches to a settled run");r.telemetry=telemetry;return r})
}
export function workflowRouteKey(route:WorkflowRoute){return canonical(route)}
export function wilsonInterval(successes:number,total:number):[number,number]|null{
 if(!Number.isInteger(total)||!Number.isInteger(successes)||total<0||successes<0||successes>total)throw Error("Invalid interval sample")
 if(!total)return null;const z=1.959963984540054,p=successes/total,d=1+z*z/total,center=(p+z*z/(2*total))/d,half=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d;return [Math.max(0,center-half),Math.min(1,center+half)]
}
const sumKnown=(values:(number|null)[])=>({known:values.reduce<number>((a,b)=>a+(b??0),0),unknown:values.filter(v=>v===null).length,total:values.every(v=>v!==null)?values.reduce<number>((a,b)=>a+b!,0):null})
export function reportWorkflowOutcomes(file:string,options:{now?:number;days?:7|28;projectID?:string;requestsFile?:string}={}){
 const now=options.now??Date.now(),days=options.days??28;if(!time(now)||![7,28].includes(days))throw Error("Invalid report window");const from=now-days*86400000
 const all=readWorkflowOutcomes(file).runs.filter(r=>r.startedAt<=now&&(!options.projectID||r.projectID===options.projectID))
 const requests=readSessionsRequests(all.filter(r=>r.startedAt>=from).map(r=>r.sessionID),options.requestsFile).records
 const runs=all.filter(r=>r.startedAt>=from).map(r=>{
  const worker=requests.filter(p=>p.sessionID===r.sessionID&&p.startedAt>=r.startedAt-1000&&p.startedAt<=Math.min(now,r.observation?.completedAt??now))
  return {...r,metrics:requestMetrics(worker),taskMetrics:requestMetrics(worker),observation:r.observation&&r.observation.observedAt<=now?r.observation:null,judgment:r.judgment&&r.judgment.judgedAt<=now?r.judgment:null}
 })
 const keys=[...new Set(runs.flatMap(r=>r.taskTags.map(tag=>JSON.stringify([workflowRouteKey(r.route),tag]))))]
 const matrix=keys.map(key=>{const [routeKey,taskTag]=JSON.parse(key),items=runs.filter(r=>workflowRouteKey(r.route)===routeKey&&r.taskTags.includes(taskTag)),judged=items.filter(r=>r.judgment!==null&&countsForRoute(r)),accepted=judged.filter(r=>r.judgment!.accepted).length,first=judged.filter(r=>r.judgment!.firstPass!==null);const settled=items.filter(r=>r.observation&&r.observation.state!=="running"),costs=[...new Set(settled.flatMap(r=>r.taskMetrics.cost.map(c=>c.currency)))].map(currency=>{const rows=settled.map(r=>r.observation?.routeConsistent===false?undefined:r.taskMetrics.cost.find(c=>c.currency===currency)),actual=sumKnown(rows.map(c=>c?.actualCharge??null)),estimate=sumKnown(rows.map(c=>c?.estimatedCost??null));return {currency,actual,estimate,actualPerTask:actual.total!==null&&settled.length?actual.total/settled.length:null,estimatePerTask:estimate.total!==null&&settled.length?estimate.total/settled.length:null,actualPerAccepted:actual.total!==null&&accepted&&judged.length===settled.length?actual.total/accepted:null,estimatePerAccepted:estimate.total!==null&&accepted&&judged.length===settled.length?estimate.total/accepted:null}});return {route:items[0].route,taskTag,samples:items.length,settledTasks:settled.length,costs,meanTaskMilliseconds:settled.length?settled.reduce((n,r)=>n+(r.observation!.completedAt??r.observation!.observedAt)-r.startedAt,0)/settled.length:null,meanTokensPerTask:Object.fromEntries(tokenFields.map(k=>{const v=sumKnown(settled.map(r=>r.observation?.tokens[k]??null));return [k,v.total!==null&&settled.length?v.total/settled.length:null]})),speed:requestMetrics(requests.filter(p=>items.some(r=>r.observation?.routeConsistent!==false&&r.sessionID===p.sessionID&&p.startedAt>=r.startedAt-1000&&p.startedAt<=Math.min(now,r.observation?.completedAt??now))&&p.startedAt<=now)).speed,judged:judged.length,accepted,rejected:judged.length-accepted,unjudged:items.filter(r=>r.judgment===null).length,unattributedJudgments:items.filter(r=>r.judgment!==null&&r.observation?.routeConsistent===false).length,acceptance:judged.length?accepted/judged.length:null,acceptanceInterval:wilsonInterval(accepted,judged.length),tokenCoverage:{completeRuns:items.filter(r=>r.observation&&r.observation.state!=="running"&&tokenFields.every(k=>r.observation!.tokens[k]!==null)).length,unsettledRuns:items.filter(r=>!r.observation||r.observation.state==="running").length,unknownRuns:items.filter(r=>!r.observation||tokenFields.some(k=>r.observation!.tokens[k]===null)).length},firstPassKnown:first.length,firstPassAccepted:first.filter(r=>r.judgment!.accepted&&r.judgment!.firstPass).length,tokens:Object.fromEntries(tokenFields.map(k=>[k,sumKnown(items.map(r=>r.observation?.tokens[k]??null))]))}})
 const real=runs.filter(r=>!r.replayOf),workflows=[...new Set(real.map(r=>JSON.stringify([r.projectID??null,r.workflowID])))].map(workflowKey=>{const [projectID,workflowID]=JSON.parse(workflowKey),items=real.filter(r=>r.workflowID===workflowID&&(r.projectID??null)===projectID),startedAt=Math.min(...items.map(r=>r.startedAt)),terminal=items.every(r=>r.observation&&r.observation.state!=="running"),completedAt=terminal?Math.max(...items.map(r=>(r.observation!.completedAt??r.observation!.observedAt))):null
 const events=items.filter(r=>(r.observation&&r.observation.state!=="running"?(r.observation.completedAt??r.observation.observedAt):now)>r.startedAt).flatMap(r=>[{at:r.startedAt,delta:1},{at:r.observation&&r.observation.state!=="running"?(r.observation.completedAt??r.observation.observedAt):now,delta:-1}]).sort((a,b)=>a.at-b.at||a.delta-b.delta);let active=0,maxConcurrent=0;for(const event of events){active+=event.delta;maxConcurrent=Math.max(maxConcurrent,active)}
 return {projectID,workflowID,startedAt,completedAt,elapsedMilliseconds:(completedAt??now)-startedAt,workerMilliseconds:items.reduce((n,r)=>n+(r.observation&&r.observation.state!=="running"?(r.observation.completedAt??r.observation.observedAt):now)-r.startedAt,0),maxConcurrent,runIDs:items.map(r=>r.runID),partialWindow:all.some(r=>!r.replayOf&&r.workflowID===workflowID&&(r.projectID??null)===projectID&&r.startedAt<from),reviewMilliseconds:sumKnown(items.map(r=>r.observation?.reviewMilliseconds??null)),integrationMilliseconds:sumKnown(items.map(r=>r.observation?.integrationMilliseconds??null))}})
 return {now,from,days,runs,matrix,workflows,note:"Observed runs started in this window. Task tags overlap; do not sum matrix rows. Unjudged work, judgments with mixed routes and runs the host ended (endedBy host: the host process ended, the run was interrupted, stopped or reloaded, or the worker did not start) are excluded from route acceptance denominators. Verified acceptance does not imply complete token coverage or eligibility for model routing. Cost per task counts worker requests; giver and integration work is unallocated, so it is not a complete task bill. Route tokens and speed describe the worker only. Tokens are disjoint input, cache reads, cache writes, output and reasoning counters; null is unknown. Worker time is summed run duration, not CPU time. Concurrency observations do not establish causal speedup. A run with replayOf is a bench: the same step run again on another route, scored by its checks and never landed; it counts toward route acceptance but not toward any workflow. Routes retain account, harness and version identity; no model ranking is inferred."}
}
export function latestRunLine(store:WorkflowStore):string{
 const run=store.runs.filter(item=>item.telemetry).sort((a,b)=>b.startedAt-a.startedAt)[0],telemetry=run?.telemetry
 if(!run||!telemetry)return "Latest run: none with telemetry yet"
 const tokens=telemetry.tokens?.worker,counted=[tokens?.input,tokens?.cacheWrite,tokens?.output,tokens?.reasoning]
 const fresh=counted.every(value=>typeof value==="number")?counted.reduce<number>((sum,value)=>sum+(value??0),0):"?"
 const worker=telemetry.cost?.worker,cost=typeof worker?.listUSD==="number"?"USD "+worker.listUSD.toFixed(4):worker?.listUSD===null?"unpriced":"not recorded"
 return "Latest run: "+(telemetry.questID??"?")+" "+run.runID+" "+(telemetry.state??"?")+(telemetry.partial?" (partial)":"")+"; "+(tokens?.requests??"?")+" worker requests, "+fresh+" fresh tokens, "+(tokens?.cacheRead??"?")+" cache-read tokens (kept apart); cost "+cost+"; outcome "+(telemetry.outcome?.state??"not recorded")
}
export type WorkflowReport=ReturnType<typeof reportWorkflowOutcomes>
