import {createHash} from "node:crypto"
import { isSafeReference } from "./core/readable-reference"
import {removeIntegratedWorktree,preserveWorktree} from "./checkouts/cleanup-git.mjs"
import {workspaceBootstrap,neededPreparation,bootstrapStepTimeout,bootstrapWorkspacePath,landingCheck,type BootstrapDeclaration,type BootstrapStep} from "./checkouts/workspace-bootstrap"
import {runPreparationSteps,type StepTiming} from "./checkouts/preparation-runner"
import {isV2Channel} from "../scripts/channel-migrate.mjs"
import {coordinationAsync} from "./checkouts/coordination"
import type {QuestStore} from "./store"
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, readdirSync, lstatSync, statSync, renameSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { projectIdentitySteps, sourceCheckoutSteps, physicalDirectory, type ProjectIdentity } from "./core/project"
import { attempt, commandRun, driveAsync, gitFed, gitOut, gitRun, taken, together, type GitResult, type GitSteps } from "./landing/git-steps"
import { acquireLock, LockBusyError } from "./locking.mts"
import { tryQueueLock } from "../scripts/land.mjs"
import { acquireRunLock, runLockOptions } from "./checkouts/run-locks"
import {writeFileDurable,readJsonRecord,assertWindowsPathFits,runFileCandidates,runFileStem} from './core/durable-file.mjs'
import {conflictReason,landRemoteSteps,remoteRef,retire,usesRepositoryLander,type Landing,type DeliveryPolicy} from "./landing/delivery"
import {deliveryRefusal,type DeliveryMode} from "./landing/delivery-permission"
import {resolveDeliveryPolicy,resolveDeliveryPolicyAsync,resolveDeliveryPolicySteps} from "./landing/delivery-policy.mjs"
import {isNonLandingBranch} from "./landing/landing-step"
import { now as spanNow, recordSpan } from "../scripts/plugin-spans"

const parsedWorkspaces=new Map<string,{stamp:string;value:Workspace}>()
const workspaceRunIDs=new Map<string,{stamp:string;runID:string}>()
const landingQueues=new Map<string,Promise<unknown>>()
async function landingBaseForStrayHead(root:string,source:string):Promise<string|undefined>{
  const head=await driveAsync(gitRun(source,["symbolic-ref","--short","-q","HEAD"],30000))
  const current=head.status===0?head.stdout.trim():""
  if(!current||!isNonLandingBranch(current))return
  let policy:DeliveryPolicy
  try{policy=(await resolveDeliveryPolicyAsync(root,{source}) as {policy:DeliveryPolicy}).policy}catch{return}
  if(policy.into===current)return
  const ref=remoteRef(policy)
  if(policy.landed==="remote"&&policy.remote)await driveAsync(gitRun(source,["fetch","--quiet",policy.remote,`+refs/heads/${policy.into}:${ref}`],60000))
  const found=await driveAsync(gitRun(source,["rev-parse","--verify","-q",ref+"^{commit}"],30000))
  return found.status===0?ref:undefined
}
function* noCommits():GitSteps<string>{return ""}
function* unread():GitSteps<GitResult|undefined>{return undefined}
import { declaredWorktreeHome, git, gitStatus, inside, lockWorktree, moveLinkedWorktree, pathKey, questLockReason, unlockQuestWorktree, worktreeExclusions, worktreeHomeSteps } from "./checkouts/worktree-plumbing"
import {currentChannel} from "./host/channel-runtimes.mjs"
import {boundedWorktreePath} from './checkouts/worktree-path'
import {worktreeRoot} from './checkouts/worktree-root.mts'
export { clearWorktreeHomeCache, declaredWorktreeHome, moveLinkedWorktree } from "./checkouts/worktree-plumbing"

export async function preparationInputs(directory:string):Promise<string> {
  const paths=(await git(directory,["ls-files","-z","--","*package.json","*lock*","*requirements*.txt","*pyproject.toml","*setup.cfg","*setup.py","*Cargo.toml","*go.mod"])).split("\0").filter(Boolean).sort()
  const hash=createHash("sha256")
  for(const path of paths){hash.update(path).update("\0");const file=join(directory,path);hash.update(existsSync(file)?readFileSync(file):"missing").update("\0")}
  return hash.digest("hex")
}

export function preparationGap(recorded:string|undefined,current:BootstrapStep[]):BootstrapStep[] {
  let previous:BootstrapStep[]=[]
  try{const parsed=JSON.parse(recorded??"[]");if(Array.isArray(parsed))previous=parsed.length&&typeof parsed[0]==="string"?[{argv:parsed as string[],description:"configured policy bootstrap"}]:parsed as BootstrapStep[]}catch{}
  const key=(step:BootstrapStep)=>JSON.stringify([step.description,step.argv,step.cwd??null])
  const seen=new Set(previous.map(key))
  return current.filter(step=>!seen.has(key(step)))
}

export type Changes = { available: boolean; files: { path: string; additions: number | null; deletions: number | null; untracked: boolean }[]; commits: string[]; at: string; error?: string }
export type LandDescribe = { title?: string; body?: string; delivery: DeliveryMode | undefined }
export type Workspace = WorkspaceReplacement & { checkoutLeaf?:string; namingVersion?:2|3; channel?:"v2"|"main"; continuationOf?:string; source?:string; cleanupProtocol?:1; cleanup?:{removed:boolean;reason:string;at:string;logicalBytes?:number;preserved?:{ref?:string}}; version: 1; runID: string; questID: string; projectID: string; root: string; path: string; branch: string; base: string; comparisonTree?:string; changes?: Changes; removed?: boolean; mode?: "shared" | "worktree" | "research"; fileScopes?: string[]; sharedReleased?: boolean; allocationVersion?: 2; physicalRunID?: string; claimedRunID?: string; preparedHead?: string; preparedStamp?: string; preparedBootstrap?: string; preparedInputs?: string; preparationMs?: number; preparationTimeline?: StepTiming[]; preparationSkipped?: string[]; preparationFailed?: string; preparationAttempt?: string; bootstrapComplete?: boolean; inheritedRunIDs?: string[]; leftovers?: string; integration?:{workerHead:string;projectHead:string;verifiedAt:string;method:"ancestor"} }
export type WorkspaceReplacement = {checkoutRunID?:string;replacedWorkspace?:{path:string;branch:string;physicalRunID:string;at:string;reason:string}}
export type {Landing}
export type ResolvedDelivery = { policy: DeliveryPolicy; source: "settings" | "inferred" }
export function dependencyContributes(workspace: Workspace | undefined): boolean {
  if (!workspace) return true
  if (workspace.mode === "research") return false
  const changes = workspace.changes
  return !(changes?.available === true && !changes.files.length && !changes.commits.length)
}

