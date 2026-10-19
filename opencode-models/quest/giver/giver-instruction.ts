import {createHash} from 'node:crypto'
import {mkdirSync} from 'node:fs'
import {writeFileDurable,readJsonRecord} from '../core/durable-file.mjs'
import {join} from 'node:path'
import {acquireLock} from '../locking.mts'
import type {QuestRequest} from '../types'
import {QuestError} from '../api'

type State={pending:Record<string,boolean>;delivered?:{id:string;at:number};unknownAt?:number}
export const automaticQuestPrompt=(metadata:any)=>metadata?.questWorkerReturn===true||metadata?.questWorkerPermission===true||metadata?.questAttention===true||metadata?.questHandoff===true||metadata?.projectRouterGoal===true||metadata?.projectRouterReturn===true||giverHandoffPrompt(metadata)
export const giverHandoffPrompt=(metadata:any)=>metadata?.questGiverHandoff===true||metadata?.questSessionHandoff===true
const key=(sessionID:string)=>createHash('sha256').update(sessionID).digest('hex')
const file=(runtime:string,sessionID:string)=>join(runtime,'giver-instructions',key(sessionID)+'.json')
function read(runtime:string,sessionID:string):State{
 const path=file(runtime,sessionID)
 return readJsonRecord<State>(path)??{pending:{}}
}
function change(runtime:string,sessionID:string,update:(state:State)=>void){
 const lock=acquireLock(runtime,'giver-instruction-'+key(sessionID))
 try{
  const state=read(runtime,sessionID);update(state)
  const path=file(runtime,sessionID);mkdirSync(join(runtime,'giver-instructions'),{recursive:true})
  writeFileDurable(path,JSON.stringify(state))
 }finally{lock.release()}
}
export function observeGiverInstruction(runtime:string,event:any){
 const {sessionID,inboxID,item}=event?.data??{}
 if(typeof sessionID!=='string'||typeof inboxID!=='string'||!['session.inbox.enqueued','session.inbox.delivered','session.inbox.cancelled'].includes(event.type))return
 const at=typeof event.created==='number'?event.created:Date.parse(event.created)
 if(!Number.isFinite(at))return
 change(runtime,sessionID,state=>{
  if(event.type==='session.inbox.enqueued'){state.pending[inboxID]=item?.type==='user'&&!automaticQuestPrompt(item.payload?.metadata);return}
  if(event.type==='session.inbox.cancelled'){delete state.pending[inboxID];return}
  if(state.delivered?.id===inboxID)return
  const human=state.pending[inboxID];delete state.pending[inboxID]
  if(human===undefined){state.unknownAt=Math.max(state.unknownAt??0,at);return}
  if(human&&(state.delivered?.at??0)<=at)state.delivered={id:inboxID,at}
 })
}
const human=(message:any)=>message?.type==='user'&&!automaticQuestPrompt(message.metadata)&&typeof message.id==='string'
const endsTurn=(message:any)=>message?.type==='idle'||message?.type==='assistant'&&Array.isArray(message.content)&&message.content.length>0&&!message.content.some((part:any)=>part?.type==='tool')
const quoted=(text:string)=>text.toLowerCase().replace(/\s+/g,' ').trim()
const QUEST_WRITE=/\btools\s*\.\s*quests\s*\.\s*(?:update|run|start|stop)\s*\(/
const writesQuests=(message:any)=>message?.type==='assistant'&&Array.isArray(message.content)&&message.content.some((part:any)=>part?.type==='tool'&&QUEST_WRITE.test(String(part.state?.input?.code??part.input?.code??'')))
function questionAnswers(message:any):any[]{
 if(message?.type!=='assistant'||!Array.isArray(message.content))return []
 return message.content.flatMap((part:any)=>{
  if(part?.type!=='tool'||part.name!=='question'||part.state?.status!=='completed')return []
  const text=(part.state.metadata?.answers as unknown[]|undefined)?.flatMap(answer=>Array.isArray(answer)?answer:[answer]).filter((answer):answer is string=>typeof answer==='string'&&answer.trim().length>0).join('\n')
  return text?[{type:'user',id:String(message.id)+':'+String(part.id??part.callID??'question'),text,time:{created:part.state.time?.completed??message.time?.created}}]:[]
 })
}
function turnUserMessages(messages:any[],assistantIndex:number,earlierTurns:boolean):{found:any[];crossedTurnEnd:boolean;notices:any[];answers:any[];actedOn:Set<string>}{
 const found:any[]=[],notices:any[]=[],answers:any[]=[],actedOn=new Set<string>()
 let crossedTurnEnd=false,laterWrite=false
 for(let i=assistantIndex-1;i>=0;i--){
  const message=messages[i]
  if(endsTurn(message)){if(found.length||!earlierTurns)break;crossedTurnEnd=true;continue}
  answers.unshift(...questionAnswers(message))
  if(writesQuests(message))laterWrite=true
  if(human(message)){found.unshift(message);if(laterWrite)actedOn.add(message.id)}
  else if(!crossedTurnEnd&&message?.type==='user'&&typeof message.id==='string'&&typeof message.text==='string')notices.unshift(message)
 }
 return {found,crossedTurnEnd,notices,answers,actedOn}
}
function requestOf(message:any):QuestRequest|undefined{
 if(typeof message?.text!=='string'||!message.text.trim())return
 const created=Number(message.time?.created)
  return {messageID:message.id,text:message.text,at:new Date(Number.isFinite(created)?created:Date.now()).toISOString(),...(message.metadata?.questHistoryOrigin?{origin:message.metadata.questHistoryOrigin}:{})}
}
export function noticeQuestIDs(messages:any[],assistantIndex:number):string[]{
 const {notices}=turnUserMessages(messages,assistantIndex,true)
 const ids=notices.flatMap(message=>[message.metadata?.questID,...(Array.isArray(message.metadata?.questIDs)?message.metadata.questIDs:[])])
 return [...new Set(ids.filter((id:unknown):id is string=>typeof id==='string'&&id.length>0))]
}
export function handoffTurn(messages:any[],assistantIndex:number):boolean{
 const {found,notices}=turnUserMessages(messages,assistantIndex,false)
 return !found.length&&notices.some(message=>giverHandoffPrompt(message.metadata))
}
export type Attribution={turnID:string;request:QuestRequest[];laterTurn?:true}
export function attributeRequest(messages:any[],assistantIndex:number,fromMessage:unknown,earlierTurns:boolean,answered:(messageID:string)=>boolean=()=>false):Attribution|undefined{
 const {found:turn,crossedTurnEnd,notices,answers,actedOn}=turnUserMessages(messages,assistantIndex,earlierTurns)
 const wanted=fromMessage===undefined?undefined:typeof fromMessage==='string'?quoted(fromMessage):''
 if(wanted!==undefined&&!/\w/.test(wanted))throw new QuestError('INVALID_INPUT','fromMessage: quote a few words from the user message this answers')
 const rows=turn.flatMap(message=>{const row=requestOf(message);return row?[row]:[]})
 const matches=wanted===undefined?[]:rows.filter(row=>quoted(row.text).includes(wanted))
 if(wanted!==undefined&&!matches.length){
  const notice=notices.findLast(message=>quoted(message.text).includes(wanted))
  if(notice)return {turnID:notice.id,request:[]}
  const answer=answers.findLast(message=>quoted(message.text).includes(wanted)),row=answer&&requestOf(answer)
  if(row)return {turnID:turn[0]?.id??answer.id,request:[row]}
 }
 if(!turn.length){
  if(wanted!==undefined&&!earlierTurns)throw new QuestError('QUOTE_NOT_FOUND','fromMessage: no user message or Quest notice in this turn holds those words, so there is nothing to quote. Leave fromMessage out.')
  return
 }
 const turnID=turn[0].id
 if(wanted!==undefined){
  if(!matches.length)throw new QuestError('QUOTE_NOT_FOUND','fromMessage: those words are not in any of the '+rows.length+' user message'+(rows.length===1?'':'s')+' this turn answers. Quote the message exactly.')
  if(new Set(matches.map(row=>row.text)).size>1)throw new QuestError('INVALID_INPUT','fromMessage: those words are in '+matches.length+' of the user messages this turn answers. Quote words only the one this answers holds.')
  return {turnID,request:[matches[0]],...(crossedTurnEnd?{laterTurn:true as const}:{})}
 }
 const handledHere=(row:QuestRequest)=>actedOn.has(row.messageID)&&!answered(row.messageID)
 const open=rows.filter(row=>!answered(row.messageID)&&!handledHere(row)),latest=rows.at(-1)
 if(crossedTurnEnd&&!open.length)return {turnID:notices[0]?.id??turnID,request:[]}
 if(!open.length&&rows.some(handledHere))return {turnID,request:rows.filter(handledHere).map(row=>({...row,context:true as const}))}
 const pool=crossedTurnEnd?open:latest&&answered(latest.messageID)?[latest]:open.length?open:rows
 return {turnID,request:pool.length>1?pool.map(row=>({...row,unattributed:true as const})):pool}
}
export function giverInstruction(runtime:string,sessionID:string,messages:any[],assistantIndex:number,fromMessage?:unknown,answered?:(messageID:string)=>boolean):Attribution|undefined{
 const attribution=attributeRequest(messages,assistantIndex,fromMessage,true,answered)
 if(attribution&&!attribution.request.length)return attribution
 if(attribution){
  const latest=messages.slice(0,assistantIndex).findLast(message=>message?.id===(attribution.request.at(-1)?.messageID??attribution.turnID))
  const at=Number(latest?.time?.created)
  if(Number.isFinite(at))change(runtime,sessionID,state=>{if((state.delivered?.at??0)<=at)state.delivered={id:latest.id,at}})
  return attribution
 }
 const assistant=messages[assistantIndex]
 const state=read(runtime,sessionID),created=Number(assistant?.time?.created)
 if(state.delivered&&state.delivered.at<=created&&(state.unknownAt??0)<=state.delivered.at)return {turnID:state.delivered.id,request:[]}
}
