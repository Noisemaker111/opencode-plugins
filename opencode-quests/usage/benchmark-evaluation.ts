import { aggregateTelemetry,normalizeTokens,type RequestRecord } from "./telemetry"
export type Trial = { id:string;taskID:string;routeID:string;startedAt:number;completedAt:number;sessionIDs:string[];accepted:boolean|null;verification:{command:string;exitCode:number;artifact:string}[];phases:{kind:"prompting"|"execution"|"watching"|"handoff"|"review"|"retry";milliseconds:number}[] }
export function evaluateTrials(trials:Trial[],records:RequestRecord[]) {
 records=records.map(r=>({...r,tokens:normalizeTokens(r.tokens??{},{inputIncludesCache:false,outputIncludesReasoning:false})}))
 if(records.some(r=>r.actualCharge&&(!Number.isFinite(r.actualCharge.value)||r.actualCharge.value<0||!r.actualCharge.currency?.trim())))throw new Error("Invalid actual-charge measurement")
 if(new Set(trials.map(t=>t.id)).size!==trials.length)throw new Error("Duplicate trial IDs")
 const allSessions=trials.flatMap(t=>t.sessionIDs);if(new Set(allSessions).size!==allSessions.length)throw new Error("A session cannot be charged to multiple trials")
 const claimedSessions=new Map<string,string>()
 const rows=trials.map(t=>{
  if(![true,false,null].includes(t.accepted))throw new Error("Invalid trial acceptance state")
  if(!Number.isFinite(t.startedAt)||!Number.isFinite(t.completedAt)||t.completedAt<t.startedAt||t.phases.some(p=>!Number.isFinite(p.milliseconds)||p.milliseconds<0))throw new Error("Invalid trial timing")
  if(t.accepted===true&&(!t.verification.length||t.verification.some(v=>!v.command||!v.artifact||v.exitCode!==0)))throw new Error("Accepted results need successful verification artifacts")
  const sessions=new Set(t.sessionIDs);let changed=true;while(changed){changed=false;for(const r of records)if(r.parentID&&sessions.has(r.parentID)&&!sessions.has(r.sessionID)){sessions.add(r.sessionID);changed=true}}
  for(const sessionID of sessions){const owner=claimedSessions.get(sessionID);if(owner&&owner!==t.id)throw new Error("Worker session overlaps multiple trials: "+sessionID);claimedSessions.set(sessionID,t.id)}
  const requests=[...new Map(records.filter(r=>sessions.has(r.sessionID)).map(r=>[r.id,r])).values()],telemetry=aggregateTelemetry(requests)
  const measurementIssues:string[]=[]
  if(!requests.length)measurementIssues.push("No request measurements")
  if(requests.some(r=>r.state==="running"||!Number.isFinite(r.completedAt)||r.completedAt!<r.startedAt))measurementIssues.push("Unsettled or invalid request timing")
  if(requests.some(r=>!Number.isFinite(r.startedAt)||r.startedAt<t.startedAt||r.completedAt!>t.completedAt))measurementIssues.push("Request outside the recorded trial interval")
  if(requests.some(r=>Object.values(r.tokens).some(n=>n===null||!Number.isFinite(n)||n<0)))measurementIssues.push("Missing or invalid actual token counts")
  return {id:t.id,taskID:t.taskID,routeID:t.routeID,accepted:t.accepted,wallMilliseconds:t.completedAt-t.startedAt,phases:t.phases,telemetry,requestIDs:requests.map(r=>r.id),measurementIssues,measurementComplete:measurementIssues.length===0}
 })
 const grouped=[...new Set(rows.map(r=>r.routeID))].map(routeID=>{const items=rows.filter(r=>r.routeID===routeID),accepted=items.filter(r=>r.accepted===true).length,totalMilliseconds=items.reduce((n,r)=>n+r.wallMilliseconds,0)
  const actualCharges:Record<string,number>={},apiEquivalent:Record<string,{knownValue:number;unavailableRequests:number}>={}
  for(const item of items){for(const [currency,value]of Object.entries(item.telemetry.actualCharges))actualCharges[currency]=(actualCharges[currency]??0)+value;for(const[currency,value]of Object.entries(item.telemetry.apiEquivalent)){const c=apiEquivalent[currency]??={knownValue:0,unavailableRequests:0};c.knownValue+=value.knownValue;c.unavailableRequests+=value.unavailableRequests}}
  return {routeID,trials:items.length,accepted,rejected:items.filter(r=>r.accepted===false).length,unjudged:items.filter(r=>r.accepted===null).length,totalMilliseconds,millisecondsPerAcceptedResult:accepted?totalMilliseconds/accepted:null,actualCharges,apiEquivalent,overhead:items.flatMap(r=>r.phases).reduce((total,p)=>({...total,[p.kind]:(total[p.kind]??0)+p.milliseconds}),{} as Record<string,number>)}
 })
 return {trials:rows,routes:grouped,note:"Includes rejected trials and observed overhead. Missing prices and unjudged outcomes remain unavailable; API equivalent is not an actual charge."}
}
