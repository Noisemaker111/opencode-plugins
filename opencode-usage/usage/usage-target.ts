import type {AccountUsage} from "../usage-service/on-computer"
import {accountRegime} from "./calibration-store"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import {writeFileDurable,readJsonRecord} from "../quest/core/durable-file.mjs"
import { dirname } from "node:path"
import { acquireLock } from "../quest/locking.mts"
import { TELEMETRY_FILE } from "./telemetry-store"
export const TARGETS_FILE=TELEMETRY_FILE+".targets.json"
export type QuestPacing={windowID:string;regime:string;resetAt:number;maxConcurrent:number}
export type UsageTarget={accountID:string;deadlineAt:number;reservePoints:number;updatedAt:number;pacing?:QuestPacing;followResets?:boolean}
export function readUsageTargets(file=TARGETS_FILE,strict=false):UsageTarget[]{
 const rows=strict?(existsSync(file)?JSON.parse(readFileSync(file,"utf8")):undefined):readJsonRecord(file)
 if(rows===undefined)return []
 if(!Array.isArray(rows)||rows.some(r=>typeof r.accountID!=="string"||![r.deadlineAt,r.reservePoints,r.updatedAt].every(Number.isFinite)||r.reservePoints<0||r.reservePoints>100))throw Error("Usage targets are unreadable")
 for(const row of rows){validateQuestPacing(row.pacing);validateResetFollowing(row.followResets,row.deadlineAt,row.pacing)}
 return rows
}
export function validateQuestPacing(pacing:QuestPacing|undefined){
 if(pacing&&(!pacing.windowID?.trim()||!pacing.regime?.trim()||!Number.isFinite(pacing.resetAt)||!Number.isInteger(pacing.maxConcurrent)||pacing.maxConcurrent<1||pacing.maxConcurrent>16))throw Error("Quest pacing requires an exact quota scope and concurrency ceiling from 1 to 16")
}
export function setUsageTarget(accountID:string,deadlineAt:number|null,reservePoints=0,file=TARGETS_FILE,now=Date.now(),pacing?:QuestPacing,followResets=false){
 validateQuestPacing(pacing);validateResetFollowing(followResets,deadlineAt,pacing)
 if(!accountID.trim()||deadlineAt!==null&&(!Number.isFinite(deadlineAt)||deadlineAt<=now)||!Number.isFinite(reservePoints)||reservePoints<0||reservePoints>100)throw Error("Target requires an account, a future deadline, and reserve between 0 and 100")
 const lock=acquireLock(dirname(file),"usage-targets")
 try{const rows=readUsageTargets(file,true).filter(r=>r.accountID!==accountID),target=deadlineAt===null?null:{accountID,deadlineAt,reservePoints,updatedAt:now,...(pacing?{pacing}:{}),...(followResets?{followResets:true}:{})};if(target)rows.push(target);mkdirSync(dirname(file),{recursive:true});writeFileDurable(file,JSON.stringify(rows),{mode:0o600});return target}finally{lock.release()}
}

function validateResetFollowing(follow:unknown,deadlineAt:number|null,pacing?:QuestPacing){
 if(follow!==undefined&&typeof follow!=="boolean"||follow&&(!pacing||deadlineAt!==pacing.resetAt))throw Error("Following resets requires explicit pacing and a deadline equal to its observed reset")
}
export function renewUsageTargets(accounts:AccountUsage[],now=Date.now(),file=TARGETS_FILE){
 if(!Number.isFinite(now))throw Error("Invalid pacing clock")
 if(!readUsageTargets(file,true).some(t=>t.followResets))return readUsageTargets(file,true)
 const lock=acquireLock(dirname(file),"usage-targets")
 try{const rows=readUsageTargets(file,true);let changed=false
  for(const t of rows){if(!t.followResets||!t.pacing)continue
   const rollover=now>=t.deadlineAt
   const a=accounts.find(a=>a.id===t.accountID),w=a?.windows.find(w=>w.id===t.pacing!.windowID),at=Date.parse(w?.observedAt??""),reset=Date.parse(w?.resetAt??"")
   if(!a||a.state!=="available"||a.error||a.freshness?.stale||a.freshness?.resetPending||accountRegime(a)!==t.pacing.regime||w?.scope!=="shared"||w.state!=="available"||!Number.isFinite(at)||at>now||now-at>=30000||at<t.updatedAt||(rollover&&at<t.pacing.resetAt)||!Number.isFinite(reset)||reset<=now||reset===t.pacing.resetAt)continue
   t.deadlineAt=reset;t.pacing.resetAt=reset;t.updatedAt=now;changed=true
  }
  if(changed){mkdirSync(dirname(file),{recursive:true});writeFileDurable(file,JSON.stringify(rows),{mode:0o600})}return rows
 }finally{lock.release()}
}
