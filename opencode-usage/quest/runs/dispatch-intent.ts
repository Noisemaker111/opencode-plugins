import { isSafeReference } from "../core/readable-reference"
import {mkdirSync,readFileSync} from 'node:fs'
import {writeFileDurable,runFileCandidates} from '../core/durable-file.mjs'
import {join} from 'node:path'
import {hostname} from 'node:os'
import {processAlive} from '../host/host-role'
import {TERMINAL_RUN} from './session-lineage'
import type {QuestStore} from '../store'

export type Phase='preflight'|'creating'|'created'|'prompting'|'command'|'released'
type Intent={version:1;runID:string;host:string;pid:number;hostStartedAt?:string;phase:Phase;sessionID?:string;at:string}
const HOST_STARTED_AT=new Date(Date.now()-process.uptime()*1000).toISOString()
export type DispatchHold={advance(phase:Exclude<Phase,'released'>,sessionID?:string):void;release():void}
const path=(runtime:string,runID:string)=>{
 if(!isSafeReference(runID))throw Error('Invalid dispatch identity')
 return runFileCandidates(join(runtime,'dispatch-intents'),runID)[0]
}
const readIntent=(runtime:string,runID:string)=>{
 if(!isSafeReference(runID))throw Error('Invalid dispatch identity')
 for(const file of runFileCandidates(join(runtime,'dispatch-intents'),runID))try{return JSON.parse(readFileSync(file,'utf8'))}catch{}
 throw Error('No dispatch intent')
}
const HOLDS=Symbol.for('questgiver.run-holds')
type Held={questID:string;hold:DispatchHold;phase:Phase;stage?:string;startedAt:string;stageAt:string;launchedAt?:string;admittedAt?:string}
export type DispatchingRun=Omit<Held,'questID'|'hold'>&{runID:string}
const holds=():Map<string,Held>=>((globalThis as any)[HOLDS]??=new Map())

export function noteDispatchStage(runID:string,stage?:string){
 const entry=holds().get(runID)
 if(entry){entry.stage=stage;entry.stageAt=new Date().toISOString()}
}

export function noteDispatchAdmitted(runID:string){
 const entry=holds().get(runID)
 if(entry)entry.admittedAt=new Date().toISOString()
}

export function dispatchingRuns(questID:string):DispatchingRun[]{
 return [...holds()].filter(([,entry])=>entry.questID===questID).map(([runID,{questID:_,hold:__,...entry}])=>({runID,...entry}))
}

export function beginDispatchIntent(runtime:string,runID:string,release:()=>void=()=>{}):DispatchHold{
 const file=path(runtime,runID)
 let record:Intent={version:1,runID,host:hostname(),pid:process.pid,hostStartedAt:HOST_STARTED_AT,phase:'preflight',at:new Date().toISOString()}
 mkdirSync(join(runtime,'dispatch-intents'),{recursive:true})
 const save=()=>writeFileDurable(file,JSON.stringify(record))
 save()
 let released=false
 return {
  advance(phase,sessionID){record={...record,phase,...(sessionID?{sessionID}:{}),at:new Date().toISOString()};save()},
  release(){if(released)return;released=true;record={...record,phase:'released',at:new Date().toISOString()};try{save()}catch(error){console.error('[quest-dispatch] release not recorded '+runID,error)}release()},
 }
}

export async function holdDispatch(runtime:string,questID:string,runID:string):Promise<DispatchHold>{
 const hold=beginDispatchIntent(runtime,runID,()=>{holds().delete(runID)})
 const now=new Date().toISOString()
 const entry:Held={questID,hold,phase:'preflight',startedAt:now,stageAt:now}
 const advance=hold.advance
 hold.advance=(phase,id)=>{advance(phase,id);entry.phase=phase;entry.stageAt=new Date().toISOString();if(phase==='creating'&&!entry.launchedAt)entry.launchedAt=entry.stageAt}
 holds().set(runID,entry)
 return hold
}

export function releaseSettledRuns(store:QuestStore,settling:(runID:string)=>unknown){
 for(const [runID,{questID,hold}] of [...holds()]){
  let run
  try{run=store.read(questID)?.sessions.find(s=>(s.runID??s.callID)===runID)}catch{continue}
  if(run&&TERMINAL_RUN.has(run.state)&&!settling(runID))hold.release()
 }
}

export function dispatchOwner(runtime:string,runID:string):{host:string;pid:number;hostStartedAt?:string;phase:Phase;alive:boolean;holding:boolean}|undefined{
 let record:Intent
 try{record=readIntent(runtime,runID)}catch{return}
 if(record.version!==1||record.runID!==runID||record.host!==hostname()||!Number.isSafeInteger(record.pid)||record.pid<1)return
 const live=processAlive(record.pid,Date.parse(record.hostStartedAt??''))
 return {host:record.host,pid:record.pid,hostStartedAt:record.hostStartedAt,phase:record.phase,alive:live,holding:live&&record.phase!=='released'}
}

export function interruptedPreflight(runtime:string,runID:string):string|undefined{
 let record:Intent
 try{record=readIntent(runtime,runID)}catch{return}
 if(record.version!==1||record.runID!==runID||record.host!==hostname()||record.phase!=='preflight'||!Number.isSafeInteger(record.pid)||record.pid<1)return
 if(processAlive(record.pid,Date.parse(record.hostStartedAt??'')))return
 return `Dispatch owner ${record.pid} on ${record.host} exited during preflight, before any worker creation or command launch. Intent recorded at ${record.at}. Retained workspace and run evidence; retry this Quest after its preparation requirements are satisfied.`
}

export function interruptedBoundDispatch(runtime:string,runID:string,sessionID:string):string|undefined{
 let record:Intent
 try{record=readIntent(runtime,runID)}catch{return}
 if(record.version!==1||record.runID!==runID||record.host!==hostname()||record.sessionID!==sessionID||!['created','prompting'].includes(record.phase)||!Number.isSafeInteger(record.pid)||record.pid<1)return
 if(processAlive(record.pid,Date.parse(record.hostStartedAt??'')))return
 return `Dispatch owner ${record.pid} on ${record.host} exited during ${record.phase}. Intent recorded at ${record.at}.`
}
