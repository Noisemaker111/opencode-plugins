import {createHash} from 'node:crypto'
import {statSync} from 'node:fs'
import {liveHostRecords,type HostRecord} from '../host/host-role'
import {boundedInspection} from '../worker-observation.mjs'
import {logFrozenRun} from './stall-watch-mode'
import {timed} from '../../scripts/plugin-spans'
import type {StallNotice} from './stall-signal'

export type ShellRun={id:string;sessionID:string;command:string;started:number;file?:string;status?:string;exit?:number}
type Endpoint={url:string;authorization:string}
export type ActiveSessions=(endpoint:Endpoint,signal:AbortSignal)=>Promise<unknown>

export class ShellRuns{
 private readonly bySession=new Map<string,Map<string,ShellRun>>()
 private readonly owner=new Map<string,string>()
 observe(event:any){
  const type=String(event?.type??''),data=event?.data??event?.properties
  if(type==='shell.created'){
   const info=data?.info,sessionID=info?.metadata?.sessionID
   if(typeof info?.id!=='string'||typeof sessionID!=='string')return
   const runs=this.bySession.get(sessionID)??this.bySession.set(sessionID,new Map()).get(sessionID)!
   runs.set(info.id,{id:info.id,sessionID,command:String(info.command??''),started:Number(info.time?.started)||Date.now(),...(typeof info.file==='string'?{file:info.file}:{})})
   this.owner.set(info.id,sessionID)
  }else if(type==='shell.exited'){
   const run=this.bySession.get(this.owner.get(data?.id)??'')?.get(data?.id)
   if(run){run.status=String(data.status??'exited');if(typeof data.exit==='number')run.exit=data.exit}
  }else if(/^session\.tool\.(success|failed)$/.test(type)&&typeof data?.sessionID==='string'){
   for(const run of [...this.bySession.get(data.sessionID)?.values()??[]])if(run.status!==undefined)this.drop(run)
  }
 }
 find(sessionID:string,command:string,callStart:number):ShellRun|undefined{
  const after=[...this.bySession.get(sessionID)?.values()??[]].filter(run=>run.started>=callStart).sort((a,b)=>a.started-b.started)
  return after.find(run=>run.command===command)??after[0]
 }
 forget(sessionID:string){for(const run of [...this.bySession.get(sessionID)?.values()??[]])this.drop(run);this.bySession.delete(sessionID)}
 private drop(run:ShellRun){this.bySession.get(run.sessionID)?.delete(run.id);this.owner.delete(run.id)}
}

const askActive:ActiveSessions=async(endpoint,signal)=>{
 const response=await fetch(endpoint.url+'/api/session/active',{headers:{authorization:endpoint.authorization},signal})
 if(!response.ok){await response.body?.cancel();throw new Error('the host answered '+response.status)}
 const body:any=await response.json()
 return body?.data??body
}

export async function sessionExecutingOnAnyHost(sessionID:string,hosts:HostRecord[]=liveHostRecords(),ask:ActiveSessions=askActive):Promise<boolean|undefined>{
 if(!hosts.length)return undefined
 const answers=await Promise.all(hosts.map(async host=>{
  if(!host.local)return undefined
  try{const active=await boundedInspection((signal:AbortSignal)=>ask(host.local!,signal));return active&&typeof active==='object'&&!Array.isArray(active)?Object.hasOwn(active,sessionID):undefined}catch{return undefined}
 }))
 return answers.includes(true)?true:answers.includes(undefined)?undefined:false
}

const savedOutput=(shell:ShellRun|undefined)=>{
 if(!shell?.file)return 'Its exit code and output were not recorded.'
 let size=''
 try{size=' ('+statSync(shell.file).size+' bytes)'}catch{}
 return (shell.exit!==undefined?'It exited with code '+shell.exit+'; its':'Its')+' output is saved in '+shell.file+size+'.'
}

export function lostCallText(notice:StallNotice,shell?:ShellRun){
 return ['LOST TOOL CALL: the host never recorded the end of your tool call `'+(notice.command??'')+'`'+(notice.callStart!==undefined?', started '+new Date(notice.callStart).toISOString():'')+'. No process of it is left and no host was running this session, so the call now shows as interrupted.',savedOutput(shell),'Check what the command already changed before you run it again, then carry on with your assignment.'].join('\n')
}

export async function resumeLostCall(runtime:string,host:{prompt:(input:any)=>Promise<unknown>},notice:StallNotice,shell?:ShellRun,writer?:Parameters<typeof timed>[2]){
 const id='msg_questlostcall'+createHash('sha256').update(notice.sessionID+':'+(notice.callStart??'')).digest('hex').slice(0,22)
 try{
  await timed({plugin:'quests',name:'stall.resume-lost-call',op:notice.run.runID,sessionID:notice.sessionID},()=>host.prompt({sessionID:notice.sessionID,id,delivery:'queue',resume:true,text:lostCallText(notice,shell),metadata:{questLostToolCall:true,questID:notice.run.questID,runID:notice.run.runID}}),writer)
  return logFrozenRun(runtime,notice,Date.now(),'resumed: the host lost the end of the call')
 }catch(error){
  return logFrozenRun(runtime,notice,Date.now(),'not resumed: '+(error instanceof Error?error.message:String(error)))
 }
}
