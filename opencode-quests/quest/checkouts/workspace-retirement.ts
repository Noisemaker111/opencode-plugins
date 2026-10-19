import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {existsSync,readFileSync,mkdirSync,copyFileSync,lstatSync,realpathSync,unlinkSync} from 'node:fs'
import {readJsonRecord} from '../core/durable-file.mjs'
import {join,resolve,isAbsolute,basename,relative} from 'node:path'
import {createHash} from 'node:crypto'
import {questAssetsDir} from '../artifacts/artifacts'
import {QuestWorkspaces} from '../workspaces'
import {QuestStore} from '../store'
import {pathKey,within,git} from './cleanup-git.mjs'
import type {Quest} from '../types'

type Retirement={runtime:string;projectRoot:string;questID:string;runID:string}
export function retireWorkspace(input:Retirement):Promise<{removed:boolean;reason:string}> {
 return new Promise((resolve,reject)=>{
  const child=spawn('bun',[fileURLToPath(import.meta.url),'--quest-retirement'],{windowsHide:true,stdio:['pipe','pipe','pipe']})
  let output='',errors=''
  child.stdout.on('data',part=>{output+=part});child.stderr.on('data',part=>{errors+=part})
  child.once('error',reject)
  child.once('close',code=>{
   try{const result=JSON.parse(output);if(code!==0||result.error)throw Error(result.error||errors||'Workspace retirement failed');resolve(result.outcome)}
   catch(error){reject(new Error('Workspace retirement did not finish: '+(errors||String(error))))}
  })
  child.stdin.on('error',reject)
  child.stdin.end(JSON.stringify(input))
 })
}
if(process.argv.includes('--quest-retirement')){
 let input='';for await(const part of process.stdin)input+=part
 try{
  const request=JSON.parse(input) as Retirement,store=new QuestStore(request.projectRoot),manager=new QuestWorkspaces(request.runtime)
  const q=store.read(request.questID)
  if(!q)throw Error('Quest is unavailable; preserve its workspace')
  const outcome=await manager.cleanup(request.runID,()=>{
   const current=store.read(q.id)
   if(current?.state!=='Archived'&&!current?.delivered)throw Error('Quest reopened during cleanup')
   const workspace=manager.get(request.runID)
   if(!workspace||workspace.questID!==q.id||workspace.claimedRunID)throw Error('Workspace ownership changed during cleanup')
   const coordination=join(store.runtime,'coordination',workspace.projectID+'.json')
   if(readJsonRecord(coordination)?.participants.some((p:any)=>!p.releasedAt&&pathKey(p.checkout)===pathKey(workspace.path)))throw Error('An editor still owns this checkout')
   preserveArtifacts(store,q,workspace.path)
  },questAssetsDir(store.projectRoot,q.id))
  process.stdout.write(JSON.stringify({outcome}))
 }catch(error){process.stdout.write(JSON.stringify({error:error instanceof Error?error.message:String(error)}));process.exitCode=1}
}

function preserveArtifacts(store:QuestStore,q:Quest,workspace:string){
 let changed=false
 const copies:Array<{source:string;digest:string}>=[]
 const artifacts=q.evidence.artifacts.map(a=>{
  if(!a.path)return a
  const assetRoot=questAssetsDir(store.projectRoot,q.id)
  if(a.path.replaceAll('\\','/').startsWith('.opencode/quests-assets/'))return a
  const source=isAbsolute(a.path)?a.path:resolve(workspace,a.path)
  if(!within(workspace,source))return a
  if(!existsSync(source)||!lstatSync(source).isFile()||!within(realpathSync(workspace),realpathSync(source)))throw Error('Artifact missing, linked or not a regular file: '+a.name)
  const data=readFileSync(source),digest=createHash('sha256').update(data).digest('hex')
  mkdirSync(assetRoot,{recursive:true})
  const destination=join(assetRoot,digest+'-'+basename(source))
  if(!existsSync(destination))copyFileSync(source,destination)
  if(createHash('sha256').update(readFileSync(destination)).digest('hex')!==digest)throw Error('Artifact copy verification failed')
  copies.push({source,digest});changed=true;return {...a,path:destination,digest}
 })
 if(changed){const current=store.read(q.id);if(!current||current.revision!==q.revision)throw Error('Quest changed while preserving artifacts; retry cleanup');store.apply(q.id,'patched',{evidence:{...q.evidence,artifacts}},'quest:cleanup-artifacts',{expectedRevision:q.revision});q.evidence.artifacts=artifacts;q.revision=store.read(q.id)!.revision}
 for(const {source,digest} of copies){
  if(git(workspace,['ls-files','--',relative(workspace,source)]))continue
  if(createHash('sha256').update(readFileSync(source)).digest('hex')!==digest)throw Error('Artifact changed after preservation')
  unlinkSync(source)
 }
}
