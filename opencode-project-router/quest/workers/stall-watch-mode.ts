import {appendFileSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs'
import {join} from 'node:path'
import type {StallNotice} from './stall-signal'

export type StallWatchMode='log'|'stop'
export const STALL_WATCH_SETTINGS='stall-watch.json'
export const FROZEN_RUN_LOG='frozen-runs.jsonl'
export const STALL_STOPS='stall-stops.json'
export const STOPS_PER_COMMAND=2

export function stallWatchMode(runtime:string):StallWatchMode{
 try{return JSON.parse(readFileSync(join(runtime,STALL_WATCH_SETTINGS),'utf8'))?.frozenRuns==='log'?'log':'stop'}catch{return 'stop'}
}

export function logFrozenRun(runtime:string,notice:StallNotice,at=Date.now(),action='logged, not stopped'){
 const row={at:new Date(at).toISOString(),questID:notice.run.questID,runID:notice.run.runID,sessionID:notice.sessionID,silentMs:notice.assessment.frozenSilenceMs,reason:notice.text,action,...(notice.command?{command:notice.command}:{})}
 try{mkdirSync(runtime,{recursive:true});appendFileSync(join(runtime,FROZEN_RUN_LOG),JSON.stringify(row)+'\n')}catch(error){console.error('[quests] frozen run not logged',error instanceof Error?error.message:error)}
 console.error('[quests] frozen run '+action,notice.run.runID,notice.text)
 return row
}

const stopKey=(notice:StallNotice)=>[notice.run.questID,[...notice.run.stepTitles].sort().join('|'),(notice.command??'').replace(/\s+/g,' ').trim()].join('\n')

function readStops(runtime:string):Record<string,number>{
 try{const parsed=JSON.parse(readFileSync(join(runtime,STALL_STOPS),'utf8'));return parsed&&typeof parsed==='object'?parsed:{}}catch{return {}}
}

function saveStops(runtime:string,stops:Record<string,number>){
 mkdirSync(runtime,{recursive:true})
 const file=join(runtime,STALL_STOPS),temporary=file+'.'+process.pid+'.tmp'
 writeFileSync(temporary,JSON.stringify(stops));renameSync(temporary,file)
}

export function stopsFor(runtime:string,notice:StallNotice){return readStops(runtime)[stopKey(notice)]??0}

export function lastFrozenRunAction(runtime:string,questID:string,runID:string,sessionID:string){
 let text:string
 try{
  text=readFileSync(join(runtime,FROZEN_RUN_LOG),'utf8')
 }catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?undefined:'resume acknowledgement unknown'}
 for(const line of text.trim().split('\n').reverse())try{
  const row=JSON.parse(line)
  if(row.questID===questID&&row.runID===runID&&row.sessionID===sessionID)return String(row.action??'')
 }catch{return 'resume acknowledgement unknown'}
}

export async function onFrozenRun(runtime:string,notice:StallNotice,stop:(notice:StallNotice,attempt:number)=>Promise<unknown>,held?:(notice:StallNotice,reason:string)=>void|Promise<void>){
 if(stallWatchMode(runtime)!=='stop'){logFrozenRun(runtime,notice);return}
 const stops=readStops(runtime),key=stopKey(notice),count=stops[key]??0
 if(count>=STOPS_PER_COMMAND){
  const reason='The stall watch stopped this step '+count+' times for the same command and stops it no more. Look at the command and its machine load, then stop or steer the run by hand.'
  logFrozenRun(runtime,notice,Date.now(),'held: stop limit reached')
  await held?.(notice,reason)
  return
 }
 const countStop=()=>{try{saveStops(runtime,{...stops,[key]:count+1})}catch(error){console.error('[quests] frozen run stop count not saved',error instanceof Error?error.message:error)}}
 const actionOf=(outcome:unknown)=>outcome&&typeof outcome==='object'&&'restart'in outcome?String((outcome as {restart:unknown}).restart):'stop requested'
 if(notice.timedOut){
  const outcome=await stop(notice,0)
  countStop()
  logFrozenRun(runtime,notice,Date.now(),'command timed out; '+actionOf(outcome))
  return outcome
 }
 const previousAction=lastFrozenRunAction(runtime,notice.run.questID,notice.run.runID,notice.sessionID)
 const firstResume=previousAction===undefined
 if(firstResume){
  logFrozenRun(runtime,notice,Date.now(),'same-session continuation acknowledgment pending')
  if(lastFrozenRunAction(runtime,notice.run.questID,notice.run.runID,notice.sessionID)!=='same-session continuation acknowledgment pending')return
 }
 const outcome=await stop(notice,firstResume?1:2)
 countStop()
 logFrozenRun(runtime,notice,Date.now(),actionOf(outcome))
 return outcome
}
