import {existsSync} from 'node:fs'
import {readSpanRows,SPANS_FILE} from '../../scripts/span-store'
import {spanWriter,type SpanWriter} from '../../scripts/plugin-spans'
import {forecastWindow,readAccountUsage} from '../../usage-service/on-computer'
import {decisionTimes} from '../permissions/permission-watchdog'
import {readUserGiver} from '../giver-registry.mjs'
import {FROZEN_SILENCE_MS,MINIMUM_STALL_SILENCE_MS} from '../workers/stall-signal'
import {currentProcessLedger,type QuietProcess} from '../workers/process-ledger'
import {foldSpans,statsOf,windowOf} from './span-aggregate'
import {summaryOf,workerReadingsOf,type WorkerEvidenceReader,type WorkerHostSignals} from './board'
import {runState} from './state-classes'
import type {QuestStore} from '../store'
import type {Quest} from '../types'

export const WARNING_TYPES=['process-no-cpu','run-no-host','tool-past-p99','ask-unanswered','step-restarted','reload-storm','budget-rate','folder-missing'] as const
export type WarningType=typeof WARNING_TYPES[number]
export type WarningOwner='worker'|'host'|'Quest Giver'|'Jon'
export type Warning={key:string;type:WarningType;at:number;owner:WarningOwner;quest?:string;run?:string;text:string;evidence:Record<string,unknown>}
export type WarningRecord=Warning&{clearedAt?:number}

const MINUTE=60_000,HOUR=3_600_000,WEEK=7*86_400_000
export const WARNING_SWEEP_MS=MINUTE
export const RELOAD_STORM_FLOOR=3
export const FEWEST_STEP_RUNS=3

const minutes=(ms:number)=>ms>=HOUR?Math.round(ms/HOUR*10)/10+' h':Math.max(1,Math.round(ms/MINUTE))+' min'
const clip=(text:string,length=100)=>text.replace(/\s+/g,' ').trim().slice(0,length)

export type Evidence={
 now:number
 runs:{quest:string;title:string;run:string;state:string;since:number;forMs:number;waitingMs?:number;command?:string;p99Ms:number;awaiting?:{ask:string;at:number}}[]
 processes:QuietProcess[]
 askP99Ms:number
 steps:{quest:string;title:string;step:string;runs:number;since:number}[]
 reloads?:{lastHour:number;limit:number;measuredHours:number;at:number}
 budgets:{account:string;window:string;outcome:string;pacePercentPerHour:number|null;runsOutAt:string|null;resetAt:string|null;usedPercent:number|null}[]
 bindings:{role:'front'|'Quest Giver';directory:string;present:boolean}[]
}

const key=(type:WarningType,...subject:string[])=>[type,...subject].join(':')

export function detectWarnings(evidence:Evidence):Warning[]{
 const {now}=evidence,found:Warning[]=[]
 for(const process of evidence.processes)found.push({key:key('process-no-cpu',process.id),type:'process-no-cpu',at:process.quietSince+process.limitMs,owner:'worker',...(process.quest?{quest:process.quest}:{}),...(process.run?{run:process.run}:{}),
  text:'A '+process.kind+' command has used no CPU and written no output for '+minutes(process.quietMs)+', past its '+minutes(process.limitMs)+' limit: '+clip(process.command,80),
  evidence:{process:process.id,command:process.command,kind:process.kind,startedAt:process.startedAt,quietSince:process.quietSince,quietMs:process.quietMs,limitMs:process.limitMs,limitMeasured:process.measured,totalCpuMs:process.totalCpuMs,outputBytes:process.outputBytes}})
 for(const run of evidence.runs){
  if(run.state==='no live host'&&run.forMs>run.p99Ms)found.push({key:key('run-no-host',run.run),type:'run-no-host',at:run.since+run.p99Ms,owner:'host',quest:run.quest,run:run.run,
   text:'A run has had no live host for '+minutes(run.forMs)+', past the '+minutes(run.p99Ms)+' a tool call takes 99% of the time.',evidence:{run:run.run,since:run.since,forMs:run.forMs,limitMs:run.p99Ms}})
  if(run.state==='waiting'&&run.waitingMs!==undefined&&run.waitingMs>run.p99Ms)found.push({key:key('tool-past-p99',run.run),type:'tool-past-p99',at:run.since+run.p99Ms,owner:'worker',quest:run.quest,run:run.run,
   text:'A tool call has run for '+minutes(run.waitingMs)+', past the '+minutes(run.p99Ms)+' that 99% of tool calls finish within'+(run.command?': '+clip(run.command,80):'.'),evidence:{run:run.run,command:run.command,runningMs:run.waitingMs,limitMs:run.p99Ms}})
  if(run.awaiting&&now-run.awaiting.at>evidence.askP99Ms)found.push({key:key('ask-unanswered',run.run,String(run.awaiting.at)),type:'ask-unanswered',at:run.awaiting.at+evidence.askP99Ms,owner:'Quest Giver',quest:run.quest,run:run.run,
   text:'A permission ask has gone unanswered for '+minutes(now-run.awaiting.at)+', past the '+minutes(evidence.askP99Ms)+' that 99% of decisions take: '+clip(run.awaiting.ask,80),evidence:{run:run.run,ask:run.awaiting.ask,askedAt:run.awaiting.at,limitMs:evidence.askP99Ms}})
 }
 for(const step of evidence.steps)if(step.runs-1>2)found.push({key:key('step-restarted',step.quest,step.step),type:'step-restarted',at:step.since,owner:'Quest Giver',quest:step.quest,
  text:'Step '+step.step+' has restarted '+(step.runs-1)+' times.',evidence:{step:step.step,runs:step.runs,restarts:step.runs-1,limit:2}})
 if(evidence.reloads&&evidence.reloads.lastHour>evidence.reloads.limit)found.push({key:key('reload-storm'),type:'reload-storm',at:evidence.reloads.at,owner:'host',
  text:evidence.reloads.lastHour+' reloads in the last hour, over the limit of '+evidence.reloads.limit+' measured from '+evidence.reloads.measuredHours+' hours.',evidence:{...evidence.reloads}})
 for(const budget of evidence.budgets)if(budget.outcome==='runs-out-before-reset')found.push({key:key('budget-rate',budget.account,budget.window),type:'budget-rate',at:now,owner:'Jon',
  text:'The '+budget.window+' allowance runs out'+(budget.runsOutAt?' at '+new Date(budget.runsOutAt).toISOString():'')+', before it resets, at '+budget.pacePercentPerHour+'% an hour.',evidence:{...budget}})
 for(const binding of evidence.bindings)if(!binding.present)found.push({key:key('folder-missing',binding.role),type:'folder-missing',at:now,owner:binding.role==='front'?'host':'Quest Giver',
  text:'The '+binding.role+' is bound to a folder that does not exist: '+binding.directory,evidence:{role:binding.role,directory:binding.directory}})
 return found
}

