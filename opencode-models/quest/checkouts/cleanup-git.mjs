import {existsSync,realpathSync,readdirSync,lstatSync,unlinkSync,rmdirSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve,relative,isAbsolute,join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {readServicesSync} from '../../scripts/fresh-services.mjs'
import {readOwnership,describeClaims} from './folder-owners.mjs'
const GIT=['-c','core.longpaths=true']
export const pathKey=p=>resolve(p).replaceAll('\\','/').toLowerCase()
export const within=(root,path)=>{const rel=relative(resolve(root),resolve(path));return !!rel&&!rel.startsWith('..')&&!isAbsolute(rel)}
export function gitDirectory(root){
 const dotgit=join(root,'.git')
 if(lstatSync(dotgit).isDirectory())return resolve(dotgit)
 const own=/^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit,'utf8'))?.[1]?.trim()
 if(!own)throw Error('Invalid Git directory binding in '+dotgit)
 return resolve(root,own)
}
export function gitCommonDirectory(root){
 const gitdir=gitDirectory(root),common=join(gitdir,'commondir')
 return existsSync(common)?resolve(gitdir,readFileSync(common,'utf8').trim()):gitdir
}
export function git(root,args){const r=spawnSync('git',[...GIT,'-C',root,...args],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024});if(r.status!==0)throw Error(r.stderr?.trim()||r.error?.message||'Git failed');return r.stdout.trim()}
export function integrationRef(root,source=root){
 const configured=spawnSync('git',[...GIT,'-C',root,'config','--get','quest.integrationRef'],{encoding:'utf8',windowsHide:true})
 if(configured.status===0&&configured.stdout.trim())return configured.stdout.trim()
 const upstream=spawnSync('git',[...GIT,'-C',source,'rev-parse','--symbolic-full-name','@{upstream}'],{encoding:'utf8',windowsHide:true})
 if(upstream.status===0)return upstream.stdout.trim()
 for(const remote of spawnSync('git',[...GIT,'-C',source,'remote'],{encoding:'utf8',windowsHide:true}).stdout?.split(/\r?\n/).filter(Boolean)??[]){
  const fallback=spawnSync('git',[...GIT,'-C',source,'symbolic-ref','-q','refs/remotes/'+remote+'/HEAD'],{encoding:'utf8',windowsHide:true})
  if(fallback.status===0&&fallback.stdout.trim())return fallback.stdout.trim()
 }
 throw Error('Set the project integration ref with git config quest.integrationRef <reviewed-branch>; checkout HEAD is not integration proof')
}
export function registeredWorktrees(root){return git(root,['worktree','list','--porcelain','-z']).split('\0\0').filter(Boolean).map(block=>Object.fromEntries(block.split('\0').filter(Boolean).map(field=>{const i=field.indexOf(' ');return i<0?[field,true]:[field.slice(0,i),field.slice(i+1)]})))}
function bytes(root){let total=0;for(const e of readdirSync(root,{withFileTypes:true})){const p=join(root,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())total+=bytes(p);else total+=lstatSync(p).size}return total}
export function removeEmptyWorktreeShell(root){
 const plan=[]
 const inspect=directory=>{for(const e of readdirSync(directory,{withFileTypes:true})){const path=join(directory,e.name);if(!within(root,path))throw Error('Leftover path escapes retired checkout');const stat=lstatSync(path);if(stat.isSymbolicLink())plan.push({path,link:true});else if(stat.isDirectory()){inspect(path);plan.push({path,link:false})}else throw Error('Ordinary file remains after Git removal; preserved: '+path)}}
 if(pathKey(realpathSync(root))!==pathKey(root))throw Error('Retired checkout changed identity')
 inspect(root)
 for(const item of plan){const stat=lstatSync(item.path);if(item.link){if(!stat.isSymbolicLink())throw Error('Leftover link changed; preserved');unlinkSync(item.path)}else{if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Leftover directory changed; preserved');rmdirSync(item.path)}}
 rmdirSync(root)
}
const safeName=value=>value.replace(/[^A-Za-z0-9._-]+/g,'_')
export function preserveWorktree({path,runID,target,base,destination}){
 const run=(args,env,cwd=path)=>{const r=spawnSync('git',[...GIT,'-C',cwd,...args],{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:64*1024*1024,env:env?{...process.env,...env}:process.env});if(r.status!==0)throw Error('Git '+args[0]+' failed: '+(r.stderr||r.error?.message||'').trim());return r.stdout}
 const head=run(['rev-parse','HEAD']).trim(),patches=[]
 mkdirSync(destination,{recursive:true})
 const modules=existsSync(join(path,'.gitmodules'))?spawnSync('git',[...GIT,'-C',path,'config','-f','.gitmodules','--get-regexp','\\.path$'],{encoding:'utf8',windowsHide:true}).stdout.split(/\r?\n/).filter(Boolean).map(line=>line.slice(line.indexOf(' ')+1)):[]
 for(const module of modules){
  const directory=join(path,module)
  if(!existsSync(join(directory,'.git')))continue
  const status=run(['status','--porcelain','--untracked-files=all'],undefined,directory)
  if(!status.trim())continue
  if(status.split(/\r?\n/).some(line=>line.startsWith('??')))throw Error('Submodule '+module+' holds untracked files; the checkout is kept')
  const file=join(destination,runID+'.'+safeName(module)+'.patch'),diff=run(['diff','--binary','HEAD'],undefined,directory)
  writeFileSync(file,diff)
  if(readFileSync(file,'utf8')!==diff)throw Error('Submodule patch verification failed')
  patches.push(file)
 }
 let tip=head,lock
 if(run(['status','--porcelain','--untracked-files=all']).trim()){
  const index=join(destination,runID+'.index.tmp'),identity={GIT_INDEX_FILE:index,GIT_AUTHOR_NAME:'Quest runtime',GIT_AUTHOR_EMAIL:'quest-runtime@localhost',GIT_COMMITTER_NAME:'Quest runtime',GIT_COMMITTER_EMAIL:'quest-runtime@localhost'}
  try{
   run(['read-tree','HEAD'],identity);run(['add','-A','--','.'],identity)
   tip=run(['commit-tree',run(['write-tree'],identity).trim(),'-p',head,'-m','Uncommitted work of '+runID+' kept when its checkout was retired'],identity).trim()
  }finally{if(existsSync(index))unlinkSync(index)}
 }
 const exclude=target??base
 const commits=Number(run(['rev-list','--count',tip,...(exclude?['^'+exclude]:[])]).trim())
 if(!commits)return {head,commits,patches}
 const ref='refs/quest-preserved/'+runID,bundle=join(destination,runID+'.bundle')
 run(['update-ref',ref,tip])
 run(['bundle','create',bundle,ref,...(exclude?['^'+exclude]:[])])
 if(!run(['bundle','list-heads',bundle]).includes(tip))throw Error('Preserved bundle does not hold '+tip)
 run(['bundle','verify',bundle])
 return {head,tip,ref,bundle,commits,patches}
}
const REGENERABLE_DIRECTORIES=new Set(['node_modules','.tanstack','.wrangler','dist','.turbo'])
const REGENERABLE_FILES=new Set(['routeTree.gen.ts'])
const REGENERABLE_PREFIXES=['apps/questgiver/site/public/']
export const regenerableIgnored=(checkout,entry)=>{
 const parts=entry.split('/').filter(Boolean)
 if(parts.some(part=>REGENERABLE_DIRECTORIES.has(part))||REGENERABLE_FILES.has(parts.at(-1))||REGENERABLE_PREFIXES.some(prefix=>entry.startsWith(prefix)))return true
 if(!entry.endsWith('/'))return false
 try{return readdirSync(join(checkout,entry),{withFileTypes:true}).every(child=>!child.isSymbolicLink()&&regenerableIgnored(checkout,entry+child.name+(child.isDirectory()?'/':'')))}catch{return false}
}
export function removeIntegratedWorktree({root,path,ref,head,branch,beforeRemove=()=>{},integrationRoot=root,preserve,cherry=false,owner,ownership,listed}){
 const retained=reason=>({removed:false,reason})
 if(!isAbsolute(root)||!isAbsolute(path)||!isAbsolute(integrationRoot)||pathKey(root)===pathKey(path))return retained('The main checkout is never removed')
 if(!existsSync(path))return retained('Workspace missing; reconcile its registration and retained evidence')
 if(pathKey(realpathSync(path))!==pathKey(path))return retained('Workspace resolves through an alias; ownership is uncertain')
 const rows=listed??registeredWorktrees(root),entry=rows.find(r=>pathKey(r.worktree)===pathKey(path))
 if(!entry||entry===rows[0]||entry.locked||entry.prunable)return retained('Worktree is unregistered, primary, locked or prunable')
 if(rows.some(r=>r!==entry&&within(path,r.worktree)))return retained('Nested worktrees are preserved')
 const claims=(ownership??readOwnership()).claims(path,owner)
 if(claims.length)return retained('Another run still needs this folder: '+describeClaims(claims))
 if(head&&entry.HEAD!==head||branch&&entry.branch!=='refs/heads/'+branch)return retained('Worktree head or branch changed')
 const dirty=git(path,['status','--porcelain','--untracked-files=all'])
 if(dirty&&!preserve)return retained('Uncommitted or untracked work is preserved')
 {
  const ignored=git(path,['ls-files','--others','--ignored','--exclude-standard','--directory','-z']).split('\0').filter(Boolean)
  const unknown=ignored.filter(entry=>!regenerableIgnored(path,entry))
  if(unknown.length)return retained('Ignored files need preservation: '+unknown.slice(0,8).join(', '))
 }
 let target
 try{target=ref?git(integrationRoot,['rev-parse','--verify',ref+'^{commit}']):undefined}catch(error){if(!preserve)throw error}
 const contained=()=>spawnSync('git',[...GIT,'-C',integrationRoot,'merge-base','--is-ancestor',entry.HEAD,target],{windowsHide:true,timeout:30000}).status===0||cherry&&(()=>{const r=spawnSync('git',[...GIT,'-C',integrationRoot,'cherry',target,entry.HEAD],{encoding:'utf8',windowsHide:true,timeout:30000});return r.status===0&&!r.stdout.split(/\r?\n/).some(row=>row.startsWith('+'))})()
 const integrated=!dirty&&!!target&&contained()
 if(!integrated&&!preserve)return retained('Commits are not integrated into '+ref)
 let kept
 if(!integrated)try{kept=preserve(target)}catch(error){return retained(error instanceof Error?error.message:String(error))}
 beforeRemove()
 if(git(path,['rev-parse','HEAD'])!==entry.HEAD||git(path,['status','--porcelain','--untracked-files=all'])!==dirty)return retained('Workspace changed during cleanup')
 const logicalBytes=bytes(path)
 const removal=spawnSync('git',[...GIT,'-C',root,'worktree','remove',path],{windowsHide:true,timeout:120000})
 if(removal.status!==0){
  if(!kept&&!existsSync(join(path,'.gitmodules')))return retained('git refused to remove it: '+(removal.stderr||removal.error?.message||'Worktree removal failed').trim())
  rmSync(path,{recursive:true,force:true,maxRetries:5})
 }
 if(existsSync(path))removeEmptyWorktreeShell(path)
 git(root,['worktree','prune'])
 if(existsSync(path)||registeredWorktrees(root).some(r=>pathKey(r.worktree)===pathKey(path)))throw Error('Worktree removal did not complete')
 return {removed:true,reason:kept?.bundle||kept?.patches?.length?'Checkout removed; its unlanded work is kept in '+[kept.bundle,...kept.patches].filter(Boolean).join(', ')+(kept.ref?' and '+kept.ref:''):'Integrated checkout removed; branch and history retained',logicalBytes,workerHead:entry.HEAD,projectHead:target,ref,...(kept?{preserved:kept}:{})}
}
const OWN_WORK=/^(commit|merge|rebase|cherry-pick|revert|pull|am)\b/
const attempt=(root,args)=>spawnSync('git',[...GIT,'-C',root,...args],{encoding:'utf8',windowsHide:true,timeout:120000})
export function retireCheckout({root,path,branch,head,tagName,landedRef,remote,deleteRemoteBranch=false,holds=[],requireOwnCommit=true,registryHere=root,registry,owner,ownership,lockHeld=()=>true,dryRun=false}){
 const kept=reason=>({retired:false,reason})
 const present=!!path&&existsSync(path)
 let tip=head,lock,rows,entry
 if(present){
  const at=resolve(path)
  if(pathKey(at)===pathKey(root))return kept('The main checkout is never retired')
  rows=registeredWorktrees(root);entry=rows.find(row=>pathKey(row.worktree)===pathKey(at))
  lock=entry?.locked?lockHeld(entry.locked===true?'':entry.locked,at):undefined
  if(lock)return {...kept('locked'),claims:typeof lock==='string'?lock:undefined}
  if(holds.some(held=>pathKey(held)===pathKey(at)||within(at,held)))return kept('in use as a working directory')
  if(!entry||entry===rows[0]||entry.prunable)return kept('Worktree is unregistered, primary or prunable')
  if(pathKey(realpathSync(at))!==pathKey(at))return kept('Workspace resolves through an alias; ownership is uncertain')
  const claims=(ownership??readOwnership()).claims(at,owner)
  if(claims.length)return {...kept('a Quest run still needs it'),claims:describeClaims(claims)}
 }
 try{
  const {managedCheckouts}=registry??readServicesSync(root,undefined,registryHere)
  if(path&&managedCheckouts.some(managed=>pathKey(managed)===pathKey(path)||within(path,managed)))return kept('registered managed checkout')
 }catch(error){return {...kept('service registry unavailable: '+error.message),failure:'service-registry'}}
 if(present){
  const at=resolve(path)
  if(git(at,['status','--porcelain','--untracked-files=all']))return kept('has files of its own')
  if(requireOwnCommit&&!git(at,['reflog','show','--format=%gs','HEAD']).split('\n').some(line=>OWN_WORK.test(line)))return kept('no commit of its own yet')
  tip=entry.HEAD
 }else if(!tip&&branch){
  const resolved=attempt(root,['rev-parse','--verify','-q','refs/heads/'+branch+'^{commit}'])
  if(resolved.status===0)tip=resolved.stdout.trim()
 }
 if(!tip)return kept('nothing identifies the work to archive')
 if(dryRun)return {retired:true,tip,dryRun:true}
 let branchExists=false
 if(branch){
  const current=attempt(root,['rev-parse','--verify','-q','refs/heads/'+branch+'^{commit}'])
  branchExists=current.status===0
  if(branchExists&&current.stdout.trim()!==tip)return kept('its branch moved past the checkout')
 }
 git(root,['tag','-f','archive/'+(tagName??branch??tip.slice(0,12)),tip])
 if(present){
  const modules=existsSync(join(path,'.gitmodules'))
  if(modules){
   const paths=attempt(path,['submodule','--quiet','foreach','--recursive','echo $displaypath'])
   for(const module of paths.status===0?paths.stdout.split(/\r?\n/).filter(Boolean):[])if(attempt(join(path,module),['status','--porcelain','--untracked-files=all']).stdout.trim())return kept('a submodule has files of its own')
   attempt(path,['submodule','deinit','--all','--force'])
  }
  if(lock===false)attempt(root,['worktree','unlock',path])
  const removal=removeIntegratedWorktree({root,path,head:tip,ref:tip,integrationRoot:root,owner,ownership,listed:lock===false?undefined:rows})
  if(!removal.removed)return kept(removal.reason)
 }
 if(branchExists)git(root,['branch','-D',branch])
 let remoteDeleted=false
 if(deleteRemoteBranch&&remote&&branch){
  const known=attempt(root,['rev-parse','--verify','-q','refs/remotes/'+remote+'/'+branch+'^{commit}'])
  if(known.status===0){
   const contained=known.stdout.trim()===tip||!!landedRef&&attempt(root,['merge-base','--is-ancestor',known.stdout.trim(),landedRef]).status===0
   if(contained)remoteDeleted=attempt(root,['push','--quiet',remote,'--delete',branch]).status===0
  }
 }
 return {retired:true,tip,remoteDeleted}
}
