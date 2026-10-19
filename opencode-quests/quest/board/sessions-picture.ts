import {Database} from 'bun:sqlite'
import {existsSync} from 'node:fs'
import {readAllQuests} from '../index'
import {questReference} from '../core/references'
import {OWNED_RUN,nativeRunID} from '../runs/session-lineage'
import {readOwnershipMap} from '../giver/ownership-map'
import {budgetPicture} from '../../usage/session-budget'
import {HOST_USAGE_DB} from '../../usage/host-counters'
import type {StatusReader} from '../runs/run-status'
import type {QuestStore} from '../store'
import type {Quest} from '../types'

const STARTER_CHARACTERS=1500
const MINIMUM_RATE_MS=60_000
const two=(value:number)=>Math.round(value*100)/100
const routeOf=(run:any)=>run.providerID&&run.modelID?run.providerID+'/'+run.modelID+(run.reasoningEffort?'#'+run.reasoningEffort:''):run.model??null
type HostRow={cost:number|null;version:string|null;model:string|null;created:number|null}
type SessionRow={role:'worker'|'giver';session:string|null;quest:string|null;title:string;run:string|null;state:string;status:string|null;route:string|null;release:string|null;startedAt:string|null
 toolCalls:number|null;toolCallsPerMinute:number|null;costUSD:number|null;weekSharePercent:number|null;fiveHourSharePercent:number|null;starterPrompt:string|null}
type Sources={hostFile?:string;accountFile?:string;ledgerFile?:string}

function hostRows(file:string,ids:string[]){
 const rows=new Map<string,HostRow&{starter:string|null}>()
 if(!ids.length||!existsSync(file))return rows
 let db:Database|undefined
 try{
  db=new Database(file,{readonly:true});db.exec('PRAGMA busy_timeout=1000')
  const session=db.query('SELECT cost,version,model,time_created created FROM session_v2 WHERE id=?')
  const first=db.query("SELECT json_extract(data,'$.text') text FROM session_message WHERE session_id=? AND type='user' ORDER BY seq LIMIT 1")
  for(const id of ids){
   const row=session.get(id) as HostRow|null
   const text=(first.get(id) as {text?:unknown}|null)?.text
   if(row)rows.set(id,{...row,starter:typeof text==='string'?text.slice(0,STARTER_CHARACTERS):null})
  }
 }catch{}finally{db?.close()}
 return rows
}

function shares(store:Pick<QuestStore,'projectRoot'|'runtime'>,sources:Sources,now:number){
 const by=new Map<string,{sharePercent:number;fiveHourPercent:number}>()
 try{
  for(const account of budgetPicture({projectRoot:store.projectRoot,runtime:store.runtime,ledgerFile:sources.ledgerFile,accountFile:sources.accountFile,hostFile:sources.hostFile,now:()=>now}).accounts)
   for(const s of account.sessions){const held=by.get(s.session)??{sharePercent:0,fiveHourPercent:0};by.set(s.session,{sharePercent:two(held.sharePercent+s.sharePercent),fiveHourPercent:two(held.fiveHourPercent+(s.fiveHourPercent??0))})}
 }catch{}
 return by
}

export function sessionsPicture(store:Pick<QuestStore,'projectRoot'|'runtime'>,now:number,reader:StatusReader,sources:Sources={}){
 const quests=readAllQuests(store.projectRoot).flatMap(row=>row.quest?[row.quest]:[]) as Quest[]
 const map=readOwnershipMap(store)
 const workers=quests.filter(q=>q.state!=='Archived').flatMap(q=>q.sessions.filter(run=>OWNED_RUN.has(run.state)).map(run=>({q,run,session:nativeRunID(run)??null})))
 const giver=map.currentGiver?.sessionID
 const file=sources.hostFile??HOST_USAGE_DB
 const host=hostRows(file,[...workers.flatMap(w=>w.session?[w.session]:[]),...(giver?[giver]:[])])
 const budget=shares(store,{...sources,hostFile:file},now)
 const rate=(startedAt:number|null,tools:number|null)=>{
  const span=startedAt===null?null:now-startedAt
  return {toolCalls:tools,toolCallsPerMinute:tools!==null&&span!==null&&span>=MINIMUM_RATE_MS?two(tools/(span/60_000)):null}
 }
 const items:SessionRow[]=workers.map(({q,run,session})=>{
  const row=session?host.get(session):undefined
  const evidence=(()=>{try{return reader.evidence?.(run,now)}catch{return undefined}})()
  const status=(()=>{try{return reader.status(run,now)}catch{return undefined}})()
  const startedAt=run.startedAt?Date.parse(run.startedAt):row?.created??null
  const share=session?budget.get(session):undefined
  return {role:'worker',session,quest:questReference(q),title:q.title.slice(0,100),run:run.runID??run.callID,state:run.state,status:status?.text??null,
   route:routeOf(run),release:run.generation??null,startedAt:startedAt===null?null:new Date(startedAt).toISOString(),...rate(startedAt,evidence?.tools??null),
   costUSD:row?.cost!==undefined&&row?.cost!==null?two(row.cost):null,weekSharePercent:share?.sharePercent??null,fiveHourSharePercent:share?.fiveHourPercent??null,
   starterPrompt:row?.starter??run.task??run.taskDescription??null}
 })
 if(giver){
  const row=host.get(giver),share=budget.get(giver)
  items.unshift({role:'giver',session:giver,quest:null,title:'Quest Giver',run:null,state:map.currentGiver?.host?.state??'unknown',status:null,route:row?.model??null,
   release:map.currentGiver?.host?.generation??null,startedAt:row?.created?new Date(row.created).toISOString():null,toolCalls:null,toolCallsPerMinute:null,
   costUSD:row?.cost!==undefined&&row?.cost!==null?two(row.cost):null,weekSharePercent:share?.sharePercent??null,fiveHourSharePercent:share?.fiveHourPercent??null,starterPrompt:row?.starter??null})
 }
 return {at:now,count:items.length,items}
}
