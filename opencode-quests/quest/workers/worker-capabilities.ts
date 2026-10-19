import {userGiverID} from '../giver/user-giver'
import {giverBrief} from '../giver/giver-brief'
import {assertWorkerIdentity,assertWorkerRequestIdentity} from './worker-identity'
import {mkdirSync} from 'node:fs'
import {writeFileDurable,readJsonRecord} from '../core/durable-file.mjs'
import {join} from 'node:path'
import {QuestError} from '../api'
import {questMemberships,researchTools} from '../permissions/shared-guard'
import type {QuestStore} from '../store'
export const SESSION_MOVE_NOTE='When you create a worktree outside the current working directory'
const GIVER_EXECUTE_NOTE='Manage Quests and select projects with this native tool.'
const WORKER_EXECUTE_NOTE='Save assigned Quest results through the callable quest_report tool inside execute.'
const names=(tools:any[]):string[]=>tools.flatMap(t=>typeof t?.function?.name==='string'?[t.function.name]:Array.isArray(t?.tools)?names(t.tools):typeof t?.name==='string'?[t.name]:[])
const size=(value:unknown)=>value===undefined?0:Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value))
export function requestShape(body:any){
 const items:any[]=[...(Array.isArray(body?.messages)?body.messages:[]),...(Array.isArray(body?.input)?body.input:[])]
 const system=items.filter(item=>item?.role==='system'||item?.role==='developer')
 const toolBytes:Record<string,number>={}
 for(const tool of Array.isArray(body?.tools)?body.tools:[])toolBytes[tool?.function?.name??tool?.name??'unnamed']=size(tool)
 return {envelopeBytes:size(body),systemBytes:size(body?.system)+size(body?.instructions)+system.reduce((sum,item)=>sum+size(item.content),0),toolBytes,conversationBytes:items.filter(item=>!system.includes(item)).reduce((sum,item)=>sum+size(item),0),messages:items.length-system.length}
}
const systemLabel=(text:string)=>{const first=text.split('\n',1)[0]!.trim();return first.startsWith('Instructions from: ')?first:first.slice(0,60)}
export async function installWorkerCapabilities(ctx:any,store:QuestStore){
 const measured=new Set<string>(),partsMeasured=new Set<string>()
 const systemParts=(event:any)=>{if(partsMeasured.has(event.sessionID)||!Array.isArray(event.system))return;partsMeasured.add(event.sessionID);save(event.sessionID,{firstSystemParts:event.system.map((part:any)=>({label:systemLabel(String(part?.text??'')),bytes:size(String(part?.text??''))}))})}
 const member=(id:string)=>questMemberships(store,id).find(row=>(row.run.sessionID??row.run.openCodeSessionId)===id)
 const run=(id:string)=>member(id)?.run
 const records=new Map<string,any>()
 const save=(id:string,value:any)=>{
  const row=run(id),giver=userGiverID(store)===id;if(!row?.runID&&!giver)return
  const dir=join(store.runtime,giver?'giver-capabilities':'worker-capabilities'),file=join(dir,(row?.runID??id)+'.json')
  const held=records.get(file)??(readJsonRecord(file)??{}),{observedAt,...prior}=held,next={...prior,...value,sessionID:id}
  records.set(file,held);if(JSON.stringify(next)===JSON.stringify(prior))return
  const saved={...next,observedAt:new Date().toISOString()}
  mkdirSync(dir,{recursive:true});writeFileDurable(file,JSON.stringify(saved));records.set(file,saved)
 }
 const shape=(event:any,assignment:ReturnType<typeof run>)=>{
  if(!assignment){
   delete event.tools?.subagent
   if(event.tools?.execute&&!String(event.tools.execute.description??'').startsWith(GIVER_EXECUTE_NOTE))event.tools.execute.description=GIVER_EXECUTE_NOTE+' Call execute with '+JSON.stringify({code:'return await tools.quests.create({title:"...",start:true})'})+'. The Quest and project signatures are in your session context; searching for them returns what you already hold. The host saves the user\'s message verbatim on the Quest as its description and its workers\' task, and keeps every backslash JavaScript would drop from a string (as in \\s or \\.), so copy regexes and paths as written.\n'+(event.tools.execute.description??'')
   if(Array.isArray(event.system))event.system.push({type:'text',text:giverBrief(store,event.sessionID)})
   return
  }
  if(Array.isArray(event.system)){const note=event.system.findIndex((part:any)=>String(part?.text??part).startsWith(SESSION_MOVE_NOTE));if(note>=0)event.system.splice(note,1)}
  if((assignment.scope as any)?.readOnly===true)for(const name of Object.keys(event.tools??{}))if(!researchTools.has(name))delete event.tools[name]
  if(event.tools?.execute){
   const example=JSON.stringify({code:'return await tools.quest_report({id:"<assigned Quest ID>",stepID:"<assigned step ID>",state:"done",note:"<actual outcome>"})'})
   if(!String(event.tools.execute.description??'').startsWith(WORKER_EXECUTE_NOTE))event.tools.execute.description=WORKER_EXECUTE_NOTE+' Call execute with '+example+'. Its returned revision and step confirm the save; retry only when the call fails.\n'+(event.tools.execute.description??'')
  }
 }
 await ctx.session.hook('context',(event:any)=>{
  const assignment=run(event.sessionID);if(!assignment){
   if(event.agent==='quest-giver'){shape(event,undefined);save(event.sessionID,{modelTools:Object.keys(event.tools??{})});systemParts(event)}
   return
  }
  assertWorkerIdentity(assignment,event)
  shape(event,assignment)
  const tools=Object.keys(event.tools??{});save(event.sessionID,{modelTools:tools});systemParts(event)
  if(!tools.includes('execute'))throw new QuestError('WORKER_TOOLS_UNAVAILABLE','Worker cannot save assigned Quest results: the host exposed neither Code Mode execute nor quest. Parent must repair tool readiness before another dispatch.')
 })
 await ctx.session.hook('compaction',(event:any)=>{const assignment=run(event.sessionID);if(assignment||event.agent==='quest-giver')shape(event,assignment)})
 await ctx.session.hook('http.request',async(event:any)=>{
  const assignment=run(event.sessionID);if(!assignment&&userGiverID(store)!==event.sessionID)return
  if(assignment){
   const session=event.agent==='compaction'?await ctx.session.get({sessionID:event.sessionID}):undefined
   assertWorkerRequestIdentity(assignment,event,session?.data??session)
  }
  if(measured.has(event.sessionID))return
  try{const body=await event.request.clone().json(),primary=(event.kind??'primary')==='primary';if(primary)measured.add(event.sessionID);save(event.sessionID,{...(Array.isArray(body.tools)?{outboundTools:names(body.tools),requestKind:event.kind??'unknown'}:{}),...(primary?{firstRequest:requestShape(body)}:{})})}catch(error){console.error('[quests] worker capability observation failed',String(error))}
 })
}
