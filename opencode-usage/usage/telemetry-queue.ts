import {LockBusyError} from '../quest/locking.mts'
import {delayMsOf} from '../quest/core/backoff'
import {timerClock} from '../quest/core/timer'
import {recordSpan,spanWriter,type SpanRow} from '../scripts/plugin-spans'
import {appendRequests,cacheRequest,spanFile,TELEMETRY_FILE} from './telemetry-store'
import {recordLedgerRequests,PASSIVE_LEDGER_FILE} from './passive-ledger'
import type {RequestRecord} from './telemetry'
import {Clock,Duration,Effect,Fiber,Latch,Schedule} from 'effect'

export type TelemetrySink={
 requests(rows:RequestRecord[],options:{timeoutMs:number}):void
 ledger(rows:RequestRecord[],options:{busyMs:number}):void
}
export type TelemetryQueueOptions={sink?:TelemetrySink;delayMs?:number;retryMinMs?:number;retryMaxMs?:number;maxPending?:number;exitWaitMs?:number;statsIntervalMs?:number;now?:()=>number;clock?:Clock.Clock}
export type Losses={saved:number;persisted:number;dropped:number;busy:number;drainError:number;maxFlushMs:number}
export type TelemetryQueueStats=Losses&{submitted:number;flushes:number;pending:number;maxPending:number;lastFlushMs:number}

const BUSY=/SQLITE_BUSY|database is locked|database table is locked/i
const isBusy=(error:unknown)=>error instanceof LockBusyError||BUSY.test(`${(error as any)?.code} ${(error as any)?.message}`)
const errorKind=(error:unknown)=>String((error as {code?:unknown})?.code??(error as {name?:unknown})?.name??'error')

const productionSink=(requestsFile:string,ledgerFile:string):TelemetrySink=>({
 requests:(rows,options)=>appendRequests(rows,requestsFile,options),
 ledger:(rows,options)=>recordLedgerRequests(rows,ledgerFile,options.busyMs),
})

const retryLadder=(minMs:number,maxMs:number):Schedule.Schedule<number,void>=>Schedule.min([
 Schedule.exponential(Duration.millis(minMs)),
 Schedule.spaced(Duration.millis(maxMs)),
])
const ladderAt=(schedule:Schedule.Schedule<number,void>,attempt:number)=>delayMsOf(schedule,attempt,16)