export class QuestWorkspaces {
  constructor(readonly runtime: string) {}
  private file(runID: string) {
    if (!isSafeReference(runID)) throw new Error("Invalid run identity")
    return join(this.runtime, "workspaces", runFileStem(runID) + ".json")
  }
  private stored(runID: string) {
    const file = this.file(runID), legacy = join(this.runtime, "workspaces", runID + ".json")
    return file === legacy || existsSync(file) || !existsSync(legacy) ? file : legacy
  }
  runIDs(): string[] {
    const directory = join(this.runtime, "workspaces")
    let names: string[] = []
    try { names = readdirSync(directory).filter(name => name.endsWith(".json")) } catch { return [] }
    return [...new Set(names.flatMap(name => {
      const file = join(directory, name), stat = statSync(file, { throwIfNoEntry: false })
      const stamp = stat ? stat.ino + ":" + stat.mtimeMs + ":" + stat.size : "", held = workspaceRunIDs.get(file)
      const runID = held && held.stamp === stamp ? held.runID : readJsonRecord<Workspace>(file)?.runID ?? name.slice(0, -5)
      if (stamp) workspaceRunIDs.set(file, { stamp, runID })
      return isSafeReference(runID) ? [runID] : []
    }))]
  }
  private save(value: Workspace) {
    const file = this.file(value.runID), legacy = join(this.runtime, "workspaces", value.runID + ".json")
    writeFileDurable(file, JSON.stringify(value, null, 2))
    if (legacy !== file && existsSync(legacy)) unlinkSync(legacy)
  }
  private savePreparedAssignment(spare: Workspace, assigned: Workspace) {
    if(spare.claimedRunID!==assigned.runID||assigned.physicalRunID!==spare.runID)throw Error("Prepared workspace assignment mismatch")
    this.save(spare)
    this.save(assigned)
  }
  get(runID: string): Workspace | undefined {
    return readJsonRecord<Workspace>(this.stored(runID))
  }
  peek(runID: string): Readonly<Workspace> | undefined {
    const file = this.stored(runID), stat = statSync(file, { throwIfNoEntry: false })
    if (!stat) { parsedWorkspaces.delete(file); return undefined }
    const stamp = stat.ino + ":" + stat.mtimeMs + ":" + stat.size, held = parsedWorkspaces.get(file)
    if (held?.stamp === stamp) return held.value
    const value = readJsonRecord<Workspace>(file)
    if (!value) return undefined
    parsedWorkspaces.set(file, { stamp, value })
    return value
  }
  lockID(runID:string) {return this.get(runID)?.continuationOf??runID}
  preparedAssignmentLost(value:Workspace):boolean {return !!value.physicalRunID&&this.get(value.physicalRunID)?.claimedRunID!==value.runID}
  checkoutMissing(value:Workspace):boolean { return value.mode!=="research"&&value.mode!=="shared"&&(!!value.removed||!existsSync(value.path)) }
  async retainedBranch(value:Workspace):Promise<string|undefined> {
    if(value.mode==="research"||value.mode==="shared")return
    for(const ref of ["refs/heads/"+value.branch,"refs/remotes/origin/"+value.branch])
      if(await gitStatus(value.root,["rev-parse","--verify","-q",ref+"^{commit}"])===0)return ref
  }
  private async restoreCheckout(value:Workspace):Promise<Workspace> {
    const ref=await this.retainedBranch(value)
    if(!ref)throw Error("Original worktree and its branch "+value.branch+" are both gone: "+value.path)
    if(existsSync(value.path))throw Error("Original worktree path exists without its checkout; preserving it: "+value.path)
    await git(value.root,["worktree","prune"])
    await git(value.root,ref.startsWith("refs/heads/")?["worktree","add",value.path,value.branch]:["worktree","add","-b",value.branch,value.path,ref])
    await lockWorktree(value.root,value.path,value.continuationOf??value.runID,value.channel)
    const restored:Workspace={...value,removed:undefined,cleanup:undefined,bootstrapComplete:false,preparedHead:undefined,preparedStamp:undefined}
    this.save(restored)
    return restored
  }
  private async repairRetainedPath(value:Workspace):Promise<Workspace> {
    if(process.platform!=='win32'||value.mode==='research'||value.mode==='shared'||join(value.path,'.git').length<260)return value
    const home=(await driveAsync(this.candidateHomeSteps(value.root))).find(candidate=>inside(candidate,value.path))??await declaredWorktreeHome(value.root)
    const target=boundedWorktreePath(home,value.checkoutRunID??value.claimedRunID??value.runID,value.channel)
    if(pathKey(target)===pathKey(value.path))throw Error('Retained checkout needs a shorter quest.worktreeRoot')
    if(!(await this.candidatePaths(value.root,this.checkoutName(value))).some(path=>pathKey(path)===pathKey(value.path)))throw Error('Retained checkout path is not runtime owned')
    const journal=runFileCandidates(this.runtime,'path-repair-'+value.runID).find(existsSync)??runFileCandidates(this.runtime,'path-repair-'+value.runID)[0]
    const pending=existsSync(journal)?JSON.parse(readFileSync(journal,'utf8')):undefined
    if(pending&&(pending.from!==value.path||pending.to!==target||pending.branch!==value.branch))throw Error('Retained repair journal conflicts; preserving both paths')
    const moved=!!pending&&!existsSync(value.path)&&existsSync(target)
    if(existsSync(target)&&!moved)throw Error('Retained repair destination exists; preserving both paths: '+target)
    const current=moved?target:value.path
    const reason=await questLockReason(value.root,current)??(moved?await questLockReason(value.root,value.path):undefined)
    const owner=value.continuationOf??value.claimedRunID??value.runID
    if(reason!=='Quest run '+owner+(value.channel?' on '+value.channel:'')+' owns this checkout')throw Error('Retained checkout lock owner changed; preserving it')
    const common=(await git(value.root,['rev-parse','--path-format=absolute','--git-common-dir'])).trim()
    const pointer=/^gitdir:\s*(.+)$/m.exec(readFileSync(join(current,'.git'),'utf8'))?.[1]?.trim()
    const administrative=pointer?resolve(current,pointer):''
    if(!administrative||pathKey(dirname(administrative))!==pathKey(join(common,'worktrees'))||readFileSync(join(administrative,'HEAD'),'utf8').trim()!=='ref: refs/heads/'+value.branch||![join(current,'.git'),...(moved?[join(value.path,'.git')]:[])].some(path=>pathKey(readFileSync(join(administrative,'gitdir'),'utf8').trim())===pathKey(path))||(pending&&pending.administrative!==administrative))throw Error('Retained Git registration or branch changed; preserving it')
    if(existsSync(join(current,'.gitmodules')))throw Error('Retained long-path checkout declares submodules; supported submodule relocation is required before recovery')
    const records=this.runIDs().map(runID=>this.get(runID)!).filter(row=>row&&(pathKey(row.path)===pathKey(value.path)||(pending&&pathKey(row.path)===pathKey(target))))
    if(records.some(row=>row.root!==value.root||row.projectID!==value.projectID||row.branch!==value.branch||(row.questID!==value.questID&&row.claimedRunID!==value.runID)))throw Error('Retained checkout has conflicting runtime ownership')
    mkdirSync(dirname(target),{recursive:true})
    writeFileDurable(journal,JSON.stringify({from:value.path,to:target,branch:value.branch,administrative}))
    if(!moved)renameSync(value.path,target)
    try {
      await git(value.root,['worktree','repair',target])
      if((await git(target,['symbolic-ref','--short','HEAD'])).trim()!==value.branch||await questLockReason(value.root,target)!==reason)throw Error('Retained checkout repair changed branch or lock')
      await git(target,['status','--porcelain=v2','-z'])
    }catch(error){if(!moved){renameSync(target,value.path);await git(value.root,['worktree','repair',value.path])}throw error}
    for(const row of records){row.path=target;row.checkoutLeaf=basename(target);row.namingVersion=row.channel?3:2;this.save(row)}
    unlinkSync(journal)
    return this.get(value.runID)!
  }
  async resume(input:{runID:string;questID:string;original:Workspace;store:QuestStore;files?:string[];bootstrap?:BootstrapDeclaration}):Promise<Workspace> {
    const home=input.original.continuationOf??input.original.runID
    const lock=acquireRunLock(this.runtime,'workspace-'+home,{quest:input.questID,run:input.runID},{timeoutMs:0})
    try {
      let original=this.get(home)
      const quest=input.store.read(input.questID)
      if(original&&original.questID===input.questID&&this.checkoutMissing(original))original=await this.restoreCheckout(original)
      if(!original||original.removed||original.questID!==input.questID||!quest)throw Error('Original continuation workspace is unavailable')
      if(quest.sessions.some(s=>(s.runID??s.callID)!==input.runID&&['planned','executing','waiting','blocked'].includes(s.state)&&this.get(s.runID??s.callID)?.path===original.path))throw Error('Original worktree still has an active owner')
      original=await this.repairRetainedPath(original)
      await this.verify(original)
      if(original.mode==='research')return await this.createResearch({runID:input.runID,questID:input.questID,directory:original.path,project:{id:original.projectID,root:original.root}})
      if(original.mode==='shared')return await this.createShared({runID:input.runID,questID:input.questID,directory:original.path,project:{id:original.projectID,root:original.root},files:input.files,store:input.store})
      await this.ensurePrepared(original,original.path,await workspaceBootstrap(original.path,input.bootstrap),original.root)
      const prior=this.get(input.runID)
      if(prior){if(prior.continuationOf!==home||prior.questID!==input.questID)throw Error('Continuation workspace identity conflicts');await this.verify(prior);return prior}
      const value:Workspace={...original,runID:input.runID,continuationOf:home,physicalRunID:undefined,claimedRunID:undefined,changes:undefined,cleanup:undefined,integration:undefined}
      this.save(value);await this.verify(value);return value
    } finally {lock.release()}
  }
  async recoverDependencies(input:{original:Workspace;runID:string;questID:string;store:QuestStore;inheritRunIDs:string[]}):Promise<Workspace> {
    const home=input.original.continuationOf??input.original.runID
    const lock=acquireRunLock(this.runtime,'workspace-'+home,{quest:input.questID,run:input.runID},{timeoutMs:0})
    try {
      const original=this.get(input.original.runID),quest=input.store.read(input.questID)
      if(!original||!quest||original.questID!==input.questID||original.mode==='research'||original.mode==='shared')throw Error('Recovery requires the retained owned editing checkout')
      await this.verify(original)
      if(quest.sessions.some(run=>(run.runID??run.callID)!==input.runID&&['planned','executing','waiting','blocked'].includes(run.state)))throw Error('Quest still has an active writer')
      const sources:Workspace[]=[]
      for(const id of input.inheritRunIDs){const source=this.get(id);if(!source||source.removed||source.questID!==input.questID||source.projectID!==original.projectID||source.mode==='research'||source.mode==='shared')throw Error('Dependency recovery ownership is unavailable: '+id);await this.verify(source);sources.push(source)}
      for(const source of sources){await this.applySnapshot(source.path,source.comparisonTree??source.base,original.path,original.fileScopes??['.']);original.inheritedRunIDs=[...new Set([...(original.inheritedRunIDs??[]),source.runID,...(source.inheritedRunIDs??[])])];this.save(original);if(original.continuationOf){const root=this.get(original.continuationOf)!;root.inheritedRunIDs=original.inheritedRunIDs;this.save(root)}}
      return original
    }finally{lock.release()}
  }
  async createResearch(input:{runID:string;questID:string;directory:string;project:ProjectIdentity}):Promise<Workspace> {
    this.file(input.runID)
    const source=physicalDirectory(input.directory),project=await driveAsync(projectIdentitySteps(source))
    if(project.id!==input.project.id)throw new Error("Research directory belongs to another project")
    const lock=acquireRunLock(this.runtime,"workspace-"+input.runID,{quest:input.questID,run:input.runID},{timeoutMs:0})
    try{
      const prior=this.get(input.runID)
      if(prior){if(prior.mode!=="research"||prior.questID!==input.questID||prior.path!==source)throw new Error("Research workspace identity conflicts");await this.verify(prior);return prior}
      const value:Workspace={version:1,runID:input.runID,questID:input.questID,projectID:project.id,root:project.root,source,path:source,branch:"",base:"",mode:"research",bootstrapComplete:true}
      this.save(value);return value
    }finally{lock.release()}
  }
  async create(input: { runID: string; questID: string; directory: string; project?:ProjectIdentity; bootstrap?:BootstrapDeclaration; inheritRunIDs?: string[]; skipPrepared?: boolean; files?: string[]; base?: string; branch?: string }): Promise<Workspace> {
    this.file(input.runID)
    const lock = acquireRunLock(this.runtime, "workspace-" + input.runID, {quest:input.questID,run:input.runID}, {timeoutMs:0})
    try {
      const timeline:StepTiming[]=[]
      const binding=Date.now()
      const {project,source} = await driveAsync(sourceCheckoutSteps(input.directory,input.project))
      const listing=Date.now()
      timeline.push({stage:"bind source checkout",start:binding,end:listing})
      const steps=await workspaceBootstrap(source,input.bootstrap)
      timeline.push({stage:"list preparation steps",start:listing,end:Date.now()})
      input={...input,bootstrap:steps}
      const prior = this.get(input.runID)
      let replacement:Workspace["replacedWorkspace"],checkoutRunID:string|undefined
      if (prior) {
        if (prior.projectID !== project.id || prior.questID !== input.questID || prior.removed || physicalDirectory(prior.source??prior.root)!==source) throw new Error("Run workspace identity conflicts with existing ownership")
        if(this.preparedAssignmentLost(prior)){
          replacement={path:prior.path,branch:prior.branch,physicalRunID:prior.physicalRunID!,at:new Date().toISOString(),reason:"Prepared spare no longer claims this run"}
          checkoutRunID=input.runID+"-fresh-"+crypto.randomUUID().replaceAll("-","").slice(0,6)
          console.error("[quest-workspaces] Prepared spare no longer claims this run; creating a fresh checkout and preserving "+prior.path)
        }else{await this.verify(prior); await this.ensurePrepared(prior,prior.path,await workspaceBootstrap(prior.path,input.bootstrap),prior.root); return prior}
      }
      if(!input.base&&!replacement)input={...input,base:await landingBaseForStrayHead(project.root,source)}
      const ready = !replacement && source===physicalDirectory(project.root) && !input.skipPrepared && !input.base && !input.branch && !input.inheritRunIDs?.length ? await this.takePrepared(input, project, steps, timeline) : undefined
      if (ready) return ready
      const root = project.root
      const base = (input.base ? await git(source, ["rev-parse", "--verify", input.base + "^{commit}"]) : await git(source, ["rev-parse", "HEAD"])).trim()
      const channel = currentChannel()
      const path = await this.workspacePath(root, checkoutRunID??input.runID, channel), branch = input.branch ?? "quest/" + (checkoutRunID??input.runID)
      assertWindowsPathFits(path)
      if (existsSync(path)) throw new Error("Workspace path exists without runtime ownership; preserving it")
      mkdirSync(dirname(path), { recursive: true })
      const added=Date.now()
      await git(root, ["worktree", "add", "-b", branch, path, base])
      timeline.push({stage:"worktree add",start:added,end:Date.now()})
      const value: Workspace = { version: 1, checkoutLeaf:basename(path), namingVersion:channel?3:2, ...(channel?{channel}:{}), cleanupProtocol:1, allocationVersion: 2, runID: input.runID, questID: input.questID, projectID: project.id, root, path, branch, base, bootstrapComplete: false }
      value.source=source
      if(replacement){value.checkoutRunID=checkoutRunID;value.replacedWorkspace=replacement}
      this.save(value)
      await lockWorktree(root, path, input.runID, channel)
      if((await git(source,["ls-files","--unmerged"])).trim())throw new Error("Resolve selected checkout conflicts before creating an editing worker; workspace retained")
      const sources:Workspace[] = []
      for (const runID of input.inheritRunIDs ?? []) sources.push(await (async () => {
        const source = this.get(runID)
        if (!source) throw new Error(`Dependency workspace ${runID} has no record left, so nothing can say whether it held unmerged work. Re-run the step that produced it in this project, or save that step's result naming what supersedes it.`)
        if (source.questID !== input.questID) throw new Error(`Dependency workspace ${runID} belongs to Quest ${source.questID}, not ${input.questID}; it is not this Quest's to inherit.`)
        if (source.projectID !== project.id) throw new Error(`Dependency workspace ${runID} was created under ${source.root} and this Quest now runs in ${project.root}, so its tree cannot be applied here. Re-run the step that produced it in this project, or save that step's result naming what supersedes it.`)
        if(!source.removed&&await this.retireLandedDependency(source,base))return this.get(runID)!
        if(source.removed){
          if(!source.integration)throw new Error("Removed dependency has no verified integration: "+runID)
          if(await gitStatus(root,["merge-base","--is-ancestor",source.integration.workerHead,base])!==0)throw new Error("Current project does not retain the removed dependency commit: "+runID)
          return source
        }
        await this.verify(source)
        if(source.mode==="research")return source
        if ((await git(source.path, ["ls-files", "--unmerged"])).trim()) throw new Error("Resolve dependency conflicts before starting another worker: " + runID)
        return source
      })())
      const independent = sources.filter(source => !sources.some(other => other.runID !== source.runID && other.inheritedRunIDs?.includes(source.runID)))
      for (const source of independent.filter(source=>!source.removed&&source.mode!=="shared"&&source.mode!=="research")) await this.applySnapshot(source.path, source.comparisonTree??source.base, path)
      value.inheritedRunIDs = [...new Set(sources.flatMap(source => [source.runID, ...(source.inheritedRunIDs ?? [])]))]
      this.save(value)
      const {run,skipped}=neededPreparation(steps,input.files)
      if(skipped.length)value.preparationSkipped=skipped.map(step=>step.description)
      await this.runPreparation(value,path,run,root,run,timeline)
      await this.verify(value); return value
    } finally { lock.release() }
  }

