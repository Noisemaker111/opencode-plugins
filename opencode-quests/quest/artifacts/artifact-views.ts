import {artifactStyles as s,escapeHtml as e,sanitizeArtifactHtml} from './artifact-html'
import {latestSessionAttempts} from '../runs/session-lineage'
import {runReviews} from '../review/review-record'
import {questReplays,type Replay} from '../bench/replay-record'
import {plainWords} from '../review/plain-words'
import {NEEDS_JON_LABEL} from '../core/state-machine'
import type {Quest,QuestSession,QuestStage} from '../types'

export type Artifact={title:string;view:'quest'|'usage'|'html';questID?:string;html:string}

const chip=(text:string,style=s.chip)=>'<span style="'+style+'">'+e(text)+'</span>'
const when=(iso:string|undefined)=>{const at=iso?Date.parse(iso):NaN;return Number.isFinite(at)?'<time datetime="'+e(iso!)+'" style="'+s.muted+'">'+e(new Date(at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))+'</time>':''}
const stepChip=(step:QuestStage)=>step.status==='done'?chip('done',s.chipAccent):step.status==='blocked'?chip(step.needsJon?'needs you: '+NEEDS_JON_LABEL[step.needsJon]:'blocked',s.chipYou):step.status==='working'?chip('working',s.chipAccent):chip('queued')
const routeName=(run:QuestSession)=>{const model=run.providerID&&run.modelID?run.providerID+'/'+run.modelID:run.model;return (model??'an unrecorded route')+(run.reasoningEffort?'#'+run.reasoningEffort:'')}
const runChip=(run:QuestSession)=>run.state==='completed'?chip('completed',s.chipAccent):run.state==='failed'||run.state==='missing'||run.state==='stale'?chip(run.state,s.chipDanger):run.state==='cancelled'?chip('stopped'):chip(run.state,s.chipAccent)
const verdictChip=(verdict:string|undefined)=>verdict==='pass'?chip('passed review',s.chipAccent):verdict==='rework'?chip('sent back',s.chipYou):verdict==='cannot tell'?chip('review could not tell'):''

export function questCard(q:Quest,runtime?:string,now=Date.now()):Artifact{
 const reviews=runReviews(q)
 const done=q.stages.filter(step=>step.status==='done').length
 const steps=q.stages.map(step=>{
  const note=step.status==='blocked'?step.blocker?.requires??step.note:step.status==='done'?step.result?.summary??step.note:step.note
  return '<li style="'+s.row+'">'+stepChip(step)+'<span style="flex:1;min-width:0">'+e(plainWords(step.title))+(note?' <span style="'+s.muted+'">· '+e(plainWords(note))+'</span>':'')+'</span></li>'
 }).join('')
 const runs=[...latestSessionAttempts(q.sessions)].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)).map(run=>{
  const id=run.runID??run.callID,review=reviews[id]
  const stepTitles=run.deliverables.map(stepID=>q.stages.find(step=>step.id===stepID)?.title??stepID).join(', ')
  return '<tr><td style="'+s.cell+'">'+runChip(run)+'</td><td style="'+s.cell+'">'+e(routeName(run))+'</td><td style="'+s.cell+'">'+e(plainWords(stepTitles))+'</td><td style="'+s.cell+'">'+verdictChip(review?.verdict)+(review?.reasons?.length?' <span style="'+s.muted+'">'+e(plainWords(review.reasons.join('; ')))+'</span>':'')+'</td><td style="'+s.cell+'">'+when(run.updatedAt)+'</td></tr>'
 }).join('')
 const benches:Replay[]=runtime?questReplays(runtime,q.id):[]
 const benchRows=benches.map(bench=>'<tr><td style="'+s.cell+'">'+chip(bench.state==='done'?'done':bench.state)+'</td><td style="'+s.cell+'">'+e(bench.route.providerID+'/'+bench.route.modelID+'#'+bench.route.reasoning)+'</td><td style="'+s.cell+'">'+verdictChip(bench.review?.verdict)+'</td><td style="'+s.cell+'">'+(bench.cost?.[0]?.estimate!=null?e(bench.cost[0].currency+' '+bench.cost[0].estimate.toFixed(3)):'')+'</td></tr>').join('')
 const result=q.result?'<p style="margin:8px 0 0;'+s.soft+'">'+e(plainWords(q.result.summary))+(q.result.howToUse?' <span style="'+s.muted+'">'+e(plainWords(q.result.howToUse))+'</span>':'')+'</p>':''
 const share=q.stages.length?Math.round(done/q.stages.length*100):0
 const html='<div style="'+s.card+'">'+
  '<h3 style="'+s.title+'">'+e(plainWords(q.title))+' '+chip(q.state)+'</h3>'+
  '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div style="flex:1;'+s.meter+'"><div style="'+s.fill+';width:'+share+'%"></div></div><span style="'+s.muted+'">'+done+' of '+q.stages.length+' steps</span>'+(q.delivered?chip('delivered',s.chipAccent):'')+'</div>'+
  (q.stages.length?'<ul style="list-style:none;margin:0;padding:0">'+steps+'</ul>':'')+
  (runs?'<h4 style="margin:10px 0 2px;font-size:12px;'+s.muted+'">Runs</h4><table style="'+s.table+'"><thead><tr><th style="'+s.head+'">State</th><th style="'+s.head+'">Route</th><th style="'+s.head+'">Steps</th><th style="'+s.head+'">Review</th><th style="'+s.head+'">When</th></tr></thead><tbody>'+runs+'</tbody></table>':'')+
  (benchRows?'<h4 style="margin:10px 0 2px;font-size:12px;'+s.muted+'">Benches</h4><table style="'+s.table+'"><thead><tr><th style="'+s.head+'">State</th><th style="'+s.head+'">Route</th><th style="'+s.head+'">Review</th><th style="'+s.head+'">Cost</th></tr></thead><tbody>'+benchRows+'</tbody></table>':'')+
  result+
  '<p style="margin:8px 0 0;font-size:11px;'+s.muted+'">as of '+e(new Date(now).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}))+'</p></div>'
 return {title:plainWords(q.title),view:'quest',questID:q.id,html:sanitizeArtifactHtml(html)}
}

