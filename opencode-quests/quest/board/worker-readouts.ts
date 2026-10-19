import {Database} from 'bun:sqlite'
import {existsSync} from 'node:fs'
import {readAllQuests} from '../index'
import {waterfallSources} from '../bench/quest-waterfall'
import {latencyWindow} from '../../usage/latency'
import {nativeRunID,OWNED_RUN} from '../runs/session-lineage'
import {runStatusReader} from './activity'
import {workersPicture} from './pictures'
import type {StatusReader} from '../runs/run-status'
import type {QuestStore} from '../store'
import type {Quest,QuestSession} from '../types'

export type ReadoutSources={hostFile?:string;now?:()=>number;reader?:StatusReader}
type Message={seq?:number;session_id?:string;time_created:number;data:string}

const MINUTE=60_000
export const DEFAULT_HISTORY_WINDOW='-5m'
export const DEFAULT_RATES_WINDOW='-1h'
const clock=(at:number)=>new Date(at).toISOString().slice(11,19)
const flat=(text:unknown,room:number)=>String(text).replace(/\s+/g,' ').slice(0,room)

function hostDatabase(sources:ReadoutSources){
 const file=sources.hostFile??waterfallSources(process.env).hostDB
 if(!existsSync(file))throw new Error('No host database at '+file)
 const db=new Database(file,{readonly:true})
 db.exec('PRAGMA busy_timeout=1000')
 return db
}

const everything=(text:string|undefined)=>text==='-all'||text==='all'
function windowMilliseconds(text:string){
 try{return latencyWindow(text).milliseconds}
 catch{throw new Error('window: give a length such as -5m, -1h or -all; '+text+' is not one')}
}

function allRuns(store:Pick<QuestStore,'projectRoot'>){
 return readAllQuests(store.projectRoot).flatMap(row=>row.quest?row.quest.sessions.map(run=>({quest:row.quest as Quest,run})):[])
}

export function sessionFor(store:Pick<QuestStore,'projectRoot'>,query:string):string{
 if(query.startsWith('ses_'))return query
 const lower=query.toLowerCase(),runs=allRuns(store)
 const exact=runs.find(({run})=>run.runID===query||run.callID===query)
 const exactSession=exact&&nativeRunID(exact.run)
 if(exactSession)return exactSession
 const stepTitles=(quest:Quest,run:QuestSession)=>run.deliverables.map(id=>quest.stages.find(step=>step.id===id)?.title??id)
 const found=runs.filter(({quest,run})=>nativeRunID(run)&&[run.sessionTitle??'',quest.title,quest.id,...stepTitles(quest,run)].some(text=>text.toLowerCase().includes(lower)))
  .sort((a,b)=>Number(OWNED_RUN.has(b.run.state))-Number(OWNED_RUN.has(a.run.state))||b.run.updatedAt.localeCompare(a.run.updatedAt))[0]
 if(!found)throw new Error('No run matches '+query+'. Give a session id, a run id or part of a title.')
 return nativeRunID(found.run)!
}

function toolResult(part:any){
 const content=Array.isArray(part.state?.content)?part.state.content.map((item:any)=>item?.text??'').join(' '):''
 return content||(typeof part.state?.output==='string'?part.state.output:part.state?.error?String(part.state.error):'')
}

export function transcriptLines(rows:Message[]):string[]{
 const lines:string[]=[]
 for(const row of rows){
  let data:any;try{data=JSON.parse(row.data)}catch{continue}
  const at=clock(row.time_created)
  for(const part of data.content??[]){
   if(part.type==='text'&&part.text)lines.push(at+' '+(data.role??data.agent??data.type??'')+': '+flat(part.text,400))
   else if(part.type==='tool'){
    lines.push(at+' tool '+part.name+' ['+(part.state?.status??'')+'] '+JSON.stringify(part.state?.input??{}).slice(0,200))
    const result=toolResult(part)
    if(result)lines.push('         '+(part.state?.status==='error'?'ERROR ':'-> ')+flat(result,200))
   }
  }
 }
 return lines
}

export function historyPicture(input:{session:string;window?:string},store:Pick<QuestStore,'projectRoot'>,sources:ReadoutSources={}){
 const at=(sources.now??Date.now)(),whole=everything(input.window),text=input.window??DEFAULT_HISTORY_WINDOW
 const span=whole?0:windowMilliseconds(text),since=whole?0:at-span
 const session=sessionFor(store,input.session)
 const db=hostDatabase(sources)
 let rows:Message[]
 try{rows=db.query('select seq,time_created,data from session_message where session_id = ? and time_created >= ? order by seq asc').all(session,since) as Message[]}
 finally{db.close()}
 const lines=transcriptLines(rows)
 const label=whole?'the whole session':'the last '+Math.round(span/MINUTE)+' min'
 return {at,session,window:whole?'all':text.replace(/^-/,''),messages:rows.length,lines,text:session+' : '+rows.length+' messages in '+label}
}

type ToolRate={tool:string;calls:number;perMinute:number;running:number;meanMs:number|null}

