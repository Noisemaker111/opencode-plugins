import {mkdirSync,readdirSync,statSync,watch,type FSWatcher} from 'node:fs'
import {basename,dirname,join} from 'node:path'
import type {QuestStore} from '../store'
import {questSettingsFile} from '../config/quest-settings.mjs'
import {timed} from '../../scripts/plugin-spans'

export type EventStep={trigger():Promise<void>;dispose():void}
const LONGEST_TIMER=2**31-1
export function eventStep(name:string,run:()=>Promise<number|void|undefined>):EventStep{
 let current:Promise<void>|undefined,again=false,disposed=false,timer:ReturnType<typeof setTimeout>|undefined
 const arm=(due:unknown)=>{
  if(timer)clearTimeout(timer);timer=undefined
  if(disposed||typeof due!=='number'||!Number.isFinite(due)||due<=Date.now())return
  timer=setTimeout(()=>{timer=undefined;void trigger()},Math.min(due-Date.now(),LONGEST_TIMER));timer.unref?.()
 }
 const loop=async()=>{
  let due:unknown
  try{do{again=false;due=undefined;try{due=await timed({plugin:'quests',name:'step',op:name},run)}catch(error){console.error('[quests] '+name+' failed',error)}}while(again&&!disposed)}
  finally{current=undefined}
  arm(due)
 }
 function trigger():Promise<void>{if(disposed)return Promise.resolve();if(current){again=true;return current}return current=loop()}
 return {trigger,dispose(){disposed=true;if(timer)clearTimeout(timer);timer=undefined}}
}

export function coalesce<T>(run:(pending:Set<T>)=>void,milliseconds=50){
 let pending:Set<T>|undefined,timer:ReturnType<typeof setTimeout>|undefined,disposed=false
 return {
  kick(...items:T[]){
   if(disposed)return
   if(pending){for(const item of items)pending.add(item);return}
   pending=new Set(items)
   timer=setTimeout(()=>{const due=pending!;pending=undefined;timer=undefined;if(!disposed)run(due)},milliseconds)
  },
  dispose(){disposed=true;if(timer)clearTimeout(timer);timer=undefined;pending=undefined},
 }
}

export type LedgerChange='ledger'|'starts'|'giver'

export function watchQuestJournal(store:QuestStore,questID:string,listener:()=>void){
 const directory=join(store.runtime,'journals')
 let watcher:FSWatcher|undefined
 try{mkdirSync(directory,{recursive:true});const own=watcher=watchEntries(directory,{names:[questID+'.jsonl']},()=>listener());own.on('error',()=>{try{own.close()}catch{};if(watcher===own)watcher=undefined})}catch{watcher=undefined}
 return {dispose(){try{watcher?.close()}catch{};watcher=undefined}}
}

const stamp=(path:string)=>{try{const stat=statSync(path);return stat.ino+':'+stat.mtimeMs+':'+stat.size}catch{return ''}}
export function watchEntries(directory:string,chosen:{names:string[]}|{matches:(name:string)=>boolean},changed:(name:string|undefined)=>void):FSWatcher{
 const matches='names' in chosen?(name:string)=>chosen.names.includes(name):chosen.matches
 const listed=()=>{if('names' in chosen)return chosen.names;try{return readdirSync(directory).filter(matches)}catch{return []}}
 const seen=new Map<string,string>()
 const record=(name:string)=>{const next=stamp(join(directory,name));if((seen.get(name)??'')===next)return false;if(next)seen.set(name,next);else seen.delete(name);return true}
 for(const name of listed())record(name)
 const watcher=watch(directory,(_event,filename)=>{
  if(typeof filename==='string'&&(seen.has(filename)||matches(filename))){if(record(filename))changed(filename);return}
  for(const name of new Set([...seen.keys(),...listed()]))if(record(name))changed(name)
 })
 watcher.unref()
 return watcher
}

export function watchQuestLedger(store:QuestStore,listener:(change:LedgerChange,name?:string)=>void){
 const targets:[string,LedgerChange,Parameters<typeof watchEntries>[1]][]=[
  [store.root,'ledger',{matches:name=>name.endsWith('.md')}],
  [join(store.runtime,'start-requests'),'starts',{matches:name=>name.endsWith('.json')}],
  [store.runtime,'giver',{names:['user-giver.json','host-exit.json']}],
  [dirname(questSettingsFile()),'giver',{names:[basename(questSettingsFile())]}],
 ]
 const watchers=new Map<string,FSWatcher>()
 let disposed=false
 const ensure=()=>{
  if(disposed)return
  for(const [directory,change,chosen] of targets){
   if(watchers.has(directory))continue
   try{
    mkdirSync(directory,{recursive:true})
    const watcher=watchEntries(directory,chosen,name=>listener(change,name))
    const detach=()=>{if(watchers.get(directory)===watcher)watchers.delete(directory);try{watcher.close()}catch{}}
    watcher.on('error',error=>{console.error('[quests] ledger watcher',directory,error);detach()})
    watchers.set(directory,watcher)
   }catch(error){console.error('[quests] could not watch',directory,error)}
  }
 }
 ensure()
 return {ensure,dispose(){disposed=true;for(const watcher of watchers.values())try{watcher.close()}catch{};watchers.clear()}}
}
