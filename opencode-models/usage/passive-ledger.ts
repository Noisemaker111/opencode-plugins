import {updateBurnControls} from "./burn-control"
import { generationKey } from "../scripts/running-generation.mjs"
import {readHostCounters,HOST_USAGE_DB} from "./host-counters"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import { basename, dirname } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { TELEMETRY_FILE, readRequestsSince, type TelemetryCursor } from "./telemetry-store"
import { harvestCodexUsage, codexRolloutRoot, saveRolloutCursors, restoreRolloutCursors, type SavedRolloutCursor } from "./codex-harvest"
import { readAccountUsage, onAccountsChanged, ACCOUNT_USAGE_FILE } from "../usage-service/on-computer"
import { quotaObservationTail, readQuotaObservations } from "./calibration-store"
import type { Observation } from "./calibration"
import type { RequestRecord, TelemetryFilter, Tokens } from "./telemetry"
import type { AccountSnapshot } from "../usage-service/on-computer"
import { timed } from "../scripts/plugin-spans"
import { retentionFrom, TELEMETRY_BUDGET } from "../scripts/telemetry-budget.mjs"
import { collectPassiveOffThread, type PassiveCollection } from "./passive-collection-thread"
import { Clock, Duration, Effect, Latch } from "effect"
import { timerClock } from "../quest/core/timer"

