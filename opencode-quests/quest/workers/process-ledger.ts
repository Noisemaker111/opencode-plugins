import {statSync} from 'node:fs'
import {spanWriter,now as spanNow,type SpanWriter} from '../../scripts/plugin-spans'
import {SPANS_FILE} from '../../scripts/span-store'
import {foldSpans,statsOf,windowOf} from '../board/span-aggregate'
import {Clock,Effect,Fiber} from 'effect'
import {timerClock,timerWait,type Wait} from '../core/timer'
import {COMMAND_LIMITS,commandKind,descendants,hostEventLoop,matchShellPid,type CommandKind} from './command-guard'
import {CPU_PROGRESS_MS,listProcesses,type ProcessLister} from './process-progress'
import {FEWEST_GAPS_FOR_A_MEDIAN,MINIMUM_STALL_SILENCE_MS} from './stall-signal'

export const PROCESS_STATES=['moving','quiet','stuck','ended','failed','lost'] as const
export type ProcessState=typeof PROCESS_STATES[number]
export const PROCESS_SAMPLE_MS=30_000
const GONE_SAMPLES=3
const WEEK_MS=7*86_400_000
const HOUR_MS=3_600_000

export type ShellRecord={id:string;sessionID?:string;pid?:number;command:string;file?:string;startedAt:number}
export type ProcessIdentity={worker?:string;run?:string;quest?:string}
export type ShellExit={id:string;exit?:number;status?:string}
export type QuietProcess={id:string;worker?:string;run?:string;quest?:string;sessionID?:string;command:string;kind:CommandKind;startedAt:number;quietSince:number;quietMs:number;limitMs:number;measured:boolean;totalCpuMs:number;outputBytes:number;pid?:number}
export type DurationSeries={count:number;p99:number|null}

export function quietLimit(kind:CommandKind,series?:DurationSeries):{ms:number;measured:boolean}{
 if(series&&series.count>=FEWEST_GAPS_FOR_A_MEDIAN&&series.p99!==null)return {ms:Math.min(COMMAND_LIMITS[kind].wallMs,Math.max(MINIMUM_STALL_SILENCE_MS,series.p99)),measured:true}
 return {ms:COMMAND_LIMITS[kind].idleMs,measured:false}
}

const held=new Map<string,{hour:number;series:Map<string,DurationSeries>}>()
export function loggedDurations(kind:CommandKind,file=process.env.OPENCODE_SPANS_FILE??SPANS_FILE,now=Date.now()):DurationSeries|undefined{
 try{
  const hour=Math.floor(now/HOUR_MS),seen=held.get(file)
  let series=seen?.hour===hour?seen.series:undefined
  if(!series){
   series=new Map()
   for(const [name,row] of windowOf(foldSpans(file),now-WEEK_MS,now).names){
    const prefix='quests · process · '
    if(name.startsWith(prefix)){const stats=statsOf(row);series.set(name.slice(prefix.length),{count:stats.count,p99:stats.p99})}
   }
   held.set(file,{hour,series})
  }
  return series.get(kind)
 }catch{return undefined}
}

export type LedgerOptions={
 now?:()=>number
 wait?:Wait
 list?:ProcessLister
 size?:(file:string)=>number|undefined
 writer?:SpanWriter
 durations?:(kind:CommandKind)=>DurationSeries|undefined
 quiet?:(process:QuietProcess)=>void
}

type Entry={shell:ShellRecord;who:ProcessIdentity;kind:CommandKind;startedAt:number;pid?:number;gone:number;seen:Map<string,number>;totalCpuMs:number;peakCpuPercent:number;lastAt:number;outputBytes:number;quietSince:number;state:'moving'|'quiet'|'stuck';sampled:boolean}

const fileSize=(file:string)=>{try{return statSync(file).size}catch{return undefined}}
const clip=(text:string)=>text.replace(/\s+/g,' ').trim().slice(0,300)
const round=(value:number)=>Math.round(value*10)/10

