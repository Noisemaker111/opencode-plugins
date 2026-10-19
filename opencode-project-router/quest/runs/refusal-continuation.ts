import type {QuestStore} from '../store'
import {abortedTurnRun} from './continuation-workspace'
import {inspectWorker} from '../workers/worker-inspection'
import {boundedInspection} from '../worker-observation.mjs'
import {physicalDirectory} from '../core/project'
import {digest} from '../privacy'
import {acquireLock} from '../locking.mts'

export function refusalContinuation(store:QuestStore,host:any){
 return async({questID,runID,sessionID,workspace,text,id}:{questID:string;runID:string;sessionID:string;workspace?:string;text:string;id:string}):Promise<false|{callID:string}>=>{
  const lock=acquireLock(store.runtime,'refusal-resume-'+digest(runID),{timeoutMs:0})
  try{
   const quest=store.read(questID),run=quest?.sessions.find(s=>(s.runID??s.callID)===runID)
   if(!quest||quest.state==='Archived'||!run||!abortedTurnRun(run)||(run.openCodeSessionId??run.sessionID)!==sessionID)return false
   if(typeof host.synthetic!=='function')return false
   const response=await boundedInspection(signal=>host.get({sessionID},{signal})),session=response?.data??response
   if(session?.id!==sessionID||!workspace||typeof session.location?.directory!=='string'||physicalDirectory(session.location.directory)!==physicalDirectory(workspace))return false
   if(!run.providerID||!run.modelID||!run.reasoningEffort||session.agent!==run.agentRole||session.model?.providerID!==run.providerID||session.model?.id!==run.modelID||session.model?.variant!==run.reasoningEffort)return false
   const observed=await inspectWorker(host,run,{messages:true})
   if(observed.state!=='interrupted'||!observed.reason?.startsWith('Permission refusal interrupted'))return false
   const current=store.read(questID)
   if(!current||current.revision!==quest.revision||current.sessions.some(s=>s.resumedFrom===run.callID)||!current.stages.some(s=>run.deliverables.includes(s.id)&&s.status!=='done'))return false
   const resumeCallID=runID+'-resume1'
   store.apply(questID,'session-claimed',{callID:resumeCallID,runID:resumeCallID,state:'planned',taskID:run.taskID,sessionID,openCodeSessionId:run.openCodeSessionId??sessionID,parentID:run.parentID??run.parentSessionID,role:run.role,model:run.model,scope:run.scope,harness:run.harness,agentRole:run.agentRole,providerID:run.providerID,modelID:run.modelID,reasoningEffort:run.reasoningEffort,fast:run.fast,runtime:run.runtime,deliverables:run.deliverables,resumedFrom:run.callID,resumeRoot:run.resumeRoot??run.callID,attempt:run.attempt+1},'quest:refusal-resume')
   await boundedInspection(signal=>host.synthetic({sessionID,id:'msg_'+digest(id).slice(0,26),text,delivery:'queue',metadata:{questID,runID:resumeCallID,resumedFrom:run.callID,questRefusalResume:true}},{signal}))
   store.apply(questID,'session-state',{callID:resumeCallID,state:'executing',evidence:'Resumed after permission refusal in the exact session and worktree'},'quest:refusal-resume')
   return {callID:resumeCallID}
  }catch(error){throw new Error('Refusal continuation could not be confirmed; retain the exact session and inspect before retrying. '+String(error))}
  finally{lock.release()}
 }
}