export const PASSIVE_LEDGER_FILE = process.env.OPENCODE_PASSIVE_LEDGER_FILE ?? TELEMETRY_FILE + ".ledger.sqlite"
export type LedgerRow = { id:string; source:"opencode"|"codex"|"opencode-host"; sessionID:string; parentID?:string|null; questID?:string; accountID?:string; regime?:string; at:number; recordedAt?:number; startedAt:number; completedAt?:number; firstVisibleAt?:number; lastOutputAt?:number; route:RequestRecord["route"]; kind:string; state:string; tokens:Tokens; outputTotal?:number; context?:RequestRecord["context"];request?:RequestRecord["request"] }
export type CollectorReceipt = { at:number; from:number; scannedFiles:number; readFiles:number; unchangedFiles?:number; newRequests?:number; newHostRows?:number; newCodexRows?:number; writtenRows?:number; reconciledRequests:number; rejectedCounters:number; repeatedCounters:number; malformedLines:number; diagnostics:string[];hostScanAt?:number|null;parserVersion?:number;calibrationDiagnostics?:string[] }
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex")
const UPSERT="INSERT INTO records VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account=excluded.account,at=excluded.at,body=excluded.body WHERE coalesce(json_extract(excluded.body,'$.recordedAt'),excluded.at)>=coalesce(json_extract(records.body,'$.recordedAt'),records.at) AND NOT(json_extract(records.body,'$.state')!='running' AND json_extract(excluded.body,'$.state')='running')"
function open(file:string) {
 mkdirSync(dirname(file),{recursive:true})
 const db=new Database(file,{create:true});db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;")
 db.exec(`CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,source TEXT,session TEXT,parent TEXT,account TEXT,at INTEGER,body TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS records_time ON records(at); CREATE INDEX IF NOT EXISTS records_session ON records(session);
 CREATE TABLE IF NOT EXISTS gaps(id TEXT PRIMARY KEY,at INTEGER,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS quota(id TEXT PRIMARY KEY,at INTEGER,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,body TEXT NOT NULL);`)
 return db
}
function onLedger<T>(file:string,action:()=>T):T{try{return action()}catch(error){throw new Error(basename(file)+": "+(error instanceof Error?error.message:String(error)))}}
export function persistLedger(input:{rows:LedgerRow[];observations:Observation[];resolvedCounters?:{sessionID:string;at:number}[];gaps?:{sessionID:string;at:number;reason:string;reportedLastTotal:number|null}[];receipt:CollectorReceipt;cursors?:{telemetry:TelemetryCursor|null;rollouts:Record<string,SavedRolloutCursor>}},file=PASSIVE_LEDGER_FILE) {
 const db=onLedger(file,()=>open(file))
 try {onLedger(file,()=>db.transaction(()=>{
  const put=db.query(UPSERT)
  for(const row of input.rows) put.run(row.id,row.source,row.sessionID,row.parentID??null,row.accountID??null,row.at,JSON.stringify(row))
  const gap=db.query("INSERT OR IGNORE INTO gaps VALUES(?,?,?)")
  for(const g of input.gaps??[])gap.run(hash(g),g.at,JSON.stringify(g))
  const resolveGap=db.query("UPDATE gaps SET body=json_set(body,'$.resolved',1,'$.resolution','Unchanged valid cumulative counters: no additional token movement') WHERE at=? AND json_extract(body,'$.sessionID')=? AND json_extract(body,'$.reason')='Last-request components do not reconcile to its total'")
  for(const r of input.resolvedCounters??[])resolveGap.run(r.at,r.sessionID)
  const quota=db.query("INSERT OR IGNORE INTO quota VALUES(?,?,?)")
  for(const o of input.observations)quota.run(o.id,o.at,JSON.stringify(o))
  db.query("INSERT OR IGNORE INTO meta VALUES('coverageFrom',?)").run(JSON.stringify(input.receipt.from))
  const meta=db.query("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body")
  meta.run("receipt",JSON.stringify(input.receipt))
  if(input.cursors){meta.run("telemetryCursor",JSON.stringify(input.cursors.telemetry));meta.run("rolloutCursors",JSON.stringify(input.cursors.rollouts))}
 }).immediate());onLedger(file,()=>enforceLedgerBudget(db,file));refreshLedgerSummary(file)}finally{db.close()}
}
export function pruneLedger(file=PASSIVE_LEDGER_FILE){const db=onLedger(file,()=>open(file));try{onLedger(file,()=>enforceLedgerBudget(db,file));refreshLedgerSummary(file)}finally{db.close()}}
function ledgerBytes(file:string){return [file,file+"-wal"].reduce((sum,path)=>sum+(statSync(path,{throwIfNoEntry:false})?.size??0),0)}
function enforceLedgerBudget(db:Database,file:string){
 const cutoff=retentionFrom()
 db.exec(`DELETE FROM records WHERE at<${cutoff}; DELETE FROM quota WHERE at<${cutoff}; DELETE FROM gaps WHERE at<${cutoff};`)
 if(ledgerBytes(file)<=TELEMETRY_BUDGET.ledgerBytes)return
 shrinkLedger(db)
 for(let pass=0;pass<64&&ledgerBytes(file)>TELEMETRY_BUDGET.ledgerBytes;pass++){
  db.exec("DELETE FROM records WHERE at<(SELECT at FROM records ORDER BY at LIMIT 1 OFFSET (SELECT count(*)/4 FROM records)); DELETE FROM quota WHERE at<(SELECT at FROM quota ORDER BY at LIMIT 1 OFFSET (SELECT count(*)/4 FROM quota))")
  shrinkLedger(db)
 }
}
function shrinkLedger(db:Database){db.exec("VACUUM");db.exec("PRAGMA wal_checkpoint(TRUNCATE)")}
export function ledgerRows(records:RequestRecord[]):LedgerRow[] {
 return records.map(r=>({id:"opencode:"+r.id,source:"opencode",sessionID:r.sessionID,parentID:r.parentID,questID:r.questID,accountID:r.accountID,regime:r.accountRegime,at:r.completedAt??r.startedAt,recordedAt:r.recordedAt??r.completedAt??r.startedAt,startedAt:r.startedAt,completedAt:r.completedAt,firstVisibleAt:r.firstVisibleAt,lastOutputAt:r.lastOutputAt,route:r.route,kind:r.kind,state:r.state,tokens:r.tokens,outputTotal:r.outputTotal,context:r.context,request:r.request}))
}
const writers=new Map<string,{db:Database;upsert:ReturnType<Database["query"]>;budgetedAt:number}>()
const HOT_BUDGET_EVERY_MS=60_000
export function recordLedgerRequests(records:RequestRecord[],file=PASSIVE_LEDGER_FILE,busyMs=1000) {
 if(!records.length)return
 const rows=ledgerRows(records)
 let held=writers.get(file)
 if(!held){const db=open(file);held={db,upsert:db.query(UPSERT),budgetedAt:0};writers.set(file,held)}
 try{
  held.db.exec("PRAGMA busy_timeout="+busyMs)
  held.db.transaction(()=>{for(const row of rows)held!.upsert.run(row.id,row.source,row.sessionID,row.parentID??null,row.accountID??null,row.at,JSON.stringify(row))}).immediate()
  if(Date.now()-held.budgetedAt>=HOT_BUDGET_EVERY_MS){held.budgetedAt=Date.now();enforceLedgerBudget(held.db,file)}
 }catch(error){closeLedgerWriters(file);throw error}
}
export function recordLedgerRequest(record:RequestRecord,file=PASSIVE_LEDGER_FILE) {recordLedgerRequests([record],file)}
export function closeLedgerWriters(file?:string){for(const [key,held] of writers)if(!file||key===file){held.db.close();writers.delete(key)}}
export type LedgerFilter=TelemetryFilter&{source?:LedgerRow["source"];providerID?:string;modelID?:string}
function conditions(options:LedgerFilter,db:Database){
 const from=options.from??0,to=options.to??Date.now()
 const clauses=["at>=?","at<=?"],params:(string|number)[]=[from,to]
 if(options.source){clauses.push("source=?");params.push(options.source)}
 if(options.providerID){clauses.push("json_extract(body,'$.route.providerID')=?");params.push(options.providerID)}
 if(options.modelID){clauses.push("json_extract(body,'$.route.modelID')=?");params.push(options.modelID)}
 if(options.accountID){clauses.push("account=?");params.push(options.accountID)}
 if(options.questID){clauses.push("json_extract(body,'$.questID')=?");params.push(options.questID)}
 if(options.sessionID){
  if(options.includeWorkers){clauses.push("session IN (WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT r.session FROM records r JOIN family f ON r.parent=f.id) SELECT id FROM family)");params.push(options.sessionID)}
  else{clauses.push("session=?");params.push(options.sessionID)}
 }
 void db
 return {where:clauses.join(" AND "),params}
}
function readonlyDatabase(file:string){const db=new Database(file,{readonly:true});db.exec("PRAGMA busy_timeout=1000");return db}
export function readLedger(options:LedgerFilter={},file=PASSIVE_LEDGER_FILE) {
 if(!existsSync(file))return {rows:[] as LedgerRow[],observations:[] as Observation[],receipt:null as CollectorReceipt|null,coverageFrom:null as number|null,resolvedGaps:0,gaps:[] as {sessionID:string;at:number;reason:string;reportedLastTotal:number|null}[],diagnostics:["Passive collector has not recorded a sample"]}
 const db=readonlyDatabase(file)
 try {
  const from=options.from??0,to=options.to??Date.now()
  const {where,params}=conditions(options,db)
  const rows=(db.query("SELECT body FROM records WHERE "+where+" ORDER BY at,id").all(...params) as {body:string}[]).map(r=>JSON.parse(r.body) as LedgerRow)
  const meta=(key:string)=>{const r=db.query("SELECT body FROM meta WHERE key=?").get(key) as {body:string}|null;return r?JSON.parse(r.body):null}
  const resolvedGaps=(db.query("SELECT count(*) count FROM gaps WHERE json_extract(body,'$.resolved')=1").get() as {count:number}).count
  return {rows,resolvedGaps,observations:(db.query("SELECT body FROM quota WHERE at>=? AND at<=? ORDER BY at").all(from,to) as {body:string}[]).map(r=>JSON.parse(r.body) as Observation),gaps:(db.query("SELECT body FROM gaps WHERE at>=? AND at<=? AND coalesce(json_extract(body,'$.resolved'),0)=0 ORDER BY at").all(from,to) as {body:string}[]).map(r=>JSON.parse(r.body) as {sessionID:string;at:number;reason:string;reportedLastTotal:number|null}),receipt:meta("receipt") as CollectorReceipt|null,coverageFrom:meta("coverageFrom") as number|null,diagnostics:[] as string[]}
 }finally{db.close()}
}

