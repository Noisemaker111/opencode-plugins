import {createHash} from 'node:crypto'
import {userGiverID,giverContext,verifyGiverBinding} from '../giver/user-giver'
import type {QuestStore} from '../store'
import {assertWorkerIdentity} from '../workers/worker-identity'
import {redact,redactSensitive} from '../privacy'
import type {Quest,QuestSession} from '../types'
import {existsSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
export function projectInstructions(run:QuestSession){
 for(const directory of [run.scope?.worktree,(run.scope as any)?.giverInstructionDirectory,run.scope?.repo]){
  if(typeof directory!=='string'||!directory)continue
  const file=join(directory,'AGENTS.md')
  try{if(existsSync(file))return redactSensitive(readFileSync(file,'utf8'))}catch{}
 }
 return undefined
}
export const workerSessionID=(run:QuestSession)=>run.openCodeSessionId??run.openCodeSessionID??run.sessionID
export const permissionSummary=(request:any)=>{
 const action=String(request.action??'permission')
 const resources=['read','external_directory'].includes(action)&&Array.isArray(request.resources)?request.resources.map((value:any)=>String(value)):[]
 return {action,resources}
}
export function permissionReplyInput(input:{quest:Quest|undefined;runID:string;giverID:string|undefined;activeID:string|undefined;worker:any;shown:any;pending:any[];reply:'once'|'reject'}) {
 const {quest,runID,giverID,activeID,worker,shown,pending,reply}=input
 if(!giverID||activeID!==giverID)throw Error('Return to your Quest Giver before replying.')
 const run=quest?.sessions.find(run=>(run.runID??run.callID)===runID)
 if(!run||quest?.state==='Archived'||!['executing','waiting','blocked'].includes(run.state)||run.harness)throw Error('Worker ownership changed. Open the worker to inspect it.')
 const id=workerSessionID(run)
 if(!id||worker?.id!==id||shown?.sessionID!==id||!shown?.id)throw Error('Permission does not belong to this worker.')
 assertWorkerIdentity(run,worker)
 const current=pending.find(request=>request.id===shown.id&&request.sessionID===id)
 const identity=(request:any)=>JSON.stringify([request?.action,request?.resources,request?.save,request?.source])
 if(!current||identity(current)!==identity(shown))throw Error('This request changed or was already answered. Review current requests again.')
 if(reply!=='once'&&reply!=='reject')throw Error('Persistent access must be reviewed in the native worker permission dialog.')
 return {sessionID:id,requestID:current.id,reply}
}

export const permissionKey=(request:any)=>createHash('sha256').update(JSON.stringify([request.id,request.sessionID,request.action,request.resources,request.save,request.source])).digest('hex')
const unwrap=(value:any)=>value?.data??value
export class WorkerPermissions {
 constructor(readonly store:QuestStore,readonly host:any,readonly permission:any){}
 private async owned(callerID:string,questID:string,runID:string){
   if(!callerID||userGiverID(this.store)!==callerID)throw Error('Only the registered Quest Giver can decide worker permissions.')
   const caller=unwrap(await this.host.get({sessionID:callerID}))
   await verifyGiverBinding(this.store,giverContext(this.store,caller,'permission-decision',questID),caller)
  const quest=this.store.read(questID),run=quest?.sessions.find(s=>(s.runID??s.callID)===runID)
  if(!quest||quest.state==='Archived'||!run||!['executing','waiting','blocked'].includes(run.state)||run.harness)throw Error('No active native assignment owns this request.')
  return {quest,run}
 }
 async inspect(callerID:string,questID:string,runID:string){
  const {quest,run}=await this.owned(callerID,questID,runID),sessionID=workerSessionID(run)!
   const pending=unwrap(await this.permission.list({sessionID}))
  if(!Array.isArray(pending))throw Error('Worker permission list returned an invalid response.')
  const requests=pending
  if(!requests.length)return {questID,runID,title:quest.title,description:quest.description||quest.objective,steps:quest.stages.filter(s=>run.deliverables.includes(s.id)).map(s=>({id:s.id,title:s.title,detail:s.detail})),workspace:run.scope?.worktree,repo:run.scope?.repo,requests:[]}
  const messages=await this.host.context({sessionID})
  const first=unwrap(messages).find((m:any)=>m.type==='user'&&typeof m.text==='string')
  return {starter:first?redactSensitive(first.text):undefined,instructions:projectInstructions(run),questID,runID,title:quest.title,description:quest.description||quest.objective,steps:quest.stages.filter(s=>run.deliverables.includes(s.id)).map(s=>({id:s.id,title:s.title,detail:s.detail})),workspace:run.scope?.worktree,repo:run.scope?.repo,requests:requests.map((request:any)=>{
   const message=unwrap(messages).find((m:any)=>m.id===request.source?.messageID),part=message?.content?.find((p:any)=>p.type==='tool'&&p.id===request.source?.id),input=part?.state?.input
   const details=JSON.stringify({tool:part?.name,input}),sanitized=redactSensitive(details)
   return {requestID:request.id,requestKey:permissionKey(request),...permissionSummary(request),source:sanitized,sourceCharacters:sanitized.length,canApprove:!!part?.name&&!!input&&typeof input==='object'&&sanitized===details}
  })}
 }
 async reply(callerID:string,input:{questID:string;runID:string;requestID:string;requestKey:string;reply:'once'|'reject';reason:string},actor:'user'|'jev'|'rule',permissionJevModel?:string,jevSessionID?:string){
  const {quest,run}=await this.owned(callerID,input.questID,input.runID),sessionID=workerSessionID(run)!
  if(!input.reason?.trim())throw Error('Record the existing authorization or reason for rejection.')
   const pending=unwrap(await this.permission.list({sessionID})),shown=pending.find((p:any)=>p.id===input.requestID)
  if(!shown||permissionKey(shown)!==input.requestKey)throw Error('Request changed or was already answered; inspect it again.')
  if(actor!=='user'&&input.reply==='once'){
   const view=await this.inspect(callerID,input.questID,input.runID)
   if(!view.requests.find((r:any)=>r.requestID===input.requestID)?.canApprove)throw Error('Part of this action was redacted as sensitive, so it cannot be approved unseen. Use native review, or reject an unnecessary request.')
  }
  const worker=unwrap(await this.host.get({sessionID})),reply=permissionReplyInput({quest:this.store.read(quest.id),runID:input.runID,giverID:userGiverID(this.store),activeID:callerID,worker,shown,pending,reply:input.reply})
  const decision={requestID:input.requestID,requestKey:input.requestKey,request:JSON.parse(redactSensitive(JSON.stringify(shown))),reply:input.reply,actor,...(permissionJevModel?{model:permissionJevModel}:{}),...(jevSessionID?{jevCall:{sessionID:jevSessionID}}:{}),reason:redact(input.reason,1500),at:new Date().toISOString()}
  const save=(state:'sending'|'acknowledged'|'unknown')=>this.store.apply(quest.id,'session-state',{callID:run.callID,state:this.store.read(quest.id)?.sessions.find(s=>s.callID===run.callID)?.state??run.state,preserveTerminal:true,permissionDecision:{...decision,state}},'quest:permission-decision')
  save('sending')
   const message=input.reply==='reject'?`This request was refused: ${decision.reason.replace(/[.!?]$/, '')}; continue the rest of your assignment without this action.`:undefined
   try{await this.permission.reply({...reply,decision:reply.reply,...(message?{message}:{})})}catch(error){save('unknown');throw error}
  let delivered=false
  try{const after=unwrap(await this.permission.list({sessionID}));delivered=Array.isArray(after)&&!after.some((p:any)=>p.id===input.requestID)}catch{}
  if(!delivered){save('unknown');throw Error('The host accepted this '+(input.reply==='reject'?'rejection':'approval')+' but the request is still pending, so it cannot be confirmed as delivered. Nothing was granted twice; inspect the worker and retry the same request.')}
  save('acknowledged')
  return {acknowledged:true,reply:input.reply,reason:decision.reason,workerState:this.store.read(quest.id)?.sessions.find(s=>s.runID===input.runID)?.state}
 }
}
