import { isSafeReference } from "../core/readable-reference"
import {giverContext,userGiverID,verifyGiverBinding} from '../giver/user-giver'
import {workerReturnsPath,WORKER_RETURNS_DIRECTORY,v2QueueGeneration,readContinuations} from '../core/runtime-queues'
import {existsSync,mkdirSync,readFileSync,readdirSync,statSync,renameSync,unlinkSync,watch,type FSWatcher} from 'node:fs'
import {createHash} from 'node:crypto'
import {basename,dirname,join,resolve} from 'node:path'
import {acquireLock} from '../locking.mts'
import {hostConfirmsRunning,hostPermissions,hostPermissionDomain} from '../host/host-observation'
import {boundedInspection} from '../worker-observation.mjs'
import {physicalDirectory} from '../core/project'
import {permissionKey,workerSessionID,WorkerPermissions} from '../permissions/worker-permissions'
import {PermissionJev,permissionJevDue,leftToUser,settledDecision,type PermissionDecision} from '../permissions/permission-jev'
import {allowAskedRead} from '../permissions/read-rule'
import {decisionTimes,roleState,watchdogVerdict,type AskWatch} from '../permissions/permission-watchdog'
import {stopFrozenRun} from '../runs/stop-run'
import {completionWake,permissionWake,permissionAsk,holdFor,RESOLVE,savedItsSteps,noticeGate,saveStopCauses,landingUnderway,LANDING_HOLD,stopReasonOf,groupedStopNotice,causeNotDelivered,causeDelivered,giverDecides,type NoticeGate} from '../giver/giver-wake'
import {recordHandoff} from '../giver/giver-handoff'
import {giverBlockers} from '../core/state-machine'
import {workerReturnMetadata} from './return-metadata'
import {readAllQuests} from '../index'
import type {QuestStore} from '../store'
import type {Quest,QuestSession} from '../types'
import type {StartRun,QuestContext} from '../api'
import type {QuestHost} from '../runs/runtime'
import {writeFileDurable,runFileStem,runFileCandidates} from '../core/durable-file.mjs'
import {sessionPermissions} from '../host/host-role'
import {stoppedOnPurpose,TERMINAL_RUN} from '../runs/session-lineage'
import {turnInDelivered} from '../landing/settle'
import {noticeKindOf,noticeSent,type NoticeSlot} from '../giver/notice-ledger'
import {failureCause} from '../routing/failure-cause'
import {questWorkflow} from '../runs/workflow'
import {timed} from '../../scripts/plugin-spans'
import {spendReturnLine} from '../host/spend-mode'
import {readAccountUsage} from '../../usage-service/on-computer'
import {permissionRetryMs} from '../permissions/backoff'

type Notice={questID:string;runID:string;context:QuestContext;agent?:string;model?:unknown;state:'waiting'|'sending'|'accepted'|'unknown';error?:string;settled?:string;decisions?:Record<string,PermissionDecision>;
 notified?:Record<string,string>;watches?:Record<string,AskWatch>
 retryAt?:number;retries?:number;waitForChange?:boolean}
