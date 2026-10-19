import {existsSync,readdirSync,readFileSync,realpathSync} from 'node:fs'
import {homedir,hostname} from 'node:os'
import {dirname,isAbsolute,join,relative,resolve} from 'node:path'
import {channelRegistry,channelRuntimes} from '../host/channel-runtimes.mjs'
import {runFileCandidates} from '../core/durable-file.mjs'
import {CHANNELS,channelHostPool,channelPointerCandidates,channelStateDirectory} from '../../scripts/channel-migrate.mjs'

const key=path=>{const full=resolve(path).replaceAll('\\','/');return process.platform==='win32'?full.toLowerCase():full}
const inside=(parent,path)=>{const rel=relative(resolve(parent),resolve(path));return !!rel&&!rel.startsWith('..')&&!isAbsolute(rel)}
const alive=pid=>{if(pid===process.pid)return true;try{process.kill(pid,0);return true}catch(error){return error?.code!=='ESRCH'}}
const editing=receipt=>receipt.mode!=='research'&&receipt.mode!=='shared'
const finished=receipt=>receipt.removed===true&&!!(receipt.integration||receipt.cleanup?.preserved)

function dispatchHolding(runtime,runID){
 let record
 for(const file of runFileCandidates(join(runtime,'dispatch-intents'),runID))try{record=JSON.parse(readFileSync(file,'utf8'));break}catch{}
 if(!record)return false
 return record?.phase!=='released'&&record?.host===hostname()&&Number.isSafeInteger(record?.pid)&&record.pid>0&&alive(record.pid)
}

function readReceipts(runtimes){
 const receipts=[],unreadable=[]
 for(const runtime of runtimes){
  const directory=join(runtime.questRuntime,'workspaces')
  let names
  try{names=readdirSync(directory).filter(name=>name.endsWith('.json'))}catch{continue}
  for(const name of names){
   const file=join(directory,name)
   let receipt
   try{receipt=JSON.parse(readFileSync(file,'utf8'))}catch{receipt=undefined}
   if(typeof receipt?.path==='string'&&typeof receipt?.runID==='string')receipts.push({channel:runtime.channel,runtime:runtime.questRuntime,receipt})
   else unreadable.push({channel:runtime.channel,file})
  }
 }
 return {receipts,unreadable}
}

function ownerChain(receipts,owner){
 if(!owner)return new Set()
 const own=receipts.filter(entry=>key(entry.runtime)===key(owner.runtime)).map(entry=>entry.receipt)
 const me=own.find(receipt=>receipt.runID===owner.runID)
 const origin=me?.continuationOf??owner.runID,ids=new Set([owner.runID,origin])
 if(me?.physicalRunID)ids.add(me.physicalRunID)
 for(const receipt of own)if(receipt.continuationOf===origin||ids.has(receipt.claimedRunID))ids.add(receipt.runID)
 return new Set([...ids].map(id=>key(owner.runtime)+'\n'+id))
}

export function readOwnership({home=homedir(),runtimes=channelRuntimes(home)}={}){
 const record=readReceipts(runtimes)
 return {...record,claims:(target,owner)=>folderClaims(record,target,owner)}
}

export function folderClaims({receipts,unreadable},target,owner){
 const at=key(target),skip=ownerChain(receipts,owner)
 const found=unreadable.map(({channel,file})=>({channel,file,reason:channel+' workspace receipt '+file+' is unreadable, so nothing can say which folder it holds'}))
 for(const {channel,runtime,receipt} of receipts){
  if(skip.has(key(runtime)+'\n'+receipt.runID))continue
  const same=key(receipt.path)===at,holds=inside(target,receipt.path),within=inside(receipt.path,target)
  if(!same&&!holds&&!within)continue
  const run=channel+' run '+receipt.runID
  if(editing(receipt)){
   if(finished(receipt))continue
   found.push({channel,runID:receipt.runID,questID:receipt.questID,path:receipt.path,reason:run+' still owns '+receipt.path+(receipt.removed?' (removed without its integration or kept work recorded)':' (its workspace receipt is not marked removed)')})
  }else if((same||holds)&&dispatchHolding(runtime,receipt.runID))found.push({channel,runID:receipt.runID,questID:receipt.questID,path:receipt.path,reason:run+' is still reading '+receipt.path})
 }
 return found
}

export function describeClaims(claims){
 return claims.length?claims.slice(0,3).map(claim=>claim.reason).join('; ')+(claims.length>3?'; and '+(claims.length-3)+' more':''):''
}

