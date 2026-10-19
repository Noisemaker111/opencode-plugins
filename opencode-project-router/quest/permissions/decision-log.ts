import {appendFileSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {acquireLock} from '../locking.mts'
import {redact} from '../privacy'
import {enforceJsonlBudget,TELEMETRY_BUDGET} from '../../scripts/telemetry-budget.mjs'

export type JevDecision={at:string;quest:string;run:string;by:'jev'|'rule'|'user';decision:'allow'|'deny'|'user';ask:string;reason:string;model?:string;ms?:number;calls?:number}

const LEGACY_RECEIPTS=['permission-decisions/attempts','permission-allowers/attempts']
const LEGACY_FOLDERS=['permission-decisions','permission-allowers','permission-reviewers']
const STATES:Record<string,JevDecision['decision']>={allowed:'allow',rejected:'deny',user:'user'}

export const decisionsFile=(runtime:string)=>join(runtime,'permission-decisions.jsonl')
export const oneLine=(text:unknown,max:number)=>redact(String(text??'').replace(/\s+/g,' ').trim(),max)

export function logDecision(runtime:string,decision:JevDecision){
 const file=decisionsFile(runtime)
 mkdirSync(dirname(file),{recursive:true})
 const lock=acquireLock(dirname(file),'permission-decisions')
 try{
  appendFileSync(file,JSON.stringify(decision)+'\n',{mode:0o600})
  enforceJsonlBudget(file,TELEMETRY_BUDGET.permissionDecisionsBytes)
 }finally{lock.release()}
}

function fromReceipt(value:any):JevDecision|undefined{
 const decision=STATES[value?.state]
 if(!decision||typeof value.at!=='string')return
 return {
  at:value.at,quest:String(value.questID??''),run:String(value.runID??''),
  by:value.actor==='rule'?'rule':decision==='user'?'user':'jev',decision,
  ask:'',reason:oneLine(value.reason,200),
  ...(typeof value.model==='string'?{model:value.model}:{}),
  ...(typeof value.milliseconds==='number'?{ms:value.milliseconds}:{}),
  ...(typeof value.usage?.calls==='number'?{calls:value.usage.calls}:{}),
 }
}

function receipts(runtime:string):JevDecision[]{
 return LEGACY_RECEIPTS.flatMap(folder=>{
  const directory=join(runtime,folder)
  try{return readdirSync(directory).filter(name=>name.endsWith('.json')).flatMap(name=>{try{const item=fromReceipt(JSON.parse(readFileSync(join(directory,name),'utf8')));return item?[item]:[]}catch{return []}})}
  catch{return []}
 })
}

function lines(file:string):JevDecision[]{
 try{return readFileSync(file,'utf8').split('\n').flatMap(line=>{try{return line?[JSON.parse(line) as JevDecision]:[]}catch{return []}})}
 catch{return []}
}

export function readDecisions(runtime:string):JevDecision[]{
 return [...lines(decisionsFile(runtime)),...receipts(runtime)]
}

export function migrateLegacyDecisions(runtime:string){
 const file=decisionsFile(runtime)
 const moved=receipts(runtime).sort((a,b)=>a.at.localeCompare(b.at))
 const kept=lines(file)
 mkdirSync(dirname(file),{recursive:true})
 const lock=acquireLock(dirname(file),'permission-decisions')
 try{
  writeFileSync(file,[...kept,...moved].map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600})
  enforceJsonlBudget(file,TELEMETRY_BUDGET.permissionDecisionsBytes)
 }finally{lock.release()}
 for(const folder of LEGACY_FOLDERS)rmSync(join(runtime,folder),{recursive:true,force:true})
 return moved.length
}
