import {join} from 'node:path'
import {readJsonRecord,writeFileDurable} from '../core/durable-file.mjs'
import {acquireLock} from '../locking.mts'
import {readAllQuests} from '../index'
import {questReference} from '../core/references'
import type {Quest} from '../types'
import {handoffCosts,handoffCostSummary} from './handoff-cost'

export type HandoffSender='front'|'outside'
export type HandoffOutcome={kind:'created'|'folded'|'refused'|'not placed';quest?:string;title?:string;reason?:string}
export type HandoffRecord={messageID:string;sender:HandoffSender;text:string;sentAt:string;refusals:{quest:string;title:string;reason:string;at:string}[];reportedAt?:string;outcomes?:HandoffOutcome[];report?:string}
type Ledger={version:1;handoffs:HandoffRecord[]}

const REFUSAL_REASONS:Record<string,string>={
 DUPLICATE_QUEST:'an open Quest already holds this request',
 DUPLICATE_QUEST_TITLE:'a Quest made in the same Quest Giver turn already uses this title',
}

export const handoffOutcomeFile=(runtime:string)=>join(runtime,'giver-handoff-outcomes.json')
const unwrap=(value:any)=>value?.data??value

function read(runtime:string):Ledger{
 const row=readJsonRecord<Ledger>(handoffOutcomeFile(runtime))
 return row?.version===1&&Array.isArray(row.handoffs)?row:{version:1,handoffs:[]}
}

function change<T>(runtime:string,update:(ledger:Ledger)=>T):T{
 const lock=acquireLock(runtime,'giver-handoff-outcomes')
 try{
  const ledger=read(runtime),value=update(ledger)
  writeFileDurable(handoffOutcomeFile(runtime),JSON.stringify(ledger))
  return value
 }finally{lock.release()}
}

export function readHandoffs(runtime:string):HandoffRecord[]{return read(runtime).handoffs}

export function recordHandoffSent(runtime:string,input:{messageID:string;sender:HandoffSender;text:string}){
 change(runtime,ledger=>{
  if(ledger.handoffs.some(row=>row.messageID===input.messageID))return
  ledger.handoffs.push({messageID:input.messageID,sender:input.sender,text:input.text,sentAt:new Date().toISOString(),refusals:[]})
 })
}

export function refusalOf(error:unknown):{quest:string;title:string;reason:string}|undefined{
 const code=(error as any)?.code,quest=(error as any)?.quest as Quest|undefined
 if(typeof code!=='string'||!REFUSAL_REASONS[code]||!quest)return undefined
 return {quest:questReference(quest),title:quest.title,reason:REFUSAL_REASONS[code]}
}

export function recordHandoffRefusal(runtime:string,messageIDs:string[],error:unknown){
 const refusal=refusalOf(error)
 if(!refusal||!messageIDs.length)return
 change(runtime,ledger=>{
  for(const row of ledger.handoffs)if(messageIDs.includes(row.messageID)&&!row.reportedAt)row.refusals.push({...refusal,at:new Date().toISOString()})
 })
}

function placedOutcomes(row:HandoffRecord,quests:Quest[]):HandoffOutcome[]{
 const holding=quests.filter(q=>q.request?.some(request=>request.messageID===row.messageID&&!request.context))
 const placed=holding.map(q=>({kind:(Date.parse(q.createdAt)>=Date.parse(row.sentAt)?'created':'folded') as HandoffOutcome['kind'],quest:questReference(q),title:q.title}))
 const refused=row.refusals.filter(refusal=>!placed.some(outcome=>outcome.quest===refusal.quest)).map(refusal=>({kind:'refused' as const,quest:refusal.quest,title:refusal.title,reason:refusal.reason}))
 const outcomes=[...placed,...refused]
 if(outcomes.length)return outcomes
 const steered=quests.filter(q=>namedIn(row.text,q)&&Date.parse(q.updatedAt)>=Date.parse(row.sentAt)).map(q=>({kind:'folded' as const,quest:questReference(q),title:q.title}))
 return steered.length?steered:[{kind:'not placed'}]
}

