import {mkdirSync} from "node:fs"
import {writeFileDurable,readJsonRecord} from "../quest/core/durable-file.mjs"
import {dirname,join} from "node:path"
import {acquireLock} from "../quest/locking.mts"
import {TELEMETRY_FILE} from "../usage/telemetry-api"
import {recordInstructionRevision} from "../usage/request-context"
import {firstDelivery} from "../scripts/first-delivery"
type State={revision:number;seen:string[]}
export class InstructionRevisions {
 constructor(readonly directory:string){}
 private file(sessionID:string){if(!/^[a-zA-Z0-9_-]{1,150}$/.test(sessionID))throw Error("Invalid context session identity");return join(this.directory,sessionID+".runtime.json")}
 state(sessionID:string):State{const file=this.file(sessionID);const {revision=0,seen=[]}=readJsonRecord(file)??{};return {revision,seen}}
 async event(event:any){
  const user=event?.type==="session.inbox.enqueued"&&event.data?.item?.type==="user"
  if(!user&&event?.type!=="session.instructions.updated")return
  const sessionID=event.data?.sessionID;if(!sessionID||!event.id)return
  const file=this.file(sessionID),lock=acquireLock(dirname(file),"context-runtime-"+sessionID)
  let state:State
  try{state=this.state(sessionID);if(state.seen.includes(event.id))return;state.revision++;state.seen.push(event.id);mkdirSync(dirname(file),{recursive:true});writeFileDurable(file,JSON.stringify(state),{mode:0o600})}finally{lock.release()}
  const created=typeof event.created==="number"?event.created:Date.parse(event.created)
  recordInstructionRevision(sessionID,state.revision,Date.now(),Number.isFinite(created)?created:undefined)
 }
}
export async function installInstructionRevisions(ctx:any){
 const revisions=new InstructionRevisions(join(dirname(TELEMETRY_FILE),"context"))
 if(ctx.event?.subscribe){const stream=await ctx.event.subscribe({});void(async()=>{for await(const event of stream)try{if(firstDelivery("models.adaptive-context",event))await revisions.event(event)}catch(error){console.error("[models] Instruction revision retained with error",error instanceof Error?error.message:"unknown error")}})().catch(error=>console.error("[models] Instruction revision events failed",error instanceof Error?error.message:"unknown error"))}
 return revisions
}
