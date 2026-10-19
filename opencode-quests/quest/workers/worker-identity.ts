import {QuestError} from '../api'
import type {QuestSession} from '../types'
export function assertWorkerIdentity(run:QuestSession|undefined,actual:{agent?:string;model?:{providerID?:string;id?:string;variant?:string}}) {
 if(!run?.providerID||!run.modelID||!run.reasoningEffort)return
 if(actual.agent===run.agentRole&&actual.model?.providerID===run.providerID&&actual.model?.id===run.modelID&&actual.model?.variant===run.reasoningEffort)return
 const named=(agent?:string,model?:{providerID?:string;id?:string;variant?:string})=>(agent??'no agent')+' on '+(model?.providerID??'?')+'/'+(model?.id??'?')+'#'+(model?.variant??'?')
 throw new QuestError('WORKER_IDENTITY_CHANGED','Worker agent/model/reasoning differs from its authorized dispatch: dispatched as '+named(run.agentRole,{providerID:run.providerID,id:run.modelID,variant:run.reasoningEffort})+', now '+named(actual.agent,actual.model)+'. The session was changed after dispatch, for example by a model selection in it. No inference was sent. Tell the user what changed, and do not substitute a model.')
}

export function assertWorkerRequestIdentity(run:QuestSession,request:Parameters<typeof assertWorkerIdentity>[1],session?:Parameters<typeof assertWorkerIdentity>[1]) {
 if(request.agent!=='compaction')return assertWorkerIdentity(run,request)
 assertWorkerIdentity(run,session??{})
 assertWorkerIdentity(run,{agent:session?.agent,model:request.model})
}