  private async retireLandedDependency(source:Workspace,base:string):Promise<boolean> {
    if(source.mode==="research"||source.mode==="shared")return false
    const registered=(await git(source.root,["worktree","list","--porcelain","-z"])).split("\0").some(field=>field.startsWith("worktree ")&&pathKey(field.slice(9))===pathKey(source.path))
    if(registered&&existsSync(source.path))return false
    const workerHead=source.changes?.commits?.[0]??source.base
    if(await gitStatus(source.root,["merge-base","--is-ancestor",workerHead,base])!==0)return false
    const at=new Date().toISOString(),reason="The checkout was retired after its work landed in "+base
    for(const runID of [...new Set([source.runID,source.continuationOf].filter((id):id is string=>!!id))]){
      const record=this.get(runID)
      if(!record||record.removed||pathKey(record.path)!==pathKey(source.path))continue
      const head=record.changes?.commits?.[0]??record.base
      if(await gitStatus(record.root,["merge-base","--is-ancestor",head,base])!==0)continue
      record.removed=true;record.integration={workerHead:head,projectHead:base,verifiedAt:at,method:"ancestor"};record.cleanup={removed:true,reason,at};this.save(record)
    }
    return !!this.get(source.runID)?.removed
  }
  private async runPreparation(value:Workspace,path:string,record:BootstrapStep[],root:string,run:BootstrapStep[]=record,timeline:StepTiming[]=[]):Promise<Workspace> {
    const started=Date.now()
    value.bootstrapComplete=false
    delete value.preparationFailed
    this.save(value)
    try{timeline.push(...(await runPreparationSteps(path,run)))}
    catch(error){
      timeline.push(...((error as {timings?:StepTiming[]}).timings??[]))
      value.preparationFailed=error instanceof Error?error.message:String(error);value.preparationAttempt=JSON.stringify(record);value.preparationTimeline=timeline
      this.save(value);throw error
    }
    value.preparationTimeline=timeline
    const skipped=value.preparationSkipped?.filter(description=>!run.some(step=>step.description===description))
    if(skipped?.length)value.preparationSkipped=skipped;else delete value.preparationSkipped
    value.bootstrapComplete=true
    value.preparedBootstrap=JSON.stringify(record)
    value.preparedInputs=await preparationInputs(path)
    value.preparationMs=Date.now()-started
    value.preparedHead=value.preparedStamp=await this.sourceStamp(root)
    this.save(value)
    return value
  }
  private async ensurePrepared(value:Workspace,path:string,steps:BootstrapStep[],root:string):Promise<Workspace> {
    if(!value.bootstrapComplete||value.preparedInputs!==await preparationInputs(path))return await this.runPreparation(value,path,steps,root)
    const gap=preparationGap(value.preparedBootstrap,steps)
    return gap.length?await this.runPreparation(value,path,steps,root,gap):value
  }

