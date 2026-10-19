import {questSettingsFile,readSettings,updateSettings,type SettingsSection} from '../config/quest-settings.mjs'
import type {Quest} from '../types'

export type QueueLimits={workers:number|null;quests:number|null}
export const RUN_MODES=['running','trial','paused'] as const
export type RunMode=typeof RUN_MODES[number]
export type QueueSettings={version:1;categories:Record<string,boolean>;limits:QueueLimits;mode:RunMode;trialSince:number|null}
export const DEFAULT_LIMITS:QueueLimits={workers:4,quests:4}
const fresh=():QueueSettings=>({version:1,categories:{},limits:{...DEFAULT_LIMITS},mode:'running',trialSince:null})
const validLimit=(value:unknown):value is number|null=>value===null||(typeof value==='number'&&Number.isSafeInteger(value)&&value>=1)
export type QuestPriority={label:Quest['priority'];score:number;why:string}

const CATEGORY=/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/
export const validCategory=(name:unknown):name is string=>typeof name==='string'&&CATEGORY.test(name)

const QUEUE_SECTION:SettingsSection<QueueSettings>={
 name:'queue',
 check(saved){
  if(saved===undefined)return fresh()
  const row=saved as Partial<QueueSettings>
  const entries=row&&typeof row==='object'&&row.categories&&typeof row.categories==='object'?Object.entries(row.categories):undefined
  if(row?.version!==1||!entries||entries.some(([name,on])=>!validCategory(name)||typeof on!=='boolean'))throw Error('Invalid Quest category settings; preserve and repair the configuration')
  const limits={...DEFAULT_LIMITS,...(row.limits&&typeof row.limits==='object'?row.limits:{})}
  if(!validLimit(limits.workers)||!validLimit(limits.quests))throw Error('Invalid Quest limits; each is a whole number of at least 1, or null for no limit')
  const mode=row.mode??'running'
  if(!RUN_MODES.includes(mode))throw Error('Invalid run mode; it is running, trial or paused')
  const trialSince=mode==='trial'&&Number.isFinite(row.trialSince)?row.trialSince as number:null
  return {version:1,categories:Object.fromEntries(entries),limits:{workers:limits.workers,quests:limits.quests},mode,trialSince}
 },
}

export const queueSettings=(file=questSettingsFile()):QueueSettings=>readSettings(QUEUE_SECTION,file)

export function readableQueueSettings(file=questSettingsFile()):QueueSettings {
 try{return queueSettings(file)}catch{return {...fresh(),mode:'paused'}}
}

export function setLimits(change:Partial<QueueLimits>,file=questSettingsFile()):QueueSettings {
 for(const key of ['workers','quests'] as const)if(key in change&&!validLimit(change[key]))throw Error(key+' limit is a whole number of at least 1, or null for no limit')
 return updateSettings(QUEUE_SECTION,current=>({...current,limits:{...current.limits,...change}}),file)
}

export function setMode(mode:RunMode,file=questSettingsFile(),now=Date.now()):QueueSettings {
 if(!RUN_MODES.includes(mode))throw Error('mode is running, trial or paused')
 return updateSettings(QUEUE_SECTION,current=>({...current,mode,trialSince:mode==='trial'?(current.mode==='trial'&&current.trialSince!==null?current.trialSince:now):null}),file)
}

export function setCategoryEnabled(name:string,enabled:boolean,file=questSettingsFile()):QueueSettings {
 if(!validCategory(name))throw Error('A category name is up to 40 letters, digits, spaces, dashes or underscores')
 if(typeof enabled!=='boolean')throw Error('enabled must be true or false')
 return updateSettings(QUEUE_SECTION,current=>({...current,categories:{...current.categories,[name]:enabled}}),file)
}

export const categoryOf=(q:Pick<Quest,'extensions'>)=>validCategory(q.extensions?.category)?q.extensions.category as string:undefined

export function categoryHold(q:Pick<Quest,'extensions'>,settings:QueueSettings=queueSettings()):string|undefined {
 const category=categoryOf(q)
 if(category&&settings.categories[category]===false)return 'Category '+category+' is turned off in Settings; this Quest starts no worker until it is turned on'
}

export function unfinishedPredecessor(q:Pick<Quest,'relationships'>,read:(id:string)=>Quest|undefined):Quest|undefined {
 for(const id of q.relationships?.dependencies??[]){
  const before=read(id)
  if(before&&before.state!=='Archived'&&!before.archive&&!before.delivered&&before.stages.some(step=>step.status!=='done'))return before
 }
}

export function afterHold(q:Pick<Quest,'relationships'>,read:(id:string)=>Quest|undefined):string|undefined {
 const before=unfinishedPredecessor(q,read)
 if(before)return 'It goes after "'+before.title+'", which is not done; this Quest starts no worker until then'
}

export function queueHold(q:Quest,read:(id:string)=>Quest|undefined,settings?:QueueSettings):string|undefined {
 return categoryHold(q,settings)??afterHold(q,read)
}

export function addsCycle(id:string,after:string[],read:(id:string)=>Quest|undefined):boolean {
 const seen=new Set<string>(),pending=[...after]
 while(pending.length){
  const next=pending.pop()!
  if(next===id)return true
  if(seen.has(next))continue
  seen.add(next)
  pending.push(...(read(next)?.relationships?.dependencies??[]))
 }
 return false
}

const BASE:Record<Quest['priority'],number>={low:0,normal:10,high:20,urgent:30}
const LABELS:Quest['priority'][]=['low','normal','high','urgent']
const ATTENTION_POINTS=5,AGE_CAP_DAYS=7

export function computedPriority(q:Pick<Quest,'priority'|'state'|'createdAt'>,now=Date.now()):QuestPriority {
 const base=BASE[q.priority]??BASE.normal
 const attention=q.state==='Needs attention'?ATTENTION_POINTS:0
 const created=Date.parse(q.createdAt)
 const age=Number.isFinite(created)?Math.min(AGE_CAP_DAYS,Math.max(0,Math.floor((now-created)/86_400_000))):0
 const score=base+attention+age
 const label=LABELS[Math.min(3,Math.floor(score/10))]
 const parts=['set to '+q.priority,...(attention?['needs attention'] :[]),...(age?['waiting '+age+' day'+(age===1?'':'s')]:[])]
 return {label,score,why:parts.join(', ')}
}

export function categoriesIn(quests:Quest[],settings:QueueSettings=queueSettings()){
 const counts=new Map<string,number>()
 for(const q of quests){const name=categoryOf(q);if(name&&q.state!=='Archived')counts.set(name,(counts.get(name)??0)+1)}
 for(const name of Object.keys(settings.categories))if(!counts.has(name))counts.set(name,0)
 return [...counts].sort(([a],[b])=>a.localeCompare(b)).map(([name,quests])=>({name,enabled:settings.categories[name]!==false,quests}))
}
