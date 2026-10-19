import {dirname} from 'node:path'
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads'
import {acquireLock,LockBusyError} from '../locking.mts'
import {recordSpan} from '../../scripts/plugin-spans'

export type SweepReport={slimmed:number;droppedSessions:number;vacuumed:boolean;vacuumSkipped?:string;longestWriteMs:number;bytesBefore:number;bytesAfter:number;ms:number;busy?:boolean}
export type SweepAnswer={ran:true;report:SweepReport}|{ran:false;reason:string}
type SweepInput={file:string;budget:number;protectedSessionIDs:string[]}

function inThread(input:SweepInput):Promise<SweepReport&{saved:boolean}>{
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{hostDatabaseSweep:input}})
  let answered=false
  worker.once('message',(answer:{report?:SweepReport&{saved:boolean};error?:string})=>{answered=true;answer.error!==undefined?reject(new Error(answer.error)):resolve(answer.report!)})
  worker.once('error',reject)
  worker.once('exit',code=>{if(!answered)reject(new Error('Host database sweep thread ended without a result (exit '+code+')'))})
 })
}

export async function sweepHostDatabase(input:{file:string;budget:number;protectedSessionIDs:Iterable<string>}):Promise<SweepAnswer>{
 let lock
 try{lock=acquireLock(dirname(input.file),'host-database-sweep',{timeoutMs:0,staleMs:15*60_000})}
 catch(error){if(error instanceof LockBusyError)return {ran:false,reason:'another host process is sweeping this database'};throw error}
 const start=performance.timeOrigin+performance.now()
 try{
  const report=await inThread({file:input.file,budget:input.budget,protectedSessionIDs:[...input.protectedSessionIDs]})
  recordSpan({plugin:'quests',name:'host-database.sweep',op:report.slimmed+' slimmed, '+report.droppedSessions+' sessions dropped'+(report.vacuumed?', vacuumed':'')+(report.vacuumSkipped?', vacuum skipped ('+report.vacuumSkipped+')':'')+', longest write '+report.longestWriteMs+' ms, '+report.bytesBefore+' to '+report.bytesAfter+' bytes',start,end:start+report.ms,outcome:report.saved?'swept':'busy, tried again next hour'})
  return {ran:true,report}
 }finally{lock.release()}
}

if(!isMainThread&&workerData?.hostDatabaseSweep)void (async()=>{
 try{
  const {enforceHostDatabaseBudget}=await import('../../scripts/host-database-budget.mjs')
  const input=workerData.hostDatabaseSweep as SweepInput,report:any={}
  const saved=enforceHostDatabaseBudget(input.file,{budget:input.budget,protectedSessionIDs:new Set(input.protectedSessionIDs),report})
  parentPort!.postMessage({report:{slimmed:0,droppedSessions:0,vacuumed:false,longestWriteMs:0,bytesBefore:0,bytesAfter:0,ms:0,...report,saved}})
 }catch(error){parentPort!.postMessage({error:error instanceof Error?error.message:String(error)})}
 finally{parentPort!.close()}
})()
