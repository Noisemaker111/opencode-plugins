import {readAllQuests} from '../index'
import {questReference} from '../core/references'
import {boardCounts,boardHeadline,questLane,summaryOf,workerBoardCounts,workerCountsLine,workerReadingsOf,type LockWaits,type WorkerEvidenceReader,type WorkerHostSignals} from '../board/board'
import {hostRecords} from '../host/host-role'
import {hostStates,runState} from './state-classes'
import {warningEmitter,warningLine,warningRow} from './warnings'
import {findingsOf} from './findings'
import {OWNED_RUN,nativeRunID} from '../runs/session-lineage'
import {readUserGiver} from '../giver-registry.mjs'
import {readSessionRequests,TELEMETRY_FILE} from '../../usage/telemetry-store'
import { getAccountUsage, readAccountUsage, plansView, usageView } from '../../usage-service/on-computer'
import {existsSync,readdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {contextGrowth} from '../board/context-growth'
import {budgetPicture} from '../../usage/session-budget'
import {routesView} from '../routing/role-routes'
import {recentRequests,routeOutages,ROUTE_HISTORY_BYTES,ROUTE_HISTORY_MS} from '../../models/observed-route-health'
import {freePools} from '../../usage/free-allowance'
import {questSettingsFile} from '../config/quest-settings.mjs'
import {driftNow} from '../../scripts/version-drift.mjs'
import {readOwnershipMap,type HostPlace} from '../giver/ownership-map'
import {handoffsPicture} from '../giver/handoff-outcome'
import type {QuestStore} from '../store'
import type {Quest} from '../types'
import {readableQueueSettings} from '../workers/quest-queue'
import {modeLine} from '../workers/trial'
import {admissionPicture,trialQuests,waitContext} from '../workers/worker-admission'
import {updateStatus} from '../workers/update-status'
import {liveHostSignals,runStatusReader} from '../board/activity'
import type {StatusReader} from '../runs/run-status'
import {sessionsPicture} from './sessions-picture'
import {hourlyPicture} from './hourly-picture'
import {MINIMUM_STALL_SILENCE_MS} from '../workers/stall-signal'
import {SPANS_FILE} from '../../scripts/span-store'
import {foldSpans,statsOf,windowOf} from './span-aggregate'

export type PictureSources={checksFile?:string;telemetryFile?:string;accountFile?:string;roleFile?:string;ledgerFile?:string;hostFile?:string;now?:()=>number;freePaths?:{catalog:string;requests:string;analysis:string;probes:string;channelDir?:string;openCodeDb?:string};freeFetch?:typeof globalThis.fetch;freeKey?:string}
export const QUESTIONS=['usage','workers','board','routes','context','owners','handoffs','budget','sessions','hourly'] as const
export type Question=typeof QUESTIONS[number]

const runRoute=(run:any)=>run.providerID&&run.modelID?run.providerID+'/'+run.modelID+(run.reasoningEffort?'#'+run.reasoningEffort:''):run.model??null

function quests(store:Pick<QuestStore,'projectRoot'>):Quest[]{
 return readAllQuests(store.projectRoot).flatMap(row=>row.quest?[row.quest]:[])
}

const evidenceReader=(reader:StatusReader):WorkerEvidenceReader=>({evidence:(run,now)=>reader.evidence?.(run,now)??{tools:0},toolTimes:now=>reader.toolTimes?.(now)??{medianMs:MINIMUM_STALL_SILENCE_MS}})

export function workerStateCounts(all:Quest[],now:number,reader:StatusReader,signals:WorkerHostSignals=liveHostSignals()){
 const counts=workerBoardCounts(all,now,evidenceReader(reader),signals)
 return {...counts,text:workerCountsLine(counts)}
}

const liveHosts=()=>{try{return hostStates(hostRecords(),Date.now())}catch{return []}}

export function workersPicture(store:Pick<QuestStore,'projectRoot'|'runtime'>,now=Date.now(),reader:StatusReader=runStatusReader(),signals?:WorkerHostSignals){
 const status=(run:Quest['sessions'][number])=>{try{return reader.status(run,now)}catch{return undefined}}
 const all=quests(store)
 const observed=new Map<string,ReturnType<typeof runState>>()
 try{for(const row of workerReadingsOf(all.map(summaryOf),now,evidenceReader(reader),signals??liveHostSignals()))observed.set(row.run.runID??row.run.callID,runState(row.run.runID??row.run.callID,row.reading,now))}catch{}
 const items=all.filter(q=>q.state!=='Archived').flatMap(q=>q.sessions.filter(run=>OWNED_RUN.has(run.state)).map(run=>{
  const seen=observed.get(run.runID??run.callID)
  return {quest:questReference(q),title:q.title.slice(0,100),run:run.runID??run.callID,state:run.state,route:runRoute(run),
  steps:run.deliverables.map(id=>q.stages.find(step=>step.id===id)?.title??id),
  startedAt:run.startedAt??null,minutes:run.startedAt?Math.round((now-Date.parse(run.startedAt))/60_000):null,
  waiting:run.awaiting?.ask??null,session:nativeRunID(run)??null,status:status(run)?.text??null,statusKind:status(run)?.kind??null,
  observed:seen?{state:seen.state,since:seen.sinceAt,forMs:seen.forMs}:null}
 }))
 return {at:now,running:items.length,counts:workerStateCounts(all,now,reader,signals),items,hosts:liveHosts()}
}

const DAY_MS=86_400_000
export function lockWaitsOf(file:string,now:number):LockWaits|undefined{
 try{
  const series=windowOf(foldSpans(file),now-DAY_MS,now).names.get('quests · lock.wait')
  if(!series)return undefined
  const stats=statsOf(series)
  return {count:stats.count,p95Ms:stats.p95,p99Ms:stats.p99}
 }catch{return undefined}
}

export function boardPicture(store:Pick<QuestStore,'projectRoot'>&Partial<Pick<QuestStore,'runtime'>>,now=Date.now(),reader:StatusReader=runStatusReader(),signals?:WorkerHostSignals){
 const all=quests(store)
 const open=all.filter(q=>q.state!=='Archived')
 const byID=new Map(all.map(q=>[q.id,q] as const))
 let context:ReturnType<typeof waitContext>|undefined
 try{context=store.runtime?waitContext({projectRoot:store.projectRoot,runtime:store.runtime},id=>byID.get(id)):undefined}catch{}
 const counts={...boardCounts(all,now,context),lockWaits:lockWaitsOf(process.env.OPENCODE_SPANS_FILE??SPANS_FILE,now)}
 const lanes:Record<string,number>={}
 for(const q of open){const lane=questLane(q);lanes[lane]=(lanes[lane]??0)+1}
 const items=open.sort((a,b)=>Date.parse(b.updatedAt??'')-Date.parse(a.updatedAt??'')).slice(0,30).map(q=>({quest:questReference(q),title:q.title.slice(0,100),lane:questLane(q),state:q.state,done:q.stages.filter(step=>step.status==='done').length,steps:q.stages.length,running:q.executingCount||0,updatedAt:q.updatedAt??null}))
 const settings=readableQueueSettings(),modeText=modeLine(trialQuests(store.projectRoot,settings),settings)
 let workers:ReturnType<typeof workerStateCounts>|undefined
 try{workers=workerStateCounts(all,now,reader,signals)}catch{}
 let update:ReturnType<typeof updateStatus>|undefined
 try{update=updateStatus({now})}catch{}
 const drift=driftNow()
 const raised=warningEmitter().list()
 const line=warningLine(raised)
 const found=open.flatMap(q=>findingsOf(q).map(finding=>({quest:questReference(q),title:q.title.slice(0,100),...finding}))).sort((a,b)=>b.at.localeCompare(a.at))
 return {at:now,...counts,text:(modeText?modeText+'. ':'')+boardHeadline(counts)+(line?' '+line:''),mode:settings.mode,...(found.length?{findings:found.slice(0,20)}:{}),...(modeText?{modeText}:{}),lanes,items,...(update?{update}:{}),drift:{checkedAt:drift.checkedAt,alerts:drift.alerts},...(workers?{workers}:{}),...(raised.length?{warnings:raised.map(warning=>warningRow(warning,now))}:{})}
}

export function usagePicture(sources:PictureSources={}){
 const now=(sources.now??Date.now)()
 const snapshot=readAccountUsage(sources.accountFile,now)
 const zone=Intl.DateTimeFormat().resolvedOptions().timeZone
 const windows=usageView(snapshot.accounts,{},now,zone).windows
 const plans=plansView(snapshot.accounts,now,zone).accounts
 if(!sources.accountFile&&plans.some(plan=>plan.state==='stale'))void getAccountUsage().catch(()=>{})
 return {at:now,updatedAt:snapshot.updatedAt||null,accounts:plans.map(plan=>({account:plan.account,provider:plan.provider,state:plan.state,limit:plan.limit,ageSeconds:plan.ageSeconds,stale:plan.stale,summary:plan.summary,
  windows:windows.filter(w=>w.account===plan.account).map(w=>({window:w.window,scope:w.scope,model:w.model,remainingPercent:w.remainingPercent,usedPercent:w.usedPercent,resetAt:w.resetAt}))})),diagnostics:snapshot.diagnostics}
}

export function contextPicture(store:Pick<QuestStore,'runtime'>,sources:PictureSources={}){
 const file=sources.telemetryFile??TELEMETRY_FILE
 const sessions:{role:'giver';sessionID:string}[]=[]
 try{const giver=readUserGiver(store.runtime);if(giver?.state==='bound')sessions.push({role:'giver',sessionID:giver.sessionID})}catch{}
 return {at:(sources.now??Date.now)(),sessions:sessions.map(({role,sessionID})=>{const growth=contextGrowth(sessionID,readSessionRequests(sessionID,file).records);const {series,...rest}=growth;return {role,...rest,recent:series.slice(-10)}})}
}

const hostRow=(host:HostPlace|undefined)=>host?{host:host.id,generation:host.generation??null,hostState:host.state}:{host:null,generation:null,hostState:null}

export function ownersPicture(store:Pick<QuestStore,'projectRoot'|'runtime'>,now=Date.now()){
 const map=readOwnershipMap(store)
 const titles=new Map(quests(store).map(q=>[q.id,q]))
 const items=map.quests.map(row=>{
  const q=titles.get(row.questID)
  return {quest:q?questReference(q):row.questID,title:(q?.title??'').slice(0,100),giver:row.giver?.sessionID??null,currentGiver:row.giver?.current??false,...hostRow(row.giver?.host),
   workers:row.workers.map(worker=>({run:worker.runID,session:worker.sessionID,state:worker.state,...hostRow(worker.host)}))}
 })
 return {at:now,activeHost:map.activeHost?{host:map.activeHost.id,generation:map.activeHost.generation??null}:null,currentGiver:map.currentGiver?{session:map.currentGiver.sessionID,host:map.currentGiver.host?.id??null}:null,owned:items.length,items}
}

export function answerQuestion(store:Pick<QuestStore,'projectRoot'|'runtime'>,question:Question,sources:PictureSources={}){
 const now=(sources.now??Date.now)()
 if(question==='owners')return ownersPicture(store,now)
 if(question==='usage')return {...usagePicture(sources),admission:admissionPicture(store,now,sources.checksFile)}
 if(question==='workers')return workersPicture(store,now)
 if(question==='sessions')return sessionsPicture(store,now,runStatusReader(),sources)
 if(question==='board')return boardPicture(store,now)
 if(question==='routes')return {at:now,roles:routesView(store.runtime,sources.roleFile??questSettingsFile()),outages:routeOutages(recentRequests(sources.telemetryFile??TELEMETRY_FILE,{sinceMs:now-ROUTE_HISTORY_MS,ceilingBytes:ROUTE_HISTORY_BYTES}),now),pools:freePools(now).pools}
 if(question==='handoffs')return handoffsPicture(store.runtime,now)
 if(question==='hourly')return hourlyPicture(store,{ledgerFile:sources.ledgerFile,hostFile:sources.hostFile,now:sources.now})
 if(question==='budget')return budgetPicture({projectRoot:store.projectRoot,runtime:store.runtime,ledgerFile:sources.ledgerFile,accountFile:sources.accountFile,now:sources.now})
 return contextPicture(store,sources)
}

export function pictureHandoff(store:Pick<QuestStore,'projectRoot'|'runtime'>,why:string,sources:PictureSources={}){
 const board=boardPicture(store),workers=workersPicture(store)
 const lines=[
  'HANDOFF: you are a fresh Quest Giver session. The last one ended because '+why+'.',
  'Your picture lives in the Quest records, the usage ledger and the running workers, not in old chat. Read them when you need more.',
  'The user asked for this new Quest Giver. Put each follow-up of the last one onto the Quest it concerns with update: a step note, or a new step with deferred "parent-done" or "jon". Never open a new Quest for one; create refuses in this turn.',
  board.text+' Lanes: '+Object.entries(board.lanes).map(([lane,count])=>lane+' '+count).join(', ')+'.',
  ...(board.warnings?.length?['Warnings: '+board.warnings.map(warning=>warning.text+(warning.quest?' ('+warning.quest+')':'')).join(' ')]:[]),
  ...board.items.slice(0,8).map(row=>'- '+row.quest+': '+row.title+' ('+row.lane+', '+row.done+'/'+row.steps+' steps'+(row.running?', '+row.running+' running':'')+')'),
  workers.counts.text,
  ...workers.items.slice(0,8).map(row=>'- '+row.quest+' run '+row.run+' on '+(row.route??'an unknown route')+(row.minutes!==null?' for '+row.minutes+' min':'')+(row.waiting?', waiting: '+row.waiting:'')),
 ]
 return lines.join('\n')
}
