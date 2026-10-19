import type { QuestContext } from '../api'
import { QuestError } from '../api'
import type { Quest } from '../types'
import type { QuestStore } from '../store'
import { physicalDirectory, sourceCheckoutAsync, gitMetadataDirectory } from '../core/project'
import { QuestWorkspaces, type Workspace } from '../workspaces'
import { questWorkflow } from './workflow'
import { sentBackWithSameGaps } from '../review/review-record'
import { readDispatchPolicy, configuredDispatchPolicyFile } from '../../models/dispatch-policy'
import { editingSource } from '../checkouts/source-binding'
import { join } from 'node:path'
import { resolveDeliveryPolicyAsync } from '../landing/delivery-policy.mjs'
import { remoteRef, type DeliveryPolicy } from '../landing/delivery'
import { driveAsync, gitRun } from '../landing/git-steps'

export async function workspaceMatchesProject(workspace:Workspace,context:QuestContext,policyFile=configuredDispatchPolicyFile()):Promise<boolean> {
  if(workspace.projectID===context.project.id)return physicalDirectory(workspace.root)===physicalDirectory(context.project.root)
  if(!readDispatchPolicy(policyFile).sourceByProject?.[context.project.id])return false
  if(!context.directory)return false
  const selected=await editingSource({project:context.project,directory:context.directory},policyFile,undefined,{readOnly:true})
  return workspace.projectID===selected.project.id&&physicalDirectory(workspace.root)===physicalDirectory(selected.project.root)
}

export function previousAttempt(quest:Quest,stepIDs:string[]) {
  const wanted=new Set(stepIDs)
  return quest.sessions.findLast(run=>['failed','cancelled','missing','stale','completed'].includes(run.state)&&run.deliverables.some(id=>wanted.has(id)))
}

export const abortedTurnRun=(run:import('../types').QuestSession)=>['cancelled','failed'].includes(run.state)&&!/Host reported execution interrupted: user/.test(`${run.result??''} ${run.evidence?.at(-1)??''}`)&&/Permission refusal interrupted the worker tool message/.test(`${run.result??''} ${run.evidence?.at(-1)??''}`)
export const awaitingRefusalObservation=(run:import('../types').QuestSession)=>run.state==='cancelled'&&run.permissionDecisions?.some(d=>d.reply==='reject')&&!/Host reported execution interrupted: user|Permission refusal interrupted|no automatic restart is authorized/.test(`${run.result??''} ${run.evidence?.at(-1)??''}`)

export function continuationContext(quest:Quest,stepIDs:string[],context:QuestContext):QuestContext {
  const previous=previousAttempt(quest,stepIDs)
  if(!previous)return serialContinuationContext(quest,{...context,resume:undefined})
  if(sentBackWithSameGaps(quest,previous.runID??previous.callID,stepIDs))return {...context,resume:undefined,freshBase:true}
  return {...context,resume:previous?{questID:quest.id,runID:previous.runID??previous.callID}:undefined}
}

export async function currentLandingBase(root:string,source:string):Promise<string> {
  let policy:DeliveryPolicy
  try{policy=(await resolveDeliveryPolicyAsync(root,{source}) as {policy:DeliveryPolicy}).policy}
  catch(error){throw new QuestError('FRESH_BASE_UNAVAILABLE','The step was sent back twice with the same gaps, so it must start from the current landing branch, but that branch cannot be read: '+(error instanceof Error?error.message:String(error)))}
  if(policy.landed==='remote'&&policy.remote){
    const fetched=await driveAsync(gitRun(source,['fetch','--quiet',policy.remote,`+refs/heads/${policy.into}:${remoteRef(policy)}`],60_000))
    if(fetched.status!==0)throw new QuestError('FRESH_BASE_UNAVAILABLE','The step was sent back twice with the same gaps, so it must start from current '+policy.into+', but fetching '+policy.remote+'/'+policy.into+' failed: '+(fetched.stderr||fetched.stdout).trim())
  }
  return remoteRef(policy)
}

