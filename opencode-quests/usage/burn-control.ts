import {mkdirSync} from "node:fs"
import {writeFileDurable,readJsonRecord} from "../quest/core/durable-file.mjs"
import {dirname} from "node:path"
import {acquireLock} from "../quest/locking.mts"
import {TELEMETRY_FILE} from "./telemetry-store"
import {readUsageTargets,renewUsageTargets,type UsageTarget} from "./usage-target"
import {getAccountUsage,ACCOUNT_USAGE_FILE} from "../usage-service/on-computer"
import {readQuotaObservations} from "./calibration-store"
import {accountRegime} from "./calibration-store"
import {resetPlan} from "./reset-planner"
import type {AccountUsage} from "../usage-service/on-computer"
import type {Observation} from "./calibration"
export const BURN_CONTROL_FILE=TELEMETRY_FILE+".burn-control.json"
export type BurnControl={accountID:string;windowID:string;targetKey:string;deadlineAt:number;state:"ready"|"hold"|"stopped";desiredConcurrency:number;maxConcurrent:number;lastAdjustedAt:number;updatedAt:number;requiredPointsPerMinute:number|null;observedPointsPerMinute:number|null;reason:string}
export const burnTargetKey=(target:UsageTarget)=>JSON.stringify([target.accountID,target.deadlineAt,target.reservePoints,target.updatedAt,target.pacing])
export function decideBurnControl(target:UsageTarget,account:AccountUsage|undefined,observations:Observation[],prior:BurnControl|undefined,now:number):BurnControl {
 const scope=target.pacing!;if(!scope)throw Error("Explicit Quest pacing authorization required")
 const key=burnTargetKey(target)
 const current=prior?.targetKey===key?prior:undefined
 const result:BurnControl={accountID:target.accountID,windowID:scope.windowID,targetKey:key,deadlineAt:target.deadlineAt,state:"hold",desiredConcurrency:current?.desiredConcurrency??1,maxConcurrent:scope.maxConcurrent,lastAdjustedAt:current?.lastAdjustedAt??now,updatedAt:now,requiredPointsPerMinute:null,observedPointsPerMinute:null,reason:"Waiting for a fresh account observation"}
 const stop=(reason:string):BurnControl=>({...result,state:"stopped",desiredConcurrency:0,reason})
 if(!Number.isFinite(now)||now<target.updatedAt||current&&now<current.updatedAt)return {...result,reason:"Clock moved backwards; refresh before dispatch"}
 if(now>=scope.resetAt)return stop("Scoped quota window ended; no work admitted into a new window")
 if(!account)return {...result,reason:"Account is not currently connected"}
 const window=account.windows.find(w=>w.id===scope.windowID)
 if(accountRegime(account)!==scope.regime||!window||window.scope!=="shared"||Date.parse(window.resetAt??"")!==scope.resetAt)return stop("Account plan or quota scope changed; set a new target explicitly")
 if(account.state==="exhausted"||window.state==="exhausted")return stop("Provider reports exhausted allowance; no new work")
 const plan=resetPlan([account],observations,now,target.reservePoints,target.deadlineAt>now?target.deadlineAt:undefined).find(p=>p.windowID===scope.windowID)!
 if(plan.state!=="ready")return {...result,reason:plan.reason??"Quota observation unavailable"}
 result.requiredPointsPerMinute=plan.requiredPointsPerMinute;result.observedPointsPerMinute=plan.observedPointsPerMinute
 if(plan.spendablePoints===0 || now>=target.deadlineAt)return {...result,state:"ready",desiredConcurrency:1,reason:plan.spendablePoints===0?"Planned allocation reached; keep one worker available while provider access permits":"Target deadline passed; keep one worker available while provider access permits"}
 result.desiredConcurrency=Math.max(1,Math.min(scope.maxConcurrent,result.desiredConcurrency))
 result.state="ready";result.reason="Holding desired concurrency; ordinary access and reservation limits still apply"
 if(plan.observedPointsPerMinute!==null&&plan.requiredPointsPerMinute!==null&&now-result.lastAdjustedAt>=300000){
  const before=result.desiredConcurrency
  if(plan.observedPointsPerMinute<plan.requiredPointsPerMinute*.8)result.desiredConcurrency=Math.min(scope.maxConcurrent,Math.max(before+1,Math.ceil(before*(plan.observedPointsPerMinute>0?Math.min(2,plan.requiredPointsPerMinute/plan.observedPointsPerMinute):2))))
  else if(plan.observedPointsPerMinute>plan.requiredPointsPerMinute*1.2)result.desiredConcurrency=Math.max(1,before-1)
  result.lastAdjustedAt=now
  result.reason=result.desiredConcurrency>before?"Below target pace; request up to twice the slots within the configured ceiling":result.desiredConcurrency<before?"Above target pace; admit fewer new workers and let current work finish":plan.observedPointsPerMinute>plan.requiredPointsPerMinute*1.2?"Above target pace; one worker remains available":"Measured pace is within the adjustment band"
 }else if(plan.observedPointsPerMinute===null){
  result.desiredConcurrency=1
  result.reason="Pace unavailable; keep one useful worker available, subject to provider access and ownership"
 }
 return result
}
export function readBurnControls(file=BURN_CONTROL_FILE):BurnControl[]{
 const rows=readJsonRecord(file)
 if(rows===undefined)return []
 if(!Array.isArray(rows)||rows.some(r=>!r.accountID||!r.targetKey||!['ready','hold','stopped'].includes(r.state)||![r.desiredConcurrency,r.maxConcurrent,r.deadlineAt,r.updatedAt,r.lastAdjustedAt].every(Number.isFinite)||!Number.isInteger(r.desiredConcurrency)||!Number.isInteger(r.maxConcurrent)||r.maxConcurrent<1||r.maxConcurrent>16||r.desiredConcurrency<0||r.desiredConcurrency>r.maxConcurrent))throw Error("Invalid pacing ledger; preserve and inspect before dispatch")
 return rows
}
export function updateBurnControls(accounts:AccountUsage[],observations:Observation[],now:number|undefined=undefined,targets:UsageTarget[]|undefined=undefined,file=BURN_CONTROL_FILE){
 targets??=renewUsageTargets(accounts,now??Date.now())
 const lock=acquireLock(dirname(file),"burn-control")
 try{const at=now??Date.now(),prior=readBurnControls(file),rows=targets.filter(t=>t.pacing).map(t=>decideBurnControl(t,accounts.find(a=>a.id===t.accountID),observations,prior.find(p=>p.accountID===t.accountID),at));mkdirSync(dirname(file),{recursive:true});writeFileDurable(file,JSON.stringify(rows),{mode:0o600});return rows}finally{lock.release()}
}

export const PACING_OBSERVATION_WINDOW_MS=45*60000
export function readPacingObservations(now=Date.now()){
 return readQuotaObservations(ACCOUNT_USAGE_FILE+".observations",{from:now-PACING_OBSERVATION_WINDOW_MS}).observations
}
export async function assertBurnLaunchAllowed(accountID:string,loadUsage:typeof getAccountUsage=getAccountUsage){
 if(!readUsageTargets().some(t=>t.accountID===accountID&&t.pacing))return
 const accounts=await loadUsage({refresh:true})
 const control=updateBurnControls(accounts.accounts,readPacingObservations()).find(c=>c.accountID===accountID)
 if(control&&(control.state!=="ready"||control.desiredConcurrency===0))throw Error("Burn pacing "+(control.state==="stopped"?"stopped: ":"hold: ")+control.reason)
}
