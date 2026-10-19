import {mkdirSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {readJsonSettings,writeFileDurable} from '../core/durable-file.mjs'
import {acquireLock} from '../locking.mts'
import {questSettingsFile} from '../config/quest-settings.mjs'
import {shellWords,splitShellSegments} from '../landing/delivery-permission'
import {redact} from '../privacy'
import {TELEMETRY_BUDGET} from '../../scripts/telemetry-budget.mjs'

export type ApprovedShape={shape:string;actor:'jev'|'fast';model?:string;reason:string;at:string}
export type ApprovedCommands={version:1;shapes:ApprovedShape[]}
export const approvedCommandsFile=()=>join(dirname(questSettingsFile()),'approved-commands.json')

const SUBCOMMAND_TOOLS=new Set(['git','gh','bun','npm','npx','bunx','pnpm','yarn','node','python','python3','cargo','go','dotnet','docker','kubectl'])
const NEVER_LEARNED=/\b(rm|rmdir|del|erase|remove-item|ri|rd|format|diskpart|shutdown|taskkill|stop-process|kill|chmod|chown|dd|mkfs|curl|wget|scp|sftp|ftp|sudo|eval|exec|xargs|tee)\b|\bgit\s+push\b|\bgh\s+(pr\s+(merge|close|create)|release)\b|\b(npm|bun|yarn|pnpm)\s+(run\s+)?(publish|deploy|release)\b|\bdeploy\b|\bpublish\b/i
const NAMED=/^[a-z][a-z0-9._+:-]*$/i
const REDIRECTS=/\d?>&\d|\d?>\s*\/dev\/null/g

function segmentShape(segment:string):string|undefined{
 const words=shellWords(segment.trim())
 if(!words?.length)return
 let index=0
 while(index<words.length&&/^[A-Z_][A-Z0-9_]*=/.test(words[index]))index++
 const head=words[index]?.replace(/\.exe$/i,'').toLowerCase()
 if(!head||!NAMED.test(head))return
 if(head==='cd')return 'cd'
 if(!SUBCOMMAND_TOOLS.has(head))return head
 const sub=words.slice(index+1).find(word=>!word.startsWith('-'))
 if(head==='bun'||head==='npm'||head==='pnpm'||head==='yarn'){
  if(sub==='run'){const script=words.slice(index+1).filter(word=>!word.startsWith('-'))[1];return script&&NAMED.test(script)?head+' run '+script:undefined}
 }
 if(head==='node'||head==='python'||head==='python3')return
 return sub&&NAMED.test(sub)?head+' '+sub.toLowerCase():head
}

export function commandShapes(command:string):string[]|undefined{
 const plain=command.replace(REDIRECTS,' ')
 if(/\$\(|`|<<|\$\{|[<>]/.test(plain))return
 const segments=splitShellSegments(plain)?.map(segment=>segment.trim()).filter(Boolean)
 if(!segments?.length)return
 const shapes:string[]=[]
 for(const segment of segments){
  const shape=segmentShape(segment)
  if(!shape)return
  if(!shapes.includes(shape))shapes.push(shape)
 }
 return shapes
}
export const learnableShape=(shape:string)=>!NEVER_LEARNED.test(shape)

const valid=(value:unknown):value is ApprovedCommands=>{
 const row=value as ApprovedCommands
 return !!row&&typeof row==='object'&&row.version===1&&Array.isArray(row.shapes)&&row.shapes.every(shape=>shape&&typeof shape.shape==='string'&&['jev','fast'].includes(shape.actor)&&typeof shape.reason==='string'&&typeof shape.at==='string')
}
export function approvedCommands(file=approvedCommandsFile()):ApprovedCommands{
 const value=readJsonSettings(file)
 if(value===undefined)return {version:1,shapes:[]}
 if(!valid(value))throw Error('Invalid approved command list in '+file+'; repair or remove it')
 return value
}
export function enforceApprovedBudget(list:ApprovedCommands):ApprovedCommands{
 const shapes=[...list.shapes]
 const size=()=>Buffer.byteLength(JSON.stringify({...list,shapes}))
 while(shapes.length&&size()>TELEMETRY_BUDGET.approvedCommandsBytes){const oldest=shapes.reduce((first,row)=>row.at<first.at?row:first);shapes.splice(shapes.indexOf(oldest),1)}
 return {...list,shapes}
}
function write(file:string,change:(list:ApprovedCommands)=>ApprovedCommands){
 mkdirSync(dirname(file),{recursive:true})
 const lock=acquireLock(dirname(file),'approved-commands')
 try{
  const next=change(approvedCommands(file))
  writeFileDurable(file,JSON.stringify(enforceApprovedBudget(next))+'\n')
  return next
 }finally{lock.release()}
}
export function learnApprovedShapes(decision:{command:string;actor:'jev';model?:string;reason:string},file=approvedCommandsFile(),now=new Date()):ApprovedShape[]{
 const shapes=commandShapes(decision.command)?.filter(learnableShape)
 if(!shapes?.length)return []
 const added:ApprovedShape[]=[]
 write(file,list=>{
  const known=new Set(list.shapes.map(row=>row.shape))
  for(const shape of shapes)if(!known.has(shape)){const row={shape,actor:decision.actor,...(decision.model?{model:decision.model}:{}),reason:redact(decision.reason,300),at:now.toISOString()};added.push(row);list.shapes.push(row)}
  return list
 })
 return added
}
export function removeApprovedShape(shape:string,file=approvedCommandsFile()):ApprovedCommands{
 return write(file,list=>({...list,shapes:list.shapes.filter(row=>row.shape!==shape)}))
}
export function approvedShapeRule(command:string,file=approvedCommandsFile()):{name:string;reason:string}|undefined{
 const shapes=commandShapes(command)
 if(!shapes?.length||!shapes.every(learnableShape))return
 let list:ApprovedCommands
 try{list=approvedCommands(file)}catch{return}
 const approved=new Set(list.shapes.map(row=>row.shape))
 return shapes.every(shape=>approved.has(shape))?{name:'approved list',reason:'every command in it ('+shapes.join(', ')+') is on the approved list in Agent settings'}:undefined
}
