import {questMemberships} from './shared-guard'
import {workerSessionID} from './worker-permissions'
import {readAllowedByRule,sameRepositoryAllowedByRule,secretFile,type PermissionDecision} from './permission-jev'
import {redactSensitive} from '../privacy'
import type {QuestStore} from '../store'
import type {Quest,QuestSession} from '../types'

export const READ_TOOLS=['read','glob','grep'] as const
export const SHELL_TOOLS=['shell','bash'] as const
export type ReadCall={tool:string;input:unknown}
const ACTIVE=new Set(['executing','waiting','blocked'])
const nameFields:Record<string,string>={glob:'pattern',grep:'include'}
const activeWorker=(run:QuestSession,sessionID:string)=>workerSessionID(run)===sessionID&&ACTIVE.has(run.state)&&!run.harness
export const assignedRepository=(run:QuestSession)=>typeof run.scope?.repo==='string'&&run.scope.repo?run.scope.repo:undefined
function readRule(run:QuestSession,request:{action:string;resources:string[]},call:ReadCall){
 const fields=call.input&&typeof call.input==='object'?call.input as Record<string,unknown>:{}
 const named=fields[nameFields[call.tool]??'']
 if(typeof named==='string'&&secretFile(named))return
 const workspace=typeof run.scope?.worktree==='string'?run.scope.worktree:undefined
 const asked={...request,source:JSON.stringify({tool:call.tool,input:call.input})}
 return sameRepositoryAllowedByRule({repo:assignedRepository(run),workspace,request:asked})??readAllowedByRule({workspace,request:asked})
}
function recordRead(store:QuestStore,quest:Quest,run:QuestSession,request:{id:string;sessionID:string;action:string;resources:string[];source?:Record<string,unknown>},reason:string){
 store.apply(quest.id,'session-state',{callID:run.callID,state:run.state,preserveTerminal:true,permissionDecision:{requestID:request.id,request:JSON.parse(redactSensitive(JSON.stringify(request))),reply:'once',state:'acknowledged',actor:'rule',reason,at:new Date().toISOString()}},'quest:permission-decision')
}
const allowedReason=(rule:{name:string;reason:string})=>'Allowed once by rule ('+rule.name+'): '+rule.reason+'.'
export function readAllowedAtAsk(store:QuestStore,event:any,call:ReadCall|undefined){
 if(event?.effect!=='ask'||event.source?.type!=='tool'||!call||typeof event.sessionID!=='string')return
 const member=questMemberships(store,event.sessionID).find(({run,archived})=>!archived&&activeWorker(run,event.sessionID))
 if(!member)return
 const request={action:String(event.action),resources:Array.isArray(event.resources)?event.resources.map(String):[]}
 const rule=readRule(member.run,request,call)
 if(!rule)return
 const reason=allowedReason(rule)
 try{recordRead(store,member.quest,member.run,{id:'rule_'+event.source.messageID+'_'+event.source.id+'_'+request.action,sessionID:event.sessionID,...request,source:event.source},reason)}catch(error){console.error('[quests] read decision not recorded',error instanceof Error?error.message:error)}
 return reason
}
export async function allowAskedRead(store:QuestStore,host:any,permission:any,quest:Quest,run:QuestSession,request:any):Promise<PermissionDecision|undefined>{
 const sessionID=workerSessionID(run)
 if(!sessionID||request?.sessionID!==sessionID||request.source?.type!=='tool'||!activeWorker(run,sessionID))return
 const messages=await host.context({sessionID}),rows=(messages as any)?.data??messages
 const message=(Array.isArray(rows)?rows:[]).find((m:any)=>m.id===request.source.messageID),part=message?.content?.find((p:any)=>p.type==='tool'&&p.id===request.source.id)
 if(typeof part?.name!=='string'||!part.state?.input||typeof part.state.input!=='object')return
 const rule=readRule(run,{action:String(request.action),resources:Array.isArray(request.resources)?request.resources.map(String):[]},{tool:part.name,input:part.state.input})
 if(!rule)return
 const reason=allowedReason(rule)
 await permission.reply({sessionID,requestID:request.id,reply:'once',decision:'once'})
 try{recordRead(store,quest,run,request,reason)}catch(error){console.error('[quests] read decision not recorded',error instanceof Error?error.message:error)}
 return {state:'allowed',actor:'rule',rule:rule.name,reason}
}