export function serialContinuationContext(quest:Quest,context:QuestContext):QuestContext {
  const workflow=questWorkflow(quest)
  if(workflow.delivery!=='quest-pr'||workflow.maxConcurrent!==1||workflow.readOnly)return context
  const owner=quest.extensions.prOwner as {runID:string;sessionID:string}|undefined
  if(!owner&&!quest.sessions.some(run=>run.scope?.worktree))return context
  const previous=owner?quest.sessions.find(run=>(run.runID??run.callID)===owner.runID&&(run.openCodeSessionId??run.sessionID)===owner.sessionID):undefined
  if(!previous||!['completed','failed','cancelled'].includes(previous.state)||previous.scope?.readOnly||!previous.scope?.worktree)throw new QuestError('CONTINUATION_WORKSPACE_UNAVAILABLE','Serial Quest PR handoff requires its recorded terminal writable PR owner; reconcile ownership before dispatch')
  return previous?{...context,resume:{questID:quest.id,runID:previous.runID??previous.callID}}:context
}
export async function continuationWorkspace(store:QuestStore,context:QuestContext,policyFile=configuredDispatchPolicyFile()):Promise<Workspace|undefined> {
  if(!context.resume)return
  const {questID,runID}=context.resume,quest=store.read(questID),manager=new QuestWorkspaces(store.runtime)
  try {
    if(!quest||quest.project?.id!==context.project.id)throw Error('Continuation Quest ownership changed')
    let run=quest.sessions.find(s=>(s.runID??s.callID)===runID),workspace:Workspace|undefined
    const seen=new Set<string>()
    if(!run)throw Error('Original run is not recorded on this Quest')
    while(run){
      if(seen.has(run.callID))throw Error('Original run lineage contains a cycle')
      seen.add(run.callID)
      const receipt=manager.get(run.runID??run.callID)
      if(receipt){
        if(receipt.questID!==questID)throw Error('Original workspace belongs to another Quest')
        if(!await workspaceMatchesProject(receipt,context,policyFile))break
        workspace=receipt
      } else if(run.scope?.worktree||run.sessionID||run.openCodeSessionId) {
        throw Error('Original workspace receipt is missing for run '+(run.runID??run.callID))
      }
      const parentID=run.resumedFrom??(run.resumeRoot!==run.callID?run.resumeRoot:undefined)
      if(!parentID)break
      const parent=quest.sessions.find(s=>s.callID===parentID)
      if(!parent)throw Error('Original run lineage is missing '+parentID)
      run=parent
    }
    if(!workspace)return
    if(manager.preparedAssignmentLost(workspace)){
      console.error('[quests] Prepared spare no longer claims the previous run; starting with a fresh checkout and preserving '+workspace.path)
      return
    }
    if(manager.checkoutMissing(workspace))return await manager.retainedBranch(workspace)?workspace:undefined
    if(workspace.removed)throw Error('Original worktree was removed: '+workspace.path)
    if(process.platform==='win32'&&workspace.mode!=='research'&&workspace.mode!=='shared'&&join(workspace.path,'.git').length>=260)return workspace
    if(workspace.mode!=='research'){
      if(gitMetadataDirectory(workspace.path)!==physicalDirectory(workspace.path))throw Error('Original path is no longer its own Git checkout: '+workspace.path)
      const selected=await sourceCheckoutAsync(workspace.path,{id:workspace.projectID,root:workspace.root})
      if(selected.source!==physicalDirectory(workspace.path))throw Error('Original path is no longer its own Git checkout: '+workspace.path)
    }
    await manager.verify(workspace)
    return workspace
  } catch(error) {
    throw new QuestError('CONTINUATION_WORKSPACE_UNAVAILABLE','Cannot resume original worktree for run '+runID+': '+(error instanceof Error?error.message:String(error))+'. Restore its recorded checkout and ownership before resuming; no project folder was substituted.')
  }
}
