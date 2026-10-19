import {primeSessionRequests,readSessionRequests,sessionRequestsIndexed,TELEMETRY_FILE} from '../../usage/telemetry-store'
import {hostToolCalls,type ToolCall} from '../../usage/worker-time'
import type {RequestRecord} from '../../usage/telemetry'
import {waterfallSources} from '../bench/quest-waterfall'
import {plainWords} from '../review/plain-words'
import {timerWait,type Wait} from '../core/timer'
import {commandKind,commandLimits} from './command-guard'
import {MERGE_OR_PUSH,progressMade,recordTreeProgress,type ProgressSample,type SessionToolCalls,type ToolCallInfo} from './process-progress'

export const FEWEST_GAPS_FOR_A_MEDIAN=6
export const WIDE_MARGIN=4
export const LONGEST_GAP_MARGIN=2
export const MINIMUM_STALL_SILENCE_MS=60_000
export const FROZEN_SILENCE_MS=10*60_000

export type ActivitySpan={start:number;end?:number;tool?:boolean;quiet?:number}
export type StallAssessment={marks:number;gaps:number;lastActivity?:number;silenceMs:number;medianGapMs?:number;longestGapMs?:number;thresholdMs?:number;inFlight:boolean;stalled:boolean;stuckToolCall:boolean;quietSince?:number;frozenSilenceMs:number;frozen:boolean;modelQuietMs?:number}

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)

export function activitySpans(requests:Pick<RequestRecord,'startedAt'|'firstVisibleAt'|'lastOutputAt'|'completedAt'|'state'>[],calls:Pick<ToolCall,'start'|'end'|'status'>[]=[]):ActivitySpan[]{
 return [...requests.map(request=>({start:request.startedAt,end:request.state==='running'?undefined:request.completedAt??request.lastOutputAt??request.firstVisibleAt??request.startedAt,quiet:request.state==='running'?Math.max(request.startedAt,request.lastOutputAt??0,request.firstVisibleAt??0):undefined})),...calls.map(call=>({start:call.start,end:['running','pending','unknown'].includes(call.status)?undefined:call.end,tool:true}))].filter(span=>finite(span.start)&&(span.end===undefined||finite(span.end)&&span.end>=span.start))
}

export function stallAssessment(spans:ActivitySpan[],now:number):StallAssessment{
 const sorted=spans.filter(span=>finite(span.start)&&span.start<=now&&(span.end===undefined||finite(span.end)&&span.end>=span.start)).sort((a,b)=>a.start-b.start)
 const merged:ActivitySpan[]=[]
 for(const span of sorted){const last=merged.at(-1);if(last&&span.start<=(last.end??Infinity))last.end=last.end===undefined||span.end===undefined?undefined:Math.max(last.end,span.end);else merged.push({...span})}
 const gaps=merged.slice(1).map((span,i)=>span.start-merged[i].end!).filter(gap=>gap>0).sort((a,b)=>a-b)
 const last=merged.at(-1),inFlight=!!last&&(last.end===undefined||last.end>now)
 const lastActivity=last?.end??last?.start
 const silenceMs=inFlight||lastActivity===undefined?0:Math.max(0,now-lastActivity)
 const open=sorted.filter(span=>span.end===undefined)
 const stuckToolCall=open.length>0&&open.every(span=>span.tool===true)
 const quietSince=sorted.length?Math.max(...sorted.map(span=>span.end??span.start)):undefined
 const frozenSilenceMs=stuckToolCall&&quietSince!==undefined?Math.max(0,now-quietSince):0
 const frozen=stuckToolCall&&frozenSilenceMs>=FROZEN_SILENCE_MS
 const toolOpen=open.some(span=>span.tool===true),modelOpen=open.filter(span=>span.tool!==true)
    const modelQuietSince=modelOpen.length&&!toolOpen?Math.max(...modelOpen.map(span=>span.quiet??span.start)):undefined
    const modelQuietMs=modelQuietSince===undefined?undefined:Math.max(0,now-modelQuietSince)
    const freeze={stuckToolCall,quietSince,frozenSilenceMs,frozen,modelQuietMs}
 if(gaps.length<FEWEST_GAPS_FOR_A_MEDIAN)return {marks:sorted.length,gaps:gaps.length,lastActivity,silenceMs,inFlight,stalled:false,...freeze}
 const medianGapMs=gaps.length%2?gaps[(gaps.length-1)/2]:(gaps[gaps.length/2-1]+gaps[gaps.length/2])/2
 const longestGapMs=gaps[gaps.length-1]
 const thresholdMs=Math.max(MINIMUM_STALL_SILENCE_MS,medianGapMs*WIDE_MARGIN,longestGapMs*LONGEST_GAP_MARGIN)
 return {marks:sorted.length,gaps:gaps.length,lastActivity,silenceMs,medianGapMs,longestGapMs,thresholdMs,inFlight,stalled:!inFlight&&silenceMs>thresholdMs,...freeze}
}

