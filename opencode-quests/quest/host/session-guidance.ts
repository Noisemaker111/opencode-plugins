import {questReference} from '../core/references'
import {SessionReferences} from './session-references'
import {assertWorkerIdentity} from '../workers/worker-identity'
import {createHash} from "node:crypto"
import {mkdirSync,realpathSync} from "node:fs"
import {writeFileDurable,readJsonRecord} from "../core/durable-file.mjs"
import {join} from "node:path"
import {QuestError,type QuestContext} from "../api"
import {QuestStore} from "../store"
import {acquireLock} from "../locking.mts"
import {readAllQuests} from "../index"
import type {QuestHost} from "../runs/runtime"
export type GuidanceRecord={id:string;questID:string;runID:string;sessionID:string;delivery:"queue"|"steer";text:string;state:"unknown"|"submitted"|"acknowledged";createdAt:number;updatedAt:number;note?:string}
const samePath=(a:string,b:string)=>{const norm=(p:string)=>process.platform==="win32"?realpathSync(p).toLowerCase():realpathSync(p);return norm(a)===norm(b)}
export class SessionGuidance {
 constructor(readonly store:QuestStore,readonly host:QuestHost,readonly options:{supported?:boolean}={}){}
 private get file(){return join(this.store.runtime,"session-guidance.json")}
 private read():GuidanceRecord[]{const rows=readJsonRecord(this.file);if(rows===undefined)return [];if(!Array.isArray(rows))throw Error("Invalid guidance ledger");return rows}
 private write(rows:GuidanceRecord[]){mkdirSync(this.store.runtime,{recursive:true});writeFileDurable(this.file,JSON.stringify(rows))}
 private quest(context:QuestContext,id:string){const q=this.store.read(id);if(!q)throw new QuestError("NOT_FOUND","Quest not found");if(q.project?.id!==context.project.id||!samePath(q.project.root,context.project.root))throw new QuestError("PROJECT_MISMATCH","Guidance belongs to another project");return q}
 status(context:QuestContext,questID:string){const q=this.quest(context,questID);if(q.integrationOwner!==context.sessionID&&!q.sessions.some(s=>s.sessionID===context.sessionID))throw new QuestError("GUIDANCE_OWNER_REQUIRED","Only the owning giver or worker can inspect guidance");return this.read().filter(r=>r.questID===q.id&&(q.integrationOwner===context.sessionID||r.sessionID===context.sessionID))}
 async send(context:QuestContext,input:{questID:string;runID:string;text:string;delivery?:"queue"|"steer"}){
  const quest=this.quest(context,input.questID),sessionRef=new SessionReferences(this.store.runtime).get(input.runID)
  const matching=quest.sessions.find(s=>(s.runID??s.callID)===input.runID||s.sessionRef===input.runID||(sessionRef&&[s.sessionID,s.openCodeSessionId].includes(sessionRef.sessionID)))
  input={...input,questID:quest.id,runID:matching?.runID??matching?.callID??input.runID}
  const delivery=input.delivery??"queue",text=input.text?.trim();if(!text||!["queue","steer"].includes(delivery))throw new QuestError("INVALID_INPUT","Provide relevant nonempty guidance and queue or steer delivery")
  const owned=()=>{const q=this.quest(context,input.questID);if(q.integrationOwner!==context.sessionID||readAllQuests(this.store.projectRoot,{includeArchived:true}).some(row=>row.quest?.sessions.some(s=>s.sessionID===context.sessionID)))throw new QuestError("GUIDANCE_OWNER_REQUIRED","Only the owning giver can guide workers");if(["Archived","Complete"].includes(q.state))throw new QuestError("GUIDANCE_TERMINAL","Quest is terminal");const run=q.sessions.find(s=>s.runID===input.runID);if(!run?.sessionID||!["executing","waiting","blocked"].includes(run.state))throw new QuestError("GUIDANCE_RUN_UNAVAILABLE","Run must be active in this Quest");if(run.runtime!=="native"||typeof run.scope?.worktree!=="string")throw new QuestError("GUIDANCE_HOST_UNSUPPORTED","Only bound native Quest workers support guidance");return run}
  const run=owned(),actual=await this.host.get({sessionID:run.sessionID}),session=actual?.data??actual;if(session?.id!==run.sessionID||typeof session?.location?.directory!=="string"||!samePath(session.location.directory,run.scope!.worktree as string))throw new QuestError("GUIDANCE_BINDING_FAILED","Host worker does not match the owned session and workspace")
  assertWorkerIdentity(run,session)
  if(!this.options.supported)throw new QuestError("GUIDANCE_HOST_UNSUPPORTED","Installed host guidance delivery has not been verified")
  const id="msg_"+createHash("sha256").update(JSON.stringify([input.questID,input.runID,run.sessionID,delivery,text])).digest("hex").slice(0,26)
  let record:GuidanceRecord;const lock=acquireLock(this.store.runtime,"session-guidance");try{owned();const rows=this.read(),old=rows.find(r=>r.id===id);if(old)return old;record={id,questID:input.questID,runID:input.runID,sessionID:run.sessionID!,delivery,text,state:"unknown",createdAt:Date.now(),updatedAt:Date.now(),note:"Submission outcome not yet confirmed; do not automatically resend"};rows.push(record);this.write(rows)}finally{lock.release()}
   try{owned();const prompt={id,text:"[Quest guidance "+id+"]\n"+text+"\nAcknowledge this guidance through quest_guidance with action=acknowledge, questID="+questReference(quest)+", guidanceID="+id+" when read; acknowledgement does not complete the assigned work.",delivery,resume:true};const reply=await this.host.prompt({sessionID:record.sessionID,...prompt});const receipt=reply?.data??reply;return this.settle(id,receipt?.id===id&&receipt?.sessionID===record.sessionID?"submitted":"unknown",receipt?.id===id&&receipt?.sessionID===record.sessionID?"Host accepted the message identity; worker acknowledgement pending":"Host returned no matching message receipt; delivery remains unknown")}
  catch{return this.settle(id,"unknown","Host submission failed or its result is ambiguous; inspect status, do not automatically retry")}
 }
 private settle(id:string,state:GuidanceRecord["state"],note:string){const lock=acquireLock(this.store.runtime,"session-guidance");try{const rows=this.read(),row=rows.find(r=>r.id===id)!;if(row.state!=="acknowledged"){row.state=state;row.note=note;row.updatedAt=Date.now();this.write(rows)}return row}finally{lock.release()}}
 acknowledge(context:QuestContext,input:{questID:string;guidanceID:string}){const q=this.quest(context,input.questID),row=this.read().find(r=>r.questID===q.id&&r.id===input.guidanceID);if(!row||row.sessionID!==context.sessionID||!q.sessions.some(s=>s.runID===row.runID&&s.sessionID===context.sessionID))throw new QuestError("GUIDANCE_WORKER_REQUIRED","Only the addressed worker can acknowledge guidance");return this.settle(row.id,"acknowledged","Worker explicitly acknowledged receipt; work remains governed by Quest step results")}
}
