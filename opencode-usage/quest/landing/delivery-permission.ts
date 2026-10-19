import {execFile} from 'node:child_process'
import {driveAsync,gitRun} from './git-steps'
import {resolve,win32} from 'node:path'
import type {Quest,QuestSession} from '../types'
import {questWorkflow} from '../runs/workflow'
import {RELEASE_BRANCH, legacyNames} from '../channel.mjs'
import {DELIVERY_NONE_FINISH} from './landing-step'

export const PROTECTED_BRANCHES=new Set([RELEASE_BRANCH,...legacyNames(RELEASE_BRANCH),'master','main','production','prod'])
export type DeliveryAction='push'|'create'|'merge'|'view'
export type RecordedDelivery={authorization?:string;into?:string;remote?:string;method?:string}
export type DeliveryAuthorization={source:'delivery'|'start';text:string;covers:DeliveryAction[]}
export type DeliverySettlement={rule:string;action:DeliveryAction;authorization:{source:'delivery'|'start';text:string}}
export type PullRequestFacts={base:string;head:string;state:string;crossRepository:boolean}
export type DeliveryLookups={
 currentBranch:(directory:string)=>string|undefined|Promise<string|undefined>
 pullRequest:(directory:string,number?:string)=>Promise<PullRequestFacts|undefined>
}

export function splitShellSegments(command:string):string[]|undefined{
 const segments:string[]=[]
 let current='',quote:string|undefined
 for(let index=0;index<command.length;index++){
  const char=command[index]
  if(quote){current+=char;if(char===quote)quote=undefined;continue}
  if(char==='"'||char==="'"){quote=char;current+=char;continue}
  if(char===';'||char==='\n'||char==='\r'||char==='|'||char==='&'){
   segments.push(current)
   current=''
   while(index+1<command.length&&(command[index+1]==='|'||command[index+1]==='&'))index++
   continue
  }
  current+=char
 }
 if(quote)return undefined
 segments.push(current)
 return segments.filter(segment=>segment.trim())
}

