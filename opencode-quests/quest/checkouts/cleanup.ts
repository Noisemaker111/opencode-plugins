import { isSafeReference } from "../core/readable-reference"
import {existsSync,mkdirSync,watch} from 'node:fs'
import {readJsonRecord} from '../core/durable-file.mjs'
import {join} from 'node:path'
import {readdir,readFile,stat} from 'node:fs/promises'
import {retireWorkspace} from './workspace-retirement'
import {QuestWorkspaces} from '../workspaces'
import {readAllQuests} from '../index'
import {questMemberships} from '../permissions/shared-guard'
import {inspectWorker,confirmWorkerIdle} from '../workers/worker-inspection'
import {readContinuations} from '../core/runtime-queues'
import {pathKey,gitCommonDirectory} from './cleanup-git.mjs'
import {settleQuests,retryLandings} from '../landing/settle'
import {hygienePass} from '../hygiene/sweep'
import {settleMergedRuns} from '../landing/merged-runs'
import {TERMINAL_RUN} from '../runs/session-lineage'
import {timed,recordSpan,now} from '../../scripts/plugin-spans'
import {releaseHostLocations} from '../host/host-role'
import {stopRetiredCheckoutProcesses} from './run-processes'
import type {QuestStore} from '../store'
import type {Quest} from '../types'