export function ratesPicture(input:{window?:string},sources:ReadoutSources={}){
 const at=(sources.now??Date.now)(),span=windowMilliseconds(input.window??DEFAULT_RATES_WINDOW),since=at-span
 const db=hostDatabase(sources)
 let rows:Message[]
 try{rows=db.query("select session_id,time_created,data from session_message where type = 'assistant' and time_created >= ?").all(since) as Message[]}
 finally{db.close()}
 const tools=new Map<string,{calls:number;running:number;timed:number;total:number}>(),sessions=new Set<string>()
 for(const row of rows){
  let data:any;try{data=JSON.parse(row.data)}catch{continue}
  for(const part of data.content??[]){
   if(part.type!=='tool')continue
   sessions.add(String(row.session_id))
   const entry=tools.get(String(part.name))??{calls:0,running:0,timed:0,total:0}
   entry.calls++
   if(part.state?.status==='running')entry.running++
   const time=part.time??{},start=time.ran??time.created
   if(part.state?.status==='completed'&&typeof start==='number'&&typeof time.completed==='number'&&time.completed>=start){entry.timed++;entry.total+=time.completed-start}
   tools.set(String(part.name),entry)
  }
 }
 const minutes=span/MINUTE,round=(value:number)=>Math.round(value*100)/100
 const list:ToolRate[]=[...tools].sort((a,b)=>b[1].calls-a[1].calls).map(([tool,entry])=>({tool,calls:entry.calls,perMinute:round(entry.calls/minutes),running:entry.running,meanMs:entry.timed?Math.round(entry.total/entry.timed):null}))
 const calls=list.reduce((sum,row)=>sum+row.calls,0)
 return {at,window:(input.window??DEFAULT_RATES_WINDOW).replace(/^-/,''),minutes:Math.round(minutes),sessions:sessions.size,calls,perMinute:round(calls/minutes),tools:list,text:calls+' tool calls in the last '+Math.round(minutes)+' min across '+sessions.size+' sessions ('+round(calls/minutes)+' a minute).'}
}

function runIntervals(all:{quest:Quest;run:QuestSession}[]){
 const intervals:{start:number;end:number;model:string}[]=[]
 for(const {run} of all){
  const start=Date.parse(run.startedAt??''),end=OWNED_RUN.has(run.state)?Infinity:Date.parse(run.updatedAt??'')
  if(Number.isFinite(start)&&!Number.isNaN(end)&&end>=start)intervals.push({start,end,model:(run.modelID??'?')+(run.reasoningEffort?'#'+run.reasoningEffort:'')})
 }
 return intervals
}

export function runningSeries(store:Pick<QuestStore,'projectRoot'>,now:number,windowMs=3_600_000){
 const last=Math.floor(now/MINUTE)*MINUTE,intervals=runIntervals(allRuns(store)),points:number[]=[]
 for(let at=last-windowMs;at<=last;at+=MINUTE)points.push(intervals.filter(run=>run.start<=at&&run.end>at).length)
 return {minutes:Math.round(windowMs/MINUTE),points,peak:Math.max(...points,0),now:points.at(-1)??0,mean:Math.round(points.reduce((a,b)=>a+b,0)/Math.max(1,points.length)*10)/10}
}

export function finishedByModel(store:Pick<QuestStore,'projectRoot'>,now:number,windowMs=86_400_000){
 const by=new Map<string,number[]>()
 for(const {run} of allRuns(store)){
  if(run.state!=='completed'||!run.startedAt||!run.updatedAt)continue
  const minutes=(Date.parse(run.updatedAt)-Date.parse(run.startedAt))/MINUTE
  if(!(minutes>0&&minutes<600)||now-Date.parse(run.updatedAt)>windowMs)continue
  const key=(run.modelID??'?')+(run.reasoningEffort?'#'+run.reasoningEffort:'')
  by.set(key,[...(by.get(key)??[]),minutes])
 }
 return [...by].sort((a,b)=>b[1].length-a[1].length).map(([model,values])=>{
  const sorted=values.slice().sort((a,b)=>a-b)
  return {model,runs:values.length,medianMinutes:Math.round(sorted[Math.floor(sorted.length/2)]),meanMinutes:Math.round(values.reduce((a,b)=>a+b,0)/values.length)}
 })
}

export function summaryPicture(store:Pick<QuestStore,'projectRoot'|'runtime'>,sources:ReadoutSources={}){
 const at=(sources.now??Date.now)(),reader=sources.reader??runStatusReader()
 const workers=workersPicture(store,at,reader)
 const verdicts:Record<string,number>={}
 for(const item of workers.items){const key=item.statusKind??'unknown';verdicts[key]=(verdicts[key]??0)+1}
 const running=runningSeries(store,at)
 let rates:ReturnType<typeof ratesPicture>|undefined,diagnostics:string[]=[]
 try{rates=ratesPicture({window:'-15m'},{...sources,now:()=>at})}catch(error){diagnostics=['tool rates unread: '+(error instanceof Error?error.message:String(error))]}
 const finished=finishedByModel(store,at)
 const text=workers.counts.text+' Running agents over the last hour: now '+running.now+', peak '+running.peak+', mean '+running.mean+'.'+(rates?' '+rates.text:'')
 return {at,text,counts:workers.counts,verdicts,workers:workers.items,running,rates:rates??null,finished,diagnostics}
}