const FINISHED_RUN=new Set(['completed','failed','cancelled','missing','stale'])
const FINISHED_QUEST=new Set(['Complete','Archived'])
export const SPARE_QUEST='__prepared__'
const real=path=>{try{return key(realpathSync(path))}catch{return key(path)}}
const runtimeOf=state=>join(state,'quests','.opencode','.quest-runtime')

export function hostRecords(registry){
 const records=[]
 for(const channel of CHANNELS){
  const pool=channelHostPool(registry,channel)
  let names;try{names=readdirSync(pool).filter(name=>name.endsWith('.json'))}catch{continue}
  for(const name of names){
   let record;try{record=JSON.parse(readFileSync(join(pool,name),'utf8'))}catch{continue}
   if(Number.isSafeInteger(record?.pid)&&record.pid>0)records.push({...record,pool:channel,alive:alive(record.pid)})
  }
 }
 return records
}

export function liveRuntimes({home=homedir(),registry=channelRegistry(home)}={}){
 const found=new Map()
 const add=(questRuntime,channel,why)=>{if(existsSync(questRuntime)&&!found.has(real(questRuntime)))found.set(real(questRuntime),{channel,questRuntime,why})}
 for(const channel of CHANNELS)if(channelPointerCandidates(registry,channel).some(existsSync))add(runtimeOf(channelStateDirectory(registry,channel)),channel,'the '+channel+' channel reads it')
 return [...found.values()]
}

function questFrontmatter(file){
 let text;try{text=readFileSync(file,'utf8')}catch{return}
 const end=text.indexOf('\n---',3),head=text.startsWith('---')&&end>0?text.slice(3,end):''
 const field=name=>{const line=head.split(/\r?\n/).find(row=>row.startsWith(name+': '));if(!line)return;try{return JSON.parse(line.slice(name.length+2))}catch{return}}
 return {state:field('state'),sessions:field('sessions')??[]}
}

export function runStatus(questRuntime,receipt){
 if(receipt.questID===SPARE_QUEST)return {live:true,why:'a prepared spare checkout'}
 const quests=join(dirname(questRuntime),'quests')
 const quest=questFrontmatter(join(quests,receipt.questID+'.md'))
 if(!quest){
  let archived=false;try{archived=readdirSync(join(dirname(questRuntime),'quests-archive')).some(day=>existsSync(join(dirname(questRuntime),'quests-archive',day,receipt.questID+'.md')))}catch{}
  return {live:false,why:'Quest '+receipt.questID+(archived?' is archived':' has no record')}
 }
 if(FINISHED_QUEST.has(quest.state))return {live:false,why:'Quest '+receipt.questID+' is '+quest.state}
 const ids=new Set([receipt.runID,receipt.physicalRunID].filter(Boolean))
 const run=quest.sessions.findLast?.(session=>ids.has(session.runID))
 if(run&&FINISHED_RUN.has(run.state))return {live:false,why:'run '+receipt.runID+' '+run.state}
 return {live:true,why:run?'run '+receipt.runID+' is '+run.state:'Quest '+receipt.questID+' is '+quest.state+' and run '+receipt.runID+' has no outcome yet'}
}

export function liveOwnership({home=homedir(),runtimes=liveRuntimes({home})}={}){
 const {receipts,unreadable}=readReceipts(runtimes)
 const live=[],finished=[]
 for(const entry of receipts){const status=runStatus(entry.runtime,entry.receipt);(status.live?live:finished).push({...entry,status})}
 const record={receipts:live,unreadable}
 const runs=new Map(live.map(entry=>[entry.receipt.runID,entry]))
 return {...record,runtimes,finished,claims:(target,owner)=>folderClaims(record,target,owner),run:runID=>runs.get(runID)}
}

export function liveWorkerRuns(options){
 const runs=new Map()
 for(const {runtime,receipt} of liveOwnership(options).receipts)if(receipt.questID!==SPARE_QUEST)runs.set(runtime+'\n'+receipt.runID,receipt.runID)
 return [...runs.values()]
}

export function channelSwitchBlocker(home=homedir()){
 const ownership=liveOwnership({home})
 if(ownership.unreadable.length)return 'Cannot switch builds while a Quest worker receipt is unreadable.'
 if(ownership.receipts.length)return 'Finish the active Quest workers before switching builds.'
}