export class TelemetryQueue{
 private readonly requests=new Map<string,RequestRecord>()
 private readonly ledger=new Map<string,RequestRecord>()
 private fiber:Fiber.Fiber<void,unknown>|undefined
 private readonly wake=Latch.makeUnsafe()
 private misses=0
 private reportedKey=''
 private reportedAt=-Infinity
 private readonly numbers={submitted:0,flushes:0,maxPending:0,lastFlushMs:0,saved:0,persisted:0,busy:0,dropped:0,drainError:0,maxFlushMs:0}
 private readonly sink:TelemetrySink
 private readonly delayMs:number
 private readonly retryMinMs:number
 private readonly retryMaxMs:number
 private readonly maxPending:number
 private readonly exitWaitMs:number
 private readonly statsIntervalMs:number
 private readonly now:()=>number
 private readonly ladder:readonly number[]
 private readonly clock:Clock.Clock
 constructor(private readonly file=TELEMETRY_FILE,options:TelemetryQueueOptions={}){
  this.sink=options.sink??productionSink(file,PASSIVE_LEDGER_FILE)
  this.delayMs=options.delayMs??50
  this.retryMinMs=options.retryMinMs??25
  this.retryMaxMs=options.retryMaxMs??1000
  this.maxPending=options.maxPending??2000
  this.exitWaitMs=options.exitWaitMs??2000
  this.statsIntervalMs=options.statsIntervalMs??60_000
  this.now=options.now??Date.now
  this.ladder=retryLadder(this.retryMinMs,this.retryMaxMs)
  this.clock=options.clock??timerClock
 }
 submit(record:RequestRecord){
  cacheRequest(record,this.file)
  this.numbers.submitted++
  this.requests.set(record.id,record)
  this.ledger.set(record.id,record)
  this.trim(this.requests)
  this.trim(this.ledger)
  this.numbers.maxPending=Math.max(this.numbers.maxPending,this.requests.size)
  if(!this.fiber)this.startLoop()
  this.wake.openUnsafe()
 }
 private trim(rows:Map<string,RequestRecord>){
  if(rows.size<=this.maxPending)return
  for(const [id,row] of rows){
   if(rows.size<=this.maxPending)break
   if(row.state==='running'){rows.delete(id);this.numbers.dropped++}
  }
 }
 private startLoop(){
  const self=this
  this.fiber=Effect.runFork(Effect.gen(function*(){
   for(;;){
    if(self.misses===0){
     yield* self.wake.await
     self.wake.closeUnsafe()
     yield* Effect.sleep(Duration.millis(self.delayMs))
    }else{
     yield* Effect.sleep(Duration.millis(ladderAt(self.ladder,self.misses)))
    }
    self.flush()
   }
  }).pipe(Effect.provideService(Clock.Clock,this.clock)))
 }
 private attempt(rows:Map<string,RequestRecord>,write:(batch:RequestRecord[])=>void,kind:'saved'|'persisted'){
  if(!rows.size)return true
  const batch=[...rows.values()]
  try{write(batch);this.numbers[kind]+=batch.length;for(const row of batch)if(rows.get(row.id)===row)rows.delete(row.id);return true}
  catch(error){
   if(isBusy(error)){this.numbers.busy++;return false}
   this.numbers.dropped+=batch.length
   for(const row of batch)if(rows.get(row.id)===row)rows.delete(row.id)
   console.error('[usage] request telemetry not saved',error instanceof Error?error.message:error)
   return true
  }
 }
 flush(){
  if(!this.requests.size&&!this.ledger.size)return
  const start=this.now(),count=this.requests.size
  const savedRequests=this.attempt(this.requests,batch=>this.sink.requests(batch,{timeoutMs:0}),'saved')
  const savedLedger=this.attempt(this.ledger,batch=>this.sink.ledger(batch,{busyMs:0}),'persisted')
  const ms=this.now()-start
  this.numbers.flushes++
  this.numbers.lastFlushMs=ms
  this.numbers.maxFlushMs=Math.max(this.numbers.maxFlushMs,ms)
  const clear=savedRequests&&savedLedger
  if(ms>=20||!clear)recordSpan({plugin:'usage',name:'telemetry.flush',op:count+' rows',start,end:start+ms,outcome:clear?'saved':'busy, kept for the next try'})
  this.report(false)
  if(clear){this.misses=0;return}
  this.misses++
 }
 drain(){
  if(this.fiber){this.fiber.interruptUnsafe();this.fiber=undefined}
  this.misses=0
  const until=this.now()+this.exitWaitMs
  while((this.requests.size||this.ledger.size)&&this.now()<until){
   try{
    if(this.requests.size){const batch=[...this.requests.values()];this.sink.requests(batch,{timeoutMs:Math.max(0,until-this.now())});this.numbers.saved+=batch.length;this.requests.clear()}
    if(this.ledger.size){const batch=[...this.ledger.values()];this.sink.ledger(batch,{busyMs:Math.max(0,until-this.now())});this.numbers.persisted+=batch.length;this.ledger.clear()}
   }catch(error){
    if(isBusy(error))continue
    this.numbers.drainError++
    console.error('[usage] telemetry drain failed:',errorKind(error))
    break
   }
  }
  this.numbers.dropped+=this.requests.size
  this.report(true)
  spanWriter(spanFile(this.file)).flushSync()
 }
 private report(force:boolean){
  const losses=this.losses(), key=JSON.stringify(losses)
  if(key===this.reportedKey||(!force&&this.now()-this.reportedAt<this.statsIntervalMs))return
  this.reportedKey=key
  this.reportedAt=this.now()
  const at=this.now(), row:SpanRow&Losses={plugin:'usage',name:'telemetry.queue',start:at,end:at,...losses}
  recordSpan(row,spanWriter(spanFile(this.file)))
 }
 private losses():Losses{
  const {saved,persisted,dropped,busy,drainError,maxFlushMs}=this.numbers
  return {saved,persisted,dropped,busy,drainError,maxFlushMs}
 }
 stats():TelemetryQueueStats{return {...this.numbers,pending:this.requests.size}}
}

let shared:TelemetryQueue|undefined
export function telemetryQueue(){
 if(!shared){
  shared=new TelemetryQueue()
  process.once('exit',()=>shared?.drain())
 }
 return shared
}
export const telemetryQueueStats=()=>shared?.stats()
