import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {artifactStyles as s,escapeHtml as e,sanitizeArtifactHtml} from './artifact-html'
import type {Artifact} from './artifact-views'
import {readJsonRecord,writeFileDurable} from '../core/durable-file.mjs'
import {acquireLock} from '../locking.mts'
import {QuestError} from '../api'
import {plainWords} from '../review/plain-words'
import {ownedRuns} from '../runs/session-lineage'
import {PICK_ACTION,lookupIn,pickWaiting} from './studio-picks'
import {NEEDS_JON_LABEL} from '../core/state-machine'
import {diskAlert} from '../../scripts/disk-guard.mjs'
import type {NeedsJon,Quest} from '../types'

export type JonAsk={key:string;questID:string;questTitle:string;kind:'permission'|NeedsJon;what:string;since?:string;action:string}
export type JonCardRecord={version:1;fingerprint:string;keys:string[];shownAt:string}
export type JonCardDue={show:boolean;asks:JonAsk[];fresh:JonAsk[];fingerprint:string}

export const JON_CARD_TITLE='Needs you'
export const jonCardFile=(runtime:string)=>join(runtime,'front-jon-card.json')

const ACTION:Record<'permission'|NeedsJon,string>={
 permission:'Open the pending approval in Quest Web and allow or reject it.',
 'sign-in':'Sign in to the account named here.',
 spend:'Tell the Quest Giver whether to spend this money.',
 'main-release':'Tell the Quest Giver whether to release v2 to main.',
 destructive:'Tell the Quest Giver whether to go ahead with this destructive action.',
 choice:'Tell the Quest Giver what you decide.',
}

export function jonAsks(quests:Quest[]):JonAsk[]{
 const asks:JonAsk[]=[],lookup=lookupIn(quests)
 for(const q of quests){
  if(q.state==='Archived'||q.archive)continue
  const questTitle=plainWords(q.title)
  for(const run of ownedRuns(q)){
   if(!run.awaiting)continue
   const steps=run.deliverables.map(id=>q.stages.find(step=>step.id===id)?.title??'').filter(Boolean).join(', ')
   asks.push({key:'permission:'+q.id+':'+run.awaiting.requestID,questID:q.id,questTitle,kind:'permission',what:plainWords('A worker on '+(steps||'this Quest')+' waits for you to allow: '+run.awaiting.ask),since:run.awaiting.at,action:ACTION.permission})
  }
  for(const step of q.stages){
   if(step.status!=='blocked'||!step.needsJon)continue
   const detail=plainWords(step.blocker?.requires??step.note??'')
   asks.push({key:'step:'+q.id+':'+step.id+':'+step.needsJon,questID:q.id,questTitle,kind:step.needsJon,what:plainWords(step.title)+' needs '+NEEDS_JON_LABEL[step.needsJon]+(detail?': '+detail:''),action:ACTION[step.needsJon]})
  }
  for(const set of pickWaiting(q,lookup)){
   const ready=set.variations.filter(row=>row.state==='ready').length
   asks.push({key:'pick:'+q.id+':'+set.id,questID:q.id,questTitle,kind:'choice',what:plainWords('Pick one of '+ready+' variations of '+set.thing+' in Design Studio.'),...(set.askedAt?{since:set.askedAt}:{}),action:PICK_ACTION})
  }
 }
 return asks.sort((a,b)=>a.key.localeCompare(b.key))
}

export const asksFingerprint=(asks:JonAsk[])=>asks.length?createHash('sha256').update(asks.map(ask=>ask.key).join('\n')).digest('hex').slice(0,24):''

export function readJonCard(runtime:string):JonCardRecord|undefined{
 const row=readJsonRecord<JonCardRecord>(jonCardFile(runtime))
 return row&&row.version===1&&typeof row.fingerprint==='string'&&Array.isArray(row.keys)?row:undefined
}

export function jonCardDue(runtime:string,asks:JonAsk[]):JonCardDue{
 const fingerprint=asksFingerprint(asks),seen=new Set(readJonCard(runtime)?.keys??[])
 const fresh=asks.filter(ask=>!seen.has(ask.key))
 return {show:fresh.length>0,asks,fresh,fingerprint}
}

export function saveJonCardShown(runtime:string,asks:JonAsk[],now=Date.now()):JonCardRecord{
 const lock=acquireLock(runtime,'front-jon-card')
 try{
  const row:JonCardRecord={version:1,fingerprint:asksFingerprint(asks),keys:asks.map(ask=>ask.key),shownAt:new Date(now).toISOString()}
  writeFileDurable(jonCardFile(runtime),JSON.stringify(row))
  return row
 }finally{lock.release()}
}

const chip=(text:string)=>'<span style="'+s.chipYou+'">'+e(text)+'</span>'
const KIND_LABEL=(kind:JonAsk['kind'])=>kind==='permission'?'permission':NEEDS_JON_LABEL[kind]

export function jonCard(asks:JonAsk[],now=Date.now(),fresh:Set<string>=new Set(asks.map(ask=>ask.key))):Artifact|undefined{
 if(!asks.length)return undefined
 const rows=asks.map(ask=>'<li style="'+s.row+';flex-wrap:wrap">'+chip(KIND_LABEL(ask.kind))+'<span style="flex:1;min-width:0;font-weight:500">'+e(ask.questTitle)+(fresh.has(ask.key)?'':' <span style="'+s.muted+'">· still waiting</span>')+'</span>'+
  '<span style="width:100%;'+s.soft+'">'+e(ask.what)+'</span>'+
  '<span style="width:100%;font-size:12px;'+s.muted+'">'+e(ask.action)+'</span></li>').join('')
 const html='<div style="'+s.card+'"><h3 style="'+s.title+'">'+e(JON_CARD_TITLE)+' '+chip(asks.length===1?'1 thing':asks.length+' things')+'</h3><ul style="list-style:none;margin:0;padding:0">'+rows+'</ul><p style="margin:8px 0 0;font-size:11px;'+s.muted+'">as of '+e(new Date(now).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}))+'</p></div>'
 return {title:JON_CARD_TITLE,view:'html',html:sanitizeArtifactHtml(html)}
}

const DISK_ACTION='Free space on C: yourself, for example by moving large files you no longer need.'
const diskAsks=():JonAsk[]=>{const alert=diskAlert();return alert?[{key:alert.key,questID:'',questTitle:'Disk space',kind:'choice',what:alert.text,action:DISK_ACTION}]:[]}

export function showJonCard(store:{runtime:string;projectRoot:string},quests:Quest[],shownToJon:boolean,now=Date.now()):Artifact{
 const due=jonCardDue(store.runtime,[...jonAsks(quests),...diskAsks()])
 const card=jonCard(due.asks,now,new Set(due.fresh.map(ask=>ask.key)))
 if(!card)throw new QuestError('NOTHING_NEEDS_JON','Nothing needs the user right now, so no card was shown. Do not message them about it.')
 if(shownToJon)saveJonCardShown(store.runtime,due.asks,now)
 return card
}
