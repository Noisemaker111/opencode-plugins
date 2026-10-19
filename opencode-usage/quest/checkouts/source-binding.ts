import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, dirname, join, basename } from 'node:path'
import { physicalDirectory, projectIdentityAsync, sourceCheckoutAsync, verifySourceBinding, type ProjectIdentity } from '../core/project'
import { driveAsync, gitRun } from '../landing/git-steps'
import type { QuestStore } from '../store'
import { QuestWorkspaces } from '../workspaces'
import { readAllQuests } from '../index'
import { readDispatchPolicy } from '../../models/dispatch-policy'
import { isV2Channel } from '../../scripts/channel-migrate.mjs'

export async function editingSource(context:{project:ProjectIdentity;directory:string},policyFile:string,files?:string[],options:{readOnly?:boolean}={}) {
  await verifySourceBinding(context,context.directory)
  try{return {...await sourceCheckoutAsync(context.directory,context.project),files}}catch(error){if(!(error instanceof Error)||error.message!=='Cannot establish selected Git checkout')throw error}
  const policy=readDispatchPolicy(policyFile)
  const binding=policy.sourceByProject?.[context.project.id]
  if(!binding){
    if(options.readOnly)return {project:context.project,source:physicalDirectory(context.directory),files}
    return {...await sourceCheckoutAsync(context.directory,context.project),files}
  }
  if(!isAbsolute(binding.directory)||!isAbsolute(binding.root)||physicalDirectory(binding.projectRoot)!==physicalDirectory(context.project.root))throw Error('Invalid configured source binding')
  let directory=binding.directory,expectedRoot=binding.root,betaRelease=false
  if(binding.loadedLatestRelease===true&&isV2Channel(process.env.OPENCODE_RELEASE_CHANNEL)){
    const generation=resolve(dirname(realpathSync.native(policyFile)),'..'),releaseRoot=resolve(generation,'..','..')
    if(basename(dirname(generation))!=='generations')throw Error('Editing v2 requires a prepared reviewed release')
    const release=JSON.parse(readFileSync(join(releaseRoot,'channel-release.json'),'utf8'))
    const source=JSON.parse(readFileSync(join(generation,'.deployment-source.json'),'utf8'))
    const head=await driveAsync(gitRun(releaseRoot,['rev-parse','HEAD'],15000))
    if(!isV2Channel(release.channel)||physicalDirectory(release.root)!==physicalDirectory(releaseRoot)||release.commit!==source.commit||head.status!==0||head.stdout.trim()!==source.commit)throw Error('Loaded v2 source identity changed; prepare a reviewed release')
    directory=physicalDirectory(releaseRoot)
    expectedRoot=directory
    betaRelease=true
  }
  const selected=await sourceCheckoutAsync(directory)
  const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b
  const pinned=betaRelease?physicalDirectory(selected.source):selected.project.root
  const expected=betaRelease?directory:resolve(expectedRoot)
  if(!same(physicalDirectory(directory),resolve(directory))||!same(pinned,expected))throw Error('Configured source checkout identity changed')
  if(!options.readOnly){
    const status=await driveAsync(gitRun(selected.source,['status','--porcelain','--untracked-files=all'],15000))
    if(status.status!==0||status.stdout.trim())throw Error('Configured source checkout must be clean; existing work was preserved')
  }
  const prefix=binding.scopePrefix
  if(typeof prefix!=='string'||!prefix||prefix.includes('..')||prefix.includes(String.fromCharCode(92))||prefix.startsWith('/'))throw Error('Invalid configured source scope prefix')
  const translated=(files??[prefix]).map(file=>{
    if(file===prefix)return '.'
    if(!file.startsWith(prefix+'/'))throw Error('Requested scope is outside the configured source binding')
    const path=file.slice(prefix.length+1)
    if(path.split('/').some(part=>part==='..'||!part)||isAbsolute(path)||path.includes(String.fromCharCode(92)))throw Error('Invalid mapped source scope')
    return path
  })
  return {...selected,files:translated,scopePrefix:prefix}
}

export async function workerLedgerProject(store:QuestStore,sessionID:string,directory:string,questID?:string):Promise<ProjectIdentity|undefined> {
  if(!questID){
    const assigned=readAllQuests(store.projectRoot,{includeArchived:true}).flatMap(row=>row.quest?.sessions.some(run=>(run.sessionID??run.openCodeSessionId)===sessionID)?[row.quest]:[])
    if(assigned.length>1)throw Error('Worker belongs to multiple Quest ledgers')
    questID=assigned[0]?.id
    if(!questID)return
  }
  const quest=store.read(questID),run=quest?.sessions.findLast(row=>(row.sessionID??row.openCodeSessionId)===sessionID)
  if(!run?.runID||quest?.project?.id===(await projectIdentityAsync(directory)).id)return
  const workspaces=new QuestWorkspaces(store.runtime),workspace=workspaces.get(run.runID)
  if(!workspace||workspace.questID!==questID||physicalDirectory(directory)!==physicalDirectory(workspace.path))throw Error('Worker ledger checkout binding changed')
  await workspaces.verify(workspace)
  return quest!.project
}