  private async workspacePath(root:string,runID:string,channel?:string):Promise<string> { return boundedWorktreePath(await declaredWorktreeHome(root),runID,channel) }
  private checkoutName(value:Workspace):string {
    if(value.checkoutLeaf)return join(value.namingVersion===3?value.channel??'':'',value.checkoutLeaf)
    if(value.namingVersion===3)return join(value.channel??"",value.checkoutRunID??value.claimedRunID??value.runID)
    return value.namingVersion===2 ? (value.checkoutRunID??value.claimedRunID??value.runID) : "quest-" + (value.physicalRunID ?? value.runID)
  }
  private candidatePaths(root:string,name:string):Promise<string[]> { return driveAsync(this.candidatePathSteps(root,name)) }
  private *candidatePathSteps(root:string,name:string):GitSteps<string[]> {
    return (yield* this.candidateHomeSteps(root)).map(home=>resolve(home,name))
  }
  private *candidateHomeSteps(root:string):GitSteps<string[]> {
    const physical=resolve(root),configured=worktreeRoot()
    return [...new Set([resolve(yield* worktreeHomeSteps(root)),...(configured?[configured]:[]),resolve(root,".claude","worktrees"),join(dirname(physical),basename(physical)+".worktrees")])]
  }

  async createShared(input:{runID:string;questID:string;directory:string;project?:ProjectIdentity;files?:string[];inheritRunIDs?:string[];store:QuestStore}):Promise<Workspace> {
    if(isV2Channel(process.env.OPENCODE_RELEASE_CHANNEL))throw new Error("V2 sessions use an isolated ledger and must use isolated worktrees; shared checkout writes could bypass main ownership")
    const lock=acquireRunLock(this.runtime,"workspace-"+input.runID,{quest:input.questID,run:input.runID},{timeoutMs:0})
    try {
      const {project,source}=await driveAsync(sourceCheckoutSteps(input.directory,input.project)),prior=this.get(input.runID)
      if(prior){if(prior.mode!=="shared"||prior.questID!==input.questID||prior.projectID!==project.id||prior.sharedReleased||physicalDirectory(prior.source??prior.root)!==source)throw new Error("Existing workspace assignment must be reconciled");await this.verify(prior);return prior}
      for(const runID of input.inheritRunIDs??[]){
        const source=this.get(runID);if(!source||source.projectID!==project.id||source.questID!==input.questID)throw new Error("Dependency workspace ownership is unavailable")
        if(source.mode==="research")continue
        if(source.mode==="shared"){if(physicalDirectory(source.path)!==physicalDirectory(input.directory))throw new Error("Shared dependency belongs to another checkout; integrate it first");continue}
        if(source.removed){if(!source.integration)throw new Error("Dependency integration is unverified");if(await gitStatus(input.directory,["merge-base","--is-ancestor",source.integration.workerHead,"HEAD"])!==0)throw new Error("Shared checkout does not contain the dependency commit");continue}
        await this.verify(source)
        if((await git(source.path,["status","--porcelain","--untracked-files=all"])).trim())throw new Error("Integrate isolated dependency changes before running shared")
        if(await gitStatus(input.directory,["merge-base","--is-ancestor",(await git(source.path,["rev-parse","HEAD"])).trim(),"HEAD"])!==0)throw new Error("Integrate isolated dependency commits before running shared")
      }
      const join=(await coordinationAsync(input.store,{directory:source,sessionID:"quest-run:"+input.runID,host:"opencode"}))({action:"join",title:"Quest "+input.questID,questID:input.questID,scopes:input.files??["."],activity:"Shared worker assignment"})
      if(!join.acquired)throw new Error("Shared workspace file conflict; runtime could not acquire the assigned scope: "+JSON.stringify((join as any).conflicts.map((x:any)=>({title:x.title,scopes:x.scopes}))))
      try {
        const fileScopes=join.participants.find(x=>x.id===join.participantID)!.scopes
        const base=(await git(source,["rev-parse","HEAD"])).trim(),branch=(await git(source,["symbolic-ref","--short","HEAD"])).trim()
        const value:Workspace={version:1,mode:"shared",runID:input.runID,questID:input.questID,projectID:project.id,root:project.root,source,path:source,base,branch,fileScopes,bootstrapComplete:true,comparisonTree:await this.applySnapshot(source,base,undefined,fileScopes)}
        this.save(value);return value
      }catch(error){(await coordinationAsync(input.store,{directory:source,sessionID:"quest-run:"+input.runID,host:"opencode"}))({action:"release",activity:"Known prelaunch failure"});throw error}
    }finally{lock.release()}
  }
  async releaseShared(runID:string,store:QuestStore,reason:string) {
    const value=this.get(runID);if(value?.mode!=="shared"||value.sharedReleased)return
    await this.collect(runID)
    await this.releaseCollected(runID,store,reason)
  }
  async releaseCollected(runID:string,store:QuestStore,reason:string) {
    const value=this.get(runID);if(value?.mode!=="shared"||value.sharedReleased)return
    ;(await coordinationAsync(store,{directory:value.path,sessionID:"quest-run:"+runID,host:"opencode"}))({action:"release",activity:reason})
    value.changes=this.get(runID)?.changes;value.sharedReleased=true;this.save(value)
  }

