import {execFile} from 'node:child_process'
import {appendFileSync,statSync} from 'node:fs'
import {Clock,Effect,Fiber,Schedule} from 'effect'
import {timerClock,timerWait,type Wait} from '../core/timer'
import {listProcesses,progressMade,type ProcessLister,type ProgressSample,type TreeProcess} from './process-progress'

export type CommandKind='git'|'test'|'install'|'gate'|'other'
export type CommandLimits={idleMs:number;wallMs:number}

const MINUTE=60_000
export const COMMAND_LIMITS:Record<CommandKind,CommandLimits>={
 git:{idleMs:2*MINUTE,wallMs:5*MINUTE},
 test:{idleMs:5*MINUTE,wallMs:15*MINUTE},
 install:{idleMs:5*MINUTE,wallMs:15*MINUTE},
 gate:{idleMs:10*MINUTE,wallMs:30*MINUTE},
 other:{idleMs:5*MINUTE,wallMs:10*MINUTE},
}
export const IDLE_PROBE_MS=30_000

const KINDS:{kind:CommandKind;pattern:RegExp}[]=[
 {kind:'gate',pattern:/\bbun\s+run\s+(land|check:[\w-]+)\b|\bscripts[\\/](land|check-gate|affected-tests|core-suite)\b/},
 {kind:'test',pattern:/\b(bun\s+(run\s+)?test|vitest|jest|pytest|playwright|(npm|pnpm|yarn)\s+(run\s+)?test|cargo\s+test|go\s+test|dotnet\s+test)\b/},
 {kind:'install',pattern:/\b(bun|npm|pnpm|yarn)\s+(install|add|i|ci)\b|\bpip\d?\s+install\b|\bcargo\s+(build|install)\b|\bbun\s+run\s+build\b|\bwinget\b|\bnpx\b|\bbunx\b/},
 {kind:'git',pattern:/(^|[;&|(\s])git(\s+-C\s+\S+)?\s+[a-z]/},
]

export function commandKind(command:string):CommandKind{
 const found=KINDS.filter(row=>row.pattern.test(command)).map(row=>row.kind)
 if(!found.length)return 'other'
 return found.reduce((best,kind)=>COMMAND_LIMITS[kind].wallMs>COMMAND_LIMITS[best].wallMs?kind:best)
}

export const commandLimits=(command:string):CommandLimits=>COMMAND_LIMITS[commandKind(command)]

export function clampedTimeout(command:string,requested:number|undefined):number{
 const wall=commandLimits(command).wallMs
 return requested&&requested>0?Math.min(requested,wall):wall
}

export const NON_INTERACTIVE_ENV:Record<string,string>={
 CI:'1',
 GIT_EDITOR:'true',
 GIT_SEQUENCE_EDITOR:'true',
 GIT_MERGE_AUTOEDIT:'no',
 GIT_TERMINAL_PROMPT:'0',
 GCM_INTERACTIVE:'never',
 GIT_PAGER:'cat',
 PAGER:'cat',
 npm_config_yes:'true',
 DEBIAN_FRONTEND:'noninteractive',
}

const seconds=(ms:number)=>ms>=MINUTE?Math.round(ms/MINUTE*10)/10+' min':Math.round(ms/1000)+' s'

export type StopReason='idle'|'wall'
export function stopMessage(kind:CommandKind,reason:StopReason,ranMs:number,quietMs:number):string{
 const limits=COMMAND_LIMITS[kind]
 return reason==='idle'
  ?'[quest] stopped: no output and no CPU use for '+seconds(quietMs)+' (the idle limit for '+kind+' commands is '+seconds(limits.idleMs)+'). It ran '+seconds(ranMs)+' in all. What it printed is above. Find what it waits for, or run a narrower command.'
  :'[quest] stopped: ran '+seconds(ranMs)+', past the '+seconds(limits.wallMs)+' limit for '+kind+' commands. What it printed is above. Run a narrower command, or split the work.'
}

export function descendants(processes:TreeProcess[],pid:number):TreeProcess[]{
 const children=new Map<number,TreeProcess[]>()
 for(const row of processes)(children.get(row.ppid)??children.set(row.ppid,[]).get(row.ppid)!).push(row)
 const found=new Map<number,TreeProcess>(),visit=(parent:number)=>{for(const child of children.get(parent)??[]){if(found.has(child.pid)||child.pid===parent)continue;found.set(child.pid,child);visit(child.pid)}}
 const self=processes.find(row=>row.pid===pid)
 if(self)found.set(self.pid,self)
 visit(pid)
 return [...found.values()]
}

const quoteFree=(command:string)=>command.split(/["'`\\\r\n]+/).reduce((best,part)=>part.trim().length>best.length?part.trim():best,'')

export function matchShellPid(processes:TreeProcess[],command:string,since:number):number|undefined{
 const needle=quoteFree(command).slice(0,160)
 if(needle.length<8)return undefined
 const found=processes.filter(row=>row.command.includes(needle)&&(!row.createdAt||row.createdAt>=since-10_000)&&row.pid!==process.pid).sort((a,b)=>a.createdAt-b.createdAt)
 return found[0]?.pid
}

export function killTree(pid:number):Promise<void>{
 return new Promise(done=>{
  if(process.platform==='win32')return void execFile('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true},()=>done())
  for(const target of [-pid,pid])try{process.kill(target,'SIGKILL')}catch{}
  done()
 })
}

export type GuardedCommand={id:string;pid?:number;command:string;file?:string}
export type GuardStop={id:string;command:string;kind:CommandKind;reason:StopReason;ranMs:number;quietMs:number;killed:boolean}
export type CommandGuardOptions={
 now?:()=>number
 wait?:Wait
 size?:(file:string)=>number|undefined
 list?:ProcessLister
 kill?:(pid:number)=>Promise<void>
 note?:(file:string,text:string)=>void
 stopped?:(stop:GuardStop)=>void
}

type Entry={command:GuardedCommand;kind:CommandKind;startedAt:number;lastSize:number;quietSince:number;baseline?:ProgressSample;cancels:(()=>void)[];done:boolean}

const fileSize=(file:string)=>{try{return statSync(file).size}catch{return undefined}}
const appendNote=(file:string,text:string)=>{try{appendFileSync(file,'\n'+text+'\n')}catch{}}

export class CommandGuard{
 private readonly running=new Map<string,Entry>()
 constructor(private readonly options:CommandGuardOptions={}){}
 private now(){return (this.options.now??Date.now)()}
 private wait(){return this.options.wait??timerWait}
 get active(){return this.running.size}

 started(command:GuardedCommand){
  if(this.running.has(command.id))return
  const kind=commandKind(command.command),limits=COMMAND_LIMITS[kind],now=this.now()
  const entry:Entry={command,kind,startedAt:now,lastSize:this.size(command.file)??0,quietSince:now,cancels:[],done:false}
  this.running.set(command.id,entry)
  entry.cancels.push(this.wait()(limits.wallMs,()=>void this.stop(entry,'wall')))
  this.armIdle(entry,limits.idleMs)
 }

 exited(id:string){
  const entry=this.running.get(id)
  if(!entry)return
  entry.done=true
  for(const cancel of entry.cancels)cancel()
  this.running.delete(id)
 }

 private size(file:string|undefined){return file?(this.options.size??fileSize)(file):undefined}

 private armIdle(entry:Entry,after:number){
  entry.cancels.push(this.wait()(after,()=>void this.checkIdle(entry)))
 }

 private async checkIdle(entry:Entry){
  if(entry.done)return
  const now=this.now(),size=this.size(entry.command.file)
  if(size!==undefined&&size>entry.lastSize){entry.lastSize=size;entry.quietSince=now;entry.baseline=undefined;return this.armIdle(entry,COMMAND_LIMITS[entry.kind].idleMs)}
  const {sample}=await this.measure(entry,size??entry.lastSize,now)
  if(entry.done)return
  if(!sample)return this.armIdle(entry,COMMAND_LIMITS[entry.kind].idleMs)
  if(!entry.baseline){entry.baseline=sample;return this.armIdle(entry,IDLE_PROBE_MS)}
  if(progressMade(entry.baseline,sample)){entry.baseline=undefined;entry.quietSince=now;return this.armIdle(entry,COMMAND_LIMITS[entry.kind].idleMs)}
  await this.stop(entry,'idle')
 }

 private async measure(entry:Entry,outputBytes:number,now:number):Promise<{pid?:number;sample?:ProgressSample}>{
  const table=await (this.options.list??listProcesses)()
  if('unavailable' in table)return {}
  const pid=entry.command.pid??matchShellPid(table.processes,entry.command.command,entry.startedAt)
  if(pid===undefined)return {}
  entry.command.pid=pid
  return {pid,sample:{at:now,processes:descendants(table.processes,pid).map(({pid,createdAt,cpuMs})=>({pid,createdAt,cpuMs})),outputBytes}}
 }

 private async stop(entry:Entry,reason:StopReason){
  if(entry.done)return
  entry.done=true
  for(const cancel of entry.cancels)cancel()
  this.running.delete(entry.command.id)
  const now=this.now(),ranMs=now-entry.startedAt,quietMs=now-entry.quietSince
  if(entry.command.file)(this.options.note??appendNote)(entry.command.file,stopMessage(entry.kind,reason,ranMs,quietMs))
  const pid=entry.command.pid??(await this.measure(entry,0,now)).pid
  if(pid!==undefined)await (this.options.kill??killTree)(pid).catch(()=>{})
  this.options.stopped?.({id:entry.command.id,command:entry.command.command,kind:entry.kind,reason,ranMs,quietMs,killed:pid!==undefined})
 }
}

type Hook=(name:string,callback:(input:any)=>void)=>Promise<unknown>
type HostEvent={type?:string;data?:any;properties?:any}

export function hostShellEvent(event:HostEvent):{created?:GuardedCommand;exited?:string}{
 const body=event?.data??event?.properties
 if(event?.type==='shell.created'&&body?.info){
  const info=body.info
  return {created:{id:String(info.id),pid:typeof info.pid==='number'?info.pid:undefined,command:String(info.command??''),file:typeof info.file==='string'?info.file:undefined}}
 }
 if(event?.type==='shell.exited'&&body?.id)return {exited:String(body.id)}
 return {}
}

const BACKGROUND=new Set<string>()
const SHELL_TOOLS=new Set(['shell','bash'])
const RECONNECT_MS='2 seconds'

export type HostEventLoop={source:unknown;subscribe:(signal:AbortSignal)=>Promise<unknown>;onEvent:(event:any)=>void}

export const hostEventLoop=({source,subscribe,onEvent}:HostEventLoop):Effect.Effect<void,unknown>=>{
 const drain=Effect.callback<void,unknown>((resume,signal)=>{
  void (async()=>{
   try{
    const stream=await subscribe.call(source,{signal})
    for await(const event of stream)onEvent(event)
    resume(Effect.void)
   }catch(error){resume(Effect.fail(error))}
  })()
 })
 return drain.pipe(
  Effect.retry(Schedule.spaced(RECONNECT_MS)),
  Effect.repeat(Schedule.spaced(RECONNECT_MS))
 )
}

export function installCommandGuard(ctx:{shell?:{hook?:Hook};tool?:{hook?:Hook};event?:{subscribe?:Function}},guard=new CommandGuard()){
 const shell=ctx?.shell?.hook,tool=ctx?.tool?.hook,subscribe=ctx?.event?.subscribe
 const ready:Promise<unknown>[]=[]
 let disposed=false,fiber:Fiber.Fiber<void,unknown>|undefined
 if(typeof shell==='function')ready.push(shell.call(ctx.shell,'create.before',invocation=>{
  Object.assign(invocation.env,NON_INTERACTIVE_ENV)
  if(invocation.timeout>0)invocation.timeout=clampedTimeout(invocation.command,invocation.timeout)
 }))
 if(typeof tool==='function')ready.push(tool.call(ctx.tool,'execute.before',(event:any)=>{
  const input=event?.input
  if(!SHELL_TOOLS.has(event?.tool)||!input||typeof input.command!=='string')return
  if(input.background===true){if(BACKGROUND.size>200)BACKGROUND.clear();BACKGROUND.add(input.command);return}
  input.timeout=clampedTimeout(input.command,typeof input.timeout==='number'?input.timeout:undefined)
 }))
 if(typeof subscribe==='function')queueMicrotask(()=>{
  if(disposed)return
  fiber=Effect.runFork(hostEventLoop({source:ctx.event,subscribe:subscribe as (signal:AbortSignal)=>Promise<unknown>,onEvent:event=>{
   const seen=hostShellEvent(event)
   if(seen.created&&!BACKGROUND.delete(seen.created.command))guard.started(seen.created)
   if(seen.exited)guard.exited(seen.exited)
  }}).pipe(Effect.provideService(Clock.Clock,timerClock)))
 })
 return {ready:Promise.all(ready),dispose:()=>{disposed=true;fiber?.interruptUnsafe()}}
}
