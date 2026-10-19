import {createHash} from 'node:crypto'
import {existsSync} from 'node:fs'
import {Database} from 'bun:sqlite'
import {timerWait,type Wait} from '../core/timer'
import {commandKind} from './command-guard'

export type ToolStep={tool:string;key:string;failed:boolean;edit?:{file:string;before?:string;after?:string};command?:string}
export type NoProgressCode='repeat-failure'|'edit-loop'|'gate-rerun'
export type NoProgress={code:NoProgressCode;detail:string}

export const REPEAT_FAILURES=4
export const EDIT_REVERSALS=2
export const GATE_RERUNS=3
export const STEP_WINDOW=40

const EDIT_TOOLS=new Set(['edit','write','patch','apply_patch'])
const hash=(value:unknown)=>typeof value==='string'?createHash('sha1').update(value).digest('hex').slice(0,12):undefined
const collapse=(text:string)=>text.replace(/\s+/g,' ').trim().slice(0,240)
const short=(text:string)=>collapse(text).slice(0,100)

function canonical(value:unknown):string{
 if(typeof value==='string')return collapse(value)
 if(value&&typeof value==='object')return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a<b?-1:1).map(([key,item])=>[key,typeof item==='string'?hash(item)??'':item])))
 return String(value)
}

export function toolStep(part:any):ToolStep|undefined{
 if(part?.type!=='tool'||typeof part.name!=='string')return undefined
 const status=String(part.state?.status??''),input=part.state?.input??{},exit=part.state?.metadata?.exit
 if(status==='running'||status==='pending')return undefined
 const failed=status==='error'||typeof exit==='number'&&exit!==0
 if(part.name==='shell'||part.name==='bash'){
  const command=typeof input.command==='string'?collapse(input.command):canonical(input)
  return {tool:part.name,key:'shell:'+command,failed,command}
 }
 const file=typeof input.filePath==='string'?input.filePath:typeof input.path==='string'?input.path:undefined
 const step:ToolStep={tool:part.name,key:part.name+':'+canonical(input),failed}
 if(EDIT_TOOLS.has(part.name)&&file&&!failed)step.edit={file,before:hash(input.oldString),after:hash(input.newString??input.content)}
 return step
}

export function sessionSteps(hostDB:string,sessionID:string,limit=STEP_WINDOW):ToolStep[]{
 if(!existsSync(hostDB))return []
 const db=new Database(hostDB,{readonly:true})
 try{
  const rows=db.query("select data from session_message where session_id = ? and type = 'assistant' order by seq desc limit ?").all(sessionID,limit) as {data:string}[]
  const steps:ToolStep[]=[]
  for(const row of rows.reverse()){
   let message:any
   try{message=JSON.parse(row.data)}catch{continue}
   for(const part of message?.content??[]){const step=toolStep(part);if(step)steps.push(step)}
  }
  return steps.slice(-limit)
 }finally{db.close()}
}

function repeatedFailure(steps:ToolStep[]):NoProgress|undefined{
 const last=[...steps].reverse().find(step=>step.failed)
 if(!last)return undefined
 let count=0
 for(let i=steps.length-1;i>=0;i--){
  const step=steps[i]!
  if(step.edit)return undefined
  if(step.key!==last.key)continue
  if(!step.failed)return undefined
  count++
 }
 return count>=REPEAT_FAILURES?{code:'repeat-failure',detail:'the same '+last.tool+' call failed '+count+' times with no edit between: '+short(last.command??last.key)}:undefined
}

function editLoop(steps:ToolStep[]):NoProgress|undefined{
 const byFile=new Map<string,{before?:string;after?:string}[]>()
 for(const step of steps)if(step.edit)(byFile.get(step.edit.file)??byFile.set(step.edit.file,[]).get(step.edit.file)!).push(step.edit)
 for(const [file,edits] of byFile){
  let reversals=0
  for(let j=1;j<edits.length;j++)for(let i=0;i<j;i++){
   const a=edits[i]!,b=edits[j]!
   if(a.before&&a.after&&a.before!==a.after&&b.before===a.after&&b.after===a.before){reversals++;break}
  }
  if(reversals>=EDIT_REVERSALS)return {code:'edit-loop',detail:'the same file was edited back and forth '+reversals+' times: '+short(file)}
 }
 return undefined
}

function gateRerun(steps:ToolStep[]):NoProgress|undefined{
 const last=[...steps].reverse().find(step=>step.command&&commandKind(step.command)==='gate'&&!/\bland\b/.test(step.command))
 if(!last)return undefined
 let count=0
 for(let i=steps.length-1;i>=0;i--){
  const step=steps[i]!
  if(step.edit)break
  if(step.key===last.key)count++
 }
 return count>=GATE_RERUNS?{code:'gate-rerun',detail:'the same check ran '+count+' times with no edit between: '+short(last.command!)}:undefined
}

export function detectNoProgress(steps:ToolStep[]):NoProgress|undefined{
 return repeatedFailure(steps)??editLoop(steps)??gateRerun(steps)
}

export const noProgressReason=(verdict:NoProgress)=>'no progress: '+verdict.detail+'. The run was stopped so it does not spend more tokens repeating itself.'

export type NoProgressRun={questID:string;runID:string}
export type NoProgressOptions={
 hostDB:()=>string
 runOf:(sessionID:string)=>NoProgressRun|undefined
 stop:(run:NoProgressRun,reason:string)=>void|Promise<void>
 steps?:(hostDB:string,sessionID:string)=>ToolStep[]
 wait?:Wait
 settleMs?:number
}

const TOOL_RESULT=/^session\.tool\.(success|failed)$/

export class NoProgressWatch{
 private readonly pending=new Map<string,()=>void>()
 private readonly stopped=new Set<string>()
 constructor(private readonly options:NoProgressOptions){}

 observe(event:{type?:unknown;data?:any;properties?:any}){
  const sessionID=(event?.data??event?.properties)?.sessionID
  if(!TOOL_RESULT.test(String(event?.type??''))||typeof sessionID!=='string'||this.pending.has(sessionID))return
  const cancel=(this.options.wait??timerWait)(this.options.settleMs??2_000,()=>{this.pending.delete(sessionID);void this.check(sessionID)})
  this.pending.set(sessionID,cancel)
 }

 async check(sessionID:string):Promise<NoProgress|undefined>{
  const run=this.options.runOf(sessionID)
  if(!run||this.stopped.has(run.runID))return undefined
  let steps:ToolStep[]
  try{steps=(this.options.steps??sessionSteps)(this.options.hostDB(),sessionID)}catch{return undefined}
  const verdict=detectNoProgress(steps)
  if(!verdict)return undefined
  this.stopped.add(run.runID)
  try{await this.options.stop(run,noProgressReason(verdict))}catch(error){console.error('[quests] run repeating itself not stopped',error instanceof Error?error.message:error)}
  return verdict
 }

 forget(sessionID:string){this.pending.get(sessionID)?.();this.pending.delete(sessionID)}
}