  private async sourceStamp(root:string) {
    return (await git(root,["rev-parse","HEAD"])).trim()
  }
  private allocations(projectID:string) {
    const directory=join(this.runtime,"workspaces")
    return existsSync(directory)?readdirSync(directory).filter(x=>x.endsWith(".json")).flatMap(x=>{const value=readJsonRecord<Workspace>(join(directory,x));return value?[value]:[]}).filter(x=>x.allocationVersion===2&&x.projectID===projectID&&!x.physicalRunID&&!x.continuationOf&&!x.removed&&(!x.claimedRunID||!this.get(x.claimedRunID)?.removed)).length:0
  }
  preparationStatus(projectID:string) {
    const file=join(this.runtime,"preparation-status-"+projectID+".json")
    const last=readJsonRecord(file)
    const spares=this.readPool(projectID).flatMap(id=>{const value=this.get(id);return value&&!value.claimedRunID&&!value.removed?[{runID:id,base:value.preparedHead,bootstrapComplete:!!value.bootstrapComplete,freshness:"rechecked at assignment"}]:[]})
    return {last,spare:spares[0]??null,spares,retainedNewAllocations:this.allocations(projectID),spareTarget:this.spareTarget(projectID)}
  }
  private poolFile(projectID:string) { return join(this.runtime,"prepared-"+projectID+".json") }
  private readPool(projectID:string): string[] {
    const path=this.poolFile(projectID)
    const value=readJsonRecord(path)
    if(!value)return []
    return Array.isArray(value?.runIDs)?value.runIDs.filter((id:unknown):id is string=>typeof id==="string"):typeof value?.runID==="string"?[value.runID]:[]
  }
  private writePool(projectID:string,runIDs:string[]) {
    if(runIDs.length)writeFileDurable(this.poolFile(projectID),JSON.stringify({runIDs}))
    else if(existsSync(this.poolFile(projectID)))unlinkSync(this.poolFile(projectID))
  }
  private demandFile(projectID:string) { return join(this.runtime,"spare-demand-"+projectID+".json") }
  spareTarget(projectID:string):number {
    try{const peak=JSON.parse(readFileSync(this.demandFile(projectID),"utf8")).peak;return Number.isSafeInteger(peak)&&peak>1?peak:1}catch{return 1}
  }
  noteDemand(projectID:string,concurrent:number) {
    if(concurrent>this.spareTarget(projectID)){mkdirSync(this.runtime,{recursive:true});writeFileDurable(this.demandFile(projectID),JSON.stringify({peak:concurrent,at:new Date().toISOString()}))}
  }
  private async reconcileMissingPrepared(project:{id:string;root:string},runID:string) {
    if(!/^warm-[a-f0-9]{10}$/.test(runID))return false
    const channel=currentChannel()
    const expected=(await Promise.all([runID,"quest-"+runID,...(channel?[join(channel,runID)]:[])].map(name=>this.candidatePaths(project.root,name)))).flat()
    for(const path of expected){try{lstatSync(path);return false}catch(error:any){if(error?.code!=="ENOENT")return false}}
    const registered=new Set((await git(project.root,["worktree","list","--porcelain","-z"])).split("\0")
      .filter(field=>field.startsWith("worktree ")).map(field=>pathKey(field.slice(9))))
    return !expected.some(path=>registered.has(pathKey(path)))
  }
  private async untouched(value:Workspace,root:string) {
    if(physicalDirectory(value.source??value.root)!==physicalDirectory(root))return false
    await this.verify(value)
    if(value.comparisonTree&&value.comparisonTree!==value.base)return (await git(value.path,["rev-parse","HEAD"])).trim()===value.base && !(await git(value.path,["diff","--name-only",value.comparisonTree,"--"])).trim() && !(await git(value.path,["ls-files","--others","--exclude-standard"])).trim()
    const status=(await git(value.path,["status","--porcelain=v2","-z","--branch","--untracked-files=all"])).split("\0").filter(Boolean)
    return status.includes("# branch.oid "+value.base) && status.every(line=>line.startsWith("# "))
  }
  private async current(value:Workspace,root:string,bootstrap:BootstrapStep[],known?:string) {
    const head=known??await this.sourceStamp(root)
    return !!value.bootstrapComplete && value.base===head && value.preparedHead===head && value.preparedBootstrap===JSON.stringify(bootstrap) && value.preparedStamp===head
  }
  private async refresh(value:Workspace,root:string,steps:BootstrapStep[],timeline:StepTiming[]=[],known?:string):Promise<Workspace> {
    const head=known??await this.sourceStamp(root)
    if(value.base!==head){const start=Date.now();await git(value.path,["reset","--quiet","--hard",head]);value.base=head;this.save(value);timeline.push({stage:"move checkout to "+head.slice(0,12),start,end:Date.now()})}
    return await this.runPreparation(value,value.path,steps,root,steps,timeline)
  }

  async prepare(input:{directory:string;bootstrap?:BootstrapDeclaration}) {
    const {project,source}=await driveAsync(sourceCheckoutSteps(input.directory))
    let steps:BootstrapStep[]
    try{steps=await workspaceBootstrap(source,input.bootstrap)}catch(error){return {state:"unconfigured",reason:String(error)}}
    if(source!==physicalDirectory(project.root))return {state:"unsupported",reason:"Prepared reuse is disabled for selected linked checkouts; allocation snapshots that exact checkout on demand"}
    let refill;try{refill=acquireLock(this.runtime,"prepared-refill-"+project.id,{timeoutMs:0})}catch{return {state:"busy"}}
    try {
      if((await git(project.root,["ls-files","--unmerged"])).trim())return {state:"conflict",reason:"Resolve coordinator conflicts before preparing a snapshot"}
      const target=this.spareTarget(project.id),head=(await git(project.root,["rev-parse","HEAD"])).trim()
      let work:{kind:"finish"|"refresh";value:Workspace;lock:ReturnType<typeof acquireLock>}|undefined,runID:string|undefined
      const ready:string[]=[]
      const pool=acquireLock(this.runtime,"prepared-"+project.id,{timeoutMs:5000})
      try {
        const kept:string[]=[]
        for(const id of this.readPool(project.id)){
          const value=this.get(id)
          if(!value){if(!await this.reconcileMissingPrepared(project,id))return {state:"unknown",reason:"Interrupted allocation retained; inspect before another preparation"};continue}
          if(value.claimedRunID||value.removed||!existsSync(value.path))continue
          kept.push(id)
          if(value.bootstrapComplete&&await this.current(value,project.root,steps,head)){ready.push(id);continue}
          if(work)continue
          let lock;try{lock=acquireLock(this.runtime,"workspace-"+id,{...runLockOptions(this.runtime),timeoutMs:0})}catch{continue}
          if(!value.bootstrapComplete&&value.preparationFailed&&value.base===head&&value.preparationAttempt===JSON.stringify(steps)){lock.release();this.writePool(project.id,kept);return {state:"failed",runID:id,reason:"Previous bootstrap failed; repair its inputs before retrying: "+value.preparationFailed}}
          try{if(existsSync(value.path)&&!await this.untouched(value,project.root)){lock.release();this.writePool(project.id,kept);return {state:"preserved",runID:id,reason:"Unassigned spare was modified; preserving it for inspection"}}}catch(error){lock.release();throw error}
          work={kind:value.bootstrapComplete?"refresh":"finish",value,lock}
        }
        if(!work&&kept.length<target){
          runID="warm-"+crypto.randomUUID().replaceAll("-","").slice(0,10)
          kept.push(runID)
        }
        this.writePool(project.id,kept)
      } finally {pool.release()}
      if(work){
        try{await this.refresh(work.value,project.root,steps)}finally{work.lock.release()}
        return {state:await this.current(this.get(work.value.runID)!,project.root,steps)?"ready":"stale",runID:work.value.runID,worked:true,spares:ready.length+1,target}
      }
      if(!runID)return {state:"ready",runID:ready[0],worked:false,spares:ready.length,target}
      const started=Date.now()
      let value:Workspace
      try {value=await this.create({runID,questID:"__prepared__",directory:project.root,skipPrepared:true,bootstrap:steps})}
      catch(error){
        const path=await this.workspacePath(project.root,runID,currentChannel())
        if(!this.get(runID)&&!existsSync(path)){const pool=acquireLock(this.runtime,"prepared-"+project.id,{timeoutMs:5000});try{this.writePool(project.id,this.readPool(project.id).filter(id=>id!==runID))}finally{pool.release()}}
        throw error
      }
      let finalizing:ReturnType<typeof acquireLock>|undefined
      try{finalizing=acquireLock(this.runtime,"workspace-"+runID,{...runLockOptions(this.runtime),timeoutMs:0})}catch(error){if(!(error instanceof LockBusyError))throw error}
      if(finalizing)try{
        value=this.get(runID)!
        if(!value.claimedRunID&&!value.removed){value.preparationMs=Date.now()-started;this.save(value)}
      }finally{finalizing.release()}
      else value=this.get(runID)!
      if(value.claimedRunID||value.removed)return {state:"ready",runID,worked:true,spares:ready.length,target}
      if(!await this.current(value,project.root,steps))return {state:"stale",runID,worked:true,spares:ready.length,target}
      return {state:"ready",runID,milliseconds:value.preparationMs,worked:true,spares:ready.length+1,target}
    } finally {refill.release()}
  }
  async replenish(input:{directory:string;bootstrap?:BootstrapDeclaration}) {
    for(;;){
      const state=await this.prepare(input) as {state:string;worked?:boolean}
      if(state.state!=="ready"||!state.worked)return state
    }
  }
  private async takePrepared(input:{runID:string;questID:string},project:{id:string;root:string},steps:BootstrapStep[],timeline:StepTiming[]=[]):Promise<Workspace|undefined> {
    const start=Date.now()
    let pool;try{pool=acquireLock(this.runtime,"prepared-"+project.id,{timeoutMs:5000})}catch{return undefined}
    let spare:Workspace|undefined,held:ReturnType<typeof acquireLock>|undefined,head=""
    let path=await this.workspacePath(project.root,input.runID),branch="quest/"+input.runID
    try {
      const ids=this.readPool(project.id)
      const candidates=ids.map(id=>this.get(id)).filter((value):value is Workspace=>!!value&&!value.claimedRunID&&!value.removed&&!!value.bootstrapComplete)
      head=await this.sourceStamp(project.root)
      const ready=new Set<Workspace>()
      for(const value of candidates)if(await this.current(value,project.root,steps,head))ready.add(value)
      candidates.sort((a,b)=>Number(ready.has(b))-Number(ready.has(a)))
      for(const value of candidates){
        let lock;try{lock=acquireLock(this.runtime,"workspace-"+value.runID,{...runLockOptions(this.runtime),timeoutMs:0})}catch{continue}
        let usable=false;try{usable=await this.untouched(value,project.root)}catch{}
        if(usable){spare=value;held=lock;break}
        lock.release()
      }
      if(!spare)return undefined
      path=await this.workspacePath(project.root,input.runID,spare.channel)
      if(existsSync(path)){held!.release();throw new Error("Prepared assignment path already exists without ownership")}
      spare.claimedRunID=input.runID;this.save(spare)
      timeline.push({stage:"check prepared spare "+spare.runID,start,end:Date.now()})
      const moving=Date.now()
      try{
        const unlocked=await unlockQuestWorktree(project.root,spare.path)
        try{await moveLinkedWorktree(project.root,spare.path,path)}catch(error){if(unlocked)await lockWorktree(project.root,spare.path,spare.runID,spare.channel);throw error}
        await lockWorktree(project.root,path,input.runID,spare.channel)
        timeline.push({stage:"move prepared spare",start:moving,end:Date.now()})
      }
      catch(error){
        console.error("[quest-workspaces] prepared spare "+spare.runID+" could not be moved: "+(error instanceof Error?error.message:String(error)))
        spare.claimedRunID=undefined;this.save(spare);held!.release();return undefined
      }
      this.writePool(project.id,ids.filter(id=>id!==spare!.runID))
    } finally {pool.release()}
    try {
      const naming=Date.now()
      await git(path,["branch","-m",branch])
      spare.path=path;spare.checkoutLeaf=basename(path);spare.branch=branch;spare.namingVersion=spare.channel?3:2
      const assigned:Workspace={...spare,runID:input.runID,questID:input.questID,physicalRunID:spare.runID,claimedRunID:undefined,preparationTimeline:undefined}
      timeline.push({stage:"name branch "+branch,start:naming,end:Date.now()})
      this.savePreparedAssignment(spare,assigned)
      if(await this.current(assigned,project.root,steps,head)){assigned.preparationTimeline=timeline;this.save(assigned)}
      else await this.refresh(assigned,project.root,steps,timeline,head)
      const value=this.get(input.runID)!
      const verifying=Date.now()
      await this.verify(value)
      value.preparationTimeline=[...(value.preparationTimeline??timeline),{stage:"verify assigned checkout",start:verifying,end:Date.now()}]
      this.save(value);return value
    } finally {held!.release()}
  }
  async assertSourceProject(value:Workspace) {
    await driveAsync(sourceCheckoutSteps(value.source??value.root,{id:value.projectID,root:value.root}))
  }
  *assertSourceProjectSteps(value:Workspace):GitSteps<void> {
    yield* sourceCheckoutSteps(value.source??value.root,{id:value.projectID,root:value.root})
  }

