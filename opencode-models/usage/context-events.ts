import {appendFileSync,existsSync,mkdirSync,readFileSync} from "node:fs"
import {enforceJsonlBudget,TELEMETRY_BUDGET} from "../scripts/telemetry-budget.mjs"
import {dirname} from "node:path"
import {acquireLock} from "../quest/locking.mts"
import {redact} from "../quest/privacy"
import {TELEMETRY_FILE} from "./telemetry-store"
import {firstDelivery} from "../scripts/first-delivery"
export type ContextEvent={id:string;sessionID:string;at:number;type:"started"|"ended"|"failed";receipt?:string;reason?:string;error?:string}
export const CONTEXT_EVENTS_FILE=TELEMETRY_FILE+".context.jsonl"
export function contextEvent(event:any):ContextEvent|undefined {
 if(!String(event?.type??"").startsWith("session.compaction."))return
 const type=String(event?.type??"").replace("session.compaction.","");if(!["started","ended","failed"].includes(type)||!event?.data?.sessionID||!event.id)return
 const at=typeof event.created==="number"?event.created:Date.parse(event.created);if(!Number.isFinite(at))return
 const error=event.data.error;return {id:event.id,sessionID:event.data.sessionID,at,type:type as ContextEvent["type"],receipt:event.data.inputID,reason:event.data.reason,error:error?redact(typeof error==="string"?error:error.message??error.data?.message??"Host compaction failed",1000):undefined}
}
export function recordContextEvent(event:ContextEvent,file=CONTEXT_EVENTS_FILE){const lock=acquireLock(dirname(file),"context-events");try{mkdirSync(dirname(file),{recursive:true});appendFileSync(file,JSON.stringify(event)+"\n",{mode:0o600});enforceJsonlBudget(file,TELEMETRY_BUDGET.contextBytes)}finally{lock.release()}}
export function readContextEvents(file=CONTEXT_EVENTS_FILE){const events=new Map<string,ContextEvent>(),diagnostics:string[]=[];if(existsSync(file))for(const[line,index]of readFileSync(file,"utf8").split("\n").map((line,index)=>[line,index] as const)){if(!line.trim())continue;try{const event=JSON.parse(line);if(!event.id||!event.sessionID||!Number.isFinite(event.at))throw Error();events.set(event.id,event)}catch{diagnostics.push("Unreadable context event at line "+(index+1))}}return {events:[...events.values()].sort((a,b)=>a.at-b.at),diagnostics}}
export async function installContextEvents(ctx:any,save=recordContextEvent){if(typeof ctx.event?.subscribe!=="function")return false;const stream=await ctx.event.subscribe({});void(async()=>{for await(const raw of stream){const event=contextEvent(raw);if(event&&firstDelivery("usage.context-events",raw))save(event)}})().catch(error=>console.error("[usage] context event collection failed",error instanceof Error?error.message:"unknown error"));return true}