export function foldWarnings(rows:Record<string,any>[]):WarningRecord[]{
 const byKey=new Map<string,WarningRecord>()
 for(const row of rows.filter(row=>row?.kind==='warning').sort((a,b)=>(a.recordedAt??a.start)-(b.recordedAt??b.start))){
  if(row.phase==='raised'){const {kind,phase,v,pid,host,start,recordedAt,plugin,name,op,...rest}=row;byKey.set(row.key,{...rest,at:row.at} as WarningRecord)}
  else if(row.phase==='cleared'){const held=byKey.get(row.key);if(held)held.clearedAt=row.recordedAt??row.start}
 }
 return [...byKey.values()]
}

export type EmitterOptions={writer?:SpanWriter;now?:()=>number;file?:string;announce?:(warning:Warning)=>void}

export class WarningEmitter{
 private readonly active=new Map<string,Warning>()
 private restored=false
 constructor(private readonly options:EmitterOptions={}){}
 private now(){return (this.options.now??Date.now)()}
 private writer(){return this.options.writer??spanWriter(this.options.file)}

 private restore(){
  if(this.restored)return
  this.restored=true
  try{for(const record of foldWarnings(readSpanRows(this.options.file??process.env.OPENCODE_SPANS_FILE??SPANS_FILE,{from:this.now()-WEEK}))){if(record.clearedAt===undefined)this.active.set(record.key,record)}}catch{}
 }

 raise(warning:Warning){
  this.restore()
  if(this.active.has(warning.key))return false
  this.active.set(warning.key,warning)
  const at=this.now()
  this.writer().push({kind:'warning',plugin:'quests',name:'warning',op:warning.type,phase:'raised',recordedAt:at,start:at,...warning})
  this.options.announce?.(warning)
  return true
 }

 clear(warningKey:string){
  this.restore()
  const held=this.active.get(warningKey)
  if(!held)return false
  this.active.delete(warningKey)
  const at=this.now()
  this.writer().push({kind:'warning',plugin:'quests',name:'warning',op:held.type,phase:'cleared',recordedAt:at,start:at,key:warningKey,type:held.type})
  return true
 }

 settle(found:Warning[],scope:ReadonlySet<WarningType>=new Set(WARNING_TYPES)){
  this.restore()
  const keys=new Set(found.map(warning=>warning.key))
  for(const warning of found)this.raise(warning)
  for(const [held,warning] of [...this.active])if(scope.has(warning.type)&&!keys.has(held))this.clear(held)
 }

 list():Warning[]{this.restore();return [...this.active.values()].sort((a,b)=>b.at-a.at)}
}

const SHARED=Symbol.for('questgiver.warning-emitter')
const registry=globalThis as typeof globalThis&{[SHARED]?:WarningEmitter}
export const warningEmitter=()=>registry[SHARED]??=new WarningEmitter()

export function onProcessQuiet(emitter=warningEmitter()){
 return (process:QuietProcess)=>{emitter.raise(detectWarnings({now:Date.now(),runs:[],processes:[process],askP99Ms:0,steps:[],budgets:[],bindings:[]})[0]!)}
}