type HeldReturn={directory:string;name:string;row:Notice;run:QuestSession;lock:{release():void}}
type ReadyReturn={row:Notice;q:Quest;text:string;slot:NoticeSlot;earlier:HeldReturn[];save:(value:Notice)=>void;lock:{release():void};reason?:string;gate?:NoticeGate;decides:boolean}
function held(row:Notice,error:unknown){row.error=String(error);row.retries=(row.retries??0)+1;row.retryAt=Date.now()+permissionRetryMs(row.retries ?? 1)}
const FINISHED_STATES=new Set(['Complete','Archived','Ready to complete'])
export const nothingElseOpen=(store:QuestStore,ids:string[])=>!readAllQuests(store.projectRoot).some(entry=>entry.quest&&(ids.includes(entry.quest.id)?questWorkflow(entry.quest).readOnly===true:!FINISHED_STATES.has(entry.quest.state)))
function retained(row:Notice,error:unknown){row.error=String(error);row.waitForChange=true;delete row.retryAt;delete row.retries}
function cleared(row:Notice){delete row.error;delete row.retryAt;delete row.retries;delete row.waitForChange}
const GENERATION_RECOVERY_SCAN_MS=60_000
export const STILL_RUNNING_HOLD='The host still runs this worker, so no stop notice is sent; the notice waits until its session ends.'
const unsettled=(decision:PermissionDecision|undefined)=>!decision||['retrying','checking'].includes(decision.state)
export function quarantineUnreadableReturn(runtime:string,directory:string,name:string,error:unknown){
 const runtimeRoot=resolve(runtime),sourceDirectory=resolve(directory)
 if(dirname(sourceDirectory)!==runtimeRoot||!WORKER_RETURNS_DIRECTORY.test(basename(sourceDirectory))||!(name.endsWith(".json")&&isSafeReference(name.slice(0,-5))))throw Error('Invalid worker return quarantine target')
 const source=join(sourceDirectory,name),root=join(runtimeRoot,'unreadable-worker-returns',basename(sourceDirectory)),raw=join(root,name+'.invalid')
 const bytes=readFileSync(source),digest=createHash('sha256').update(bytes).digest('hex')
 mkdirSync(root,{recursive:true})
 if(existsSync(raw)){
  if(createHash('sha256').update(readFileSync(raw)).digest('hex')!==digest)throw Error('A different quarantined receipt already uses this identity')
  unlinkSync(source)
 }else renameSync(source,raw)
 const diagnostic=join(root,name+'.diagnostic.json')
 writeFileDurable(diagnostic,JSON.stringify({version:1,source,digest,error:String(error),quarantinedAt:new Date().toISOString()},null,2))
 return {source,raw,diagnostic,digest}
}
export class QuestWorkerReturns {
 private unreadable=new Map<string,string>()
 private sessionChanges=new Map<string,number>()
 private blocked=new Map<string,{revision:string;workerID?:string}>()
 private undelivered=new Map<string,number>()
 wake(sessionID?:string){if(sessionID)this.sessionChanges.set(sessionID,(this.sessionChanges.get(sessionID)??0)+1)}
 private revision(row:Notice,ledger:Map<string,Quest>,giverID:string|undefined,workerID?:string){return [ledger.get(row.questID)?.revision??'-',giverID??'-',this.sessionChanges.get(row.context.sessionID)??0,workerID?this.sessionChanges.get(workerID)??0:0].join(':')}
 constructor(readonly store:QuestStore,readonly host:QuestHost,readonly generation=v2QueueGeneration(),readonly observation?:{generationScan?:()=>void;permissionJevEnabled?:()=>boolean;permissionJev?:()=>Pick<PermissionJev,'decide'>}){}
 private directory(){return workerReturnsPath(this.store.runtime,this.generation)}
 private generations?:{directories:string[]}
 private generationsDirty=true
 private generationScannedAt=0
 private runtimeIdentity?:string
 private generationWatcher?:FSWatcher
 private worklist=new Map<string,{mtimeMs:number;names:Set<string>}>()
 private scanDirectories(permissionDirectory?:string){
  if(permissionDirectory)return [this.directory()]
  try{
   const stat=statSync(this.store.runtime),identity=stat.dev+':'+stat.ino+':'+stat.birthtimeMs
   if(this.runtimeIdentity!==identity){this.runtimeIdentity=identity;this.generationsDirty=true;this.generationWatcher?.close();this.generationWatcher=undefined}
  }catch{this.generationsDirty=true;return []}
  if(!this.generationWatcher)try{
   const watcher=watch(this.store.runtime,(_event,name)=>{if(!name||WORKER_RETURNS_DIRECTORY.test(String(name)))this.generationsDirty=true})
   this.generationWatcher=watcher
   watcher.on('error',()=>{watcher.close();if(this.generationWatcher===watcher)this.generationWatcher=undefined;this.generationsDirty=true})
   watcher.on('close',()=>{if(this.generationWatcher===watcher)this.generationWatcher=undefined;this.generationsDirty=true})
   watcher.unref()
  }catch{this.generationsDirty=true}
  if(this.generationsDirty||!this.generations||Date.now()-this.generationScannedAt>=GENERATION_RECOVERY_SCAN_MS){
   this.observation?.generationScan?.()
   let names:string[]
   try{names=readdirSync(this.store.runtime)}catch{return []}
   this.generations={directories:names.filter(n=>WORKER_RETURNS_DIRECTORY.test(n)).map(n=>join(this.store.runtime,n))}
   this.generationScannedAt=Date.now()
   this.generationsDirty=!this.generationWatcher
  }
  return this.generations.directories
 }
 dispose(){this.generationWatcher?.close();this.generationWatcher=undefined}
 private scanReceipts(directory:string){
  let mtimeMs:number
  try{mtimeMs=statSync(directory).mtimeMs}catch{return []}
  const held=this.worklist.get(directory)
  if(held?.mtimeMs===mtimeMs)return [...held.names]
  const names=new Set(readdirSync(directory).filter(n=>n.endsWith(".json")&&isSafeReference(n.slice(0,-5))))
  this.worklist.set(directory,{mtimeMs,names})
  return [...names]
 }
 private settled(directory:string,name:string){this.worklist.get(directory)?.names.delete(name)}
 private save(row:Notice,directory=this.directory()){
  const [file,legacy]=runFileCandidates(directory,row.runID)
  writeFileDurable(file,JSON.stringify({...row,decisions:row.decisions&&Object.fromEntries(Object.entries(row.decisions).map(([key,decision])=>[key,settledDecision(decision)]))}))
  if(legacy&&existsSync(legacy))unlinkSync(legacy)
 }
 private quarantine(directory:string,name:string,error:unknown){
  const source=join(directory,name)
  try{
   const {digest}=quarantineUnreadableReturn(this.store.runtime,directory,name,error)
   this.settled(directory,name);this.unreadable.delete(source)
   console.error('[quests] unreadable worker return quarantined:',source,'sha256:'+digest)
   return true
  }catch(quarantineError){
   const reason=String(error)+'; quarantine failed: '+String(quarantineError)
   if(this.unreadable.get(source)!==reason)console.error('[quests] unreadable worker return retained:',source,reason)
   this.unreadable.set(source,reason)
   return false
  }
 }
 async watch(input:Parameters<StartRun>[0]){
  const parent=await boundedInspection(signal=>this.host.get({sessionID:input.context.sessionID},{signal})),session=(parent as any)?.data??parent
  const lock=acquireLock(this.store.runtime,'worker-return-'+runFileStem(input.runID))
  try{if(runFileCandidates(this.directory(),input.runID).some(file=>existsSync(file)))return;this.save({questID:input.quest.id,runID:input.runID,context:input.context,agent:session?.agent,model:session?.model,state:'waiting'})}finally{lock.release()}
 }
  private actionable(ledger:Map<string,Quest>,directory:string,row:Notice){
   if(directory!==this.directory())return false
  const recorded=ledger.get(row.questID)?.sessions.find(s=>s.runID===row.runID)
  if(!recorded)return false
  if(TERMINAL_RUN.has(recorded.state))return true
  return directory===this.directory()&&row.state==='waiting'&&['executing','waiting','blocked'].includes(recorded.state)&&!recorded.harness
 }
 private parked(path:string,row:Notice,ledger:Map<string,Quest>,giverID:string|undefined){
  const decided=this.blocked.get(path)
  const unchanged=decided===undefined||decided.revision===this.revision(row,ledger,giverID,decided.workerID)
  return unchanged&&(row.waitForChange===true&&decided!==undefined||typeof row.retryAt==='number'&&row.retryAt>Date.now())
 }
 nextDue?:number
 private heldReturns(pending:{directory:string;name:string;row:Notice}[],directory:string,name:string,row:Notice,q:Quest,healing:boolean){
  const found:{directory:string;name:string;row:Notice;run:Quest['sessions'][number];lock:{release():void}}[]=[]
  for(const other of pending){
   if(other.row.questID!==row.questID||other.directory===directory&&other.name===name)continue
   let lock;try{lock=acquireLock(this.store.runtime,'worker-return-'+other.name.slice(0,-5),{timeoutMs:0})}catch{continue}
   let kept=false
   try{
    const current:Notice=JSON.parse(readFileSync(join(other.directory,other.name),'utf8'))
    const run=q.sessions.find(s=>s.runID===current.runID)
    if(current.state!=='accepted'&&current.context.sessionID===row.context.sessionID&&run&&TERMINAL_RUN.has(run.state)&&completionWake(q,run,healing).wake){found.push({directory:other.directory,name:other.name,row:current,run,lock});kept=true}
   }catch{}finally{if(!kept)lock.release()}
  }
  return found
 }
 private async workerAsks(q:Quest,run:QuestSession,row:Notice,save:(value:Notice)=>void){
  const sessionID=workerSessionID(run);if(!sessionID)return
  let giverID:string|undefined;try{giverID=userGiverID(this.store)}catch{}
  const routed=sessionPermissions(),response=await (routed?routed.list({sessionID}):hostPermissions(this.host,sessionID)),listed=(response as any)?.data??response
  const requests=(Array.isArray(listed)?listed:[]).filter((request:any)=>request?.sessionID===sessionID&&typeof request.id==='string')
  let waiting:{request:any;reason?:string}|undefined
  const answered=new Set<string>()
  for(const request of requests){
   const key=permissionKey(request);row.decisions??={}
   if(!row.decisions[key]){
    let read:PermissionDecision|undefined
    try{read=await allowAskedRead(this.store,this.host,routed??hostPermissionDomain(this.host),q,run,request)}catch(error){console.error('[quests] read rule not applied',error instanceof Error?error.message:error)}
    if(read){row.decisions[key]=read;save(row);answered.add(request.id);continue}
   }
   if(giverID&&(this.observation?.permissionJevEnabled?.()??true)&&permissionJevDue(row.decisions[key])){
    const permissionJev=this.observation?.permissionJev?.()??new PermissionJev(this.store,this.host)
    await permissionJev.decide({giverID,questID:q.id,runID:row.runID,requestID:request.id,requestKey:key,previous:row.decisions[key],save:value=>{row.decisions![key]=value;save(row)}})
   }
   const decided=row.decisions[key]
   if(unsettled(decided)&&(this.observation?.permissionJevEnabled?.()??true)){
    if(await this.watchAsk(q,run,row,request,key,giverID,save))return
    continue
   }
   if(leftToUser(decided))waiting??={request,reason:decided?.reason}
  }
  if(row.watches){const live=new Set(requests.map((request:any)=>permissionKey(request)));for(const key of Object.keys(row.watches))if(!live.has(key)){delete row.watches[key];save(row)}}
  const current=this.store.read(q.id)?.sessions.find(s=>s.callID===run.callID)
  if(!current)return
  if(!waiting){
   if(current.awaiting&&!requests.some((request:any)=>!answered.has(request.id)&&request.id===current.awaiting!.requestID))this.store.apply(q.id,'session-state',{callID:run.callID,state:current.state,preserveTerminal:true,awaiting:null},'quest:worker-ask')
   return
  }
  const {request,reason}=waiting
  let ask=current.awaiting?.requestID===request.id?current.awaiting.ask:undefined
  if(!ask){
   let source:string|undefined
   if(giverID)try{source=(await new WorkerPermissions(this.store,this.host,sessionPermissions()??hostPermissionDomain(this.host)).inspect(giverID,q.id,row.runID)).requests.find((shown:any)=>shown.requestID===request.id)?.source}catch{}
   ask=permissionAsk(request,source)
   this.store.apply(q.id,'session-state',{callID:run.callID,state:current.state,preserveTerminal:true,awaiting:{requestID:request.id,ask,reason}},'quest:worker-ask')
  }
  const wake=permissionWake(this.store.read(q.id)??q,request,ask,reason,row.notified)
  if(!wake.wake||!giverID)return
  try{
   await this.host.prompt({sessionID:giverID,id:'msg_questpermission'+request.id,delivery:'queue',text:wake.text,metadata:{questWorkerPermission:true,questID:q.id,runID:row.runID,requestID:request.id}})
   row.notified={...row.notified,[request.id]:new Date().toISOString()};cleared(row)
  }catch(error){held(row,error)}
  save(row)
 }
 private async watchAsk(q:Quest,run:QuestSession,row:Notice,request:any,key:string,giverID:string|undefined,save:(value:Notice)=>void){
  row.watches??={}
  const now=Date.now(),times=decisionTimes(this.store.runtime),ask=permissionAsk(request)
  const verdict=watchdogVerdict({watch:row.watches[key]??{askedAt:now},now,times,ask,role:()=>roleState(this.store.runtime,giverID,key,row.decisions?.[key])})
  row.watches[key]=verdict.watch
  save(row)
  if(verdict.act==='wait')return false
  const current=this.store.read(q.id)?.sessions.find(s=>s.callID===run.callID)
  if(current?.awaiting)this.store.apply(q.id,'session-state',{callID:run.callID,state:current.state,preserveTerminal:true,awaiting:null},'quest:permission-watchdog')
  try{await stopFrozenRun(this.store,this.host,q.id,row.runID,verdict.reason)}catch(error){console.error('[quests] worker with an unanswered ask not stopped',error instanceof Error?error.message:error)}
  return true
 }
 async tick(permissionDirectory?:string){
  const now=Date.now();let due:number|undefined
  const note=(row:Notice)=>{if(row.state!=='accepted'&&typeof row.retryAt==='number'&&row.retryAt>now&&(due===undefined||row.retryAt<due))due=row.retryAt;for(const decision of Object.values(row.decisions??{})){const at=decision.retryAt;if(['retrying','checking'].includes(decision.state)&&typeof at==='number'&&at>now&&(due===undefined||at<due))due=at};if(row.state!=='accepted')for(const watch of Object.values(row.watches??{})){const at=watch.dueAt;if(typeof at==='number'&&at>now&&(due===undefined||at<due))due=at}}
  try{await this.pass(permissionDirectory,note)}finally{this.nextDue=due}
 }
 private async pass(permissionDirectory:string|undefined,note:(row:Notice)=>void){
  if(!existsSync(this.store.runtime))return
  const directories=this.scanDirectories(permissionDirectory)
  const pending:{directory:string;name:string;row:Notice}[]=[]
  for(const directory of directories){
   if(!existsSync(directory))continue
   for(const name of this.scanReceipts(directory)){
    const path=join(directory,name)
    try{
     const row:Notice=JSON.parse(readFileSync(path,'utf8'));this.unreadable.delete(path)
     if(row.state==='accepted')this.settled(directory,name)
     else pending.push({directory,name,row})
    }catch(error){
     try{const workspace=JSON.parse(readFileSync(join(this.store.runtime,'workspaces',name),'utf8'));if(this.store.read(workspace.questID)?.state==='Archived'){this.settled(directory,name);continue}}catch{}
     this.quarantine(directory,name,error)
    }
   }
  }
  if(!pending.length)return
  const ledger=new Map(readAllQuests(this.store.projectRoot,{includeArchived:true}).flatMap(row=>row.quest?[[row.quest.id,row.quest] as const]:[]))
  const sessions=new Map<string,Promise<any>>()
  let giverID:string|undefined;try{giverID=userGiverID(this.store)}catch{}
  const authoritative=new Map<string,ReturnType<QuestStore['read']>>()
  const readQuest=(id:string)=>{if(!authoritative.has(id))authoritative.set(id,this.store.read(id));return authoritative.get(id)}
  let healing:Set<string>|undefined
  const healingQuests=()=>healing??=new Set(readContinuations(this.store.runtime).filter(row=>!['done','stopped'].includes(row.state)).map(row=>row.questID))
  const giverSession=async(sessionID:string)=>{
   let pending=sessions.get(sessionID)
   if(!pending){pending=boundedInspection(signal=>this.host.get({sessionID},{signal})).then((value:any)=>value?.data??value);sessions.set(sessionID,pending)}
   return pending
  }
  const stops:ReadyReturn[]=[]
  for(const candidate of pending){
    const {directory,name}=candidate
    const path=join(directory,name)
    let row=candidate.row
   if(!this.actionable(ledger,directory,row)||this.parked(path,row,ledger,giverID)){note(row);continue}
   let lock;try{lock=acquireLock(this.store.runtime,'worker-return-'+name.slice(0,-5),{timeoutMs:0})}catch{continue}
   let deferred=false
   try{
    try{row=JSON.parse(readFileSync(path,'utf8'))}catch{continue}
    if(row.state==='accepted'){this.settled(directory,name);continue}
    let written=JSON.stringify(row)
    const save=(value:Notice)=>{const next=JSON.stringify(value);if(next===written)return;written=next;this.save(value,directory)}
    if(!this.actionable(ledger,directory,row))continue
    let q=readQuest(row.questID);const run=q?.sessions.find(s=>s.runID===row.runID)
    if(!q||!run)continue
    const terminal=TERMINAL_RUN.has(run.state)
    if(directory!==this.directory()&&!terminal)continue
    if(!terminal&&row.state!=='waiting')continue
    if(savedItsSteps(q,run)&&!permissionDirectory&&this.undelivered.get(q.id)!==q.revision){const before=q;q=await timed({plugin:'quests',name:'return.turn-in',op:row.runID},()=>turnInDelivered(this.store,before));authoritative.set(q.id,q);if(q.state!=='Archived')this.undelivered.set(q.id,q.revision)}
    if(terminal&&q.stages.some(step=>step.status==='blocked'&&!step.note?.trim())){q=saveStopCauses(this.store,q);authoritative.set(q.id,q)}
    const wake=terminal?completionWake(q,run,healingQuests().has(q.id)):undefined
    if(wake&&!wake.wake){row.state='accepted';row.settled=wake.settled;cleared(row);save(row);continue}
    const workerID=workerSessionID(run),revision=this.revision(row,ledger,giverID,workerID),previous=this.blocked.get(path)?.revision
    const changed=previous!==undefined&&previous!==revision
    if(row.waitForChange&&previous===revision)continue
    if(!changed&&typeof row.retryAt==='number'&&row.retryAt>Date.now())continue
    this.blocked.set(path,{revision,workerID})
    if(permissionDirectory){
     if(terminal||typeof run.scope?.worktree!=='string'||physicalDirectory(run.scope.worktree)!==permissionDirectory)continue
     const workerID=workerSessionID(run),response=workerID?await boundedInspection(signal=>this.host.get({sessionID:workerID},{signal})):undefined,worker=(response as any)?.data??response
     if(worker?.id!==workerID||typeof worker?.location?.directory!=='string'||physicalDirectory(worker.location.directory)!==permissionDirectory)continue
    }
    if(!terminal&&(!['executing','waiting','blocked'].includes(run.state)||run.harness))continue
    if(!terminal){await this.workerAsks(q,run,row,save);continue}
    if(run.state==='completed'&&landingUnderway(q)){retained(row,LANDING_HOLD);save(row);continue}
    const refused=failureCause(run)?.code==='route-refused'
    if(refused&&workerID&&typeof this.host.interrupt==='function')void Promise.resolve(this.host.interrupt({sessionID:workerID})).catch(()=>{})
    if(wake?.wake&&stopReasonOf(wake.text)&&!stoppedOnPurpose(run)&&!refused&&workerID&&await hostConfirmsRunning(this.host,workerID,boundedInspection)){retained(row,STILL_RUNNING_HOLD);save(row);continue}
    const registeredID=row.context.giverDirectory?userGiverID(this.store):undefined
    if(registeredID&&registeredID!==row.context.sessionID){
     let next
     try{next=await giverSession(registeredID)}catch(error){held(row,error);save(row);continue}
     if(next?.id!==registeredID){retained(row,'Registered Quest Giver session is unavailable; return retained for the registered giver');save(row);continue}
     try{row.context={...row.context,...giverContext(this.store,next,row.context.requestID,row.questID,false,row.context.turnID)};row.model=next?.model;row.agent=next?.agent}catch(error){retained(row,error);save(row);continue}
     save(row)
    }
    let session
    try{session=await giverSession(row.context.sessionID)}catch(error){held(row,error);save(row);continue}
    if(JSON.stringify(session?.model)!==JSON.stringify(row.model)){
     if(registeredID&&registeredID===row.context.sessionID&&session?.id===registeredID){row.model=session?.model;row.agent=session?.agent;save(row)}
     else{retained(row,'Giver model changed; return retained for inspection');save(row);continue}
    }
    try{await verifyGiverBinding(this.store,row.context,session)}catch(error){retained(row,error);save(row);continue}
    delete row.waitForChange
    const sibling=holdFor(q,run,healingQuests().has(q.id))
    if(sibling){retained(row,'Held for run '+(sibling.runID??sibling.callID)+' of the same Quest, which is still going; both wake the giver once');save(row);continue}
    const earlier=this.heldReturns(pending,directory,name,row,q,healingQuests().has(q.id))
    const together=earlier.length?completionWake(q,run,healingQuests().has(q.id),earlier.map(other=>other.run)):wake
    const woken=together?.wake?together.text:wake?.wake?wake.text:''
    const spending=woken?spendReturnLine(this.store.runtime,q.id,id=>{try{return readQuest(id)}catch{return undefined}},()=>readAccountUsage().accounts):''
    const text=spending?woken+'\n'+spending:woken
    const gate=noticeGate(this.store.runtime,q,[...earlier.map(other=>other.run),run].flatMap(other=>other.deliverables),text,run,()=>[...ledger.values()].map(other=>readQuest(other.id)??other))
    if(!gate.send){
     for(const other of earlier)other.lock.release()
     row.state='accepted';row.settled=gate.settled;cleared(row);save(row)
     try{recordHandoff(this.store,q.id,giverBlockers(q),'worker return')}catch(error){console.error('[quests] hand-off not recorded',q.id,error)}
     continue
    }
    row.state='sending';save(row)
    const sent=gate.text?(spending?gate.text+'\n'+spending:gate.text):text
    const ready:ReadyReturn={row,q,text:sent,slot:gate.slot,earlier,save,lock,reason:gate.text?undefined:stopReasonOf(woken),gate,decides:giverDecides(sent)}
    if(ready.reason){stops.push(ready);deferred=true;continue}
    await this.deliver([ready])
   }finally{if(!deferred){lock.release();note(row)}}
  }
  const groups=new Map<string,ReadyReturn[]>()
  for(const ready of stops){const key=JSON.stringify([ready.row.context.sessionID,ready.reason]);groups.set(key,[...(groups.get(key)??[]),ready])}
  for(const group of groups.values()){
   try{await this.deliver(group)}
   finally{for(const ready of group){ready.lock.release();note(ready.row)}}
  }
 }
 private async deliver(group:ReadyReturn[]){
  const [first]=group,quests=[...new Set(group.map(ready=>ready.q.id))]
  const text=quests.length>1?groupedStopNotice(group.map(ready=>({title:ready.q.title,text:ready.text}))):first.text
  const runIDs=group.flatMap(ready=>[...ready.earlier.map(other=>other.row.runID),ready.row.runID])
  const id=group.length>1?'msg_questreturns'+createHash('sha256').update(runIDs.join(',')).digest('hex').slice(0,22):'msg_questreturn'+first.row.runID
  const metadata=group.length>1?{...workerReturnMetadata(first.q.id,first.row.runID,runIDs),questIDs:quests}:workerReturnMetadata(first.q.id,first.row.runID,first.earlier.map(other=>other.row.runID))
  try{
   if(!(noticeKindOf(text)==='DONE'&&nothingElseOpen(this.store,quests)))await timed({plugin:'quests',name:'return.giver-wake',op:first.row.runID},()=>this.host.prompt({sessionID:first.row.context.sessionID,id,delivery:'queue',resume:group.some(ready=>ready.decides),text,metadata}))
   for(const {row,q,text:own,slot,earlier,save,gate} of group){
    row.state='accepted'
    cleared(row)
    noticeSent(this.store.runtime,slot,own,q)
    try{recordHandoff(this.store,q.id,giverBlockers(q),'worker return')}catch(error){console.error('[quests] hand-off not recorded',q.id,error)}
    for(const other of earlier){other.row.state='accepted';other.row.settled='Delivered with run '+row.runID;cleared(other.row);this.save(other.row,other.directory);this.settled(other.directory,other.name)}
    save(row)
   }
  }catch(error){for(const {row,save,gate} of group){if(gate)causeNotDelivered(this.store.runtime,gate);row.state='unknown';held(row,error);save(row)}}
  finally{for(const ready of group)for(const other of ready.earlier)other.lock.release()}
 }
}
