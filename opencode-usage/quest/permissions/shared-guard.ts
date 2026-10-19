import {acquireLock,acquireLockAsync,LockBusyError,workspaceLockHolder,type HeldLock,type LockOptions} from "../locking.mts"
import {isTerminalSession} from '../runs/session-lineage'
import {runLockOptions} from '../checkouts/run-locks'
import {holdWorkspaceLock,workspaceWaitSignal} from '../host/host-observation'
import {QuestWorkspaces} from '../workspaces'
import {readQuestLedger} from '../index'
import {ledgerKey,onLedgerChange,watchLedger} from '../core/ledger-changes'
import {join} from 'node:path'
import {coordinationAsync} from '../checkouts/coordination'
import {QuestError} from '../api'
import type {QuestStore} from '../store'
import type {Quest,QuestSession} from '../types'
import {enabledMCPServers,unpermittedComputerTool} from './computer-use'
import {giverSettings} from '../giver/giver-settings'
import {userGiverID} from '../giver/user-giver'
import {questOperations} from '../operations.mjs'
import {desktopInputViolations} from '../../scripts/shell-guard'
import {isReplayRun,replayBySession,replayRun} from '../bench/replay-record'
import {readOnlyGit} from './research-git'
const guardedHosts=new WeakSet<object>()
export const researchGuardReady=(host:object)=>guardedHosts.has(host)
export const researchTools=new Set(['read','glob','grep','skill','webfetch','websearch','quests_list','quests_get','quests_update','quests_wait','quests_status','quests_plan','quests_inspect','quests_report','quest_report','usage_status','execute','tool_search','shell','bash'])
export function researchPermissions():{action:string;resource:string;effect:'allow'|'deny'}[] {
 const deny=(action:string)=>({action,resource:'*',effect:'deny' as const})
 return [
  ...['usage_*','project_*','opencode_*','quest_outcome','quest_work_supply','edit','write','patch','apply_patch'].map(deny),
  ...Object.keys(questOperations).map(operation=>'quests_'+operation).filter(name=>!researchTools.has(name)).map(deny),
  {action:'usage_status',resource:'*',effect:'allow'},
 ]
}
export type QuestMembership={quest:Quest;run:QuestSession;archived:boolean}
const sessionIndexes=new Map<string,{index:Map<string,QuestMembership[]>}>()
let listening=false
export function questMemberships(store:QuestStore,sessionID:string):QuestMembership[] {
 const root=ledgerKey(store.projectRoot)
 if(!listening){listening=true;onLedgerChange(changed=>{sessionIndexes.delete(changed)})}
 let held=sessionIndexes.get(root)
 if(!held){
  const watched=watchLedger(store.projectRoot)
  const archive=ledgerKey(join(store.projectRoot,'.opencode','quests-archive'))
  const index=new Map<string,QuestMembership[]>()
  for(const {quest,path} of readQuestLedger(store.projectRoot,{includeArchived:true}).rows){
   if(!quest)continue
   const archived=ledgerKey(path).startsWith(archive)
   for(const run of quest.sessions)for(const id of new Set([run.openCodeSessionId,run.sessionID])){
    if(!id)continue
    const entry={quest,run,archived}
    const list=index.get(id);if(list)list.push(entry);else index.set(id,[entry])
   }
  }
  held={index}
  if(watched)sessionIndexes.set(root,held)
 }
 return held.index.get(sessionID)??replayMemberships(store,sessionID)
}
function replayMemberships(store:QuestStore,sessionID:string):QuestMembership[] {
 const replay=replayBySession(store.runtime,sessionID),quest=replay&&store.read(replay.questID)
 return replay&&quest?[{quest,run:replayRun(replay),archived:false}]:[]
}
export async function assertSharedAssignment(store:QuestStore,sessionID:string,membership?:QuestMembership[]) {
  const member=(membership??questMemberships(store,sessionID))[0],run=member?.run
 if(!run?.runID)return
  const manager=new QuestWorkspaces(store.runtime),workspace=manager.get(run.runID)
  if(workspace&&(workspace.mode??'worktree')==='worktree'&&member?.quest.sessions.some(s=>s.runID&&s.runID!==run.runID&&['planned','executing','waiting','blocked'].includes(s.state)&&manager.get(s.runID)?.path===workspace.path))throw new QuestError('WORKSPACE_ASSIGNMENT_ENDED','A continuation now owns this checkout; continue through its current Quest assignment')
 if(workspace?.removed)throw new QuestError('WORKSPACE_RETIRED','This checkout was cleaned after turn-in. Reopen the Quest and start a new run to get an owned workspace.')
 if(workspace?.mode!=='shared')return
 if(workspace.sharedReleased)throw new QuestError('SHARED_ASSIGNMENT_ENDED','This shared assignment ended and released its files. Continue through a new Quest run so ownership is acquired before editing.')
 await manager.verify(workspace)
 const result=(await coordinationAsync(store,{directory:workspace.root,sessionID:'quest-run:'+run.runID,host:'opencode'}))({action:'update',scopes:workspace.fileScopes,activity:'Shared worker executing'})
 if(!result.acquired)throw new QuestError('SHARED_SCOPE_CONFLICT','Shared file reservation changed; reconcile before editing')
}
export function workspaceHolderEnded(store:QuestStore,holder:string):boolean {
 if(!holder.startsWith('session:'))return false
 const runs=questMemberships(store,holder.slice('session:'.length)).map(member=>store.read(member.quest.id)?.sessions.find(run=>run.callID===member.run.callID)??member.run)
 return runs.length>0&&runs.every(run=>isTerminalSession(run.state))
}
export const workspaceLockOptions=(store:QuestStore,sessionID:string):Pick<LockOptions,'holder'|'holderEnded'>=>({holder:workspaceLockHolder(sessionID),holderEnded:holder=>workspaceHolderEnded(store,holder)})
const SHELL=/^(shell|bash|cmd|powershell|pwsh)$/i
function refuseDesktopInput(input:any,run:QuestSession){
 const command=typeof input==='string'?input:input?.command??input?.cmd
 if(typeof command!=='string')return
 const cwd=[input?.workdir,input?.cwd,(run.scope as any)?.worktree,run.worktree].find((value):value is string=>typeof value==='string'&&value.length>0)
 const refused=desktopInputViolations(command,cwd)
 if(refused.length)throw new QuestError('DESKTOP_INPUT_DENIED',refused.map(hit=>hit.message).join('; '))
}
export async function installSharedWorkspaceGuard(ctx:any,store:QuestStore) {
 const register=ctx.tool?.transform??ctx.tool?.catalog
 if(typeof register!=='function')throw new Error('Workspace guard requires host tool transform')
 await register((draft:any)=>{
  for(const {id} of draft.list()) {
   if(!draft.get(id))continue
   draft.update(id,(tool:any)=>{const original=tool.execute;if(typeof original!=='function')return;tool.execute=async(input:any,context:any)=>{const membership=context?.sessionID?questMemberships(store,context.sessionID):[];if(context?.sessionID&&(membership.length||userGiverID(store)===context.sessionID)&&id.includes('_')){const blocked=unpermittedComputerTool(id,giverSettings().computerUse??[],enabledMCPServers());if(blocked)throw new QuestError('COMPUTER_USE_DENIED','Computer-use server '+blocked+' is not named in computerUse in the Quest settings')};if(membership.length&&SHELL.test(id))refuseDesktopInput(input,membership[0].run);if(context?.sessionID){const run=membership[0]?.run;if((run?.scope as any)?.readOnly===true){const workspace=run?.runID&&new QuestWorkspaces(store.runtime).get(run.runID);if(!workspace||workspace.mode!=='research')throw new QuestError('RESEARCH_BINDING_FAILED','Read-only research workspace is unavailable');await new QuestWorkspaces(store.runtime).verify(workspace);if(!researchTools.has(id)&&!(id==='quest_guidance'&&['acknowledge','status'].includes(input?.action)))throw new QuestError('RESEARCH_WRITE_DENIED','Read-only research cannot run '+id+'; record findings through the assigned Quest step');if(SHELL.test(id)&&!readOnlyGit(input?.command??input?.cmd))throw new QuestError('RESEARCH_WRITE_DENIED','Read-only research may run only git log, show, diff, grep, blame and the other read-only git commands, one at a time')}else if(['edit','write','patch','apply_patch','shell','bash'].includes(id))await assertSharedAssignment(store,context.sessionID,membership)}const member=membership[0]&&{q:membership[0].quest,s:membership[0].run};
     if(member&&['edit','write','patch','apply_patch','shell','bash'].includes(id)){
      const runID=member.s.runID;if(member.q.state==='Archived'&&!isReplayRun(member.s))throw new QuestError('WORKSPACE_RETIRED','This Quest was turned in; reopen it and start a new worker before editing.')
       if(runID){
        const lockID=new QuestWorkspaces(store.runtime).lockID(runID)
       let lock:HeldLock|undefined,waiting:ReturnType<typeof workspaceWaitSignal>|undefined,release:(()=>void)|undefined
       try{
         const holding={...workspaceLockOptions(store,context.sessionID),...runLockOptions(store.runtime,{quest:member.q.id,run:runID})}
         try{lock=acquireLock(store.runtime,'workspace-'+lockID,{...holding,timeoutMs:0})}catch(error){
         if(!(error instanceof LockBusyError))throw error
         waiting=workspaceWaitSignal(ctx.session,context.sessionID)
          lock=await acquireLockAsync(store.runtime,'workspace-'+lockID,waiting.signal,holding)
        }
        const held=lock;release=ctx.session?holdWorkspaceLock(ctx.session,context.sessionID,held):()=>held.release()
         waiting?.signal.throwIfAborted()
        await assertSharedAssignment(store,context.sessionID,membership)
        if(!isReplayRun(member.s)&&store.read(member.q.id)?.state==='Archived')throw Error('Quest turned in during tool admission')
        return await original(input,context)
       }finally{waiting?.dispose();if(release)release();else lock?.release()}
      }
     }
     return original(input,context)}})
  }
 })
 if(ctx.session)guardedHosts.add(ctx.session)
}
