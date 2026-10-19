import {readdirSync} from 'node:fs'
import {join} from 'node:path'
import {isSafeReference} from '../core/readable-reference'
import {writeFileDurable,readJsonRecord,runFileStem,runFileCandidates} from '../core/durable-file.mjs'
import {stopCheckoutProcesses,describeProcess} from './checkout-processes.mjs'
import {pathKey,within} from './cleanup-git.mjs'
import {TERMINAL_RUN} from '../runs/session-lineage'
import {QuestWorkspaces,type Workspace} from '../workspaces'
import type {QuestStore} from '../store'
import type {Quest,QuestSession} from '../types'

export type StoppedProcess={pid:number;ppid:number;name:string;command:string;createdAt?:number;checkout:string}
export type ProcessSweep={version:1;runID:string;questID:string;checkout:string;at:string;because:'run ended'|'checkout retired';stopped:StoppedProcess[];failed:Array<StoppedProcess&{error:string}>;keptForLiveSessions:Array<{session:string;pids:number[]}>}

const sweepFile=(runtime:string,runID:string)=>join(runtime,'process-sweeps',runFileStem(runID)+'.json')
const listed=(directory:string)=>{try{return readdirSync(directory).filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5)).filter(isSafeReference)}catch{return []}}
const overlaps=(a:string,b:string)=>pathKey(a)===pathKey(b)||within(a,b)||within(b,a)
const editing=(w:Workspace)=>w.mode!=='shared'&&w.mode!=='research'

export function readProcessSweeps(runtime:string,runID:string):ProcessSweep[]{
 for(const file of runFileCandidates(join(runtime,'process-sweeps'),runID))try{const rows=readJsonRecord(file);if(rows)return rows}catch{}
 return []
}

function record(store:QuestStore,run:QuestSession|undefined,sweep:ProcessSweep){
 writeFileDurable(sweepFile(store.runtime,sweep.runID),JSON.stringify([...readProcessSweeps(store.runtime,sweep.runID),sweep],null,2))
 if(!run||!sweep.stopped.length&&!sweep.failed.length)return
 const evidence='Stopped '+sweep.stopped.length+' process(es) left running in its checkout '+sweep.checkout+' after the '+sweep.because+(sweep.stopped.length?': '+sweep.stopped.map(describeProcess).join(', '):'')+(sweep.failed.length?'; could not stop '+sweep.failed.map(entry=>describeProcess(entry)+' ('+entry.error+')').join(', '):'')
 try{store.apply(sweep.questID,'session-state',{callID:run.callID,state:run.state,preserveTerminal:true,evidence},'quest:checkout-processes')}
 catch(error){console.error('[quests] stopped processes not recorded on '+sweep.runID,error)}
}

async function sweep(store:QuestStore,targets:Array<{workspace:Workspace;run?:QuestSession}>,because:ProcessSweep['because']){
 if(!targets.length)return []
 const outcome=await stopCheckoutProcesses({checkouts:[...new Set(targets.map(target=>target.workspace.path))]})
 if('unavailable' in outcome&&outcome.unavailable){console.error('[quests] processes in ended checkouts were not checked: '+outcome.unavailable);return []}
 const at=new Date().toISOString(),sweeps:ProcessSweep[]=[]
 for(const {workspace,run} of targets){
  const mine=<T extends {checkout:string}>(rows:T[])=>rows.filter(row=>pathKey(row.checkout)===pathKey(workspace.path))
  const result:ProcessSweep={version:1,runID:workspace.runID,questID:workspace.questID,checkout:workspace.path,at,because,stopped:mine(outcome.stopped),failed:mine(outcome.failed),
   keptForLiveSessions:mine(outcome.kept).map((tree:any)=>({session:tree.session,pids:tree.processes.map((entry:any)=>entry.pid)}))}
  record(store,run,result);sweeps.push(result)
 }
 return sweeps
}

const neverSwept=new Map<string,Set<string>>()

export async function stopEndedRunProcesses(store:QuestStore):Promise<ProcessSweep[]>{
 const swept=new Set(listed(join(store.runtime,'process-sweeps'))),skipped=neverSwept.get(store.runtime)??neverSwept.set(store.runtime,new Set()).get(store.runtime)!
 const pending=new QuestWorkspaces(store.runtime).runIDs().filter(runID=>!swept.has(runID)&&!swept.has(runFileStem(runID))&&!skipped.has(runID))
 if(!pending.length)return []
 const manager=new QuestWorkspaces(store.runtime),quests=new Map<string,Quest|undefined>()
 const quest=(id:string)=>{if(!quests.has(id))try{quests.set(id,store.read(id)??undefined)}catch{quests.set(id,undefined)};return quests.get(id)}
 const runOf=(w:Workspace)=>quest(w.questID)?.sessions.find(s=>(s.runID??s.callID)===w.runID)
 const read=(runID:string)=>{try{return manager.get(runID)}catch{return undefined}}
 const ended=pending.flatMap(runID=>{
  const w=read(runID)
  if(w&&(!editing(w)||!quest(w.questID))){skipped.add(runID);return []}
  const run=w?runOf(w):undefined
  return w&&run&&TERMINAL_RUN.has(run.state)?[{workspace:w,run}]:[]
 })
 if(!ended.length)return []
 const active=pending.map(read).filter((w):w is Workspace=>!!w&&!w.removed&&editing(w)).filter(w=>{const run=runOf(w);return !!run&&!TERMINAL_RUN.has(run.state)})
 return sweep(store,ended.filter(({workspace})=>!active.some(other=>other.runID!==workspace.runID&&overlaps(other.path,workspace.path))),'run ended')
}

export async function stopRetiredCheckoutProcesses(store:QuestStore,workspace:Workspace):Promise<ProcessSweep|undefined>{
 if(!editing(workspace))return
 let run:QuestSession|undefined
 try{run=store.read(workspace.questID)?.sessions.find(s=>(s.runID??s.callID)===workspace.runID)}catch{}
 return (await sweep(store,[{workspace,run}],'checkout retired'))[0]
}