const wordsOf=(text:string)=>new Set(text.split(/[^A-Za-z0-9_-]+/))
const namedIn=(text:string,quest:Pick<Quest,'id'|'ref'>)=>{const words=wordsOf(text);return [quest.id,quest.ref].some(name=>!!name&&words.has(name))}

export function routineHandoff(row:Pick<HandoffRecord,'sender'|'text'>,outcomes:HandoffOutcome[]):boolean{
 const words=wordsOf(row.text)
 return row.sender==='front'&&outcomes.length>0&&outcomes.every(outcome=>outcome.kind==='folded'&&!!outcome.quest&&words.has(outcome.quest))
}

const shown=(text:string)=>{const line=text.trim().split('\n')[0]??'';return line.length>160?line.slice(0,157)+'...':line}
const named=(outcome:HandoffOutcome)=>'"'+outcome.title+'" ('+outcome.quest+')'

export function handoffReport(row:HandoffRecord,outcomes:HandoffOutcome[]){
 const lines=outcomes.map(outcome=>
  outcome.kind==='created'?'HAND-OFF PLACED: the Quest Giver created '+named(outcome)+'.'
  :outcome.kind==='folded'?'HAND-OFF FOLDED: the Quest Giver put the work into '+named(outcome)+'. Check that it holds every outcome you asked for.'
  :outcome.kind==='refused'?'HAND-OFF REFUSED: the Quest Giver made no new Quest because '+outcome.reason+'. It used '+named(outcome)+'. Check that it holds every outcome you asked for.'
  :'HAND-OFF NOT PLACED: the Quest Giver ended its turn with no new Quest and no named existing Quest. Hand it on again or ask it why.')
 return [...lines,'Hand-off ('+(row.sender==='front'?'from you':'from an outside caller')+'): "'+shown(row.text)+'"'].join('\n')
}

function answered(messages:any[],messageID:string){
 const at=messages.findIndex(message=>message?.id===messageID)
 if(at<0)return false
 return messages.slice(at+1).some(message=>message?.type==='assistant'&&message.finish&&message.finish!=='tool-calls'&&message.finish!=='tool_calls')
}

export async function reportAnsweredHandoffs(input:{runtime:string;projectRoot:string;host:{context?:(input:{sessionID:string})=>Promise<unknown>};giverID:string;notify:(row:HandoffRecord,text:string,outcomes:HandoffOutcome[])=>Promise<boolean>}){
 const open=read(input.runtime).handoffs.filter(row=>!row.reportedAt)
 if(!open.length||typeof input.host.context!=='function')return []
 const messages=unwrap(await input.host.context({sessionID:input.giverID}))
 if(!Array.isArray(messages))return []
 const due=open.filter(row=>answered(messages,row.messageID))
 if(!due.length)return []
 const quests=readAllQuests(input.projectRoot).flatMap(entry=>entry.quest?[entry.quest]:[])
 const reported:HandoffRecord[]=[]
 for(const row of due){
  const outcomes=placedOutcomes(row,quests),text=handoffReport(row,outcomes)
  if(!await input.notify(row,text,outcomes))continue
  const saved=change(input.runtime,ledger=>{const current=ledger.handoffs.find(other=>other.messageID===row.messageID);if(!current||current.reportedAt)return undefined;Object.assign(current,{reportedAt:new Date().toISOString(),outcomes,report:text});return {...current}})
  if(saved)reported.push(saved)
 }
 return reported
}

export function handoffsPicture(runtime:string,now=Date.now()){
 const costs=handoffCosts(runtime),since=now-86_400_000
 const items=readHandoffs(runtime).slice().reverse().map(row=>({messageID:row.messageID,sender:row.sender,text:shown(row.text),sentAt:row.sentAt,state:row.reportedAt?'reported':'waiting for the Quest Giver',outcomes:row.outcomes??[],reportedAt:row.reportedAt??null,cost:costs.get(row.messageID)??null}))
 const day=items.filter(item=>Date.parse(item.sentAt)>=since&&item.cost).map(item=>item.cost!)
 return {at:now,lastDay:handoffCostSummary(day),items}
}
