import {Database} from "bun:sqlite"
import {existsSync} from "node:fs"
import {join} from "node:path"
import {homedir} from "node:os"
import type {LedgerRow} from "./passive-ledger"
export const HOST_USAGE_DB=process.env.OPENCODE_DB??join(process.env.XDG_DATA_HOME??join(homedir(),".local/share"),"opencode","opencode.db")
export function readHostCounters(options:{file?:string;from?:number;to?:number}={}) {
 const file=options.file??HOST_USAGE_DB,diagnostics:string[]=[],rows:LedgerRow[]=[]
 if(!existsSync(file))return {available:false,rows,diagnostics:["Native host database is unavailable"]}
 let db:Database|undefined
 try{
  db=new Database(file,{readonly:true});db.exec("PRAGMA busy_timeout=1000")
  if(!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message'").get())return {available:false,rows,diagnostics:["Native host counter schema is unavailable"]}
  const data=db.query(`SELECT m.id,m.session_id,s.parent_id,s.time_created sessionStarted,m.time_updated,
   json_extract(m.data,'$.time.created') started,json_extract(m.data,'$.time.completed') completed,
   json_extract(m.data,'$.model.providerID') provider,json_extract(m.data,'$.model.id') model,json_extract(m.data,'$.model.variant') variant,
   json_extract(m.data,'$.tokens.input') input,json_extract(m.data,'$.tokens.output') output,json_extract(m.data,'$.tokens.reasoning') reasoning,
   json_extract(m.data,'$.tokens.cache.read') cacheRead,json_extract(m.data,'$.tokens.cache.write') cacheWrite
   FROM session_message m JOIN session_v2 s ON s.id=m.session_id
   WHERE m.type='assistant' AND m.time_updated>=? AND m.time_updated<=? ORDER BY m.time_updated LIMIT 100001`).all(options.from??0,options.to??Date.now()) as any[]
  if(data.length>100000)diagnostics.push("Host counter query exceeded 100000 messages; coverage is incomplete")
  let partial=0
  for(const r of data.slice(0,100000)){
   if(!r.completed||!r.started||!r.provider||!r.model||r.started<r.sessionStarted)continue
   const keys=["input","output","reasoning","cacheRead","cacheWrite"] as const
   if(keys.some(k=>!Number.isSafeInteger(r[k])||r[k]<0)){partial++;for(const k of keys)if(!Number.isSafeInteger(r[k])||r[k]<0)r[k]=null}
   rows.push({id:"opencode-host:"+r.id,source:"opencode-host",sessionID:r.session_id,parentID:r.parent_id,at:r.completed,recordedAt:r.time_updated,startedAt:r.started,route:{providerID:r.provider,modelID:r.model,variant:typeof r.variant==="string"?r.variant:undefined,harness:"native-host"},kind:"host-normalized",state:"completed",tokens:{input:r.input,output:r.output,reasoning:r.reasoning,cacheRead:r.cacheRead,cacheWrite:r.cacheWrite}})
  }
  if(partial)diagnostics.push(partial+" host messages have partial numeric counters")
  return {available:true,rows,diagnostics}
 }catch{return {available:false,rows:[],diagnostics:["Native host counter query failed; coverage is incomplete"]}}finally{db?.close()}
}