function reloadEvidence(file:string,now:number):Evidence['reloads']{
 try{
  const series=windowOf(foldSpans(file),now-WEEK,now).trends,hours=new Map<number,number>()
  for(const [name,row] of series){
   if(!name.startsWith('checks · reload\0'))continue
   const start=Number(name.slice(name.lastIndexOf('\0')+1)),hour=Math.floor(start/HOUR)
   hours.set(hour,(hours.get(hour)??0)+row.n)
  }
  const current=Math.floor(now/HOUR),lastHour=[...hours].filter(([hour])=>hour>=current-1).reduce((total,[,count])=>total+count,0)
  const before=[...hours].filter(([hour])=>hour<current-1).map(([,count])=>count).sort((a,b)=>a-b)
  const p99=before.length?before[Math.max(0,Math.ceil(before.length*.99)-1)]!:0
  return {lastHour,limit:Math.max(RELOAD_STORM_FLOOR,p99),measuredHours:before.length,at:now-HOUR/2}
 }catch{return undefined}
}


function budgetEvidence(now:number):Evidence['budgets']{
 try{
  return readAccountUsage(undefined,now).accounts.flatMap(account=>account.windows.filter(window=>window.scope==='shared'&&(window.label==='5h'||window.label==='weekly')).map(window=>({account:account.id,...forecastWindow(window,now)})))
   .map(row=>({account:row.account,window:row.window,outcome:row.outcome,pacePercentPerHour:row.pacePercentPerHour,runsOutAt:row.runsOutAt,resetAt:row.resetAt,usedPercent:row.usedPercent}))
 }catch{return []}
}

function bindingEvidence(store:Pick<QuestStore,'projectRoot'|'runtime'>):Evidence['bindings']{
 const found:Evidence['bindings']=[{role:'front',directory:store.projectRoot,present:existsSync(store.projectRoot)}]
 try{const giver=readUserGiver(store.runtime);if(giver?.state==='bound'&&typeof giver.directory==='string')found.push({role:'Quest Giver',directory:giver.directory,present:existsSync(giver.directory)})}catch{}
 return found
}

export function warningEvidence(store:Pick<QuestStore,'projectRoot'|'runtime'>,quests:Quest[],now:number,reader:WorkerEvidenceReader,signals:WorkerHostSignals,file=process.env.OPENCODE_SPANS_FILE??SPANS_FILE):Evidence{
 const readings=workerReadingsOf(quests.map(summaryOf),now,reader,signals)
 const runs=readings.map(({quest,run,reading,times})=>{
  const id=run.runID??run.callID,state=runState(id,reading,now),p99Ms=Math.max(MINIMUM_STALL_SILENCE_MS,times.p99Ms??FROZEN_SILENCE_MS)
  return {quest,title:quests.find(q=>q.id===quest)?.title??quest,run:id,state:state.state,since:state.since,forMs:state.forMs,...(reading.waitingMs!==undefined?{waitingMs:reading.waitingMs}:{}),...(reading.command?{command:reading.command}:{}),p99Ms,
   ...(run.awaiting&&Number.isFinite(Date.parse(run.awaiting.at))?{awaiting:{ask:run.awaiting.ask,at:Date.parse(run.awaiting.at)}}:{})}
 })
 const steps:Evidence['steps']=[]
 for(const quest of quests.filter(q=>q.state!=='Archived'))for(const stage of quest.stages.filter(step=>step.status!=='done')){
  const attempts=quest.sessions.filter(run=>run.deliverables.includes(stage.id))
  if(attempts.length>=FEWEST_STEP_RUNS)steps.push({quest:quest.id,title:quest.title,step:stage.id,runs:attempts.length,since:Math.max(...attempts.map(run=>Date.parse(run.startedAt??run.updatedAt)||now))})
 }
 let askP99Ms=MINIMUM_STALL_SILENCE_MS
 try{askP99Ms=Math.max(MINIMUM_STALL_SILENCE_MS,decisionTimes(store.runtime).p99??0)}catch{}
 return {now,runs,processes:currentProcessLedger()?.stuck()??[],askP99Ms,steps,reloads:reloadEvidence(file,now),budgets:budgetEvidence(now),bindings:bindingEvidence(store)}
}

const SWEPT=new Set<WarningType>(WARNING_TYPES)
export function sweepWarnings(store:Pick<QuestStore,'projectRoot'|'runtime'>,quests:Quest[],now:number,reader:WorkerEvidenceReader,signals:WorkerHostSignals,emitter=warningEmitter()){
 emitter.settle(detectWarnings(warningEvidence(store,quests,now,reader,signals)),SWEPT)
 return emitter.list()
}

export function warningLine(warnings:Warning[]):string{
 if(!warnings.length)return ''
 const first=warnings.slice(0,3).map(warning=>warning.text)
 return warnings.length+(warnings.length===1?' warning: ':' warnings: ')+first.join(' ')+(warnings.length>3?' And '+(warnings.length-3)+' more.':'')
}

export const warningRow=(warning:Warning,now:number)=>({type:warning.type,owner:warning.owner,at:new Date(warning.at).toISOString(),forMs:Math.max(0,now-warning.at),...(warning.quest?{quest:warning.quest}:{}),...(warning.run?{run:warning.run}:{}),text:warning.text,evidence:warning.evidence})
