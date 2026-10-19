import {execFile,type ChildProcess} from 'node:child_process'
import {join,resolve} from 'node:path'
import {Database} from 'bun:sqlite'
import {existsSync} from 'node:fs'

export type TreeProcess={pid:number;ppid:number;name:string;command:string;createdAt:number;cpuMs:number}
export type ProcessTable={processes:TreeProcess[]}|{unavailable:string}
export type ProcessLister=()=>Promise<ProcessTable>
export type TreeLocation={worktree?:string;hostPID?:number;callStart:number}
export type ProgressSample={at:number;processes:{pid:number;createdAt:number;cpuMs:number}[];outputBytes:number}
export type ToolCallInfo={tool:string;command:string;start:number;outputBytes:number}
export type SessionToolCalls={running?:ToolCallInfo}

export const CPU_PROGRESS_MS=500
export const CALL_START_SLACK_MS=5_000
export const MERGE_OR_PUSH=/\bgh\s+pr\s+merge\b|\bgit(\s+-C\s+\S+)?\s+(push|merge)\b/

const WINDOWS_QUERY=`$ErrorActionPreference='Stop';$epoch=[datetime]'1970-01-01';@(Get-CimInstance Win32_Process|ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=[string]$_.Name;command=[string]$_.CommandLine;createdAt=$(if($_.CreationDate){[int64]($_.CreationDate.ToUniversalTime()-$epoch).TotalMilliseconds}else{0});cpuMs=[int64](([uint64]$_.KernelModeTime+[uint64]$_.UserModeTime)/10000)}})|ConvertTo-Json -Compress -Depth 3`
const powershell=()=>process.env.SystemRoot?join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):'powershell.exe'
const LISTING=process.platform==='win32'
 ?{command:powershell(),args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',WINDOWS_QUERY]}
 :{command:'ps',args:['-A','-o','pid=,ppid=,etimes=,times=,args=']}

function parseListing(stdout:string):TreeProcess[]{
 if(process.platform==='win32'){const parsed=JSON.parse(stdout);return (Array.isArray(parsed)?parsed:[parsed]).map((row:any)=>({pid:Number(row.pid),ppid:Number(row.ppid),name:String(row.name??''),command:String(row.command??''),createdAt:Number(row.createdAt)||0,cpuMs:Number(row.cpuMs)||0}))}
 const now=Date.now()
 return stdout.split('\n').flatMap(line=>{
  const parts=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line)
  return parts?[{pid:Number(parts[1]),ppid:Number(parts[2]),name:parts[5].split(/\s/)[0]??'',command:parts[5],createdAt:now-Number(parts[3])*1000,cpuMs:Number(parts[4])*1000}]:[]
 })
}

const spawnListing:ProcessLister=()=>new Promise(done=>{
 let child:ChildProcess|undefined
 child=execFile(LISTING.command,LISTING.args,{encoding:'utf8',windowsHide:true,timeout:60_000,maxBuffer:64*1024*1024},(error,stdout)=>{
  if(error)return done({unavailable:LISTING.command+' could not list processes: '+error.message})
  try{const processes=parseListing(stdout).filter(row=>Number.isSafeInteger(row.pid)&&row.pid>0&&row.pid!==child?.pid);done(processes.length?{processes}:{unavailable:'the process list came back empty'})}
  catch(cause){done({unavailable:'the process list could not be read: '+(cause instanceof Error?cause.message:String(cause))})}
 })
})

export function sharedListing(list:ProcessLister):ProcessLister{
 let inFlight:Promise<ProcessTable>|undefined
 return ()=>inFlight??=list().finally(()=>{inFlight=undefined})
}

export const listProcesses:ProcessLister=sharedListing(spawnListing)

const pathForms=(path:string)=>{
 const forward=resolve(path).replaceAll('\\','/').replace(/\/+$/,'').toLowerCase()
 const drive=/^([a-z]):\//.exec(forward)
 return drive?[forward,'/'+drive[1]+forward.slice(2)]:[forward]
}

export function workerTree(processes:TreeProcess[],at:TreeLocation,self=process.pid):TreeProcess[]{
 const byPid=new Map(processes.map(row=>[row.pid,row])),children=new Map<number,TreeProcess[]>()
 for(const row of processes){const parent=byPid.get(row.ppid);if(parent&&parent.pid!==row.pid&&(!row.createdAt||!parent.createdAt||parent.createdAt<=row.createdAt))(children.get(parent.pid)??children.set(parent.pid,[]).get(parent.pid)!).push(row)}
 const forms=at.worktree?pathForms(at.worktree):[]
 const excluded=new Set([self,at.hostPID])
 const member=new Map<number,TreeProcess>()
 const add=(row:TreeProcess)=>{if(excluded.has(row.pid)||member.has(row.pid))return;member.set(row.pid,row);for(const child of children.get(row.pid)??[])add(child)}
 for(const row of processes){const text=row.command.replaceAll('\\','/').toLowerCase();if(forms.some(form=>text.includes(form)))add(row)}
 if(at.hostPID!==undefined){
  const walk=(row:TreeProcess)=>{for(const child of children.get(row.pid)??[]){if(child.createdAt>=at.callStart-CALL_START_SLACK_MS)add(child);else walk(child)}}
  const host=byPid.get(at.hostPID)
  if(host)walk(host)
 }
 return [...member.values()]
}

