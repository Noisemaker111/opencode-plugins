import {readSpanRows,SPANS_FILE} from '../../scripts/span-store'
import {latencyWindow} from '../../usage/latency'
import {processRecords,type ProcessRecord,type ProcessState} from '../workers/process-ledger'
import {processState} from './state-classes'

export const DEFAULT_PROCESS_WINDOW='24h'

export type ProcessRow={rank:number;id:string;state:ProcessState;since:string;inStateMs:number;ranMs:number;running:boolean;worker:string|null;run:string|null;quest:string|null;command:string;kind:string;startedAt:string;endedAt:string|null;exitCode:number|null;cpuMs:number;cpuShare:number|null;peakCpuPercent:number;outputBytes:number}
export type ProcessesPicture={at:number;window:string;total:number;running:number;stuck:number;states:Record<string,number>;text:string;rows:ProcessRow[];diagnostics:string[]}

const iso=(at:number)=>new Date(at).toISOString()
const two=(value:number)=>Math.round(value*100)/100

function rowOf(record:ProcessRecord,now:number):Omit<ProcessRow,'rank'>{
 const running=record.end===undefined,ranMs=Math.max(0,(record.end??now)-record.start)
 const held=processState(record.id,record.state,now,record.since)
 return {id:record.id,state:record.state,since:held.sinceAt,inStateMs:held.forMs,ranMs,running,worker:record.worker??null,run:record.run??null,quest:record.quest??null,command:record.command,kind:record.kind,startedAt:iso(record.start),endedAt:record.end===undefined?null:iso(record.end),exitCode:record.exitCode??null,cpuMs:record.totalCpuMs,cpuShare:ranMs>0?two(record.totalCpuMs/ranMs):null,peakCpuPercent:record.peakCpuPercent,outputBytes:record.outputBytes}
}

export function processesPicture(input:{window?:string}={},sources:{spansFile?:string;now?:()=>number}={}):ProcessesPicture{
 const at=(sources.now??Date.now)(),window=latencyWindow(input.window??DEFAULT_PROCESS_WINDOW),from=at-window.milliseconds
 const diagnostics:string[]=[]
 let records:ProcessRecord[]=[]
 try{records=processRecords(readSpanRows(sources.spansFile??process.env.OPENCODE_SPANS_FILE??SPANS_FILE,{from})).filter(record=>record.end===undefined||record.end>=from)}
 catch(error){diagnostics.push('process log unread: '+(error instanceof Error?error.message:String(error)))}
 const rows=records.map(record=>rowOf(record,at)).sort((a,b)=>Number(b.running)-Number(a.running)||b.ranMs-a.ranMs).map((row,index)=>({rank:index+1,...row}))
 const states:Record<string,number>={}
 for(const row of rows)states[row.state]=(states[row.state]??0)+1
 const running=rows.filter(row=>row.running).length,stuck=states.stuck??0,top=rows[0]
 const text='In the last '+window.label+': '+rows.length+' worker processes, '+running+' running now'+(stuck?', '+stuck+' stuck with no CPU and no output':'')+(top?'. Longest: '+Math.round(top.ranMs/60_000)+' min'+(top.running?' and still running':'')+', '+top.command.slice(0,60):'')+'.'
 return {at,window:window.label,total:rows.length,running,stuck,states,text,rows,diagnostics}
}
