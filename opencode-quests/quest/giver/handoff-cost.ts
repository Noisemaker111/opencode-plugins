import {Database} from 'bun:sqlite'
import {appendFileSync,existsSync,mkdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {acquireLock} from '../locking.mts'
import {readAllQuests} from '../index'
import {questReference} from '../core/references'
import {readHandoffs,type HandoffRecord} from './handoff-outcome'
import {hostDatabaseFile} from '../../usage/worker-time'
import {o200k} from '../../usage/request-composition'
import {valueRequest,type RequestRecord} from '../../usage/telemetry'
import {appendRequests} from '../../usage/telemetry-store'
import {listPriceOf,priceBookFile} from '../../usage/price-book'
import {planAllowanceOf} from '../../models/allowance-cost'
import type {Quest} from '../types'

export const HANDOFF_MEASURES=['prompt-tokens','prompt-characters','giver-turns','giver-fresh-input-tokens','giver-cache-write-tokens','giver-cache-read-tokens','giver-output-tokens','giver-model-ms','giver-turn-ms','to-quest-ms','to-first-worker-ms'] as const
export type HandoffMeasureName=typeof HANDOFF_MEASURES[number]
export type MeasureUnit='tokens'|'characters'|'turns'|'ms'
export type Measure={at:string;scope:'hand-off';id:string;measure:HandoffMeasureName;value:number;unit:MeasureUnit;handoffAt:string;quest?:string}
export type GiverTurn={sessionID:string;startedAt:number;endedAt:number;requests:number;input:number;cached:number;cacheWrite:number;output:number;modelMs:number;route:{providerID:string;modelID:string}|null;finish:{tools:number;last:string|null}}
export type GiverTurnKind='plan'|'delegate'|'answer'|'other'

const UNITS:Record<HandoffMeasureName,MeasureUnit>={'prompt-tokens':'tokens','prompt-characters':'characters','giver-turns':'turns','giver-fresh-input-tokens':'tokens','giver-cache-write-tokens':'tokens','giver-cache-read-tokens':'tokens','giver-output-tokens':'tokens','giver-model-ms':'ms','giver-turn-ms':'ms','to-quest-ms':'ms','to-first-worker-ms':'ms'}
const TURN_MEASURES:HandoffMeasureName[]=['giver-turns','giver-fresh-input-tokens','giver-cache-write-tokens','giver-cache-read-tokens','giver-output-tokens','giver-model-ms','giver-turn-ms']
const PAGE=200

export const measureFile=(runtime:string)=>join(runtime,'measures.jsonl')
const key=(row:Pick<Measure,'scope'|'id'|'measure'>)=>row.scope+'|'+row.id+'|'+row.measure

export function readMeasures(runtime:string):Measure[]{
 const file=measureFile(runtime)
 if(!existsSync(file))return []
 return readFileSync(file,'utf8').split('\n').flatMap(line=>{if(!line.trim())return [];try{const row=JSON.parse(line);return typeof row?.measure==='string'&&typeof row?.id==='string'&&Number.isFinite(row?.value)?[row as Measure]:[]}catch{return []}})
}

export function appendMeasures(runtime:string,rows:Measure[]):Measure[]{
 if(!rows.length)return []
 const lock=acquireLock(runtime,'measures')
 try{
  const seen=new Set(readMeasures(runtime).map(key)),fresh=rows.filter(row=>{const k=key(row);if(seen.has(k))return false;seen.add(k);return true})
  if(fresh.length){mkdirSync(runtime,{recursive:true});appendFileSync(measureFile(runtime),fresh.map(row=>JSON.stringify(row)).join('\n')+'\n',{encoding:'utf8',mode:0o600})}
  return fresh
 }finally{lock.release()}
}

const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0

export function openHostDatabase(file=hostDatabaseFile()):Database|undefined{
 if(!existsSync(file))return undefined
 try{const db=new Database(file,{readonly:true});db.exec('PRAGMA busy_timeout=1000');return db}catch{return undefined}
}

export function giverTurnAfter(db:Database,messageID:string):GiverTurn|undefined{
 try{
  const sent=db.query('SELECT session_id,seq,time_created FROM session_message WHERE id=?').get(messageID) as {session_id:string;seq:number;time_created:number}|null
  if(!sent)return undefined
  const page=db.query("SELECT type,seq,time_created,data FROM session_message WHERE session_id=? AND seq>? AND type IN ('assistant','idle','user') ORDER BY seq LIMIT ?")
  const turn:GiverTurn={sessionID:sent.session_id,startedAt:sent.time_created,endedAt:0,requests:0,input:0,cached:0,cacheWrite:0,output:0,modelMs:0,route:null,finish:{tools:0,last:null}}
  const routes=new Map<string,{providerID:string;modelID:string;n:number}>()
  const finish=():GiverTurn=>{
   const top=[...routes.values()].sort((a,b)=>b.n-a.n)[0]
   if(top)turn.route={providerID:top.providerID,modelID:top.modelID}
   return turn
  }
  let after=sent.seq
  for(;;){
   const rows=page.all(sent.session_id,after,PAGE) as {type:string;seq:number;time_created:number;data:string}[]
   if(!rows.length)return undefined
   for(const row of rows){
    after=row.seq
    if(row.type!=='assistant'){turn.endedAt=row.time_created;return finish()}
    let data:any
    try{data=JSON.parse(row.data)}catch{continue}
    const tokens=data?.tokens??{},created=Number(data?.time?.created),completed=Number(data?.time?.completed)
    turn.finish.last=typeof data?.finish==='string'?data.finish:null
    if(turn.finish.last==='tool-calls')turn.finish.tools++
    turn.requests++
    turn.input+=count(tokens.input);turn.cached+=count(tokens.cache?.read);turn.cacheWrite+=count(tokens.cache?.write);turn.output+=count(tokens.output)+count(tokens.reasoning)
    if(Number.isFinite(created)&&Number.isFinite(completed)&&completed>=created)turn.modelMs+=completed-created
    const providerID=data?.model?.providerID,modelID=data?.model?.id??data?.model?.modelID
    if(typeof providerID==='string'&&typeof modelID==='string'){const name=providerID+'/'+modelID,seen=routes.get(name);routes.set(name,{providerID,modelID,n:(seen?.n??0)+1})}
   }
   if(rows.length<PAGE)return undefined
  }
 }catch{return undefined}
}

export function giverTurnsNaming(db:Database,text:string):string[]{
 try{
  const like='%'+text.replace(/[\\%_]/g,match=>'\\'+match)+'%'
  const hits=db.query("SELECT id,session_id,seq,type FROM session_message WHERE data LIKE ? ESCAPE '\\' ORDER BY seq").all(like) as {id:string;session_id:string;seq:number;type:string}[]
  const latest=db.query("SELECT id FROM session_message WHERE session_id=? AND type='user' AND seq<? ORDER BY seq DESC LIMIT 1")
  const starts=new Set<string>()
  for(const hit of hits){
   if(hit.type==='user'){starts.add(hit.id);continue}
   const start=latest.get(hit.session_id,hit.seq) as {id:string}|null
   if(start)starts.add(start.id)
  }
  return [...starts]
 }catch{return []}
}

export function giverTurnsOfQuest(db:Database|undefined,input:{quest:{id:string;ref?:string};runIDs:string[];placing:string[]}):{turns:GiverTurn[];starts:string[];unmapped:string[]}{
 if(!db)return {turns:[],starts:[],unmapped:[]}
 const names=[input.quest.id,input.quest.ref,...input.runIDs].filter((name): name is string=>!!name)
 const starts=[...new Set([...input.placing,...names.flatMap(name=>giverTurnsNaming(db,name))])]
 const turns:GiverTurn[]=[],unmapped:string[]=[]
 for(const start of starts){
  const turn=giverTurnAfter(db,start)
  if(turn)turns.push(turn)
  else unmapped.push(start)
 }
 return {turns,starts,unmapped}
}

export function giverTurnRequests(turns:GiverTurn[]):RequestRecord[]{
 return turns.map((turn,index)=>({
  id:'giver-turn-'+index+':'+turn.sessionID,sessionID:turn.sessionID,
  route:turn.route??{providerID:'unknown',modelID:'unknown'},kind:'primary',startedAt:turn.startedAt,state:'completed',
  tokens:{input:turn.input,cacheRead:turn.cached,cacheWrite:turn.cacheWrite,output:turn.output,reasoning:0},
 }))
}

export function giverTurnKind(turn:Pick<GiverTurn,'finish'>,placed:'created'|'folded'|undefined):GiverTurnKind{
 if(placed==='created')return 'plan'
 if(placed==='folded')return 'delegate'
 return turn.finish.last==='stop'?'answer':'other'
}

function giverTurnCost(row:RequestRecord,file:string):NonNullable<RequestRecord['cost']>{
 const listed=listPriceOf(row,file)
 const value=listed?valueRequest({...row,price:listed.price}):undefined
 const listUSD=value?.currency==='USD'?value.value:null
 const allowance=listUSD===null?null:planAllowanceOf(row.route.providerID,row.route.modelID,row.accountID)
 return {listUSD,planUSD:listUSD!==null&&allowance?listUSD/allowance.multiplier:null,priceSource:listed?.source??null}
}

function giverTurnRow(turn:GiverTurn,input:{messageID:string;kind:GiverTurnKind;questID?:string;telemetryFile:string}):RequestRecord{
 const row:RequestRecord={id:'giver-turn:'+input.messageID,sessionID:turn.sessionID,...(input.questID?{questID:input.questID}:{}),role:'giver',runID:null,stepID:null,
  route:turn.route??{providerID:'unknown',modelID:'unknown'},kind:input.kind,startedAt:turn.startedAt,completedAt:turn.endedAt,elapsedMs:turn.endedAt-turn.startedAt,state:'completed',
  tokens:{input:turn.input,cacheRead:turn.cached,cacheWrite:turn.cacheWrite,output:turn.output,reasoning:0}}
 return {...row,cost:giverTurnCost(row,priceBookFile(input.telemetryFile))}
}

function placementOf(row:HandoffRecord,quests:Map<string,Quest>){
 const quest=[...quests.values()].find(quest=>quest.request?.some(request=>request.messageID===row.messageID&&!request.context))
 return quest&&{quest,placed:Date.parse(quest.createdAt)>=Date.parse(row.sentAt)?'created' as const:'folded' as const}
}

function heldQuests(row:HandoffRecord,quests:Map<string,Quest>):Quest[]{
 return (row.outcomes??[]).flatMap(outcome=>outcome.quest&&quests.has(outcome.quest)?[quests.get(outcome.quest)!]:[])
}

export function firstWorkerStart(row:HandoffRecord,held:Quest[]):{at:number;quest:string}|undefined{
 const sent=Date.parse(row.sentAt)
 let first:{at:number;quest:string}|undefined
 for(const quest of held)for(const run of quest.sessions){
  const at=run.startedAt?Date.parse(run.startedAt):NaN
  if(Number.isFinite(at)&&at>=sent&&(!first||at<first.at))first={at,quest:questReference(quest)}
 }
 return first
}

export async function measureHandoffs(input:{runtime:string;projectRoot:string;hostDB?:string;countTokens?:(text:string)=>number;telemetryFile?:string}):Promise<Measure[]>{
 const handoffs=readHandoffs(input.runtime)
 if(!handoffs.length)return []
 const have=new Set(readMeasures(input.runtime).map(key))
 const missing=(id:string,name:HandoffMeasureName)=>!have.has(key({scope:'hand-off',id,measure:name}))
 let quests:Map<string,Quest>|undefined
 const questsByReference=()=>quests??=new Map(readAllQuests(input.projectRoot,{includeArchived:true}).flatMap(entry=>entry.quest?[[questReference(entry.quest),entry.quest] as const,[entry.quest.id,entry.quest] as const]:[]))
 const unmatched=new Set<string>()
 let counter=input.countTokens,db:Database|undefined,opened=false
 const hostDatabase=()=>{if(!opened){opened=true;db=openHostDatabase(input.hostDB)};return db}
 const rows:Measure[]=[],turnRows:RequestRecord[]=[]
 const add=(row:HandoffRecord,measure:HandoffMeasureName,value:number,at:number|string,quest?:string)=>rows.push({at:typeof at==='number'?new Date(at).toISOString():at,scope:'hand-off',id:row.messageID,measure,value:Math.round(value),unit:UNITS[measure],handoffAt:row.sentAt,...(quest?{quest}:{})})
 try{
 for(const row of handoffs){
  const id=row.messageID
  if(missing(id,'prompt-characters'))add(row,'prompt-characters',row.text.length,row.sentAt)
  if(missing(id,'prompt-tokens')){
   if(!counter)try{counter=await o200k()}catch{}
   if(counter)add(row,'prompt-tokens',counter(row.text),row.sentAt)
  }
  const host=!unmatched.has(id)&&TURN_MEASURES.some(name=>missing(id,name))?hostDatabase():undefined
  if(host){
   const turn=giverTurnAfter(host,id)
   if(!turn)unmatched.add(id)
   else{
    if(input.telemetryFile){const placed=placementOf(row,questsByReference());turnRows.push(giverTurnRow(turn,{messageID:id,kind:giverTurnKind(turn,placed?.placed),questID:placed?.quest.id,telemetryFile:input.telemetryFile}))}
    const values:Record<HandoffMeasureName,number>={'prompt-tokens':0,'prompt-characters':0,'giver-turns':turn.requests,'giver-fresh-input-tokens':turn.input,'giver-cache-write-tokens':turn.cacheWrite,'giver-cache-read-tokens':turn.cached,'giver-output-tokens':turn.output,'giver-model-ms':turn.modelMs,'giver-turn-ms':Math.max(0,turn.endedAt-Date.parse(row.sentAt)),'to-quest-ms':0,'to-first-worker-ms':0}
    for(const name of TURN_MEASURES)if(missing(id,name))add(row,name,values[name],turn.endedAt)
   }
  }
  if(!row.outcomes?.length)continue
  const needQuest=missing(id,'to-quest-ms')&&row.outcomes.some(outcome=>outcome.kind==='created')
  const needWorker=missing(id,'to-first-worker-ms')&&row.outcomes.some(outcome=>!!outcome.quest)
  if(!needQuest&&!needWorker)continue
  const held=heldQuests(row,questsByReference())
  if(needQuest){
   const created=held.filter(quest=>row.outcomes!.some(outcome=>outcome.kind==='created'&&outcome.quest===questReference(quest))).map(quest=>({at:Date.parse(quest.createdAt),quest:questReference(quest)})).filter(item=>Number.isFinite(item.at)).sort((a,b)=>a.at-b.at)[0]
   if(created)add(row,'to-quest-ms',Math.max(0,created.at-Date.parse(row.sentAt)),created.at,created.quest)
  }
  if(needWorker){
   const first=firstWorkerStart(row,held)
   if(first)add(row,'to-first-worker-ms',first.at-Date.parse(row.sentAt),first.at,first.quest)
  }
 }
 }finally{db?.close()}
 appendRequests(turnRows,input.telemetryFile)
 return appendMeasures(input.runtime,rows)
}

export type HandoffCost={promptTokens:number|null;promptCharacters:number|null;giverTurns:number|null;giverFreshInputTokens:number|null;giverCacheWriteTokens:number|null;giverCacheReadTokens:number|null;giverOutputTokens:number|null;giverFreshTokens:number|null;giverModelMs:number|null;giverTurnMs:number|null;toQuestMs:number|null;toFirstWorkerMs:number|null}
const FIELDS:Record<HandoffMeasureName,keyof HandoffCost>={'prompt-tokens':'promptTokens','prompt-characters':'promptCharacters','giver-turns':'giverTurns','giver-fresh-input-tokens':'giverFreshInputTokens','giver-cache-write-tokens':'giverCacheWriteTokens','giver-cache-read-tokens':'giverCacheReadTokens','giver-output-tokens':'giverOutputTokens','giver-model-ms':'giverModelMs','giver-turn-ms':'giverTurnMs','to-quest-ms':'toQuestMs','to-first-worker-ms':'toFirstWorkerMs'}

export const giverFreshTokens=(cost:Pick<HandoffCost,'giverFreshInputTokens'|'giverCacheWriteTokens'|'giverOutputTokens'>)=>cost.giverFreshInputTokens===null||cost.giverCacheWriteTokens===null||cost.giverOutputTokens===null?null:cost.giverFreshInputTokens+cost.giverCacheWriteTokens+cost.giverOutputTokens

export function handoffCosts(runtime:string):Map<string,HandoffCost>{
 const costs=new Map<string,HandoffCost>()
 for(const row of readMeasures(runtime)){
  if(row.scope!=='hand-off'||!(row.measure in FIELDS))continue
  const cost=costs.get(row.id)??Object.fromEntries([...Object.values(FIELDS),"giverFreshTokens"].map(field=>[field,null])) as HandoffCost
  cost[FIELDS[row.measure]]=row.value
  cost.giverFreshTokens=giverFreshTokens(cost)
  costs.set(row.id,cost)
 }
 return costs
}

const median=(values:number[])=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),mid=sorted.length>>1;return sorted.length%2?sorted[mid]:Math.round((sorted[mid-1]+sorted[mid])/2)}

export function handoffCostSummary(costs:HandoffCost[]){
 const pick=(field:keyof HandoffCost)=>costs.map(cost=>cost[field]).filter((value):value is number=>value!==null)
 const total=(field:keyof HandoffCost)=>{const values=pick(field);return values.length?values.reduce((a,b)=>a+b,0):null}
 const fresh=costs.map(giverFreshTokens).filter((value):value is number=>value!==null)
 return {handoffs:costs.length,promptTokens:total('promptTokens'),giverTurns:total('giverTurns'),giverFreshTokens:fresh.length?fresh.reduce((a,b)=>a+b,0):null,giverCacheReadTokens:total('giverCacheReadTokens'),medianPromptTokens:median(pick('promptTokens')),medianGiverTurns:median(pick('giverTurns')),medianGiverFreshTokens:median(fresh),medianToQuestMs:median(pick('toQuestMs')),medianToFirstWorkerMs:median(pick('toFirstWorkerMs')),measuredFirstWorker:pick('toFirstWorkerMs').length}
}
