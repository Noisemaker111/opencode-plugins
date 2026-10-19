import {existsSync,readdirSync} from 'node:fs'
import {readJsonRecord} from './durable-file.mjs'
import {readJsonCached} from './json-cache'
import {join} from 'node:path'
import {createHash} from 'node:crypto'

export function v2QueueGeneration(){return [process.env.OPENCODE_PLUGIN_GENERATION??'unversioned',process.pid,performance.timeOrigin].join(':')}
export function runtimeQueuePath(runtime:string,name:string,generation=v2QueueGeneration(),suffix=''){
 const key=generation?'-'+createHash('sha256').update(generation).digest('hex').slice(0,24):''
 return join(runtime,name+key+suffix)
}
export function continuationFiles(runtime:string){
 if(!existsSync(runtime))return []
 return readdirSync(runtime).filter(n=>/^continuations(?:-[a-f0-9]{24})?\.json$/.test(n)).map(n=>join(runtime,n))
}
export function readContinuations(runtime:string):any[]{return continuationFiles(runtime).flatMap(file=>readJsonCached(file)??[])}
export function readCurrentContinuations(runtime:string):any[]{return readJsonCached(runtimeQueuePath(runtime,'continuations',v2QueueGeneration(),'.json'))??[]}
export const WORKER_RETURNS_DIRECTORY=/^(?:worker-returns(?:-[a-f0-9]{24})?|wr-[a-f0-9]{12})$/
export function workerReturnsPath(runtime:string,generation=v2QueueGeneration()){
 return join(runtime,generation?'wr-'+createHash('sha256').update(generation).digest('hex').slice(0,12):'worker-returns')
}