export type UsageAccountView={accountID:string;provider:string;plan:string;state:string;remainingPoints?:number|null;resetAt?:number|null;paceMultiplier?:number|null;requestedSlots?:number;windowID?:string|null;pacing?:{desiredSlots:number;ceiling:number;reason:string}|null}
export type UsageCardInput={at:number;accounts:UsageAccountView[];inFlight?:Record<string,number>;session?:{requests:number;runningRequests:number;sessions:number;tokens?:{input?:number|null;output?:number|null;cacheRead?:number|null}|null};diagnostics?:string[]}

const resetIn=(resetAt:number|null|undefined,now:number)=>{if(resetAt==null)return '';const ms=resetAt-now;if(ms<=0)return 'reset due';const h=Math.floor(ms/3_600_000),m=Math.round(ms%3_600_000/60_000);return 'resets in '+(h?h+'h ':'')+m+'m'}
const pointsLeft=(points:number|null|undefined)=>points==null?'':Math.round(points)+'% left'

export function usageCard(input:UsageCardInput):Artifact{
 const now=input.at
 const rows=input.accounts.map(account=>{
  const left=account.remainingPoints==null?null:Math.max(0,Math.min(100,account.remainingPoints))
  const pace=account.paceMultiplier==null?'':account.paceMultiplier.toFixed(2)+'x pace needed'
  const flying=input.inFlight?.[account.accountID]
  return '<li style="'+s.row+';flex-wrap:wrap"><span style="min-width:160px;font-weight:500">'+e(account.provider)+' <span style="'+s.muted+'">'+e(account.plan)+'</span></span>'+
   '<span style="flex:1;min-width:120px;'+s.meter+'">'+(left==null?'':'<span style="'+s.fill+';width:'+left+'%"></span>')+'</span>'+
   '<span style="min-width:70px;text-align:right">'+e(pointsLeft(left))+'</span>'+chip(account.state,account.state==='ready'?s.chipAccent:account.state==='quota-constrained'?s.chipYou:s.chip)+
   '<span style="width:100%;font-size:11.5px;'+s.muted+'">'+e([resetIn(account.resetAt,now),pace,flying?flying+' in flight':'',account.pacing?'wants '+account.pacing.desiredSlots+' of '+account.pacing.ceiling+' workers':''].filter(Boolean).join(' · '))+'</span></li>'
 }).join('')
 const session=input.session
 const totals=session?'<p style="margin:8px 0 0;'+s.soft+'">'+session.requests+' model requests across '+session.sessions+' sessions'+(session.runningRequests?', '+session.runningRequests+' running now':'')+(session.tokens?.input!=null&&session.tokens?.output!=null?' · '+Math.round((session.tokens.input+(session.tokens.cacheRead??0))/1000)+'k in, '+Math.round(session.tokens.output/1000)+'k out':'')+'</p>':''
 const diagnostics=input.diagnostics?.length?'<p style="margin:6px 0 0;font-size:11.5px;'+s.muted+'">'+e(plainWords(input.diagnostics.slice(0,3).join('; ')))+'</p>':''
 const html='<div style="'+s.card+'"><h3 style="'+s.title+'">Usage and pacing</h3>'+(rows?'<ul style="list-style:none;margin:0;padding:0">'+rows+'</ul>':'<p style="'+s.muted+'">No account usage is recorded yet.</p>')+totals+diagnostics+'<p style="margin:8px 0 0;font-size:11px;'+s.muted+'">as of '+e(new Date(now).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}))+'</p></div>'
 return {title:'Usage and pacing',view:'usage',html:sanitizeArtifactHtml(html)}
}

export function htmlCard(title:string|undefined,html:string):Artifact{
 return {title:plainWords(title?.trim()||'Card'),view:'html',html:sanitizeArtifactHtml(html)}
}