const terminal=TERMINAL_RUN
const SETTLE_BUDGET=30_000
const finishedQuest=(q:Quest)=>q.state==='Archived'||!!q.delivered
const running=new Map<string,Promise<CleanupSweep>>()
const failedRetirements=new Map<string,string>()
const TRANSIENT_RETIREMENT=/still running|changed during cleanup|reopened during cleanup|retry cleanup/i
const AWAITING_MERGE=/not integrated/i
const retirementInputs=(q:Quest,w:any)=>{const {cleanup:_,changes:__,...record}=w;return q.revision+'\0'+JSON.stringify(record)}
const settledQuests=new Map<string,Map<string,string>>()
const UNSETTLED=/still running|changed during cleanup|reopened during cleanup|retry cleanup|Connect the owning|has not confirmed|Worker retained|An editor still owns/i
export type CleanupSweep=Array<Record<string,unknown>>&{examined?:number}
export function cleanupQuests(store:QuestStore,host?:any,only?:string,options:{changedOnly?:boolean;refs?:boolean}={}):Promise<CleanupSweep> {
 const active=running.get(store.runtime)
 if(active)return only||options.changedOnly?active.then(()=>cleanupQuests(store,host,only,options)):active
 const run=async()=>{
  const manager=new QuestWorkspaces(store.runtime),results:CleanupSweep=[]
  results.examined=0
  if(!only)await releaseHostLocations(directory=>!existsSync(directory))
  const quests=readAllQuests(store.projectRoot,{includeArchived:true}).flatMap(e=>e.quest&&finishedQuest(e.quest)&&(!only||e.quest.id===only)?[e.quest]:[])
  if(!quests.length)return results
  const owned=manager.byQuest(only?quests.flatMap(q=>q.sessions.map(s=>s.runID??s.callID)):undefined)
  let continuing:Set<string>|undefined
  const continues=(id:string)=>(continuing??=new Set(readContinuations(store.runtime).filter(r=>!['done','stopped'].includes(r.state)).map(r=>r.questID))).has(id)
  const settled=settledQuests.get(store.runtime)??settledQuests.set(store.runtime,new Map()).get(store.runtime)!
  for(const q of quests){
   const open=(owned.get(q.id)??[]).filter(w=>!w.removed&&!w.claimedRunID&&w.mode!=='shared'&&w.mode!=='research')
   if(!open.length){settled.delete(q.id);continue}
   const signature=JSON.stringify([q.revision,continues(q.id),open.map(w=>retirementInputs(q,w))])
   const awaitingMerge=!!options.refs&&open.some(w=>AWAITING_MERGE.test(w.cleanup?.reason??''))
   if(options.changedOnly&&settled.get(q.id)===signature&&!awaitingMerge)continue
   results.examined++
   let unsettled=false
   for(const w of open){
    let outcome:any
    try{outcome=await retireOne(q,w,awaitingMerge)}
    catch(error){try{outcome=manager.retain(w.runID,error instanceof Error?error.message:String(error),w)}catch(inner){console.error('[quests] cleanup',w.runID,inner);unsettled=true;continue}}
    results.push({quest:q.title,...outcome})
    if(!outcome?.removed&&UNSETTLED.test(String(outcome?.reason??'')))unsettled=true
   }
   if(unsettled)settled.delete(q.id);else settled.set(q.id,signature)
  }
  return results
  async function retireOne(q:Quest,w:any,retry=false){
    const key=store.runtime+'\0'+w.runID,inputs=retirementInputs(q,w)
    if(!retry&&failedRetirements.get(key)===inputs&&w.cleanup?.removed===false)return w.cleanup
    const {outcome,retired}=await judge(q,w)
    if(retired&&!outcome.removed&&!TRANSIENT_RETIREMENT.test(outcome.reason??''))failedRetirements.set(key,inputs);else failedRetirements.delete(key)
    return outcome
  }
  async function judge(q:Quest,w:any){
    let reason:string|undefined
    const sessions=q.sessions.filter(s=>(s.runID??s.callID)===w.runID)
    if(w.cleanupProtocol!==1)reason='Older worker lacks the retirement guard; retain until its owner explicitly finishes the checkout'
    else if(!sessions.length)reason='No terminal worker ownership record; retained for inspection'
    else if(q.sessions.some(s=>!terminal.has(s.state)))reason='A Quest worker is active or uncertain'
    else if(continues(q.id))reason='A continuation still needs this Quest'
    else for(const s of sessions){
     if(s.sessionID?.startsWith('command_'))continue
     if(!host){reason='Connect the owning OpenCode host to verify worker completion';break}
     const sessionID=s.openCodeSessionId??s.sessionID
     if(!sessionID)continue
     if(!await confirmWorkerIdle(host,sessionID)){reason='Owning host has not confirmed this worker is idle';break}
     const observed=await inspectWorker(host,s)
     if(['running','blocked','waiting','executing'].includes(observed.state)){reason='Worker retained: '+observed.reason;break}
    }
    if(!reason)try{
     const coordination=join(store.runtime,'coordination',w.projectID+'.json')
     if(readJsonRecord(coordination)?.participants.some((p:any)=>!p.releasedAt&&pathKey(p.checkout)===pathKey(w.path)))reason='An editor still owns this checkout'
    }catch(e){reason=String(e)}
    if(reason)return {outcome:manager.retain(w.runID,reason,w),retired:false}
    await releaseHostLocations(directory=>pathKey(directory)===pathKey(w.path))
    await stopRetiredCheckoutProcesses(store,w).catch(error=>console.error('[quests] processes in a retiring checkout were not stopped',error))
    const outcome=await retireWorkspace({runtime:store.runtime,projectRoot:store.projectRoot,questID:q.id,runID:w.runID})
     .catch(error=>manager.retain(w.runID,error instanceof Error?error.message:String(error),w))
    return {outcome,retired:true}
  }
 }
 const promise=run().finally(()=>{running.delete(store.runtime)})
 running.set(store.runtime,promise)
 return promise
}
export function cleanupSessionQuest(store:QuestStore,host:any,sessionID:string):string|undefined {
 const quest=questMemberships(store,sessionID)[0]?.quest
 if(!quest||!finishedQuest(quest))return
 scheduleQuestCleanup(store,host,quest.id);return quest.id
}
const scheduled=new Map<string,Set<string>>()
export function scheduleQuestCleanup(store:QuestStore,host:any,questID:string):void {
 const prior=scheduled.get(store.runtime)
 if(prior){prior.add(questID);return}
 const pending=new Set([questID]);scheduled.set(store.runtime,pending)
 setTimeout(()=>{void (async()=>{
  try {
   while(pending.size){
    const active=running.get(store.runtime)
    if(active)try{await active}catch(error){console.error('[quests] cleanup',error)}
    const ids=[...pending];pending.clear()
    for(const id of ids)try{await cleanupQuests(store,host,id)}catch(error){console.error('[quests] cleanup',error)}
   }
  }finally{scheduled.delete(store.runtime)}
 })().catch(error=>console.error('[quests] cleanup',error))},0)
}
export function cleanupStatus(store:QuestStore,q:Quest){const manager=new QuestWorkspaces(store.runtime);return q.sessions.flatMap(s=>{const id=s.runID??s.callID;if(!isSafeReference(id))return [];const w=manager.get(id);return w?[{runID:id,removed:w.removed===true,...w.cleanup}]:[]})}

