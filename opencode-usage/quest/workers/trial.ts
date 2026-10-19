import {existsSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {failureCause} from '../routing/failure-cause'
import type {Quest} from '../types'
import {setMode,type QueueLimits,type QueueSettings} from './quest-queue'

const FAULTS=new Set(['host-lost','command-stuck','start-failed','workspace','tools-not-loaded','database'])
const ENDED=new Set(['completed','failed','stale','missing','cancelled'])

export const PAUSED_TEXT='Paused. Nothing starts until it is set to Trial or Running in Settings'

export type Trial={allowed:number;clean:number;cap:number|null;text:string}

export function trialOf(quests:Quest[],settings:Pick<QueueSettings,'limits'|'trialSince'>):Trial {
 const since=settings.trialSince??0
 const ended=quests.flatMap(q=>q.sessions.filter(run=>ENDED.has(run.state)&&run.agentRole!=='command'&&run.role!=='command'&&Date.parse(run.updatedAt)>=since))
  .sort((a,b)=>Date.parse(a.updatedAt)-Date.parse(b.updatedAt))
 let clean=0
 for(const run of ended){
  if(run.state==='completed')clean++
  else if(FAULTS.has(failureCause(run)?.code??''))clean=0
 }
 const caps=[settings.limits.workers,settings.limits.quests].filter((n):n is number=>n!==null)
 const cap=caps.length?Math.min(...caps):null
 const allowed=cap===null?1+clean:Math.min(cap,1+clean)
 return {allowed,clean,cap,text:'Trial: '+allowed+(cap===null?'':' of '+cap)+' allowed, '+clean+' clean run'+(clean===1?'':'s')}
}

export function effectiveLimits(quests:Quest[],settings:Pick<QueueSettings,'limits'|'mode'|'trialSince'>):QueueLimits {
 if(settings.mode!=='trial')return settings.limits
 const {allowed}=trialOf(quests,settings)
 const within=(limit:number|null)=>limit===null?allowed:Math.min(limit,allowed)
 return {workers:within(settings.limits.workers),quests:within(settings.limits.quests)}
}

export function modeLine(quests:Quest[],settings:Pick<QueueSettings,'limits'|'mode'|'trialSince'>):string|undefined {
 if(settings.mode==='paused')return PAUSED_TEXT
 if(settings.mode==='trial')return trialOf(quests,settings).text
 return undefined
}

export function moveLegacyHold(runtime:string):boolean {
 const file=join(runtime,'worker-hold.json')
 if(!existsSync(file))return false
 setMode('paused')
 rmSync(file,{force:true})
 return true
}
