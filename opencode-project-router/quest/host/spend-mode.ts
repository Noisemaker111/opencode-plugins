import {mkdirSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {randomBytes} from 'node:crypto'
import {writeFileDurable,readJsonRecord} from '../core/durable-file.mjs'
import {acquireLock} from '../locking.mts'
import {QuestError} from '../api'
import type {Quest} from '../types'
import type {AccountUsage} from '../../usage-service/on-computer'

export type SpendUsageTarget={accountID:string;windowID:string;stopAtUsedPercent:number}
export type SpendLink={questID:string;item?:string;at:number}
export type SpendState='active'|'met'|'target reached'|'stopped'
export type SpendGoal={id:string;goal:string;projectRoot:string;count?:number;items?:string[];usage?:SpendUsageTarget;until?:number;state:SpendState;reason?:string;quests:SpendLink[];startedAt:number;endedAt?:number}
export type SpendStart={goal:string;projectRoot:string;count?:number;items?:string[];usage?:SpendUsageTarget;until?:number}
export type SpendProgress={done:number;open:number;remainingItems:string[];left:number|null;usedPercent:number|null}

export const spendGoalsFile=(runtime:string)=>join(runtime,'spend-goals.json')

const finished=(quest:Quest|undefined)=>!!quest&&(!!quest.delivered||quest.state==='Complete'||(quest.state==='Archived'&&quest.archive?.accepted!==false))
const closedUnfinished=(quest:Quest|undefined)=>!quest||(quest.state==='Archived'&&quest.archive?.accepted===false)

function validGoal(row:any):row is SpendGoal{
 return !!row&&typeof row.id==='string'&&typeof row.goal==='string'&&typeof row.projectRoot==='string'&&['active','met','target reached','stopped'].includes(row.state)&&Array.isArray(row.quests)&&Number.isFinite(row.startedAt)
}

export function readSpendGoals(runtime:string):SpendGoal[]{
 const rows=readJsonRecord(spendGoalsFile(runtime))
 if(rows===undefined)return []
 if(!Array.isArray(rows)||!rows.every(validGoal))throw new QuestError('SPEND_GOALS_UNREADABLE','The saved spend goals are unreadable: '+spendGoalsFile(runtime))
 return rows
}

function change<T>(runtime:string,edit:(rows:SpendGoal[])=>T):T{
 const file=spendGoalsFile(runtime),lock=acquireLock(dirname(file),'spend-goals')
 try{const rows=readSpendGoals(runtime),value=edit(rows);mkdirSync(dirname(file),{recursive:true});writeFileDurable(file,JSON.stringify(rows,null,1));return value}finally{lock.release()}
}

function find(rows:SpendGoal[],id:string){
 const goal=rows.find(row=>row.id===id)
 if(!goal)throw new QuestError('SPEND_GOAL_NOT_FOUND','No spend goal '+id)
 return goal
}

const distinct=(items:string[]|undefined)=>items===undefined?undefined:[...new Set(items.map(item=>item.trim()).filter(Boolean))]

export function startSpendGoal(runtime:string,input:SpendStart,now=Date.now()):SpendGoal{
 if(!input.goal?.trim())throw new QuestError('INVALID_INPUT','spend: name the goal')
 if(input.count!==undefined&&(!Number.isSafeInteger(input.count)||input.count<1))throw new QuestError('INVALID_INPUT','spend: count must be a whole number of Quests')
 if(input.until!==undefined&&!(Number.isFinite(input.until)&&input.until>now))throw new QuestError('INVALID_INPUT','spend: until must be a future time')
 const usage=input.usage
 if(usage&&(!usage.accountID?.trim()||!usage.windowID?.trim()||!(usage.stopAtUsedPercent>0&&usage.stopAtUsedPercent<=100)))throw new QuestError('INVALID_INPUT','spend: a usage target needs an account, its window and a used percent from 1 to 100')
 const goal:SpendGoal={id:'spend_'+randomBytes(4).toString('hex'),goal:input.goal.trim(),projectRoot:input.projectRoot,...(input.count!==undefined?{count:input.count}:{}),...(input.items?{items:distinct(input.items)}:{}),...(usage?{usage}:{}),...(input.until!==undefined?{until:input.until}:{}),state:'active',quests:[],startedAt:now}
 return change(runtime,rows=>{rows.push(goal);return goal})
}

export function addSpendItems(runtime:string,id:string,items:string[]){
 return change(runtime,rows=>{const goal=find(rows,id);goal.items=distinct([...(goal.items??[]),...items]);return goal})
}

export function endSpendGoal(runtime:string,id:string,state:Exclude<SpendState,'active'>,reason:string,now=Date.now()){
 return change(runtime,rows=>{const goal=find(rows,id);if(goal.state==='active'){goal.state=state;goal.reason=reason;goal.endedAt=now};return goal})
}

export function assertSpendLink(runtime:string,id:string,item:string|undefined,read:(questID:string)=>Quest|undefined){
 const goal=find(readSpendGoals(runtime),id)
 if(goal.state!=='active')throw new QuestError('SPEND_GOAL_ENDED','The spend goal "'+goal.goal+'" ended: '+(goal.reason??goal.state)+'. No Quest was created.')
 const key=item?.trim()
 if(key){const held=goal.quests.find(link=>link.item===key&&!closedUnfinished(read(link.questID)));if(held)throw new QuestError('SPEND_ITEM_TAKEN','Item "'+key+'" of this spend goal already has Quest '+held.questID+'. No Quest was created.')}
 return goal
}

export function linkSpendQuest(runtime:string,id:string,questID:string,item?:string,now=Date.now()){
 return change(runtime,rows=>{const goal=find(rows,id);goal.quests.push({questID,...(item?.trim()?{item:item.trim()}:{}),at:now});return goal})
}

export function spendProgress(goal:SpendGoal,read:(questID:string)=>Quest|undefined,accounts:AccountUsage[]):SpendProgress{
 const quests=goal.quests.map(link=>({link,quest:read(link.questID)}))
 const done=quests.filter(row=>finished(row.quest))
 const open=quests.filter(row=>!finished(row.quest)&&!closedUnfinished(row.quest)).length
 const covered=new Set(quests.filter(row=>!closedUnfinished(row.quest)).flatMap(row=>row.link.item?[row.link.item]:[]))
 const remainingItems=(goal.items??[]).filter(item=>!covered.has(item))
 const left=goal.items?.length?goal.items.filter(item=>!done.some(row=>row.link.item===item)).length:goal.count!==undefined?Math.max(0,goal.count-done.length):null
 const window=goal.usage?accounts.find(account=>account.id===goal.usage!.accountID)?.windows.find(row=>row.id===goal.usage!.windowID):undefined
 return {done:done.length,open,remainingItems,left,usedPercent:window?.usedPercent??null}
}

export function spendVerdict(goal:SpendGoal,progress:SpendProgress,now:number):{state:Exclude<SpendState,'active'>;reason:string}|undefined{
 if(goal.state!=='active')return
 if(progress.left===0)return {state:'met',reason:goal.items?.length?'Every item has a finished Quest':'The goal of '+goal.count+' finished Quests is met'}
 if(goal.usage&&progress.usedPercent!==null&&progress.usedPercent>=goal.usage.stopAtUsedPercent)return {state:'target reached',reason:'The account window reached '+progress.usedPercent+'% used, at or above the target of '+goal.usage.stopAtUsedPercent+'%'}
 if(goal.until!==undefined&&now>=goal.until)return {state:'target reached',reason:'The spend goal reached its end time'}
}

export function settleSpendGoals(runtime:string,read:(questID:string)=>Quest|undefined,accounts:AccountUsage[],now=Date.now()){
 const goals=readSpendGoals(runtime)
 const ending=goals.flatMap(goal=>{const verdict=spendVerdict(goal,spendProgress(goal,read,accounts),now);return verdict?[{goal,verdict}]:[]})
 for(const {goal,verdict} of ending)endSpendGoal(runtime,goal.id,verdict.state,verdict.reason,now)
 return readSpendGoals(runtime)
}

export function spendView(goal:SpendGoal,read:(questID:string)=>Quest|undefined,accounts:AccountUsage[]){
 return {...goal,progress:spendProgress(goal,read,accounts)}
}

export function spendGoalLine(goal:SpendGoal){
 const usage=goal.usage?' Stop at '+goal.usage.stopAtUsedPercent+'% used of '+goal.usage.accountID+' '+goal.usage.windowID+'.':''
 const until=goal.until!==undefined?' Stop at '+new Date(goal.until).toISOString()+'.':''
 return 'Spend goal '+goal.id+' in '+goal.projectRoot+': "'+goal.goal+'".'+usage+until
}

export function spendProgressLine(goal:SpendGoal,progress:SpendProgress){
 const left=progress.left===null?'':progress.left+' left, '
 const items=progress.remainingItems.length?' Items without a Quest: '+progress.remainingItems.slice(0,20).join(', ')+(progress.remainingItems.length>20?' and '+(progress.remainingItems.length-20)+' more':'')+'.':''
 const usage=goal.usage?(progress.usedPercent===null?' Usage: no reading yet.':' Usage now '+progress.usedPercent+'%.'):''
 return left+progress.done+' done, '+progress.open+' open.'+items+usage
}

export const SPEND_RULE='While a spend goal is active, keep creating Quests toward it in its project with create start:true spendGoal {id, item}, one Quest per distinct item, each started at once. Do not wait for open Quests to finish and set no maxConcurrent: account admission and usage pacing decide how many workers run. When the goal names work you must first list, such as the open issues of a repository, list it and save the items with spend {goalID, addItems}. When the goal is met or cannot continue, end it with spend {goalID, end: {state, reason}}. What is left comes back with each worker return; spend without start or end lists the goals with their progress.'

export function spendReturnLine(runtime:string,questID:string,read:(questID:string)=>Quest|undefined,usage:()=>AccountUsage[],now=Date.now()){
 try{
  const linked=readSpendGoals(runtime).find(goal=>goal.quests.some(link=>link.questID===questID))
  if(!linked)return ''
  const accounts=linked.state==='active'?usage():[]
  const goal=settleSpendGoals(runtime,read,accounts,now).find(row=>row.id===linked.id)!
  if(goal.state!=='active')return 'Spend goal "'+goal.goal+'" ended: '+(goal.reason??goal.state)+'. Create no more Quests for it.'
  return spendGoalLine(goal)+' '+spendProgressLine(goal,spendProgress(goal,read,accounts))+' Create the next Quests toward it now.'
 }catch(error){return 'Spend goal could not be read: '+(error instanceof Error?error.message:String(error))}
}

export function spendInstruction(runtime:string,read:(questID:string)=>Quest|undefined,usage:()=>AccountUsage[],now=Date.now()){
 let goals:SpendGoal[],accounts:AccountUsage[]=[]
 try{
  if(!readSpendGoals(runtime).some(goal=>goal.state==='active'))return ''
  accounts=usage()
  goals=settleSpendGoals(runtime,read,accounts,now)
 }catch(error){return 'Spend goals could not be read: '+(error instanceof Error?error.message:String(error))}
 const active=goals.filter(goal=>goal.state==='active')
 if(!active.length)return ''
 return [SPEND_RULE,...active.map(spendGoalLine)].join('\n')
}
