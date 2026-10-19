import {existsSync,readFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {questSettingsFile,readSettings,updateSettings} from '../config/quest-settings.mjs'
import {execFile,spawnSync} from 'node:child_process'
import {gitDirectory,pathKey} from '../checkouts/cleanup-git.mjs'
import {LEGACY_CHANNEL_NAMES} from '../channel.mjs'

export const DELIVERY_METHODS=['pull-request','push','local-merge']
export const DELIVERY_LANDED=['remote','local']
export const DELIVERY_PLACEHOLDERS=['into','branch','head','remote','title','body']
const POLICY_KEYS=['into','method','remote','retire','landed','pullRequest']
const PLACEHOLDER=/\{([a-z]+)\}/g

const gitCall=(cwd,args,env)=>({cwd,args:['-c','core.longpaths=true',...args],timeout:30000,...(env?{env}:{})})
function* read(cwd,args){const r=yield gitCall(cwd,args);return r.status===0?r.stdout.trim():undefined}
function* together(...steps){return yield {together:steps}}
const gitDirOf=cwd=>{try{return gitDirectory(cwd)}catch{return join(cwd,'.git')}}
const driveSync=steps=>{
 let next=steps.next()
 while(!next.done){
  if(next.value.together){next=steps.next(next.value.together.map(driveSync));continue}
  const {cwd,args,timeout,env}=next.value
  const r=spawnSync('git',['--git-dir='+gitDirOf(cwd),...args],{encoding:'utf8',windowsHide:true,timeout,...(env?{env:{...process.env,...env}}:{})})
  next=steps.next({status:r.status,stdout:r.stdout??'',stderr:r.stderr??''})
 }
 return next.value
}
const driveAsync=async steps=>{
 let next=steps.next()
 while(!next.done){
  if(next.value.together){next=steps.next(await Promise.all(next.value.together.map(driveAsync)));continue}
  const {cwd,args,timeout,env}=next.value
  const r=await new Promise(done=>execFile('git',['--git-dir='+gitDirOf(cwd),...args],{encoding:'utf8',windowsHide:true,timeout,maxBuffer:16*1024*1024,...(env?{env:{...process.env,...env}}:{})},(error,stdout,stderr)=>done({status:error?(typeof error.code==='number'?error.code:null):0,stdout:stdout??'',stderr:stderr??''})))
  next=steps.next(r)
 }
 return next.value
}
const text=value=>typeof value==='string'&&value.trim().length>0
const argvList=(value,where)=>{
 if(!Array.isArray(value)||!value.length||!value.every(text))throw Error(where+' must be a non-empty list of argument strings')
 for(const part of value)for(const [,name] of part.matchAll(PLACEHOLDER))if(!DELIVERY_PLACEHOLDERS.includes(name))throw Error(where+' uses the unknown placeholder {'+name+'}; known: '+DELIVERY_PLACEHOLDERS.map(n=>'{'+n+'}').join(' '))
 return value
}

export function validateDeliveryPolicy(value,where='delivery policy'){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error(where+' must be an object')
 for(const key of Object.keys(value))if(!POLICY_KEYS.includes(key))throw Error(where+' has the unknown key "'+key+'"; known keys: '+POLICY_KEYS.join(', '))
 if(!text(value.into))throw Error(where+' needs "into": the branch that work lands on')
 if(!DELIVERY_METHODS.includes(value.method))throw Error(where+' needs "method" of '+DELIVERY_METHODS.join(', '))
 if(!DELIVERY_LANDED.includes(value.landed))throw Error(where+' needs "landed" of '+DELIVERY_LANDED.join(', ')+': where the landing is judged')
 if(typeof value.retire!=='boolean')throw Error(where+' needs "retire": true or false')
 if(value.method==='local-merge'&&value.landed!=='local')throw Error(where+' method local-merge is judged on the local branch: "landed" must be local')
 if(value.method!=='local-merge'&&value.landed!=='remote')throw Error(where+' method '+value.method+' is judged on the remote: "landed" must be remote')
 if(value.landed==='remote'&&!text(value.remote))throw Error(where+' needs "remote": the git remote it lands on')
 if(value.remote!==undefined&&!text(value.remote))throw Error(where+' "remote" must be a remote name')
 const out={into:value.into,method:value.method,retire:value.retire,landed:value.landed}
 if(value.remote!==undefined)out.remote=value.remote
 if(value.pullRequest!==undefined){
  if(value.method!=='pull-request')throw Error(where+' "pullRequest" commands belong to method pull-request')
  const pr=value.pullRequest
  if(!pr||typeof pr!=='object'||Array.isArray(pr))throw Error(where+' "pullRequest" must be an object with open and merge commands')
  for(const key of Object.keys(pr))if(!['open','merge'].includes(key))throw Error(where+' pullRequest has the unknown key "'+key+'"; known keys: open, merge')
  out.pullRequest={}
  for(const key of ['open','merge'])if(pr[key]!==undefined)out.pullRequest[key]=argvList(pr[key],where+' pullRequest.'+key)
 }
 return out
}

export function expandArgv(argv,values){
 return argv.map(part=>part.replace(PLACEHOLDER,(_,name)=>{if(!Object.hasOwn(values,name))throw Error('Unknown placeholder {'+name+'}');return String(values[name])}))
}

const DELIVERY_SECTION={
 name:'delivery',
 check(saved){
  if(saved===undefined)return {}
  if(!saved||typeof saved!=='object'||Array.isArray(saved))throw Error('Quest settings "delivery" must be an object keyed by project checkout path')
  return saved
 },
}
export function readDeliverySettings(file=questSettingsFile()){return readSettings(DELIVERY_SECTION,file)}

const mainCheckout=(directory,common)=>{
 if(!common)throw Error(directory+' is not inside a Git checkout')
 return resolve(dirname(common))
}
export const projectMainCheckout=directory=>mainCheckout(directory,driveSync(read(directory,['rev-parse','--path-format=absolute','--git-common-dir'])))
export const projectMainCheckoutAsync=async directory=>mainCheckout(directory,await driveAsync(read(directory,['rev-parse','--path-format=absolute','--git-common-dir'])))

const settingsKey=(delivery,root)=>Object.keys(delivery).find(key=>pathKey(key)===pathKey(root))

const branchOf=(remote,ref)=>{
 const bare=ref.replace(/^refs\/remotes\//,'').replace(/^refs\/heads\//,'')
 return bare.startsWith(remote+'/')?bare.slice(remote.length+1):bare
}

function* remoteFor(source,remotes,configured,current){
 if(configured){
  const bare=configured.replace(/^refs\/remotes\//,'')
  const hit=remotes.find(name=>bare.startsWith(name+'/'))
  if(hit)return hit
 }
 const tracked=current?yield* read(source,['config','--get','branch.'+current+'.remote']):undefined
 return remotes.includes(tracked)?tracked:remotes[0]
}

function repositoryLandBase(root){
 try{
  const base=JSON.parse(readFileSync(join(root,'land.config.json'),'utf8')).base
  return text(base)?base:undefined
 }catch{return undefined}
}

function statedLandingBranches(root){
 const found=new Set()
 for(const name of ['AGENTS.md','CLAUDE.md']){
  const file=join(root,name)
  if(!existsSync(file))continue
  for(const [,branch] of readFileSync(file,'utf8').matchAll(/\blands?\s+on\s+`([^`\s]+)`/gi))found.add(Object.hasOwn(LEGACY_CHANNEL_NAMES,branch)?LEGACY_CHANNEL_NAMES[branch]:branch)
 }
 return [...found]
}

export function* inferDeliveryPolicySteps(projectRoot,source=projectRoot){
 const [listed,branch,configured]=yield* together(read(source,['remote']),read(source,['symbolic-ref','--short','HEAD']),read(projectRoot,['config','--get','quest.integrationRef']))
 const remotes=(listed??'').split(/\r?\n/).filter(Boolean)
 if(!remotes.length){
  if(!branch)throw Error(source+' is not on a branch, so there is no branch to land on; set a delivery policy for this project with `quest delivery`')
  return {policy:{into:branch,method:'local-merge',retire:true,landed:'local'},basis:'no remote: the current branch of the checkout'}
 }
 const remote=yield* remoteFor(source,remotes,configured,branch)
 const has=function*(branch){return (yield* read(projectRoot,['rev-parse','-q','--verify','refs/remotes/'+remote+'/'+branch+'^{commit}']))!==undefined}
 const make=(into,basis)=>({policy:{into,method:'pull-request',remote,retire:true,landed:'remote'},basis})
 if(configured)return make(branchOf(remote,configured),'git config quest.integrationRef')
 const landBase=repositoryLandBase(projectRoot)
 if(landBase&&(yield* has(landBase)))return make(landBase,'land.config.json base')
 const stated=statedLandingBranches(projectRoot)
 if(stated.length===1&&(yield* has(stated[0])))return make(stated[0],'the landing branch stated in AGENTS.md or CLAUDE.md')
 const live=yield gitCall(projectRoot,['ls-remote','--symref',remote,'HEAD'],{GIT_TERMINAL_PROMPT:'0'})
 const served=live.status===0?live.stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1]:undefined
 if(served&&(yield* has(served)))return make(served,'the default branch '+remote+' reports')
 const head=yield* read(projectRoot,['symbolic-ref','-q','refs/remotes/'+remote+'/HEAD'])
 if(head)return make(branchOf(remote,head),'the default branch of '+remote+' as last fetched')
 throw Error('No landing branch for '+projectRoot+': set git config quest.integrationRef, or a delivery policy with `quest delivery`')
}

export const inferDeliveryPolicy=(projectRoot,source=projectRoot)=>driveSync(inferDeliveryPolicySteps(projectRoot,source))

export function* resolveDeliveryPolicySteps(projectRoot,{settingsFile=questSettingsFile(),source=projectRoot}={}){
 const delivery=readDeliverySettings(settingsFile),key=settingsKey(delivery,projectRoot)
 if(key!==undefined)return {policy:validateDeliveryPolicy(delivery[key],'Delivery policy for '+key+' in '+settingsFile),source:'settings',file:settingsFile}
 const inferred=yield* inferDeliveryPolicySteps(projectRoot,source)
 return {policy:inferred.policy,source:'inferred',basis:inferred.basis}
}
export const resolveDeliveryPolicy=(projectRoot,options={})=>driveSync(resolveDeliveryPolicySteps(projectRoot,options))
export const resolveDeliveryPolicyAsync=(projectRoot,options={})=>driveAsync(resolveDeliveryPolicySteps(projectRoot,options))

export function setDeliveryPolicy(projectRoot,policy,settingsFile=questSettingsFile()){
 return updateSettings(DELIVERY_SECTION,current=>{
  const delivery={...current},existing=settingsKey(delivery,projectRoot)
  if(existing!==undefined)delete delivery[existing]
  if(policy!==null)delivery[resolve(projectRoot).replaceAll('\\','/')]=validateDeliveryPolicy(policy,'Delivery policy')
  return delivery
 },settingsFile)
}