export type ScopeTotals={requests:number;runningRequests:number;sessions:number;firstAt:number|null;lastAt:number|null;totals:Tokens;knownTokens:number;missing:Record<keyof Tokens,number>;outputIncludingReasoning:number;missingOutputRequests:number;models:{modelID:string;providerID:string;reasoning:string|null;harness:string|null;requests:number;sessions:number}[]}
const TOKEN_KEYS=["input","cacheRead","cacheWrite","output","reasoning"] as const
const field=(path:string)=>`json_extract(body,'$.${path}')`
const OUTPUT_SQL=`coalesce(${field("outputTotal")},${field("tokens.output")}+${field("tokens.reasoning")})`
const KNOWN_TOKENS_SQL=`coalesce(${field("tokens.input")},0)+coalesce(${field("tokens.cacheRead")},0)+coalesce(${field("tokens.cacheWrite")},0)+coalesce(${field("outputTotal")},coalesce(${field("tokens.output")},0)+coalesce(${field("tokens.reasoning")},0))`
const scopeTotalsCache=new Map<string,{version:string;results:Map<string,ScopeTotals>}>()
function ledgerVersion(file:string){return [file,file+"-wal"].map(path=>{const stat=statSync(path,{throwIfNoEntry:false});return stat?.size?stat.ino+":"+stat.mtimeMs+":"+stat.size:"-"}).join("|")}
export function ledgerScopeTotals(options:LedgerFilter={},file=PASSIVE_LEDGER_FILE):Readonly<ScopeTotals>|null {
 if(!existsSync(file))return null
 const summarized=summaryEntry(file,options);if(summarized)return summarized.totals
 const version=ledgerVersion(file),key=JSON.stringify(options)
 let held=scopeTotalsCache.get(file)
 if(held?.version!==version)scopeTotalsCache.set(file,held={version,results:new Map()})
 const hit=held.results.get(key)
 if(hit)return hit
 const totals=scopeTotalsQuery(options,file)
 for(const part of [totals.totals,totals.missing,...totals.models,totals.models,totals])Object.freeze(part)
 held.results.set(key,totals)
 return totals
}
const SUMMARY_SOURCES: LedgerRow["source"][] = ["opencode", "codex", "opencode-host"]
type LedgerSummaryEntry = { totals: ScopeTotals; latest: LedgerRow | null; context: ReturnType<typeof latestContextQuery>; coverage: ReturnType<typeof coverageQuery> }
let summaryCache: { path: string; stamp: string; results: Record<string, LedgerSummaryEntry> } | undefined
function summaryEntry(file: string, options: LedgerFilter): LedgerSummaryEntry | undefined {
 const path = file + ".summary.json"
 const stat = statSync(path, { throwIfNoEntry: false })
 if (!stat) return undefined
 const stamp = stat.ino + ":" + stat.mtimeMs + ":" + stat.size
 if (summaryCache?.path !== path || summaryCache.stamp !== stamp) {
  try { summaryCache = { path, stamp, results: (JSON.parse(readFileSync(path, "utf8")) as { results: Record<string, LedgerSummaryEntry> }).results } }
  catch { return undefined }
 }
 return summaryCache.results[JSON.stringify(options)]
}
export function refreshLedgerSummary(file = PASSIVE_LEDGER_FILE, now = Date.now()) {
 if (!existsSync(file)) return
 const results = Object.fromEntries(SUMMARY_SOURCES.map(source => {
  const options: LedgerFilter = { source }
  return [JSON.stringify(options), { totals: scopeTotalsQuery(options, file), latest: latestRequestQuery(options, file), context: latestContextQuery(options, file), coverage: coverageQuery(file, now, options) }]
 }))
 const text = JSON.stringify({ at: now, results })
 if (Buffer.byteLength(text) > TELEMETRY_BUDGET.ledgerSummaryBytes) return
 const path = file + ".summary.json", temp = path + "." + randomUUID() + ".tmp"
 writeFileSync(temp, text)
 renameSync(temp, path)
}
function scopeTotalsQuery(options:LedgerFilter,file:string):ScopeTotals {
 const db=readonlyDatabase(file)
 try {
  const {where,params}=conditions(options,db)
  const token=(key:string)=>`sum(json_extract(body,'$.tokens.${key}')) ${key}, sum(json_extract(body,'$.tokens.${key}') IS NULL) missing_${key}`
  const row=db.query(`SELECT count(*) requests, sum(json_extract(body,'$.state')='running') running, count(DISTINCT session) sessions, min(at) firstAt, max(at) lastAt,
   sum(${KNOWN_TOKENS_SQL}) knownTokens, sum(coalesce(${OUTPUT_SQL},0)) outputTotal, sum(${OUTPUT_SQL} IS NULL) missingOutput,
   ${TOKEN_KEYS.map(token).join(", ")} FROM records WHERE `+where).get(...params) as any
  const models=db.query("SELECT json_extract(body,'$.route.modelID') modelID, json_extract(body,'$.route.providerID') providerID, json_extract(body,'$.route.reasoning') reasoning, json_extract(body,'$.route.harness') harness, count(*) requests, count(DISTINCT session) sessions FROM records WHERE "+where+" GROUP BY modelID,providerID,reasoning,harness ORDER BY requests DESC,providerID,modelID,reasoning,harness").all(...params) as ScopeTotals['models']
  const totals={} as Tokens, missing={} as Record<keyof Tokens,number>
  for(const key of TOKEN_KEYS){totals[key]=row?.[key]??null;missing[key]=row?.["missing_"+key]??0}
  return {requests:row?.requests??0,runningRequests:row?.running??0,sessions:row?.sessions??0,firstAt:row?.firstAt??null,lastAt:row?.lastAt??null,totals,knownTokens:row?.knownTokens??0,missing,outputIncludingReasoning:row?.outputTotal??0,missingOutputRequests:row?.missingOutput??0,models}
 }finally{db.close()}
}
export function ledgerLatestRequest(options:LedgerFilter={},file=PASSIVE_LEDGER_FILE):LedgerRow|null {
 if(!existsSync(file))return null
 const summarized=summaryEntry(file,options);if(summarized)return summarized.latest
 return latestRequestQuery(options,file)
}
function latestRequestQuery(options:LedgerFilter,file:string):LedgerRow|null {
 const db=readonlyDatabase(file)
 try {
  const {where,params}=conditions(options,db)
  const row=db.query("SELECT body FROM records WHERE "+where+" ORDER BY at DESC,id LIMIT 1").get(...params) as {body:string}|null
  return row?JSON.parse(row.body) as LedgerRow:null
 }finally{db.close()}
}
export function ledgerLatestContext(options:LedgerFilter={},file=PASSIVE_LEDGER_FILE):(NonNullable<RequestRecord["context"]>&{sessionID:string})|null {
 if(!existsSync(file))return null
 const summarized=summaryEntry(file,options);if(summarized)return summarized.context
 return latestContextQuery(options,file)
}
function latestContextQuery(options:LedgerFilter,file:string):(NonNullable<RequestRecord["context"]>&{sessionID:string})|null {
 const db=readonlyDatabase(file)
 try {
  const {where,params}=conditions(options,db)
  const row=db.query("SELECT body FROM records WHERE "+where+" AND json_extract(body,'$.context.tokens') IS NOT NULL AND json_extract(body,'$.kind') IN ('primary','chat') ORDER BY at DESC,id LIMIT 1").get(...params) as {body:string}|null
  if(!row)return null
  const value=JSON.parse(row.body) as LedgerRow
  return value.context?{...value.context,sessionID:value.sessionID}:null
 }finally{db.close()}
}
export function ledgerRequestPage(options:LedgerFilter&{offset:number;limit:number},file=PASSIVE_LEDGER_FILE) {
 if(!existsSync(file))return {rows:[] as LedgerRow[],total:0,nextOffset:null as number|null}
 const db=readonlyDatabase(file)
 try {
  const {where,params}=conditions(options,db)
  const total=(db.query("SELECT count(*) count FROM records WHERE "+where).get(...params) as {count:number}).count
  const rows=(db.query("SELECT body FROM records WHERE "+where+" ORDER BY at DESC,id LIMIT ? OFFSET ?").all(...params,options.limit,options.offset) as {body:string}[]).map(r=>JSON.parse(r.body) as LedgerRow)
  return {rows,total,nextOffset:options.offset+options.limit<total?options.offset+options.limit:null}
 }finally{db.close()}
}
export function ledgerActivityPage(options: LedgerFilter & { group: 'session' | 'quest' | 'model'; offset: number; limit: number }, file = PASSIVE_LEDGER_FILE) {
 const empty = { rows: [] as { sessionID: string | null; questID: string | null; providerID: string | null; modelID: string | null; reasoning: string | null; harness: string | null; variant: string | null; serviceTier: string | null; requests: number; sessions: number; tokens: number | null; partial: boolean }[], total: 0, nextOffset: null as number | null }
 if (!existsSync(file)) return empty
 const db = readonlyDatabase(file)
 try {
  const { where, params } = conditions(options, db)
  const routeFields = ['providerID', 'modelID', 'reasoning', 'harness', 'variant', 'serviceTier']
  const groups = { session: 'session', quest: "json_extract(body,'$.questID')", model: routeFields.map(key => field('route.' + key)).join(',') }
  const group = groups[options.group]
  if (!group) throw new Error('Unknown usage grouping')
  const total = (db.query(`SELECT count(*) count FROM (SELECT 1 FROM records WHERE ${where} GROUP BY ${group})`).get(...params) as { count: number }).count
  const input = ['input', 'cacheRead', 'cacheWrite'].map(key => field('tokens.' + key))
  const known = [...input, field('outputTotal'), field('tokens.output'), field('tokens.reasoning')].map(value => `${value} IS NOT NULL`).join(' OR ')
  const rows = db.query(`SELECT
   ${options.group === 'session' ? 'session' : 'NULL'} sessionID,
   ${options.group === 'quest' ? "json_extract(body,'$.questID')" : 'NULL'} questID,
   ${routeFields.map(key => (options.group === 'model' ? field('route.' + key) : 'NULL') + ' ' + key).join(',')},
   count(*) requests, count(DISTINCT source||':'||session) sessions,
   CASE WHEN max(${known}) THEN sum(${KNOWN_TOKENS_SQL}) ELSE NULL END tokens,
   max(${[...input, OUTPUT_SQL].map(value => `${value} IS NULL`).join(' OR ')}) partial
   FROM records WHERE ${where} GROUP BY ${group} ORDER BY tokens DESC, ${group} LIMIT ? OFFSET ?`).all(...params, options.limit, options.offset) as (Omit<(typeof empty.rows)[number], 'partial'> & { partial: number })[]
  return { rows: rows.map(row => ({ ...row, partial: Boolean(row.partial) })), total, nextOffset: options.offset + options.limit < total ? options.offset + options.limit : null }
 } finally { db.close() }
}
export function ledgerSessionPage(options:LedgerFilter&{offset:number;limit:number},file=PASSIVE_LEDGER_FILE) {
 if(!existsSync(file))return {sessions:[] as any[],total:0,nextOffset:null as number|null}
 const db=readonlyDatabase(file)
 try {
  const {where,params}=conditions(options,db)
  const total=(db.query("SELECT count(DISTINCT source||':'||session) count FROM records WHERE "+where).get(...params) as {count:number}).count
  const token=(key:string)=>`sum(${field('tokens.'+key)}) ${key}, sum(${field('tokens.'+key)} IS NULL) missing_${key}`
  const sessions=db.query(`SELECT json_extract(body,'$.source') source, session sessionID, count(*) requests,
   sum(json_extract(body,'$.state')='running') runningRequests, max(at) lastAt, min(at) firstAt,
   sum(${OUTPUT_SQL}) outputIncludingReasoning, sum(${OUTPUT_SQL} IS NULL) missingOutputRequests,
   ${TOKEN_KEYS.map(token).join(", ")} FROM records WHERE `+where+" GROUP BY source,session ORDER BY lastAt DESC LIMIT ? OFFSET ?").all(...params,options.limit,options.offset) as any[]
  return {sessions:sessions.map(s=>({source:s.source,sessionID:s.sessionID,requests:s.requests,runningRequests:s.runningRequests,firstAt:s.firstAt,lastAt:s.lastAt,outputIncludingReasoning:s.outputIncludingReasoning,missingOutputRequests:s.missingOutputRequests,totals:Object.fromEntries(TOKEN_KEYS.map(k=>[k,s[k]])),missingComponents:Object.fromEntries(TOKEN_KEYS.map(k=>[k,s['missing_'+k]]))})),total,nextOffset:options.offset+options.limit<total?options.offset+options.limit:null}
 }finally{db.close()}
}
export const UNCAPTURED_WINDOW_MS=86400000
export function ledgerCoverage(file=PASSIVE_LEDGER_FILE,now=Date.now(),options:LedgerFilter={}) {
 if(!existsSync(file))return {receipt:null as CollectorReceipt|null,coverageFrom:null as number|null,openGaps:0,resolvedGaps:0,records:0,observations:0,uncaptured:[] as {route:string;steps:number;sessions:number}[]}
 const summarized=summaryEntry(file,options);if(summarized)return summarized.coverage
 return coverageQuery(file,now,options)
}
function coverageQuery(file:string,now:number,options:LedgerFilter) {
 const db=readonlyDatabase(file)
 try {
  const meta=(key:string)=>{const r=db.query("SELECT body FROM meta WHERE key=?").get(key) as {body:string}|null;return r?JSON.parse(r.body):null}
  const count=(sql:string)=>(db.query(sql).get() as {count:number}).count
  const {where,params}=conditions(options,db)
  const host=conditions({...options,source:'opencode-host',from:Math.max(options.from??0,now-UNCAPTURED_WINDOW_MS)},db)
  const uncaptured=options.source==='codex'?[]:db.query("SELECT json_extract(h.body,'$.route.providerID')||'/'||json_extract(h.body,'$.route.modelID') route,count(*) steps,count(DISTINCT h.session) sessions FROM (SELECT * FROM records WHERE "+host.where+") h WHERE NOT EXISTS(SELECT 1 FROM records o WHERE o.session=h.session AND o.source='opencode') GROUP BY route ORDER BY steps DESC").all(...host.params) as {route:string;steps:number;sessions:number}[]
  const gapCount=(resolved:boolean)=>options.source&&options.source!=='codex'?0:(db.query("SELECT count(*) count FROM gaps WHERE coalesce(json_extract(body,'$.resolved'),0)=? AND at>=? AND at<=?"+(options.sessionID||options.accountID||options.questID||options.providerID||options.modelID?" AND json_extract(body,'$.sessionID') IN (SELECT session FROM records WHERE "+where+")":"")).get(resolved?1:0,options.from??0,options.to??now,...(options.sessionID||options.accountID||options.questID||options.providerID||options.modelID?params:[])) as {count:number}).count
  return {receipt:meta("receipt") as CollectorReceipt|null,coverageFrom:meta("coverageFrom") as number|null,
   openGaps:gapCount(false),resolvedGaps:gapCount(true),
   records:(db.query("SELECT count(*) count FROM records WHERE "+where).get(...params) as {count:number}).count,observations:count("SELECT count(*) count FROM quota"),uncaptured}
 }finally{db.close()}
}
export async function collectPassive(options:{file?:string;root?:string;hostDB?:string;now?:number;accounts?:AccountSnapshot;records?:RequestRecord[];observations?:Observation[];force?:boolean}={}) {
 const file=options.file??PASSIVE_LEDGER_FILE,now=options.now??Date.now(),db=onLedger(file,()=>open(file))
 const owner=randomUUID()
 let previous:number|null=null,hostPrevious:number|null=null,parserVersion=0,claimed=false,notBefore:number|undefined
 let telemetryCursor:TelemetryCursor|null=null,rolloutCursors:Record<string,SavedRolloutCursor>|null=null
 try {onLedger(file,()=>db.transaction(()=>{
  const get=(key:string)=>{const r=db.query("SELECT body FROM meta WHERE key=?").get(key) as {body:string}|null;return r?JSON.parse(r.body):null}
  previous=get("receipt")?.at??null;hostPrevious=get("receipt")?.hostScanAt??null;parserVersion=get("receipt")?.parserVersion??0
  const lease=get("lease")?.until??0
  if(lease>now){notBefore=lease;return}
  if(!options.force&&previous!==null&&now-previous<30000){notBefore=previous+30000;return}
  telemetryCursor=get("telemetryCursor");rolloutCursors=get("rolloutCursors")
  db.query("INSERT INTO meta VALUES('lease',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(JSON.stringify({owner,until:now+120000}));claimed=true
 }).immediate())}finally{db.close()}
 if(!claimed)return {collected:false,notBefore}
 try {
  const resumable=parserVersion>=4
  const from=Math.max(0,now-7*86400000,previous===null||!resumable?0:previous-5*60000)
  if(resumable)restoreRolloutCursors(rolloutCursors)
  const harvest=await harvestCodexUsage({root:options.root,from,now,changedOnly:resumable})
  const stored=options.records?{records:options.records,diagnostics:[],cursor:telemetryCursor,restarted:false}:readRequestsSince(resumable?telemetryCursor:null)
  const accounts=options.accounts??readAccountUsage()
  const observations=options.observations??readQuotaObservations(ACCOUNT_USAGE_FILE+".observations",{from:Math.max(0,now-7*86400000,previous===null?0:previous-5*60000)}).observations
  const hostFrom=Math.max(0,now-7*86400000,hostPrevious===null||!resumable?0:hostPrevious-5*60000)
  const nativeHost=readHostCounters({file:options.hostDB,from:hostFrom,to:now})
  const codexRows:LedgerRow[]=[]
  for(const s of harvest.sessions)for(const p of s.points)codexRows.push({id:"codex:"+hash([s.id,p.at,p.model,p.tokens]),source:"codex",sessionID:s.id,parentID:s.parentID,at:p.at,startedAt:p.at,route:{providerID:"openai",modelID:p.model,reasoning:p.reasoning??undefined,harness:"codex"},kind:s.source,state:"completed",tokens:p.tokens})
  const rows=[...ledgerRows(stored.records),...nativeHost.rows,...codexRows]
  const receipt:CollectorReceipt={at:now,from,parserVersion:4,hostScanAt:nativeHost.available?now:hostPrevious,scannedFiles:harvest.scannedFiles,readFiles:harvest.readFiles,unchangedFiles:harvest.unchangedFiles,
   newRequests:stored.records.length,newHostRows:nativeHost.rows.length,newCodexRows:codexRows.length,writtenRows:rows.length,...harvest.coverage,
   calibrationDiagnostics:[...harvest.diagnostics,...stored.diagnostics,...(harvest.coverage.malformedLines?["Malformed rollout lines leave calibration coverage incomplete"]:[])],
   diagnostics:[...(previous!==null&&now-previous>7*86400000?["Collector outage exceeds seven-day backfill; earlier activity may be missing"]:[]),...((stored as any).restarted&&previous!==null?["Request log was replaced; the collector re-read it from the start"]:[]),...harvest.diagnostics,...stored.diagnostics,...nativeHost.diagnostics,...(harvest.coverage.malformedLines?["Malformed rollout lines leave collection coverage incomplete"]:[])]}
  persistLedger({rows,observations,receipt,resolvedCounters:harvest.sessions.flatMap(s=>s.resolvedCounterAt.map(at=>({at,sessionID:s.id}))),gaps:harvest.sessions.flatMap(s=>s.gaps.map(g=>({...g,sessionID:s.id}))),cursors:{telemetry:(stored as any).cursor??null,rollouts:saveRolloutCursors()}},file)
  void accounts
  return {collected:true,receipt}
 } finally {
  onLedger(file,()=>{const release=open(file);try{release.query("DELETE FROM meta WHERE key='lease' AND json_extract(body,'$.owner')=?").run(owner)}finally{release.close()}})
 }
}
const KEY=generationKey("opencode.usage.passive-ledger")
export const PASSIVE_DEBOUNCE_MS=1500
export type PassiveUsageOptions={clock?:Clock.Clock}
export function startPassiveUsage(collect:()=>Promise<PassiveCollection>=collectPassiveOffThread,options:PassiveUsageOptions={}){
 const state=globalThis as any;if(state[KEY])return state[KEY].stop
 const observations=quotaObservationTail(ACCOUNT_USAGE_FILE+".observations")
 let running=false,dirty=false,stopped=false,scheduled:number|undefined
 const wake=Latch.makeUnsafe()
 const clock=options.clock??timerClock
 const run=async()=>{
  scheduled=undefined;running=true;dirty=false
  let retryAt:number|undefined
  try{
   const result=await timed({plugin:'usage',name:'step',op:'passive collection'},()=>collect())
   if(!result.collected)retryAt=result.notBefore
   updateBurnControls(readAccountUsage().accounts,observations(Date.now()-7*86400000))
  }catch(error){console.error("[usage] passive collection failed",error instanceof Error?error.message:"unknown")}
  finally{running=false}
  return retryAt
 }
 const loop=Effect.gen(function*(){
  for(;;){
   if(scheduled===undefined){yield* wake.await;wake.closeUnsafe();continue}
   if(stopped)break
   yield* Effect.sleep(Duration.millis(Math.max(0,scheduled)))
   if(stopped)break
   const retryAt=yield* Effect.promise(()=>run())
   if(dirty)scheduled=Math.max(PASSIVE_DEBOUNCE_MS,(retryAt??0)-Date.now())
   else if(retryAt!==undefined)scheduled=retryAt-Date.now()
  }
 })
 scheduled=PASSIVE_DEBOUNCE_MS
 const fiber=Effect.runFork(loop.pipe(Effect.provideService(Clock.Clock,clock)))
 const changed=()=>{if(stopped)return;if(running)dirty=true;else if(scheduled===undefined){scheduled=PASSIVE_DEBOUNCE_MS;wake.openUnsafe()}}
 const watchers:FSWatcher[]=[]
 const follow=(dir:string,match:(name:string)=>boolean,recursive=false)=>{
  if(!existsSync(dir))return
  try{const w=watch(dir,{recursive},(_event,name)=>{if(!name||match(String(name)))changed()});w.on("error",()=>{});(w as any).unref?.();watchers.push(w)}catch{}
 }
 mkdirSync(dirname(TELEMETRY_FILE),{recursive:true})
 follow(dirname(TELEMETRY_FILE),name=>name===basename(TELEMETRY_FILE))
 try{const stopAccounts=onAccountsChanged(changed);watchers.push({close:stopAccounts} as FSWatcher)}catch{}
 const host=basename(HOST_USAGE_DB)
 follow(dirname(HOST_USAGE_DB),name=>name===host||name===host+"-wal"||name===host+"-journal")
 follow(codexRolloutRoot(),()=>true,true)
 const stop=()=>{stopped=true;fiber.interruptUnsafe();for(const w of watchers)try{w.close()}catch{};delete state[KEY]}
 state[KEY]={stop};return stop
}

export function ledgerFirstRequests(sessionIDs:string[],file=PASSIVE_LEDGER_FILE):Map<string,number>{
 const found=new Map<string,number>()
 if(!sessionIDs.length||!existsSync(file))return found
 const db=readonlyDatabase(file)
 try{
  const statement=db.query("SELECT min(coalesce(json_extract(body,'$.startedAt'),at)) first FROM records WHERE session=? AND source='opencode'")
  for(const sessionID of new Set(sessionIDs)){const row=statement.get(sessionID) as {first:number|null}|null;if(typeof row?.first==="number")found.set(sessionID,row.first)}
 }finally{db.close()}
 return found
}
export function readSessionLedgerRowsBatch(queries:{sessionID:string;from:number;to:number}[],file=PASSIVE_LEDGER_FILE):LedgerRow[][]{
 for(const q of queries)if(!q.sessionID||!Number.isFinite(q.from)||!Number.isFinite(q.to)||q.to<q.from)throw Error("Invalid session ledger query")
 if(!queries.length)return []
 if(!existsSync(file))return queries.map(()=>[])
 const db=readonlyDatabase(file)
 try{
  const statement=db.query("SELECT body FROM records WHERE session=? AND source='opencode' AND at>=? AND at<=? ORDER BY at,id")
  return queries.map(q=>(statement.all(q.sessionID,q.from,q.to) as {body:string}[]).map(r=>JSON.parse(r.body) as LedgerRow))
 }finally{db.close()}
}