export class ProcessLedger{
 private readonly open=new Map<string,Entry>()
 private cancel:(()=>void)|undefined
 private ticking=false
 private disposed=false
 constructor(private readonly options:LedgerOptions={}){}
 private now(){return (this.options.now??Date.now)()}
 private writer(){return this.options.writer??spanWriter()}
 get active(){return this.open.size}

 stuck():QuietProcess[]{
  const now=this.now()
  return [...this.open.values()].filter(entry=>entry.state==='stuck').map(entry=>{
   const limit=quietLimit(entry.kind,(this.options.durations??(kind=>loggedDurations(kind)))(entry.kind))
   return {id:entry.shell.id,...entry.who,...(entry.shell.sessionID?{sessionID:entry.shell.sessionID}:{}),command:clip(entry.shell.command),kind:entry.kind,startedAt:entry.startedAt,quietSince:entry.quietSince,quietMs:now-entry.quietSince,limitMs:limit.ms,measured:limit.measured,totalCpuMs:Math.round(entry.totalCpuMs),outputBytes:entry.outputBytes,...(entry.pid!==undefined?{pid:entry.pid}:{})}
  })
 }

 private identity(entry:Entry){
  return {plugin:'quests',name:'process',op:entry.kind,id:'process:'+entry.shell.id,command:clip(entry.shell.command),...(entry.shell.sessionID?{sessionID:entry.shell.sessionID}:{}),...(entry.who.worker?{worker:entry.who.worker}:{}),...(entry.who.run?{run:entry.who.run}:{}),...(entry.who.quest?{quest:entry.who.quest}:{}),...(entry.pid!==undefined?{shellPid:entry.pid}:{}),began:entry.startedAt}
 }
 private totals(entry:Entry){return {totalCpuMs:Math.round(entry.totalCpuMs),peakCpuPercent:round(entry.peakCpuPercent),outputBytes:entry.outputBytes}}

 started(shell:ShellRecord,who:ProcessIdentity={}){
  if(this.disposed||this.open.has(shell.id))return
  const startedAt=shell.startedAt||this.now(),kind=commandKind(shell.command)
  const entry:Entry={shell,who,kind,startedAt,pid:shell.pid,gone:0,seen:new Map(),totalCpuMs:0,peakCpuPercent:0,lastAt:startedAt,outputBytes:this.size(shell.file)??0,quietSince:startedAt,state:'moving',sampled:false}
  this.open.set(shell.id,entry)
  this.writer().push({kind:'process',phase:'start',...this.identity(entry),start:startedAt,state:'moving',since:startedAt,...this.totals(entry)})
  this.arm()
 }

 exited(id:string,exit?:number,status?:string){
  const entry=this.open.get(id)
  if(entry)this.finish(entry,exit,status)
 }

 private finish(entry:Entry,exit?:number,status?:string,lost=false){
  this.open.delete(entry.shell.id)
  const end=this.now(),size=this.size(entry.shell.file)
  if(size!==undefined)entry.outputBytes=size
  const failed=lost||(exit!==undefined?exit!==0:status!==undefined&&status!=='exited')
  this.writer().push({kind:'span',...this.identity(entry),start:entry.startedAt,end:Math.max(end,entry.startedAt),outcome:lost?'lost':failed?'failed':'completed',recordedAt:end,...(exit!==undefined?{exitCode:exit}:{}),...(status?{status}:{}),...this.totals(entry)})
  if(!this.open.size)this.disarm()
 }

 dispose(){this.disposed=true;this.disarm()}

 private size(file:string|undefined){return file?(this.options.size??fileSize)(file):undefined}
 private arm(){
  if(this.cancel||this.disposed)return
  this.cancel=(this.options.wait??timerWait)(PROCESS_SAMPLE_MS,()=>{this.cancel=undefined;void this.tick()})
 }
 private disarm(){this.cancel?.();this.cancel=undefined}