export async function sampleProgress(at:TreeLocation&{outputBytes:number;now:number},lister:ProcessLister=listProcesses):Promise<ProgressSample|{unavailable:string}>{
 const table=await lister()
 if('unavailable' in table)return table
 return {at:at.now,processes:workerTree(table.processes,at).map(({pid,createdAt,cpuMs})=>({pid,createdAt,cpuMs})),outputBytes:at.outputBytes}
}

export async function killCommandTree(worktree:string|undefined,lister:ProcessLister=listProcesses,kill:(pid:number)=>void=pid=>{try{process.kill(pid,'SIGKILL')}catch{}}):Promise<number[]>{
 if(!worktree)return []
 const table=await lister()
 if('unavailable' in table)return []
 const spared=lineageOf(table.processes,process.pid)
 const victims=workerTree(table.processes,{worktree,callStart:0}).filter(row=>!spared.has(row.pid)&&!/opencode|quest-host|^system$/i.test(row.name+' '+row.command.split(/\s+/)[0]))
 for(const row of victims)kill(row.pid)
 return victims.map(row=>row.pid)
}
function lineageOf(processes:TreeProcess[],pid:number){
 const byPid=new Map(processes.map(row=>[row.pid,row])),found=new Set<number>()
 for(let row=byPid.get(pid);row&&!found.has(row.pid);row=byPid.get(row.ppid))found.add(row.pid)
 return found
}

const seconds=(ms:number)=>(Math.round(ms/100)/10)+' s'
export function progressMade(before:ProgressSample,after:ProgressSample):string|undefined{
 const earlier=new Map(before.processes.map(row=>[row.pid+':'+row.createdAt,row.cpuMs]))
 const started=after.processes.filter(row=>!earlier.has(row.pid+':'+row.createdAt)).length
 const cpu=after.processes.reduce((total,row)=>total+Math.max(0,row.cpuMs-(earlier.get(row.pid+':'+row.createdAt)??row.cpuMs)),0)
 const reasons=[...(cpu>=CPU_PROGRESS_MS?['used '+seconds(cpu)+' of CPU time']:[]),...(started?['started '+started+' new process'+(started===1?'':'es')]:[]),...(after.outputBytes>before.outputBytes?['wrote '+(after.outputBytes-before.outputBytes)+' bytes of output']:[])]
 return reasons.length?'its process tree '+reasons.join(', '):undefined
}

const treeReadings=new Map<string,{at:number;moving:boolean}>()
export function recordTreeProgress(sessionID:string,at:number,moving:boolean){treeReadings.set(sessionID,{at,moving});if(treeReadings.size>2000)treeReadings.delete(treeReadings.keys().next().value!)}
export const treeProgressOf=(sessionID:string)=>treeReadings.get(sessionID)


const callText=(input:unknown)=>{
 if(typeof input==='string')return input
 const row=(input??{}) as Record<string,unknown>
 const direct=row.command??row.cmd??row.code
 return typeof direct==='string'?direct:JSON.stringify(row)
}

export function sessionToolCalls(hostDB:string,sessionID:string):SessionToolCalls{
 if(!existsSync(hostDB))return {}
 const db=new Database(hostDB,{readonly:true})
 try{
  const rows=db.query("select data from session_message where session_id = ? and type = 'assistant' order by seq").all(sessionID) as {data:string}[]
  const found:SessionToolCalls={}
  for(const row of rows){
   let message:any
   try{message=JSON.parse(row.data)}catch{continue}
   for(const part of message?.content??[]){
    if(part?.type!=='tool'||typeof part.name!=='string')continue
    const time=part.time??{},start=time.ran??time.created,status=String(part.state?.status??'unknown')
    if(typeof start!=='number')continue
    const output=part.state?.metadata?.output??part.state?.output
    const info={tool:part.name,command:callText(part.state?.input),start,outputBytes:typeof output==='string'?Buffer.byteLength(output):0}
    if(['running','pending','unknown'].includes(status))found.running=info
   }
  }
  return found
 }finally{db.close()}
}
