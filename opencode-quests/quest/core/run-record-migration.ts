import {existsSync,readFileSync,readdirSync,unlinkSync} from 'node:fs'
import {join} from 'node:path'
import {runFileStem,writeFileDurable} from './durable-file.mjs'
import {acquireLock} from '../locking.mts'
import {WORKER_RETURNS_DIRECTORY} from './runtime-queues'

export function runRecordDirectories(runtime:string):string[]{
 let names:string[]=[]
 try{names=readdirSync(runtime)}catch{return []}
 return [join(runtime,'workspaces'),...names.filter(name=>WORKER_RETURNS_DIRECTORY.test(name)).map(name=>join(runtime,name))].filter(directory=>existsSync(directory))
}

export function migrateLongRunRecords(runtime:string):{moved:string[];kept:string[]}{
 const moved:string[]=[],kept:string[]=[],directories=runRecordDirectories(runtime)
 if(!directories.length)return {moved,kept}
 let lock;try{lock=acquireLock(runtime,'run-record-migration',{timeoutMs:0})}catch{return {moved,kept}}
 try{
  for(const directory of directories)for(const name of readdirSync(directory)){
   if(!name.endsWith('.json'))continue
   const stem=name.slice(0,-5),short=runFileStem(stem)
   if(short===stem)continue
   const from=join(directory,name),to=join(directory,short+'.json')
   let row:any
   try{row=JSON.parse(readFileSync(from,'utf8'))}catch{kept.push(from);continue}
   if(!row||typeof row!=='object'||Array.isArray(row)){kept.push(from);continue}
   if(typeof row.runID!=='string')row.runID=stem
   if(row.runID!==stem||existsSync(to)){kept.push(from);continue}
   writeFileDurable(to,JSON.stringify(row,null,2))
   unlinkSync(from)
   moved.push(to)
  }
 }finally{lock.release()}
 return {moved,kept}
}