export type WatchedRun={questID:string;runID:string;questTitle:string;stepTitles:string[];worktree?:string}
export type StallNotice={run:WatchedRun;sessionID:string;assessment:StallAssessment;text:string;command?:string;callStart?:number;timedOut?:boolean}
export type ProcessWatch={calls:(sessionID:string)=>SessionToolCalls;sample:(run:WatchedRun,sessionID:string,call:ToolCallInfo,now:number)=>Promise<ProgressSample|{unavailable:string}>;executing?:(sessionID:string)=>Promise<boolean|undefined>}
export type TreeVerdict={frozen:true;reason:string;command:string;lostCallStart?:number;timedOut?:boolean}|{frozen:false;reason:string;recheckAt:number}

const openToolStart=(spans:ActivitySpan[]|undefined)=>{const open=(spans??[]).filter(span=>span.tool===true&&span.end===undefined);return open.length?Math.max(...open.map(span=>span.start)):undefined}

const minutes=(ms:number)=>{const m=ms/60_000;return m>=10?Math.round(m)+' minutes':m>=1?(Math.round(m*10)/10)+' minutes':Math.round(ms/1000)+' seconds'}

export function stallNoticeText(run:WatchedRun,assessment:StallAssessment){
 return ['RUN STALLED "'+plainWords(run.questTitle)+'"',plainWords(run.stepTitles.join(', '))+': no model request or tool call for '+minutes(assessment.silenceMs)+'; this run usually goes '+minutes(assessment.medianGapMs??0)+' between them (median of '+assessment.gaps+' gaps, longest '+minutes(assessment.longestGapMs??0)+').','(look at its run, steer the Quest Giver, or wait)'].join('\n')
}

export function frozenRunReason(assessment:Pick<StallAssessment,'frozenSilenceMs'>){
 return 'the run froze with a tool call stuck in running and no model request or tool call for '+minutes(assessment.frozenSilenceMs)
}

export function silentStopMs(assessment:Pick<StallAssessment,'thresholdMs'>){return Math.max(FROZEN_SILENCE_MS,assessment.thresholdMs??0)}

export function silentRunReason(silentMs:number,inModelCall:boolean,assessment:Pick<StallAssessment,'thresholdMs'>){
  return (inModelCall?'the run froze inside one model request: no output for ':'the run has been silent for ')+minutes(silentMs)+(inModelCall?'':' with no model request or tool call')+', past its usual gap of '+minutes(silentStopMs(assessment))
}

const shortCommand=(command:string)=>command.replace(/\s+/g,' ').trim().slice(0,120)

export function frozenTreeReason(command:string,stillMs:number){
 return 'the run froze with a tool call stuck in running: its process tree used no CPU time, wrote no output and started no process for '+minutes(stillMs)+' while it ran '+shortCommand(command)
}

export function timedOutReason(command:string,ranMs:number){
 return 'command timed out: '+shortCommand(command)+' ran for '+minutes(ranMs)+', past the '+minutes(commandLimits(command).wallMs)+' limit on '+commandKind(command)+' commands, whatever CPU time or output it used'
}

export function lostCallReason(command:string){
 return 'the host never recorded the end of the tool call '+shortCommand(command)+': no process of it is left and no host is running its session, so nothing will ever finish it'
}