 async tick(){
  if(this.ticking||this.disposed||!this.open.size)return
  this.ticking=true
  try{
   const table=await (this.options.list??listProcesses)(),now=this.now()
   for(const entry of [...this.open.values()])if(this.open.has(entry.shell.id))this.update(entry,table,now)
  }catch(error){console.error('[quests] process ledger sample failed',error instanceof Error?error.message:error)}
  finally{this.ticking=false;if(this.open.size)this.arm()}
 }

 private enter(entry:Entry,state:Entry['state'],since:number,at:number){
  entry.state=state
  this.writer().push({kind:'process',phase:'state',...this.identity(entry),start:at,state,since,...this.totals(entry)})
 }

 private update(entry:Entry,table:Awaited<ReturnType<ProcessLister>>,now:number){
  const size=this.size(entry.shell.file)??entry.outputBytes
  let cpuGain=0,fresh=0,measured=false
  if(!('unavailable' in table)){
   entry.pid??=entry.shell.pid??matchShellPid(table.processes,entry.shell.command,entry.startedAt)
   const tree=entry.pid===undefined?[]:descendants(table.processes,entry.pid)
   measured=tree.length>0
   if(!measured&&entry.pid!==undefined){
    entry.gone++
    if(entry.gone>=GONE_SAMPLES&&this.size(entry.shell.file)===entry.outputBytes)return this.finish(entry,undefined,'lost',true)
   }else entry.gone=0
   for(const row of tree){
    const key=row.pid+':'+row.createdAt,before=entry.seen.get(key)
    if(before===undefined)fresh++
    cpuGain+=Math.max(0,row.cpuMs-(before??0))
    entry.seen.set(key,Math.max(before??0,row.cpuMs))
   }
  }
  const grew=size>entry.outputBytes
  if(!measured&&!grew){entry.lastAt=now;return}
  entry.totalCpuMs+=cpuGain
  entry.peakCpuPercent=Math.max(entry.peakCpuPercent,cpuGain/Math.max(1,now-entry.lastAt)*100)
  const progress=cpuGain>=CPU_PROGRESS_MS||(entry.sampled&&fresh>0)||grew
  entry.sampled=true
  entry.outputBytes=size
  entry.lastAt=now
  if(progress){
   entry.quietSince=now
   if(entry.state!=='moving')this.enter(entry,'moving',now,now)
   return
  }
  if(entry.state==='moving')this.enter(entry,'quiet',entry.quietSince,now)
  const limit=quietLimit(entry.kind,(this.options.durations??(kind=>loggedDurations(kind)))(entry.kind))
  if(entry.state==='quiet'&&now-entry.quietSince>=limit.ms){
   this.enter(entry,'stuck',entry.quietSince+limit.ms,now)
   this.options.quiet?.({id:entry.shell.id,...entry.who,...(entry.shell.sessionID?{sessionID:entry.shell.sessionID}:{}),command:clip(entry.shell.command),kind:entry.kind,startedAt:entry.startedAt,quietSince:entry.quietSince,quietMs:now-entry.quietSince,limitMs:limit.ms,measured:limit.measured,totalCpuMs:Math.round(entry.totalCpuMs),outputBytes:entry.outputBytes,...(entry.pid!==undefined?{pid:entry.pid}:{})})
  }
 }
}

type HostEvent={type?:string;data?:any;properties?:any}
export function hostShellRecord(event:HostEvent):{created?:ShellRecord;exited?:ShellExit}{
 const body=event?.data??event?.properties
 if(event?.type==='shell.created'&&body?.info){
  const info=body.info,session=info.metadata?.sessionID??info.sessionID
  return {created:{id:String(info.id),command:String(info.command??''),startedAt:Number(info.time?.started)||Date.now(),...(typeof session==='string'?{sessionID:session}:{}),...(typeof info.pid==='number'?{pid:info.pid}:{}),...(typeof info.file==='string'?{file:info.file}:{})}}
 }
 if(event?.type==='shell.exited'&&body?.id)return {exited:{id:String(body.id),...(typeof body.exit==='number'?{exit:body.exit}:{}),...(typeof body.status==='string'?{status:body.status}:{})}}
 return {}
}

