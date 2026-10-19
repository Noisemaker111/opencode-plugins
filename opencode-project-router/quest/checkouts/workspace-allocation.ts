import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads'
import {QuestWorkspaces, type Workspace} from '../workspaces'
import {QuestStore} from '../store'
import {projectIdentityMemory,rememberProjectIdentities,type ProjectIdentityMemory} from '../core/project'
import {holdWorktreeHomesForOperation} from './worktree-plumbing'
import type {BootstrapDeclaration} from './workspace-bootstrap'
import {releaseWorkerLocks} from '../locking.mts'

type Allocation = {runtime:string; projectRoot:string} & (
 {mode:'resume';input:Omit<Parameters<QuestWorkspaces['resume']>[0],'store'>} |
 {mode:'worktree';input:Parameters<QuestWorkspaces['create']>[0]} |
 {mode:'shared';input:Omit<Parameters<QuestWorkspaces['createShared']>[0],'store'>} |
 {mode:'research';input:Parameters<QuestWorkspaces['createResearch']>[0]} |
 {mode:'replenish';input:{directory:string;bootstrap?:BootstrapDeclaration}}
)
export function allocateWorkspace(input:Allocation):Promise<Workspace> {
 return new Promise((resolve,reject)=>{
  const posted=Date.now(),lockOwnerToken=crypto.randomUUID()
  const worker=new Worker(new URL(import.meta.url),{workerData:{...input,identities:projectIdentityMemory(),lockOwnerToken}})
  let received=false
  worker.once('message',result=>{received=true;result.error?reject(new Error(result.error)):resolve({...result.workspace,preparationTimeline:[{stage:'start preparation thread',start:posted,end:result.began},...(result.workspace.preparationTimeline??[])]})})
  worker.once('error',reject)
  worker.once('exit',code=>{releaseWorkerLocks(input.runtime,lockOwnerToken);if(!received)reject(new Error('Workspace preparation ended without a saved result (exit '+code+')'))})
 })
}

const allocating=new Map<string,number>()
const refilling=new Map<string,{again:boolean}>()

export function allocateEditingWorkspace(request:{runtime:string;projectRoot:string;projectID:string;input:Parameters<QuestWorkspaces['create']>[0];spares:boolean}):Promise<Workspace> {
 const {runtime,projectRoot,projectID,input,spares}=request
 const concurrent=(allocating.get(projectID)??0)+1
 allocating.set(projectID,concurrent)
 if(spares)try{new QuestWorkspaces(runtime).noteDemand(projectID,concurrent)}catch(error){console.error('[quest-workspaces] spare demand not recorded',error)}
 const settled=()=>{
  const left=(allocating.get(projectID)??1)-1
  if(left>0)allocating.set(projectID,left);else allocating.delete(projectID)
  if(spares)refillSpares({runtime,projectRoot,projectID,directory:input.directory,bootstrap:input.bootstrap})
 }
 return allocateWorkspace({runtime,projectRoot,mode:'worktree',input}).finally(settled)
}

function refillSpares(request:{runtime:string;projectRoot:string;projectID:string;directory:string;bootstrap?:BootstrapDeclaration}) {
 const running=refilling.get(request.projectID)
 if(running){running.again=true;return}
 const state={again:false}
 refilling.set(request.projectID,state)
 const pass=()=>allocateWorkspace({runtime:request.runtime,projectRoot:request.projectRoot,mode:'replenish',input:{directory:request.directory,bootstrap:request.bootstrap}})
  .catch(error=>console.error('[quest-workspaces] spare preparation for '+request.projectID+' stopped: '+(error instanceof Error?error.message:String(error))))
  .then(()=>{if(state.again){state.again=false;return pass()}refilling.delete(request.projectID)})
 void pass()
}

if(!isMainThread&&workerData?.mode){
 const began=Date.now()
 const request=workerData as Allocation&{identities?:ProjectIdentityMemory},manager=new QuestWorkspaces(request.runtime)
 rememberProjectIdentities(request.identities)
 if(request.mode!=='replenish')holdWorktreeHomesForOperation()
 void (async()=>{try{
  const workspace=await (request.mode==='replenish'?manager.replenish(request.input):request.mode==='resume'?manager.resume({...request.input,store:new QuestStore(request.projectRoot)}):request.mode==='research'?manager.createResearch(request.input):request.mode==='shared'?manager.createShared({...request.input,store:new QuestStore(request.projectRoot)}):manager.create(request.input))
  parentPort!.postMessage({workspace,began})
 }catch(error){parentPort!.postMessage({error:error instanceof Error?error.message:String(error)})}
 finally{parentPort!.close()}})()
}