const watching=new WeakMap<object,()=>void>()
const TEMP_RENAME=/\.\d+\.\d+\.tmp$/
const RECEIPT=/^\.quest-runtime[/\\](?:continuations(?:-[a-f0-9]+)?\.json|(?:worker-returns(?:-[a-f0-9]+)?|wr-[a-f0-9]{12})[/\\][^/\\]+\.json)$/
export function installQuestCleanup(store:QuestStore,host:object){
 const existing=watching.get(host);if(existing)return existing
 const root=join(store.projectRoot,'.opencode');mkdirSync(root,{recursive:true})
 const gitWatchers=new Set<string>(),watchedRoots=new Set<string>(),mergeWatchers=new Set<ReturnType<typeof watch>>()
 const watchRefs=(common:string)=>{
  const refs=join(common,'refs'),watchers:ReturnType<typeof watch>[]=[]
  if(existsSync(refs))watchers.push(watch(refs,{recursive:true},()=>trigger('refs')))
  watchers.push(watch(common,{recursive:false},(_,file)=>{if(String(file??'')==='packed-refs')trigger('refs')}))
  return watchers
 }
 const inspected=new Set<string>(),unreadable=new Map<string,number>()
 let merging:Promise<void>|undefined,mergeAgain=false,closed=false
 const watchMerges=():Promise<void>=>{
  if(merging){mergeAgain=true;return merging}
  return merging=(async()=>{do{mergeAgain=false;await watchMergesOnce()}while(mergeAgain&&!closed)})().finally(()=>{merging=undefined})
 }
 const watchMergesOnce=async()=>{
  const dir=join(store.runtime,'workspaces')
  let files:string[]=[]
  try{files=await readdir(dir)}catch{return}
  for(const file of files){
   if(closed)return
   if(!file.endsWith('.json')||inspected.has(file))continue
   let root:string|undefined
   try{
    const path=join(dir,file)
    let w:any,changedAt=-1
    try{
     changedAt=(await stat(path)).mtimeMs
     if(unreadable.get(file)===changedAt)continue
     w=JSON.parse(await readFile(path,'utf8'))
    }catch(error){
     if(!unreadable.has(file))console.error('[quests] cleanup watch skips '+file+' until it changes: '+(error instanceof Error?error.message:String(error)))
     unreadable.set(file,changedAt);continue
    }
    unreadable.delete(file)
    if(w.mode==='research'||watchedRoots.has(w.root)){inspected.add(file);continue}
    if(!existsSync(w.root))continue
    inspected.add(file);root=w.root
    if(!existsSync(join(w.root,'.git')))continue
    const common=gitCommonDirectory(w.root)
    if(gitWatchers.has(pathKey(common))||closed)continue
    for(const watcher of watchRefs(common)){mergeWatchers.add(watcher);watcher.unref();watcher.on('error',e=>console.error('[quests] merge cleanup watcher',e))}
    gitWatchers.add(pathKey(common))
   }catch(e){console.error('[quests] cleanup watch',e)}
   finally{if(root)watchedRoots.add(root)}
  }
 }
 let pending:ReturnType<typeof setTimeout>|undefined,full=false,runtime=false,refsMoved=false
 const changed=new Set<string>()
 type SettleScope={files?:Set<string>;refs:boolean}
 let settling:Promise<void>|undefined,queuedSettle:SettleScope|undefined,fetchedAtStart=false
 const widen=(a:SettleScope|undefined,b:SettleScope):SettleScope=>!a?b:{files:a.files&&b.files?new Set([...a.files,...b.files]):undefined,refs:a.refs||b.refs}
 const settleOnce=async({files,refs}:SettleScope)=>{try{
   const until=Date.now()+SETTLE_BUDGET
  let only:Set<string>|undefined
  if(files){only=new Set();for(const e of readAllQuests(store.projectRoot))if(e.quest&&files.has(pathKey(e.path)))only.add(e.quest.id);if(!only.size)return}
  const fetch=!only&&!fetchedAtStart;if(fetch)fetchedAtStart=true
  const merged=await settleMergedRuns(store,{only,fetch,until})
  if(merged.length)console.error('[quests] found on v2: '+merged.map(change=>change.questID+' ('+[...change.steps,...change.landingSteps,...change.housekeeping].join(', ')+')').join('; '))
  await retryLandings(store,{only})
  const done=await settleQuests(store,{only,refs})
  if(done.turnedIn.length||done.noticed.length)console.error('[quests] settled: turned in '+(done.turnedIn.join(', ')||'none')+'; told the giver about '+(done.noticed.join(', ')||'none'))
  const hygiene=await hygienePass(store,{only,until})
  if(hygiene.rows.some(row=>row.applied))console.error('[quests] hygiene: '+hygiene.rows.filter(row=>row.applied).map(row=>row.quest+' '+row.kind).join('; '))
 }catch(e){console.error('[quests] settle',e)}}
 const settle=(files:Set<string>|undefined,refs:boolean):Promise<void>=>{
  queuedSettle=widen(queuedSettle,{files,refs})
  if(settling)return settling
  return settling=(async()=>{while(queuedSettle&&!closed){const scope=queuedSettle;queuedSettle=undefined;await timed({plugin:'quests',name:'step',op:scope.refs?'settle all':'settle'},()=>settleOnce(scope))}})().finally(()=>{settling=undefined})
 }
 const sweep=(changedOnly:boolean,refs:boolean)=>{
  const start=now()
  return cleanupQuests(store,host,undefined,{changedOnly,refs}).then(
   result=>{recordSpan({plugin:'quests',name:'step',op:'cleanup sweep',start,end:now(),quests:result.examined??0,...(changedOnly?{}:{fullSweep:true})});return result},
   error=>{recordSpan({plugin:'quests',name:'step',op:'cleanup sweep',start,end:now(),error:String(error instanceof Error?error.message:error).slice(0,200)});throw error})
 }
 const trigger=(change:'full'|'refs'|'receipt'|{file:string})=>{if(change==='receipt')runtime=true;else if(change==='refs')refsMoved=true;else if(change==='full')full=true;else changed.add(pathKey(join(root,change.file)));if(pending)return;pending=setTimeout(()=>{
  pending=undefined
  if(closed)return
  const all=full,every=runtime,refs=refsMoved,files=new Set(changed);full=false;runtime=false;refsMoved=false;changed.clear()
  void timed({plugin:'quests',name:'step',op:'merge watch'},watchMerges).catch(e=>console.error('[quests] cleanup watch',e))
  void settle(all||refs||every?undefined:files,all||refs)
  if(all||refs||every){void sweep(!all,refs).catch(e=>console.error('[quests] cleanup',e));return}
  for(const e of readAllQuests(store.projectRoot,{includeArchived:true}))if(e.quest&&finishedQuest(e.quest)&&files.has(pathKey(e.path)))scheduleQuestCleanup(store,host,e.quest.id)
 },100);pending.unref()}
 const watcher=watch(root,{recursive:true},(_,file)=>{const name=String(file??'').replace(TEMP_RENAME,'');if(/^quests(?:-archive)?[/\\].*\.md$/.test(name))trigger({file:name});else if(RECEIPT.test(name))trigger('receipt')});watcher.unref();watcher.on('error',e=>console.error('[quests] cleanup watcher',e))
 trigger('full')
 const dispose=()=>{closed=true;if(pending)clearTimeout(pending);watcher.close();for(const merge of mergeWatchers)merge.close();watching.delete(host)}
 watching.set(host,dispose);return dispose
}