const LEDGER=Symbol.for('questgiver.process-ledger')
const shared=globalThis as typeof globalThis&{[LEDGER]?:ProcessLedger}
export const currentProcessLedger=()=>shared[LEDGER]

export function installProcessLedger(ctx:{event?:{subscribe?:Function}},who:(sessionID:string)=>ProcessIdentity,ledger=new ProcessLedger({quiet:quiet=>quietProcess?.(quiet)})){
 const subscribe=ctx?.event?.subscribe
 shared[LEDGER]=ledger
 let disposed=false,fiber:Fiber.Fiber<void,unknown>|undefined
 if(typeof subscribe==='function')queueMicrotask(()=>{
  if(disposed)return
  fiber=Effect.runFork(hostEventLoop({source:ctx.event,subscribe:subscribe as (signal:AbortSignal)=>Promise<unknown>,onEvent:event=>{
   const seen=hostShellRecord(event)
   if(seen.created)ledger.started(seen.created,seen.created.sessionID?who(seen.created.sessionID):{})
   if(seen.exited)ledger.exited(seen.exited.id,seen.exited.exit,seen.exited.status)
  }}).pipe(Effect.provideService(Clock.Clock,timerClock)))
 })
 return ()=>{disposed=true;fiber?.interruptUnsafe();ledger.dispose();if(shared[LEDGER]===ledger)shared[LEDGER]=undefined}
}

let quietProcess:((process:QuietProcess)=>void)|undefined
export function onQuietProcess(listener:((process:QuietProcess)=>void)|undefined){quietProcess=listener}

export type ProcessRecord={id:string;worker?:string;run?:string;quest?:string;session?:string;command:string;kind:string;start:number;end?:number;exitCode?:number;state:ProcessState;since:number;totalCpuMs:number;peakCpuPercent:number;outputBytes:number;host?:string;hostPid?:number;shellPid?:number}

export function processRecords(rows:Record<string,any>[]):ProcessRecord[]{
 const byID=new Map<string,Record<string,any>[]>()
 for(const row of rows){
  if(row?.name!=='process'||typeof row.id!=='string'||!(row.kind==='process'||row.kind==='span'))continue
  const list=byID.get(row.id)??[];list.push(row);byID.set(row.id,list)
 }
 const records:ProcessRecord[]=[]
 for(const list of byID.values()){
  const ordered=list.slice().sort((a,b)=>(a.recordedAt??a.start)-(b.recordedAt??b.start)||(a.phase==='start'?-1:b.phase==='start'?1:0))
  const first=ordered[0]!,last=ordered.at(-1)!,end=ordered.find(row=>row.kind==='span')
  const stated=ordered.filter(row=>row.phase==='state'||row.phase==='start').at(-1)!
  const began=Number(first.began??first.start)
  const failed=end?end.outcome==='failed':false
  records.push({
   id:String(first.id).replace(/^process:/,''),command:String(first.command??''),kind:String(first.op??'other'),start:began,
   ...(first.worker?{worker:first.worker}:{}),...(first.run?{run:first.run}:{}),...(first.quest?{quest:first.quest}:{}),...(first.sessionID?{session:first.sessionID}:{}),
   ...(end?{end:Number(end.end),...(typeof end.exitCode==='number'?{exitCode:end.exitCode}:{})}:{}),
   state:end?end.outcome==='lost'?'lost':failed?'failed':'ended':stated.state,since:end?Number(end.end):Number(stated.since??began),
   totalCpuMs:Number(last.totalCpuMs??0),peakCpuPercent:Number(last.peakCpuPercent??0),outputBytes:Number(last.outputBytes??0),
   ...(first.host?{host:first.host}:{}),...(typeof first.pid==='number'?{hostPid:first.pid}:{}),...(typeof last.shellPid==='number'?{shellPid:last.shellPid}:{}),
  })
 }
 return records.sort((a,b)=>a.start-b.start)
}

export const ledgerNow=spanNow
