import {hostAlive,type HostRecord} from '../host/host-role'
import {WORKER_STATES,type WorkerReading,type WorkerState} from './worker-counts'
import {PROCESS_STATES,type ProcessState} from '../workers/process-ledger'

export const RUN_STATES=WORKER_STATES
export const HOST_STATES=['serving','draining','standby','down'] as const
export type RunState=WorkerState
export type HostState=typeof HOST_STATES[number]
export type StateKind='run'|'process'|'host'
export type StateReading<S extends string=string>={state:S;since:number;forMs:number;sinceAt:string}

const KEY=Symbol.for('questgiver.state-entries')
const KEPT=5000
const registry=globalThis as typeof globalThis&{[KEY]?:Map<string,{state:string;since:number}>}
const entries=registry[KEY]??=new Map()

export function enterState<S extends string>(kind:StateKind,id:string,state:S,now:number,evidenceSince?:number):StateReading<S>{
 const key=kind+'\0'+id,held=entries.get(key)
 let since=held?.state===state?held.since:Math.min(now,evidenceSince??now)
 if(held?.state===state&&evidenceSince!==undefined&&evidenceSince<since)since=evidenceSince
 if(held?.state!==state||held.since!==since){
  entries.delete(key)
  entries.set(key,{state,since})
  if(entries.size>KEPT)entries.delete(entries.keys().next().value!)
 }
 return {state,since,forMs:Math.max(0,now-since),sinceAt:new Date(since).toISOString()}
}

export const forgetStates=()=>entries.clear()

export function runState(runID:string,reading:Pick<WorkerReading,'state'|'waitingMs'>,now:number):StateReading<RunState>{
 return enterState('run',runID,reading.state,now,reading.state==='waiting'&&reading.waitingMs!==undefined?now-reading.waitingMs:undefined)
}

export function hostStateOf(host:Pick<HostRecord,'pid'|'processStart'|'record'|'state'>):HostState{
 if(!hostAlive(host))return 'down'
 if(host.state==='active')return 'serving'
 if(host.state==='draining')return 'draining'
 return 'standby'
}

export function hostStates(hosts:HostRecord[],now:number){
 return hosts.map(host=>{
  const state=hostStateOf(host)
  return {host:host.id,pid:host.pid,...(host.generation?{generation:host.generation}:{}),...enterState('host',host.pid+':'+host.id,state,now)}
 })
}

export function processState(id:string,state:ProcessState,now:number,since?:number){
 return enterState('process',id,state,now,since)
}

export const STATE_SETS={run:RUN_STATES,process:PROCESS_STATES,host:HOST_STATES} as const