export type StallWatchOptions={ledgerFile?:string;hostDB?:string;wait?:Wait;clock?:()=>number;runOf:(sessionID:string)=>WatchedRun|undefined;notify:(notice:StallNotice)=>void|Promise<void>;frozen?:(notice:StallNotice)=>void|Promise<void>;lost?:(notice:StallNotice)=>void|Promise<void>;tree?:ProcessWatch;held?:(notice:StallNotice)=>void}

export class StallWatch{
 private readonly live=new Map<string,{lastObserved?:number;cancel?:()=>void;notifiedSilenceFrom?:number;frozeFrom?:number;spans?:ActivitySpan[];baseline?:{key:string;sample:ProgressSample};heldReason?:string;measuredStuckSince?:number}>()
 constructor(readonly options:StallWatchOptions){void primeSessionRequests(this.file()).catch(()=>{})}
 private clock(){return (this.options.clock??Date.now)()}
 private row(sessionID:string){let row=this.live.get(sessionID);if(!row){row={};this.live.set(sessionID,row)}return row}
 recorded(sessionID:string,from:number,to:number):ActivitySpan[]{
  const file=this.options.ledgerFile??TELEMETRY_FILE
  const requests=readSessionRequests(sessionID,file).records
  const hostDB=this.options.hostDB??waterfallSources(process.env).hostDB
  let calls:ToolCall[]=[]
  try{calls=hostToolCalls(hostDB,sessionID,from,to).calls}catch{}
  return activitySpans(requests,calls)
 }
 private assessmentOf(sessionID:string,now:number,fresh:boolean){
  const row=this.row(sessionID)
  if(fresh||!row.spans)row.spans=this.recorded(sessionID,0,now)
  const assessment=stallAssessment(row.spans,now)
  if(row.lastObserved!==undefined){assessment.lastActivity=Math.max(assessment.lastActivity??row.lastObserved,row.lastObserved);assessment.silenceMs=assessment.inFlight?0:Math.max(0,now-assessment.lastActivity);assessment.stalled=!assessment.inFlight&&assessment.thresholdMs!==undefined&&assessment.silenceMs>assessment.thresholdMs;if(assessment.modelQuietMs!==undefined)assessment.modelQuietMs=Math.min(assessment.modelQuietMs,Math.max(0,now-row.lastObserved));if(assessment.stuckToolCall){assessment.quietSince=Math.max(assessment.quietSince??row.lastObserved,row.lastObserved);assessment.frozenSilenceMs=Math.max(0,now-assessment.quietSince);assessment.frozen=assessment.frozenSilenceMs>=FROZEN_SILENCE_MS}}
  return assessment
 }
 private file(){return this.options.ledgerFile??TELEMETRY_FILE}
 observe(sessionID:string,at=this.clock()){
  if(!this.options.runOf(sessionID))return undefined
  const row=this.row(sessionID)
  row.lastObserved=Math.max(row.lastObserved??at,at)
  if(!sessionRequestsIndexed(this.file())){void primeSessionRequests(this.file()).then(()=>this.check(sessionID)).catch(()=>{});return undefined}
  const assessment=this.assessmentOf(sessionID,at,false)
  this.arm(sessionID,assessment,at)
  const stuckSince=assessment.stuckToolCall?openToolStart(row.spans):undefined
  const run=stuckSince!==undefined&&row.measuredStuckSince!==stuckSince&&this.options.tree?this.options.runOf(sessionID):undefined
  if(run){row.measuredStuckSince=stuckSince;void this.measure(run,sessionID,at).catch(()=>{})}
  return assessment
 }
 private arm(sessionID:string,assessment:StallAssessment,now:number){
  const row=this.row(sessionID)
  row.cancel?.();row.cancel=undefined
  const quietFrom=assessment.modelQuietMs!==undefined?now-assessment.modelQuietMs:assessment.inFlight||assessment.lastActivity===undefined?undefined:assessment.lastActivity
  const stopDue=quietFrom===undefined?undefined:quietFrom+silentStopMs(assessment)+1
  const notifyDue=assessment.inFlight||assessment.thresholdMs===undefined||assessment.lastActivity===undefined||row.notifiedSilenceFrom===assessment.lastActivity?undefined:assessment.lastActivity+assessment.thresholdMs+1
  const dues=[stopDue,notifyDue].filter((due):due is number=>due!==undefined)
  const due=assessment.stuckToolCall&&assessment.quietSince!==undefined?assessment.quietSince+FROZEN_SILENCE_MS:dues.length?Math.min(...dues):undefined
  if(due===undefined)return
  row.cancel=(this.options.wait??timerWait)(due-now,()=>{row.cancel=undefined;void this.check(sessionID)})
}
 async check(sessionID:string,now=this.clock()):Promise<StallAssessment|undefined>{
  if(!sessionRequestsIndexed(this.file()))await primeSessionRequests(this.file()).catch(()=>{})
  const run=this.options.runOf(sessionID)
  if(!run){this.forget(sessionID);return undefined}
  const row=this.row(sessionID)
   const assessment=this.assessmentOf(sessionID,now,true)
  if(assessment.frozen){
   if(row.frozeFrom===assessment.quietSince)return assessment
   let text=frozenRunReason(assessment),command:string|undefined,callStart:number|undefined,timedOut=false
   if(this.options.tree){
    const verdict=await this.judgeTree(run,sessionID,now)
    if(!verdict.frozen){
     assessment.frozen=false
     row.cancel?.();row.cancel=(this.options.wait??timerWait)(Math.max(0,verdict.recheckAt-now),()=>{row.cancel=undefined;void this.check(sessionID)})
     if(row.heldReason!==verdict.reason){row.heldReason=verdict.reason;this.options.held?.({run,sessionID,assessment,text:verdict.reason})}
     return assessment
    }
    text=verdict.reason;command=verdict.command;callStart=verdict.lostCallStart;timedOut=verdict.timedOut===true
   }
   row.cancel?.();row.cancel=undefined
   row.frozeFrom=assessment.quietSince
   const handler=callStart!==undefined&&this.options.lost?this.options.lost:this.options.frozen??this.options.notify
   await handler({run,sessionID,assessment,text,...(command!==undefined?{command}:{}),...(callStart!==undefined?{callStart}:{}),...(timedOut?{timedOut}:{})})
   return assessment
  }
  const silent=assessment.modelQuietMs??(assessment.inFlight?undefined:assessment.silenceMs)
   if(silent!==undefined&&silent>silentStopMs(assessment)){
    const quietFrom=now-silent
    if(row.frozeFrom===quietFrom)return assessment
    row.cancel?.();row.cancel=undefined
    row.frozeFrom=quietFrom
    await(this.options.frozen??this.options.notify)({run,sessionID,assessment:{...assessment,frozenSilenceMs:silent},text:silentRunReason(silent,assessment.modelQuietMs!==undefined,assessment)})
    return assessment
   }
   if(assessment.stuckToolCall&&this.options.tree)await this.measure(run,sessionID,now)
  if(!assessment.stalled){this.arm(sessionID,assessment,now);return assessment}
  if(row.notifiedSilenceFrom===assessment.lastActivity)return assessment
   row.notifiedSilenceFrom=assessment.lastActivity
  await this.options.notify({run,sessionID,assessment,text:stallNoticeText(run,assessment)})
   this.arm(sessionID,assessment,now)
  return assessment
 }
 private async measure(run:WatchedRun,sessionID:string,now:number):Promise<{calls:SessionToolCalls;running?:ToolCallInfo;key?:string;baseline?:ProgressSample;fresh?:boolean;unavailable?:string}>{
  const row=this.row(sessionID),calls=this.options.tree!.calls(sessionID),running=calls.running
  if(!running)return {calls}
  const key=running.start+':'+running.command
  if(row.baseline?.key===key)return {calls,running,key,baseline:row.baseline.sample}
  const sample=await this.options.tree!.sample(run,sessionID,running,now)
  if('unavailable' in sample)return {calls,running,key,unavailable:sample.unavailable}
  row.baseline={key,sample}
  return {calls,running,key,baseline:sample,fresh:true}
 }
 async judgeTree(run:WatchedRun,sessionID:string,now:number):Promise<TreeVerdict>{
  const row=this.row(sessionID),later=now+FROZEN_SILENCE_MS
  const measured=await this.measure(run,sessionID,now),{running}=measured
  if(!running)return {frozen:false,reason:'Stall stop held: the host shows no running tool call to measure.',recheckAt:later}
  if(MERGE_OR_PUSH.test(running.command))return {frozen:false,reason:'Stall stop held: the run is merging or pushing ('+shortCommand(running.command)+'), and a stop never lands during a merge or push.',recheckAt:later}
  if(measured.unavailable)return {frozen:false,reason:'Stall stop held: the process list could not be read ('+measured.unavailable+'), so progress is unknown.',recheckAt:later}
  if(measured.fresh||!measured.baseline)return {frozen:false,reason:'Stall stop held: the watch started measuring the process tree of '+shortCommand(running.command)+'.',recheckAt:later}
  const baseline=measured.baseline
  const sample=await this.options.tree!.sample(run,sessionID,running,now)
  if('unavailable' in sample)return {frozen:false,reason:'Stall stop held: the process list could not be read ('+sample.unavailable+'), so progress is unknown.',recheckAt:later}
  const progress=progressMade(baseline,sample)
  recordTreeProgress(sessionID,now,!!progress)
  const timedOut=now-running.start>=commandLimits(running.command).wallMs?{frozen:true as const,reason:timedOutReason(running.command,now-running.start),command:running.command,timedOut:true}:undefined
  if(timedOut&&(progress||now-baseline.at<FROZEN_SILENCE_MS))return timedOut
  if(progress){row.baseline={key:measured.key!,sample};return {frozen:false,reason:'Stall stop held: '+progress+' while it ran '+shortCommand(running.command)+', so the run is working.',recheckAt:later}}
  const stillMs=now-baseline.at
  if(stillMs<FROZEN_SILENCE_MS)return {frozen:false,reason:'Stall stop held: the process tree of '+shortCommand(running.command)+' has been still for '+minutes(stillMs)+' only.',recheckAt:baseline.at+FROZEN_SILENCE_MS}
  if(!sample.processes.length){
   const executing=await this.options.tree!.executing?.(sessionID).catch(()=>undefined)
   if(executing===false)return {frozen:true,reason:lostCallReason(running.command),command:running.command,lostCallStart:running.start}
   return {frozen:false,reason:'Stall stop held: no process of '+shortCommand(running.command)+' was found'+(executing?' while a host still runs its session, as when the call waits on a permission question':' and no host answered whether it still runs its session')+', so its progress is unknown.',recheckAt:later}
  }
  return {frozen:true,reason:frozenTreeReason(running.command,stillMs),command:running.command}
 }
 assess(sessionID:string,now=this.clock()):StallAssessment|undefined{
  if(!this.options.runOf(sessionID))return undefined
  return this.assessmentOf(sessionID,now,true)
 }
 private refreshing?:Promise<void>
 private refreshAgain=false
 refresh():Promise<void>{
  if(this.refreshing){this.refreshAgain=true;return this.refreshing}
  const running=(async()=>{
   do{this.refreshAgain=false;for(const sessionID of [...this.live.keys()]){await this.check(sessionID).catch(()=>undefined);await new Promise<void>(next=>setImmediate(next))}}while(this.refreshAgain)
  })().finally(()=>{if(this.refreshing===running)this.refreshing=undefined})
  this.refreshing=running
  return running
 }
 watch(sessionIDs:Iterable<string>){for(const sessionID of sessionIDs)void this.check(sessionID)}
 forget(sessionID:string){const row=this.live.get(sessionID);row?.cancel?.();this.live.delete(sessionID)}
 dispose(){for(const id of [...this.live.keys()])this.forget(id)}
}

export const ACTIVITY_EVENT=/^session\.(step\.(started|ended)|tool\.(called|success|failed)|text\.ended|execution\.started)$/
export const ENDED_EVENT=/^session\.execution\.(succeeded|failed|interrupted)$/