  private async applySnapshot(source: string, base: string, target?: string, scopes:string[]=["."]) {
    const index = join(this.runtime, "snapshot-" + process.pid + "-" + crypto.randomUUID() + ".index")
    const run = async (args: string[], input?: string) => {
      const out = await gitFed(source, args, { input, env: { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" }, maxBuffer: 32 * 1024 * 1024 })
      if (out.status !== 0) throw new Error("Dependency snapshot failed: " + (out.stderr || out.error?.message))
      return out.stdout.trim()
    }
    const head=(await git(source,["rev-parse","HEAD"])).trim()
    const excluded=await worktreeExclusions(source)
    const selectedFiles=()=>git(source,["ls-files","--cached","--with-tree="+head,"--others","--exclude-standard","-z","--",...scopes.map(scope=>":(literal)"+scope),":(exclude,glob)**/.claude/worktrees/**",...excluded])
    const paths=await selectedFiles()
    const tracked=new Set((await git(source,["ls-files","--cached","--with-tree="+head,"-z"])).split("\0").filter(Boolean))
    const names=paths.split("\0").filter(Boolean)
    const trackedPaths=names.filter(name=>tracked.has(name)).map(name=>name+"\0").join("")
    const newPaths=names.filter(name=>!tracked.has(name)).map(name=>name+"\0").join("")
    const stage=async()=>{
      if(trackedPaths)await run(["add","-A","--force","--pathspec-from-file=-","--pathspec-file-nul"],trackedPaths)
      if(newPaths)await run(["add","-A","--pathspec-from-file=-","--pathspec-file-nul"],newPaths)
    }
    try {
      await run(["read-tree", head])
      await stage()
      const tree=await run(["write-tree"])
      await run(["read-tree", head])
      await stage()
      const changed=await selectedFiles()!==paths?"file list":await run(["write-tree"])!==tree?"content":(await git(source,["rev-parse","HEAD"])).trim()!==head?"HEAD":JSON.stringify(await worktreeExclusions(source))!==JSON.stringify(excluded)?"worktree registration":undefined
      if(changed)throw new Error("Source changed during workspace snapshot ("+changed+"); retry after edits settle")
      if(!target)return tree
      if((await git(target,["log","--format=%T","HEAD"])).split(/\r?\n/).includes(tree))return tree
      const diff = await gitFed(source, ["diff", "--binary", "--full-index", base, tree, "--"], { binary: true, maxBuffer: 32 * 1024 * 1024 })
      if (diff.status !== 0) throw new Error("Could not read dependency snapshot")
      if (!diff.stdout.length) return tree
      const applied = await gitFed(target, ["apply", "--3way", "--index", "--whitespace=nowarn", "-"], { input: diff.stdout, maxBuffer: 32 * 1024 * 1024 })
      if (applied.status !== 0) throw new Error("Dependency changes conflict; source and destination workspaces retained for recovery: " + applied.stderr.trim())
      return tree
    } finally { if (existsSync(index)) unlinkSync(index) }
  }
  verify(value: Workspace): Promise<void> { return driveAsync(this.verifySteps(value)) }
  *verifySteps(value: Workspace): GitSteps<void> {
    const owned = this.get(value.runID)
    if(value.continuationOf){
      const original=this.get(value.continuationOf)
      if(!owned||owned.continuationOf!==value.continuationOf||!original||original.continuationOf||original.removed||original.questID!==value.questID||original.projectID!==value.projectID||original.path!==value.path||original.branch!==value.branch||owned.path!==value.path)throw Error('Original continuation workspace binding changed')
      yield* this.verifySteps(original);return
    }
    if(value.mode==="research"){if(!owned||owned.mode!=="research"||owned.questID!==value.questID||owned.path!==value.path||physicalDirectory(value.path)!==physicalDirectory(value.source??value.root)||(yield* projectIdentitySteps(value.path)).id!==value.projectID)throw new Error("Research directory binding changed");return}
    if(value.mode==="shared"){if(!owned||owned.mode!=="shared"||owned.path!==value.path||owned.questID!==value.questID||physicalDirectory(value.path)!==physicalDirectory(value.source??value.root)||(yield* projectIdentitySteps(value.path)).id!==value.projectID||(yield* gitOut(value.path,["symbolic-ref","--short","HEAD"])).trim()!==value.branch)throw new Error("Shared checkout ownership or branch changed");return}
    const [candidates, listing, identity, head] = yield* together(attempt(this.candidatePathSteps(value.root, this.checkoutName(value))), attempt(gitOut(value.root, ["worktree","list","--porcelain","-z"])),
      attempt(projectIdentitySteps(value.path)), attempt(gitOut(value.path, ["symbolic-ref", "--short", "HEAD"])))
    const expected = taken(candidates)
    const registered = new Set(taken(listing).split("\0")
      .filter(field=>field.startsWith("worktree ")).map(field=>pathKey(field.slice(9))))
    if (!owned || owned.namingVersion !== value.namingVersion || owned.branch !== value.branch || owned.physicalRunID !== value.physicalRunID || owned.claimedRunID !== value.claimedRunID || owned.path !== value.path || owned.questID !== value.questID || !expected.some(path=>pathKey(path)===pathKey(value.path)) || !registered.has(pathKey(value.path))) throw new Error("Workspace ownership or path mismatch")
    if (value.physicalRunID && this.get(value.physicalRunID)?.claimedRunID !== value.runID) throw new Error("Prepared workspace assignment mismatch")
    if (taken(identity).id !== value.projectID) throw new Error("Worker workspace belongs to a different project")
    if (taken(head).trim() !== value.branch) throw new Error("Worker branch changed; preserving workspace for inspection")
  }
  collect(runID: string): Promise<Workspace> { return driveAsync(this.collectSteps(runID)) }
  *collectSteps(runID: string): GitSteps<Workspace> {
    const value = this.get(runID)
    if (!value) throw new Error("Unknown owned workspace")
    if(value.mode==="shared"&&value.sharedReleased)return value
    if(value.mode==="research"){yield* this.verifySteps(value);value.changes={available:true,files:[],commits:[],at:new Date().toISOString()};this.save(value);return value}
    const scopes=value.mode==="shared"?value.fileScopes??["."]:["."]
    const at = new Date().toISOString()
    if (!existsSync(value.path) || value.removed) {
      value.changes = { available: false, files: value.changes?.files ?? [], commits: value.changes?.commits ?? [], at, error: "Workspace unavailable; showing retained change records" }
      this.save(value); return value
    }
    const [verified, numstat, others, commits] = yield* together(attempt(this.verifySteps(value)), attempt(gitOut(value.path, ["diff", "--numstat", "--no-renames", "-z", value.comparisonTree??value.base, "--",...scopes])),
      attempt(gitOut(value.path, ["ls-files", "--others", "--exclude-standard", "-z","--",...scopes])), attempt(value.mode==="shared"?noCommits():gitOut(value.path, ["rev-list", value.base + "..HEAD"])))
    taken(verified)
    const files: Changes["files"] = taken(numstat).split("\0").filter(Boolean).map(row => {
      const first = row.indexOf("\t"), second = row.indexOf("\t", first + 1)
      const a = row.slice(0, first), d = row.slice(first + 1, second)
      return { path: row.slice(second + 1), additions: a === "-" ? null : Number(a), deletions: d === "-" ? null : Number(d), untracked: false }
    })
    for (const name of taken(others).split("\0").filter(Boolean)) {
      const path = join(value.path, name)
      let count: number | null = null
      try { if (inside(realpathSync(value.path), realpathSync(path))) {
        const data = readFileSync(path)
        if (!data.includes(0)) count = data.length ? data.toString("utf8").split("\n").length - (data.at(-1) === 10 ? 1 : 0) : 0
      }
      } catch {}
      files.push({ path: name, additions: count, deletions: 0, untracked: true })
    }
    value.changes = { available: true, files, commits: taken(commits).trim().split("\n").filter(Boolean), at }
    this.save(value); return value
  }
  land(runID: string, describe: LandDescribe): Promise<Landing | undefined> {
    const value = this.get(runID), target = value ? pathKey(value.source ?? value.root) : runID
    const landing = (landingQueues.get(target) ?? Promise.resolve()).then(() => driveAsync(this.landSteps(runID, describe)))
    const settled = landing.then(() => {}, () => {})
    landingQueues.set(target, settled)
    void settled.then(() => { if (landingQueues.get(target) === settled) landingQueues.delete(target) })
    return landing
  }
  deliveryPolicy(value: Workspace): Promise<ResolvedDelivery> {
    return driveAsync(this.deliveryPolicySteps(value))
  }
  *deliveryPolicySteps(value: Workspace): GitSteps<ResolvedDelivery> {
    return (yield* resolveDeliveryPolicySteps(value.root, { source: value.source ?? value.root })) as ResolvedDelivery
  }
  *landSteps(runID: string, describe: LandDescribe): GitSteps<Landing | undefined> {
    const start = spanNow()
    let outcome = 'skipped', route: string | undefined, failure: string | undefined
    try {
    const owned = this.get(runID)
    if (!owned || owned.mode === "research" || owned.mode === "shared" || owned.removed) return
    let resolved: ResolvedDelivery | Error
    try { resolved = yield* this.deliveryPolicySteps(owned) } catch (error) { resolved = error instanceof Error ? error : new Error(String(error)) }
    if (!(resolved instanceof Error)) route = [resolved.policy.remote, resolved.policy.into].filter(Boolean).join('/')
    const landing = yield* this.landOnce(runID, describe, resolved)
    outcome = landing?.state ?? 'skipped'
    const value = this.get(runID)
    if (!landing || !value || !existsSync(value.path)) return landing
    const policy: DeliveryPolicy | undefined = resolved instanceof Error ? undefined : resolved.policy
    const [head, ref] = yield* together(gitRun(value.path, ["rev-parse", "HEAD"], 60000), policy ? gitRun(value.path, ["rev-parse", "-q", "--verify", remoteRef(policy) + "^{commit}"], 60000) : unread())
    return { ...landing, workerHead: head.status === 0 ? head.stdout.trim() : landing.workerHead, intoHead: ref?.status === 0 ? ref.stdout.trim() : landing.intoHead }
    } catch (error) { outcome = 'failed'; failure = error instanceof Error ? error.message : String(error); throw error }
    finally { recordSpan({ plugin: 'quests', name: 'landing', op: runID, route, start, end: spanNow(), outcome, ...(failure ? { error: failure } : {}) }) }
  }
  *saveLeftovers(value: Workspace, title: string): GitSteps<string | undefined> {
    yield* gitOut(value.path, ["add", "--all"])
    if ((yield* gitRun(value.path, ["diff", "--cached", "--quiet"])).status === 0) return this.get(value.runID)?.leftovers
    yield* gitOut(value.path, ["commit", "--quiet", "-m", title])
    const sha = (yield* gitOut(value.path, ["rev-parse", "HEAD"])).trim()
    yield* this.collectSteps(value.runID)
    const saved = this.get(value.runID)!
    saved.leftovers = sha
    this.save(saved)
    return sha
  }
  private *landOnce(runID: string, describe: LandDescribe, resolved: ResolvedDelivery | Error): GitSteps<Landing | undefined> {
    const value = this.get(runID)
    if (!value || value.mode === "research" || value.mode === "shared" || value.removed) return
    const into = value.source ?? value.root
    const at = new Date().toISOString()
    const blocked = (reason: string): Landing => ({ state: "blocked", into, branch: value.branch, reason, at })
    const run = (cwd: string, args: string[]) => gitRun(cwd, args, 60000)
    let lock, queue: (() => void) | undefined
    try { lock = acquireLock(this.runtime, "workspace-" + this.lockID(runID), { ...runLockOptions(this.runtime),timeoutMs: 0 }) } catch { return blocked("Its workspace is busy; land it once the worker's tools finish") }
    try {
      const leftovers = yield* this.saveLeftovers(value, describe.title?.trim() || value.branch)
      if (leftovers) return blocked("The worker left uncommitted files; saved as commit " + leftovers.slice(0, 12) + " on " + value.branch + ", not landed.")
      const refusal = deliveryRefusal({ questID: value.questID, delivery: describe.delivery, gate: "land" })
      if (refusal) return blocked(refusal)
      if (resolved instanceof Error) return blocked(resolved.message)
      const handedToProjectLander = usesRepositoryLander(value.root, resolved.policy)
      if (!handedToProjectLander) {
        queue = tryQueueLock((yield* gitOut(into, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim())
        if (!queue) return blocked("Waiting in the landing queue: another landing into " + into + " is running; this one lands when it finishes")
      }
      if (resolved.policy.landed === "remote") {
        yield* this.verifySteps(value)
        return yield* landRemoteSteps({ path: value.path, root: value.root, branch: value.branch, base: value.base, policy: resolved.policy, source: resolved.source, title: describe.title?.trim() || value.branch, body: describe.body?.trim() || value.branch })
      }
      const read = (cwd: string, args: string[]) => attempt(gitOut(cwd, args))
      const [verified, workerRead, status, target, merging, unmerged, intoRead] = yield* together(attempt(this.verifySteps(value)), read(value.path, ["rev-parse", "HEAD"]), read(value.path, ["status", "--porcelain", "--untracked-files=all"]),
        run(into, ["symbolic-ref", "--short", "HEAD"]), run(into, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]), read(into, ["ls-files", "--unmerged"]), read(into, ["rev-parse", "HEAD"]))
      taken(verified)
      const workerHead = taken(workerRead).trim()
      const dirty = taken(status).trim()
      if (target.status !== 0) return blocked(into + " is not on a branch (detached HEAD)")
      const branch = target.stdout.trim()
      if (branch !== resolved.policy.into) return blocked(into + " is on " + branch + " but the delivery policy lands on " + resolved.policy.into)
      if (merging.status === 0 || taken(unmerged).trim()) return blocked(into + " has a merge in progress")
      const intoHead = taken(intoRead).trim()
      const landed = (method: Landing["method"], head: string): Landing => ({ state: "landed", into, branch, method, head, workerBranch: value.branch, workerHead, at })
      const [contained, ahead] = yield* together(run(into, ["merge-base", "--is-ancestor", workerHead, intoHead]), run(into, ["merge-base", "--is-ancestor", intoHead, workerHead]))
      if (contained.status === 0) {
        if (dirty && ((yield* run(value.path, ["diff", "--quiet", intoHead, "--"])).status !== 0 || (yield* gitOut(value.path, ["ls-files", "--others", "--exclude-standard"])).trim()))
          return blocked("The worker left uncommitted changes in " + value.path + "; nothing was landed")
        return workerHead === value.base && !dirty ? undefined : landed("already", intoHead)
      }
      if (dirty) return blocked("The worker left uncommitted changes in " + value.path + " beside its commits on " + value.branch + "; nothing was landed")
      const refused = (result: GitResult) => blocked("Git refused to land " + value.branch + " into " + branch + ": " + (result.stderr || result.stdout || "unknown error").trim().split(/\r?\n/).slice(0, 4).join(" "))
      const check = landingCheck(value.path)
      let tested: Landing["check"]
      for (let base = intoHead, tip = workerHead, known: GitResult | undefined = ahead; ;) {
        const fastForward = known ?? (yield* run(into, ["merge-base", "--is-ancestor", base, tip]))
        known = undefined
        if (fastForward.status === 0) {
          const forward = yield* run(into, ["merge", "--ff-only", tip])
          if (forward.status === 0) return tip === workerHead ? landed("fast-forward", tip) : { ...landed("merge", tip), ...(tested ? { check: tested } : {}) }
          const moved = (yield* gitOut(into, ["rev-parse", "HEAD"])).trim()
          if (moved === base) return refused(forward)
          base = moved
          continue
        }
        const probe = yield* run(into, ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, tip])
        if (probe.status !== 0) { const files = probe.stdout.split(/\r?\n/).slice(1).filter(Boolean); return { ...blocked(conflictReason(branch, files)), conflict: files } }
        if (!check) {
          const merged = yield* run(into, ["merge", "--no-ff", "--no-edit", "-m", "Land " + value.branch, tip])
          return merged.status === 0 ? { ...landed("merge", (yield* gitOut(into, ["rev-parse", "HEAD"])).trim()), check: { command: null } } : refused(merged)
        }
        const merge = yield* run(value.path, ["merge", "--no-ff", "--no-edit", "-m", "Merge " + branch + " into " + value.branch, base])
        if (merge.status !== 0) { yield* run(value.path, ["merge", "--abort"]); return refused(merge) }
        const combined = (yield* gitOut(value.path, ["rev-parse", "HEAD"])).trim(), command = check.argv.join(" ")
        const result = yield* commandRun(bootstrapWorkspacePath(value.path, check), check.argv, bootstrapStepTimeout(check), check.shell)
        if (result.status !== 0) {
          const why = result.timedOut ? "timed out after " + bootstrapStepTimeout(check) / 1000 + " s" : result.error ? result.error.message : (result.stderr + "\n" + result.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ")
          return blocked(value.branch + " merges cleanly with " + branch + ", but `" + command + "` fails on the combined tree (" + why + "); the merge " + combined.slice(0, 12) + " stays on " + value.branch + " and nothing was landed")
        }
        tested = { command, passed: true }
        tip = combined
      }
    } catch (error) { return blocked(error instanceof Error ? error.message : String(error)) }
    finally { queue?.(); lock.release() }
  }
  byQuest(runIDs?:Iterable<string>):Map<string,Workspace[]> {
    const dir=join(this.runtime,"workspaces"),groups=new Map<string,Workspace[]>()
    const ids=runIDs?new Set(runIDs):existsSync(dir)?this.runIDs():[]
    for(const id of ids){if(!isSafeReference(id))continue;const held=this.peek(id);if(held){const w={...held} as Workspace;(groups.get(w.questID)??groups.set(w.questID,[]).get(w.questID)!).push(w)}}
    return groups
  }
  retain(runID:string,reason:string,known?:Workspace) {
    const same=(w?:Workspace)=>w?.cleanup?.removed===false&&w.cleanup.reason===reason
    if(known?.runID===runID&&same(known))return known.cleanup!
    const value=this.get(runID);if(!value)throw Error("Unknown workspace")
    if(same(value))return value.cleanup!
    value.cleanup={removed:false,reason,at:new Date().toISOString()};this.save(value);return value.cleanup
  }
  async cleanup(runID: string, beforeRemove:()=>void, preserveTo?:string): Promise<{ removed: boolean; reason: string }> {
    this.file(runID)
    let lock;try{lock=acquireLock(this.runtime,"workspace-"+this.lockID(runID),{...runLockOptions(this.runtime),timeoutMs:0})}catch{return {removed:false,reason:"Workspace tool or cleanup is still running"}}
    try {
      const value=this.get(runID)
      if(!value)throw Error("Unknown workspace")
      if(value.removed)return {removed:true,reason:"Already removed; retained records available"}
      if(value.continuationOf&&this.get(value.continuationOf)?.removed){value.removed=true;value.cleanup={removed:true,reason:'Original worktree already retired; continuation records retained',at:new Date().toISOString()};this.save(value);return value.cleanup}
      if(value.mode==="shared"||value.mode==="research")return this.retain(runID,"Original checkout is never removed")
      if(preserveTo&&!existsSync(value.path)){
        let listed=false
        try{listed=(await git(value.root,["worktree","list","--porcelain","-z"])).split("\0").some(field=>field.startsWith("worktree ")&&pathKey(field.slice(9))===pathKey(value.path))}catch{}
        if(!listed){value.removed=true;value.cleanup={removed:true,reason:"The checkout no longer exists; nothing was left to retire",at:new Date().toISOString()};this.save(value);return value.cleanup}
      }
      Object.assign(value,await this.collect(runID));await this.verify(value);beforeRemove()
      const into=value.source&&existsSync(value.source)?value.source:value.root
      let ref:string|undefined,integrationRoot=value.root,policy:DeliveryPolicy|undefined
      try{policy=(await this.deliveryPolicy(value)).policy;ref=remoteRef(policy);if(policy.landed==="local")integrationRoot=into}catch(error){if(!preserveTo)throw error}
      if(policy&&!policy.retire)return this.retain(runID,"The delivery policy keeps worker checkouts and their branches (retire is false)",value)
      const unlocked=await unlockQuestWorktree(value.root,value.path)
      let result:ReturnType<typeof removeIntegratedWorktree>|undefined
      try{result=await removeIntegratedWorktree({root:value.root,path:value.path,ref,integrationRoot,branch:value.branch,beforeRemove,cherry:true,owner:{runtime:this.runtime,runID},
        ...(preserveTo?{preserve:(target?:string)=>preserveWorktree({path:value.path,runID:value.continuationOf??runID,target,base:value.base,destination:preserveTo})}:{})})}
      finally{if(!result?.removed&&unlocked&&existsSync(value.path))await lockWorktree(value.root,value.path,value.continuationOf??runID,value.channel)}
      const kept=!!(result.preserved?.ref||result.preserved?.patches?.length)
      if(result.removed&&policy&&ref&&!kept){
        try{const retired=await retire({root:value.root,path:value.path,branch:value.branch,head:result.workerHead,landedRef:ref,remote:policy.remote,deleteRemoteBranch:policy.landed==="remote",requireOwnCommit:false});if(!retired.retired)result.reason+="; its branch was kept: "+retired.reason}
        catch(error){result.reason+="; its branch was kept: "+(error instanceof Error?error.message:String(error))}
      }
      if(result.removed){value.removed=true;if(!kept&&result.projectHead)value.integration={workerHead:result.workerHead!,projectHead:result.projectHead!,verifiedAt:new Date().toISOString(),method:"ancestor"};if(value.continuationOf){const original=this.get(value.continuationOf)!;original.removed=true;original.integration=value.integration;original.cleanup={...result,at:new Date().toISOString()};this.save(original)}}
      value.cleanup={...result,at:new Date().toISOString()};this.save(value);return result
    }catch(error){return this.retain(runID,error instanceof Error?error.message:String(error))}
    finally {lock.release()}
  }
}
