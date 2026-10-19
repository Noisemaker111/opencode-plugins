import {execFile,spawnSync} from 'node:child_process'
import {readlink} from 'node:fs/promises'
import {join} from 'node:path'

export const running=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true}catch(error){return error.code==='EPERM'}}

const CLEAN=`-replace '[\\u0000-\\u001F\\u007F]',' '`
const WINDOWS_QUERY=`$ErrorActionPreference='Stop';$epoch=[datetime]'1970-01-01';@(Get-CimInstance Win32_Process|ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=[string]$_.Name ${CLEAN};image=[string]$_.ExecutablePath ${CLEAN};command=[string]$_.CommandLine ${CLEAN};createdAt=$(if($_.CreationDate){[int64]($_.CreationDate.ToUniversalTime()-$epoch).TotalMilliseconds}else{0})}})|ConvertTo-Json -Compress -Depth 3`
const powershell=()=>process.env.SystemRoot?join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):'powershell.exe'
const LISTING=process.platform==='win32'
 ?{command:powershell(),args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',WINDOWS_QUERY]}
 :{command:'ps',args:['-A','-o','pid=,ppid=,etimes=,comm=,args=']}
const OPTIONS={encoding:'utf8',windowsHide:true,timeout:30_000,maxBuffer:64*1024*1024}

function parse(stdout){
 if(process.platform==='win32'){const parsed=JSON.parse(stdout);return Array.isArray(parsed)?parsed:[parsed]}
 const now=Date.now()
 return stdout.split('\n').map(line=>{
  const parts=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
  if(!parts)return undefined
  return {pid:Number(parts[1]),ppid:Number(parts[2]),name:parts[4],image:parts[4],command:parts[5],createdAt:now-Number(parts[3])*1000}
 }).filter(Boolean)
}

function snapshot(entries){
 const processes=entries.filter(entry=>Number.isSafeInteger(entry.pid)&&entry.pid>0)
 if(!processes.length)throw Error('the process listing came back empty, which no live machine produces')
 return {processes,at:Date.now()}
}

const failure=(status,stderr)=>Error(`${LISTING.command} exited ${status}: ${(stderr||'').trim().slice(0,300)||'no diagnostic'}`)

export function processSnapshot(){
 try{
  const run=spawnSync(LISTING.command,LISTING.args,OPTIONS)
  if(run.error)throw Error(`${LISTING.command} could not run: ${run.error.message}`)
  if(run.status!==0)throw failure(run.status,run.stderr)
  return snapshot(parse(run.stdout))
 }catch(error){return {unavailable:String(error?.message??error)}}
}

export async function processListing(){
 try{
  const stdout=await new Promise((done,fail)=>execFile(LISTING.command,LISTING.args,OPTIONS,(error,out,stderr)=>{
   if(error)fail(typeof error.code==='number'?failure(error.code,stderr):Error(`${LISTING.command} could not run: ${error.message}`));else done(out)
  }))
  const listed=snapshot(parse(stdout))
  if(process.platform==='linux')await Promise.all(listed.processes.map(async entry=>{try{entry.cwd=await readlink(`/proc/${entry.pid}/cwd`)}catch{}}))
  return listed
 }catch(error){return {unavailable:String(error?.message??error)}}
}
