import {readFileSync,realpathSync,statSync} from 'node:fs'
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path'
import {homedir} from 'node:os'
import {questMemberships} from '../permissions/shared-guard'
import {QuestWorkspaces} from '../workspaces'
import {assertWorkerIdentity} from './worker-identity'
import {workerSessionID} from '../permissions/worker-permissions'
import type {QuestStore} from '../store'
import {setSessionInstructions} from '../../models/instruction-files'
import {READ_TOOLS,SHELL_TOOLS,readAllowedAtAsk,type ReadCall} from '../permissions/read-rule'
import {generationFiles} from '../../scripts/running-generation.mjs'
import {presentOrServingRelease} from '../host/serving-release'
const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b
type SharedInstruction={installed:string;source:string}
const questgiverRoot=()=>generationFiles()??process.env.OPENCODE_CONFIG_DIR??resolve(import.meta.dir,'..','..')
const sharedInstructions=():SharedInstruction[]=>{
 const root=questgiverRoot()
 return [
  {installed:join(homedir(),'.agents','user-verification.md'),source:join(root,'docs','user-verification.md')},
  {installed:join(homedir(),'.agents','matt-pocock.md'),source:join(root,'setup','files','.agents','matt-pocock.md')},
 ]
}
function repository(start:string):{common:string;root:string}|undefined {
 for(let dir=resolve(start);;){
  const dotgit=join(dir,'.git')
  try{
   if(statSync(dotgit).isDirectory())return {common:realpathSync.native(dotgit),root:dir}
   const gitdir=/^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit,'utf8'))?.[1]?.trim()
   if(gitdir){const own=resolve(dir,gitdir);let common=own;try{common=resolve(own,readFileSync(join(own,'commondir'),'utf8').trim())}catch{};return {common:realpathSync.native(common),root:dir}}
  }catch{}
  const parent=dirname(dir);if(parent===dir)return;dir=parent
 }
}

export function projectInstructionFiles(workspace:string):string[] {
 const start=resolve(workspace),top=repository(start)?.root??start,files:string[]=[]
 for(let dir=start;;){
  const file=join(dir,'AGENTS.md')
  try{if(statSync(file).isFile())files.unshift(file)}catch{}
  const parent=dirname(dir);if(same(dir,top)||parent===dir)break;dir=parent
 }
 return files
}

export const workerRoleFile=()=>join(import.meta.dir,'worker-role.md')
export const workerRulesFile=()=>join(import.meta.dir,'worker-agents.md')

export function workerProjectFiles(workspace:string,giverRoot=questgiverRoot()):string[] {
 const giver=repository(giverRoot)?.common,own=repository(workspace)?.common
 return giver&&own&&same(giver,own)?[workerRulesFile()]:projectInstructionFiles(workspace)
}

export function workerInstructionFiles(store:QuestStore,sessionID:string):string[]|undefined {
 const member=questMemberships(store,sessionID).find(({run,archived})=>!archived&&workerSessionID(run)===sessionID)
 const workspace=member?.run.scope?.worktree
 return typeof workspace==='string'?[workerRoleFile(),...workerProjectFiles(workspace)]:undefined
}

export function instructionReadPath(path:unknown,directory:string,roots:string[],giverDirectory?:string,shared:SharedInstruction[]=sharedInstructions()):string|undefined {
 if(typeof path!=='string')return
 const target=resolve(directory,path==='~'?homedir():path.startsWith('~/')||path.startsWith('~\\')?join(homedir(),path.slice(2)):path)
 for(const entry of shared)if(same(target,resolve(entry.installed)))try{
  if(statSync(target).isFile()&&readFileSync(target).equals(readFileSync(entry.source)))return target
 }catch{}
 if(!['AGENTS.md','MEMORY.md'].includes(basename(target)))return
 try{
  if(!statSync(target).isFile())return
  const physical=realpathSync.native(target)
  for(const root of [...roots,...(basename(target)==='AGENTS.md'&&giverDirectory?[giverDirectory]:[])]){
   if(!isAbsolute(root))continue
   const actual=realpathSync.native(root)
   if(same(dirname(target),resolve(root))&&same(physical,join(actual,basename(target))))return target
  }
 }catch{}
}
export async function installWorkerInstructionReads(ctx:any,store:QuestStore) {
 setSessionInstructions(sessionID=>workerInstructionFiles(store,sessionID))
 if(!ctx.permission?.hook||!ctx.tool?.transform)return
 const calls=new Map<string,{path:string;questID:string;runID:string;sessionID:string}>()
 const key=(sessionID:string,source:any)=>JSON.stringify([sessionID,source?.messageID,source?.id])
 const reads=new Map<string,ReadCall>()
 await ctx.permission.hook('evaluate',(event:any)=>{
  if(event.effect!=='ask'||event.source?.type!=='tool')return
  const id=key(event.sessionID,event.source),call=calls.get(id)
  if(call&&event.action==='external_directory'){
   const quest=store.read(call.questID),run=quest?.sessions.find(run=>run.runID===call.runID)
   const resource=join(dirname(call.path),'*').replaceAll('\\','/')
   if(run&&quest?.state!=='Archived'&&workerSessionID(run)===call.sessionID&&['executing','waiting','blocked'].includes(run.state)&&event.resources?.length===1&&same(event.resources[0],resource)){event.effect='allow';event.message='Read-only access to this assigned project instruction file.';return}
  }
  const allowed=readAllowedAtAsk(store,event,reads.get(id))
  if(allowed){event.effect='allow';event.message=allowed}
 })
 const instructionRead=async(original:any,input:any,context:any)=>{
  const member=questMemberships(store,context.sessionID).find(({run,archived})=>!archived&&workerSessionID(run)===context.sessionID)
  if(!member?.run.runID||!['executing','waiting','blocked'].includes(member.run.state))return original(input,context)
  const workspace=new QuestWorkspaces(store.runtime).get(member.run.runID)
  if(!workspace||workspace.removed||workspace.sharedReleased)return original(input,context)
  const path=instructionReadPath(input?.path,workspace.path,[workspace.source??workspace.root,workspace.root,workspace.path,member.quest.project?.root].filter((root):root is string=>typeof root==='string'),presentOrServingRelease(member.run.scope?.giverInstructionDirectory))
  if(!path)return original(input,context)
  await new QuestWorkspaces(store.runtime).verify(workspace)
  const actual=await ctx.session.get({sessionID:context.sessionID});assertWorkerIdentity(member.run,actual?.data??actual)
  const id=key(context.sessionID,context)
  calls.set(id,{path,questID:member.quest.id,runID:member.run.runID,sessionID:context.sessionID})
  try{return await original(input,context)}finally{calls.delete(id)}
 }
 await ctx.tool.transform((draft:any)=>{
  const listed=typeof draft.list==='function'?new Set<string>(draft.list().map((tool:any)=>tool.id)):undefined
  for(const name of [...READ_TOOLS,...SHELL_TOOLS.filter(name=>listed?.has(name))])draft.update(name,(tool:any)=>{
   const original=tool.execute
   tool.execute=async(input:any,context:any)=>{
    const id=key(context?.sessionID,context)
    reads.set(id,{tool:name,input})
    try{return name==='read'?await instructionRead(original,input,context):await original(input,context)}
    finally{reads.delete(id)}
   }
  })
 })
}