export function shellWords(segment:string):string[]|undefined{
 const words:string[]=[]
 let current:string|undefined,quote:string|undefined
 for(const char of segment){
  if(quote){
   if(char===quote){quote=undefined;continue}
   if(quote==='"'&&(char==='$'||char==='`'))return undefined
   current=(current??'')+char
   continue
  }
  if(char==='"'||char==="'"){quote=char;current??='';continue}
  if(/\s/.test(char)){if(current!==undefined)words.push(current);current=undefined;continue}
  if(/[;&|<>$`(){}~%\r\n]/.test(char))return undefined
  current=(current??'')+char
 }
 if(quote)return undefined
 if(current!==undefined)words.push(current)
 return words
}

const absolute=(value:string)=>/^[a-z]:[\\/]|^\\\\/i.test(value)?win32.resolve(value):resolve(value)
const key=(value:string)=>{const path=absolute(value).replace(/\\/g,'/').replace(/\/+$/,'');return process.platform==='win32'?path.toLowerCase():path}
export const samePath=(left:string,right:string)=>key(left)===key(right)
export const withinPath=(path:string,root:string)=>key(path).startsWith(key(root)+'/')

export function deliveryAuthorizations(quest:Quest|undefined,run:QuestSession|undefined,start:unknown):DeliveryAuthorization[]{
 if(!quest||!run)return []
 const scope=(run.scope??{}) as {readOnly?:boolean;delivery?:RecordedDelivery}
 if(scope.readOnly)return []
 const found:DeliveryAuthorization[]=[]
 const recorded=scope.delivery?.authorization
 if(typeof recorded==='string'&&recorded.trim()){
  const covers:DeliveryAction[]=['view']
  if(/\bpush/i.test(recorded))covers.push('push')
  if(/\bpull[- ]request\b|\bPR\b/i.test(recorded))covers.push('create')
  if(/\bmerge/i.test(recorded))covers.push('merge')
  found.push({source:'delivery',text:recorded,covers})
 }
 const recordedStart=start as {action?:string;at?:string;scope?:string}|undefined
 if(recordedStart?.action){
  const workflow=questWorkflow(quest).delivery??'project'
  const owner=(quest.extensions.prOwner as {runID?:string}|undefined)?.runID
  const runID=run.runID??run.callID
  const opensPR=workflow==='step-pr'||workflow==='quest-pr'&&owner===runID
  found.push({source:'start',text:recordedStart.action+' at '+recordedStart.at+' with workflow delivery '+workflow+': '+(recordedStart.scope??''),covers:opensPR?['view','push','create']:['view']})
 }
 return found
}

function flagValues(words:string[],valued:Record<string,string>,switches:Set<string>){
 const values:Record<string,string>={},positional:string[]=[],seen=new Set<string>()
 for(let index=0;index<words.length;index++){
  const word=words[index]
  if(!word.startsWith('-')||word==='-'){positional.push(word);continue}
  const [flag,inline]=word.includes('=')&&word.startsWith('--')?[word.slice(0,word.indexOf('=')),word.slice(word.indexOf('=')+1)]:[word,undefined]
  if(switches.has(flag)){if(inline!==undefined)return undefined;seen.add(flag);continue}
  const name=valued[flag]
  if(!name)return undefined
  const value=inline??words[++index]
  if(value===undefined||name in values)return undefined
  values[name]=value
 }
 return {values,positional,seen}
}

const branchName=(ref:string)=>ref.startsWith('refs/heads/')?ref.slice('refs/heads/'.length):ref

export async function settleDelivery(input:{command:string;workdir?:string;workspace:string;run:QuestSession;authorizations:DeliveryAuthorization[];lookups:DeliveryLookups}):Promise<DeliverySettlement|undefined>{
 const scope=(input.run.scope??{}) as {branch?:string;workspaceMode?:string;delivery?:RecordedDelivery}
 const task=scope.branch,delivery=scope.delivery??{},into=delivery.into
 if(!task||!into||scope.workspaceMode==='shared'||PROTECTED_BRANCHES.has(task)||PROTECTED_BRANCHES.has(into)||task===into)return
 if(input.workdir!==undefined&&!samePath(input.workdir,input.workspace)&&!withinPath(input.workdir,input.workspace))return
 const segments=splitShellSegments(input.command)
 if(segments?.length!==1)return
 const words=shellWords(segments[0])
 if(!words||words.length<2)return
 const covering=(action:DeliveryAction)=>input.authorizations.find(row=>row.covers.includes(action))
 const settled=(action:DeliveryAction,rule:string):DeliverySettlement|undefined=>{const found=covering(action);return found?{rule,action,authorization:{source:found.source,text:found.text}}:undefined}
 const current=()=>input.lookups.currentBranch(input.workdir??input.workspace)
 const [program,verb,...rest]=words
 if(program==='git'&&verb==='push'){
  if(!delivery.remote)return
  const parsed=flagValues(rest,{},new Set(['-u','--set-upstream']))
  if(!parsed||parsed.positional.length!==2)return
  const [remote,refspec]=parsed.positional
  if(remote!==delivery.remote||refspec.startsWith('+')||refspec.split(':').length>2)return
  const [from,to=from]=refspec.split(':')
  const source=from==='HEAD'?await current():branchName(from),target=to==='HEAD'?await current():branchName(to)
  if(!source||!target||PROTECTED_BRANCHES.has(target))return
  if(target===task&&source===task)return settled('push','git push of the run\'s own task branch '+task+' to '+remote)
  if(target===into&&delivery.method==='push'&&(source===task||source===into))return settled('push','git push to '+into+' under the project\'s push delivery policy')
  return
 }
 if(program!=='gh'||verb!=='pr'||!rest.length)return
 const [sub,...args]=rest
 if(sub==='view'){
  if(args.some(word=>word==='-w'||word==='--web'))return
  return settled('view','gh pr view')
 }
 if(sub==='create'){
  const parsed=flagValues(args,{'--base':'base','-B':'base','--head':'head','-H':'head','--title':'title','-t':'title','--body':'body','-b':'body','--body-file':'bodyFile','-F':'bodyFile'},new Set(['--fill','--fill-first','--fill-verbose']))
  if(!parsed||parsed.positional.length||parsed.values.base!==into)return
  const bodyFile=parsed.values.bodyFile
  if(bodyFile!==undefined&&bodyFile!=='-'&&!withinPath(/^[a-z]:[\\/]|^\\\\|^\//i.test(bodyFile)?bodyFile:resolve(input.workdir??input.workspace,bodyFile),input.workspace))return
  const head=parsed.values.head??await current()
  if(head!==task)return
  return settled('create','gh pr create of '+task+' into '+into)
 }
 if(sub==='merge'){
  const parsed=flagValues(args,{},new Set(['--merge','--auto']))
  if(!parsed||parsed.positional.length>1||!parsed.seen.has('--merge'))return
  const number=parsed.positional[0]
  if(number!==undefined&&!/^\d+$/.test(number))return
  const facts=await input.lookups.pullRequest(input.workdir??input.workspace,number)
  if(!facts||facts.state!=='OPEN'||facts.crossRepository||facts.base!==into||facts.head!==task)return
  return settled('merge','gh pr merge '+(number?'#'+number+' ':'')+(parsed.seen.has('--auto')?'--auto ':'')+'--merge of '+task+' into '+into)
 }
}

export type DeliveryMode='project'|'quest-pr'|'step-pr'|'none'
export type DeliveryGate='push'|'create'|'merge'|'land'
const GATE_WORDS:Record<DeliveryGate,string>={push:'push',create:'opening a pull request',merge:'merge',land:'landing'}
const GATED_COMMANDS:[DeliveryGate,RegExp][]=[['create',/\bgh(?:\.exe)?\s+pr\s+create\b/i],['merge',/\bgh(?:\.exe)?\s+pr\s+merge\b/i],['land',/\bbun\s+run\s+land\b|\bland\.mjs\b/i]]
const PUSH_COMMAND=/\bgit(?:\.exe)?\s+push\b([^;&|\r\n]*)/gi

export function deliveryRefusal(input:{questID:string;delivery?:DeliveryMode;gate:DeliveryGate}):string|undefined{
 const mode=input.delivery
 if(mode!=='none'&&mode!=='quest-pr')return undefined
 const head=`Quest ${input.questID} has delivery ${mode}: ${GATE_WORDS[input.gate]} is refused. `
 if(mode==='none')return head+'Nothing is pushed, opened, merged or landed for this Quest; leave the commit on its branch and report it in the step notes. '+DELIVERY_NONE_FINISH
 if(input.gate==='merge'||input.gate==='land')return head+'A pull request may be opened, but the user merges it.'
 return undefined
}

export function commandDeliveryRefusal(input:{questID:string;delivery?:DeliveryMode;branch?:string;command:string}):string|undefined{
 const mode=input.delivery
 if(mode!=='none'&&mode!=='quest-pr')return undefined
 const refused=(gate:DeliveryGate)=>deliveryRefusal({questID:input.questID,delivery:mode,gate})
 for(const match of input.command.matchAll(PUSH_COMMAND)){
  const refusal=refused('push')
  if(refusal)return refusal
  const refspec=match[1].trim().split(/\s+/).filter(word=>word&&!word.startsWith('-'))[1]
  const target=refspec===undefined||refspec==='HEAD'?input.branch:refspec.split(':').pop()!.replace(/^\+/,'').replace(/^refs\/heads\//,'')
  if(target!==input.branch)return `Quest ${input.questID} has delivery ${mode}: push to ${target ?? 'the current branch'} is refused; only the run's own branch${input.branch?' '+input.branch:''} may be pushed.`
 }
 for(const [gate,pattern] of GATED_COMMANDS)if(pattern.test(input.command)){const refusal=refused(gate);if(refusal)return refusal}
 return undefined
}

export const productionLookups:DeliveryLookups={
 currentBranch:async directory=>{
  const result=await driveAsync(gitRun(directory,['symbolic-ref','--short','-q','HEAD'],30000))
  const branch=result.status===0?result.stdout.trim():''
  return branch||undefined
 },
 pullRequest:(directory,number)=>new Promise(done=>{
  execFile('gh',['pr','view',...(number?[number]:[]),'--json','baseRefName,headRefName,state,isCrossRepository'],{cwd:directory,windowsHide:true,timeout:30000,env:{...process.env,GH_PROMPT_DISABLED:'1'}},(error:Error|null,stdout:string)=>{
   if(error)return done(undefined)
   try{const value=JSON.parse(stdout);done({base:String(value.baseRefName),head:String(value.headRefName),state:String(value.state),crossRepository:value.isCrossRepository===true})}catch{done(undefined)}
  })
 }),
}
