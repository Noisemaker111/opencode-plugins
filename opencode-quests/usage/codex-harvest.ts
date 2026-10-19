import { existsSync, readdirSync, openSync, closeSync, readSync, fstatSync, statSync } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { join } from "node:path"
import { homedir } from "node:os"

export type HarvestTokens = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
export type HarvestPoint = { at: number; model: string; reasoning: string | null; tokens: HarvestTokens }
export type HarvestQuota = { at: number; limitID: string; window: string; minutes: number | null; resetAt: number | null; usedPercent: number }
export type HarvestSession = { id: string; parentID: string | null; forkedFromID: string | null; source: string; startedAt: number; points: HarvestPoint[]; quota: HarvestQuota[]; repeatedCounters: number; rejectedCounters: number; inheritedRecords: number; malformedLines: number; resolvedCounterAt:number[]; gaps: {at:number;reason:string;reportedLastTotal:number|null}[] }
const keys = ["input_tokens","cached_input_tokens","cache_write_input_tokens","output_tokens","reasoning_output_tokens"] as const
const counter = (v: any): number[] | null => {
  if (!v || keys.some(k => !Number.isSafeInteger(v[k]) || v[k] < 0) || v.cached_input_tokens+v.cache_write_input_tokens>v.input_tokens || v.reasoning_output_tokens>v.output_tokens || v.total_tokens!==v.input_tokens+v.output_tokens) return null
  return keys.map(k=>v[k])
}
type ParserState={session:HarvestSession|null;model:string;reasoning:string|null;prior:number[]|null}
type UsageParser={accept:(line:string)=>void;readonly session:HarvestSession|null;state:()=>ParserState;copy:()=>UsageParser}
function usageParser(initial?:{session:HarvestSession|null;model:string;reasoning:string|null;prior:number[]|null}):UsageParser {
  let {session,model,reasoning,prior}=initial??{session:null,model:"unknown",reasoning:null,prior:null}
  const accept=(line:string)=>{
    if (!line.trim()) return
    let row: any
    try { row=JSON.parse(line) } catch { if(session) session.malformedLines++; return }
    const p=row?.payload, at=Date.parse(row?.timestamp)
    if (!p || !Number.isFinite(at)) return
    if (row.type==="session_meta") {
      if (!session && typeof p.id==="string") session={id:p.id,parentID:typeof p.parent_thread_id==="string"?p.parent_thread_id:null,forkedFromID:typeof p.forked_from_id==="string"?p.forked_from_id:null,source:typeof p.source==="string"?p.source:p.source?.subagent?.other==="guardian"?"guardian":"subagent",startedAt:at,points:[],quota:[],repeatedCounters:0,rejectedCounters:0,inheritedRecords:0,malformedLines:0,resolvedCounterAt:[],gaps:[]}
      return
    }
    if (!session) return
    if (at<session.startedAt) {session.inheritedRecords++;return}
    if (row.type==="turn_context") {model=typeof p.model==="string"?p.model:"unknown";reasoning=typeof p.effort==="string"?p.effort:null;return}
    if (row.type!=="event_msg" || p.type!=="token_count") return
    const limits=p.rate_limits
    if (limits) for(const window of ["primary","secondary"]) {
      const w=limits[window]
      if(w && Number.isFinite(w.used_percent) && w.used_percent>=0 && w.used_percent<=100) session.quota.push({at,limitID:typeof limits.limit_id==="string"?limits.limit_id:"unknown",window,minutes:Number.isFinite(w.window_minutes)?w.window_minutes:null,resetAt:Number.isFinite(w.resets_at)?w.resets_at*1000:null,usedPercent:w.used_percent})
    }
    if (!p.info) return
    const total=counter(p.info.total_token_usage),last=counter(p.info.last_token_usage)
    if (total && prior && total.every((v,i)=>v===prior![i])) {session.repeatedCounters++;if(!last)session.resolvedCounterAt.push(at);return}
    if (!total || !last) {session.rejectedCounters++;session.gaps.push({at,reason:!total?"Cumulative components are inconsistent or missing":"Last-request components do not reconcile to its total",reportedLastTotal:Number.isSafeInteger(p.info.last_token_usage?.total_tokens)?p.info.last_token_usage.total_tokens:null});return}
    const delta=total.map((v,i)=>v-(prior?.[i]??0))
    const reconciled=delta.every((v,i)=>v===last[i])
    prior=total
    if (!reconciled) {session.rejectedCounters++;session.gaps.push({at,reason:"Cumulative movement does not match the last request",reportedLastTotal:p.info.last_token_usage.total_tokens});return}
    session.points.push({at,model,reasoning,tokens:{input:last[0]-last[1]-last[2],cacheRead:last[1],cacheWrite:last[2],output:last[3]-last[4],reasoning:last[4]}})
  }
  return {accept,get session(){return session},state:()=>({session,model,reasoning,prior}),copy:()=>usageParser(structuredClone({session,model,reasoning,prior}))}
}
export function parseCodexUsage(lines: Iterable<string>): HarvestSession | null {
  const parser=usageParser();for(const line of lines)parser.accept(line);return parser.session
}

type RolloutCursor={identity:string;mtime:number;size:number;offset:number;tail:string;decoder:StringDecoder;parser:ReturnType<typeof usageParser>;anchor:Buffer}
const cursors=new Map<string,RolloutCursor>()
export type SavedRolloutCursor={identity:string;mtime:number;size:number;offset:number;tail:string;anchor:string;model:string;reasoning:string|null;prior:number[]|null;session:HarvestSession|null}
export function saveRolloutCursors():Record<string,SavedRolloutCursor>{
 const saved:Record<string,SavedRolloutCursor>={}
 for(const [path,cursor] of cursors){
  const state=cursor.parser.state(),session=state.session
  saved[path]={identity:cursor.identity,mtime:cursor.mtime,size:cursor.size,offset:cursor.offset,tail:cursor.tail,anchor:cursor.anchor.toString("base64"),model:state.model,reasoning:state.reasoning,prior:state.prior,
   session:session?{...session,points:[],quota:[],gaps:[],resolvedCounterAt:[]}:null}
 }
 return saved
}
export function restoreRolloutCursors(saved:Record<string,SavedRolloutCursor>|null|undefined){
 cursors.clear()
 for(const [path,row] of Object.entries(saved??{})){
  if(!row||typeof row.identity!=="string"||!Number.isFinite(row.offset))continue
  cursors.set(path,{identity:row.identity,mtime:row.mtime,size:row.size,offset:row.offset,tail:row.tail??"",decoder:new StringDecoder("utf8"),anchor:Buffer.from(row.anchor??"","base64"),
   parser:usageParser({session:row.session,model:row.model??"unknown",reasoning:row.reasoning??null,prior:row.prior??null})})
 }
}
async function readRolloutSnapshot(path:string){
 const fd=openSync(path,'r')
 try{
  const stat=fstatSync(fd),identity=[stat.dev,stat.ino,stat.birthtimeMs].join(':'),previous=cursors.get(path)
  let cursor=previous,bytesRead=0,parsedBytes=0
  if(cursor&&cursor.offset){const anchor=Buffer.alloc(cursor.anchor.length);const n=readSync(fd,anchor,0,anchor.length,cursor.offset-anchor.length);bytesRead+=n;if(n!==anchor.length||!anchor.equals(cursor.anchor))cursor=undefined}
  if(!cursor||cursor.identity!==identity||stat.size<cursor.offset||(stat.size===cursor.offset&&stat.mtimeMs!==cursor.mtime))cursor={identity,mtime:stat.mtimeMs,size:stat.size,offset:0,tail:'',decoder:new StringDecoder('utf8'),parser:usageParser(),anchor:Buffer.alloc(0)}
  const buffer=Buffer.alloc(256*1024)
  while(cursor.offset<stat.size){
   const n=readSync(fd,buffer,0,Math.min(buffer.length,stat.size-cursor.offset),cursor.offset);if(!n)break
   cursor.offset+=n;bytesRead+=n;parsedBytes+=n;cursor.tail+=cursor.decoder.write(buffer.subarray(0,n))
   let start=0,end:number
   while((end=cursor.tail.indexOf('\n',start))!==-1){cursor.parser.accept(cursor.tail.slice(start,end));start=end+1}
   cursor.tail=cursor.tail.slice(start)
   await new Promise<void>(resolve=>setImmediate(resolve))
  }
  cursor.mtime=stat.mtimeMs;cursor.size=stat.size;if(parsedBytes){cursor.anchor=Buffer.alloc(Math.min(256,cursor.offset));bytesRead+=readSync(fd,cursor.anchor,0,cursor.anchor.length,cursor.offset-cursor.anchor.length)}cursors.set(path,cursor)
  const snapshot=cursor.parser.copy();let pendingTail=false
  if(cursor.tail.trim()){try{JSON.parse(cursor.tail);snapshot.accept(cursor.tail)}catch{pendingTail=true}}
  return {session:snapshot.session,bytesRead,parsedBytes,pendingTail}
 }catch(error){cursors.delete(path);throw error}finally{closeSync(fd)}
}
const reading=new Map<string,ReturnType<typeof readRolloutSnapshot>>()
async function readRollout(path:string){
 let pending=reading.get(path)
 if(!pending){pending=readRolloutSnapshot(path).finally(()=>reading.delete(path));reading.set(path,pending)}
 const result=await pending
 return {...result,session:structuredClone(result.session)}
}
export function sumHarvest(points: HarvestPoint[]): HarvestTokens {
  return points.reduce((a,p)=>({input:a.input+p.tokens.input,cacheRead:a.cacheRead+p.tokens.cacheRead,cacheWrite:a.cacheWrite+p.tokens.cacheWrite,output:a.output+p.tokens.output,reasoning:a.reasoning+p.tokens.reasoning}),{input:0,cacheRead:0,cacheWrite:0,output:0,reasoning:0})
}
export const codexRolloutRoot = () => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")
export async function harvestCodexUsage(options: {root?:string;from?:number;to?:number;now?:number;changedOnly?:boolean} = {}) {
  const now=options.now??Date.now(),from=options.from??now-4*3600000,to=options.to??now
  if (![from,to,now].every(Number.isFinite) || from>to || to>now || to-from>7*86400000) throw new Error("Harvest needs a past time range of at most seven days")
  const root=options.root??codexRolloutRoot(),diagnostics:string[]=[],files:{path:string;mtime:number;size:number}[]=[]
  let scanned=0
  const present=new Set<string>()
  function walk(dir:string) {
    for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>b.name.localeCompare(a.name))) {
      const path=join(dir,entry.name)
      if(entry.isDirectory()) walk(path)
      else if(entry.isFile() && entry.name.endsWith(".jsonl")){scanned++;present.add(path);const s=statSync(path);if(s.mtimeMs>=from) files.push({path,mtime:s.mtimeMs,size:s.size})}
    }
  }
  if(existsSync(root))try{walk(root)}catch{diagnostics.push("Some rollout directories could not be read")}
  else diagnostics.push("Codex rollout directory is unavailable")
  files.sort((a,b)=>b.mtime-a.mtime)
  for(const path of [...cursors.keys()])if(!present.has(path))cursors.delete(path)
  const byID=new Map<string,HarvestSession>()
  let bytesRead=0,parsedBytes=0,readFiles=0,unchangedFiles=0
  for(const file of files) {
    const known=cursors.get(file.path)
    if(options.changedOnly&&known&&known.size===file.size&&known.mtime===file.mtime){unchangedFiles++;continue}
    try {
      const read=await readRollout(file.path);bytesRead+=read.bytesRead;parsedBytes+=read.parsedBytes;if(read.bytesRead)readFiles++;if(read.pendingTail)diagnostics.push("A rollout has an unfinished trailing record; completed counters remain available");const s=read.session;if(!s)continue
      s.gaps=s.gaps.filter(g=>g.at>=from&&g.at<=to);s.points=s.points.filter(p=>p.at>=from&&p.at<=to);s.quota=s.quota.filter(p=>p.at>=from&&p.at<=to)
      if(!s.points.length&&!s.quota.length&&!s.gaps.length&&!s.resolvedCounterAt.length)continue
      const previous=byID.get(s.id)
      if(previous){diagnostics.push("Duplicate rollout identity; retaining the snapshot with more measured points");if(previous.points.length>=s.points.length)continue}
      byID.set(s.id,s)
    }catch{diagnostics.push("A rollout could not be read")}
  }
  const sessions=[...byID.values()].sort((a,b)=>a.startedAt-b.startedAt).map(s=>({...s,totals:sumHarvest(s.points),requests:s.points.length,lastObservedAt:s.points.at(-1)?.at??null}))
  const families=new Map<string,typeof sessions>()
  for(const session of sessions){let rootID=session.id,parent=session.parentID;const seen=new Set([rootID]);while(parent&&!seen.has(parent)){seen.add(parent);rootID=parent;parent=byID.get(parent)?.parentID??null}const family=families.get(rootID)??[];family.push(session);families.set(rootID,family)}
  return {source:"codex-rollout-counters" as const,from,to,observedAt:now,scannedFiles:scanned,readFiles,unchangedFiles,bytesRead,parsedBytes,diagnostics,sessions,
    families:[...families].map(([id,rows])=>({id,sessionIDs:rows.map(s=>s.id),astraSessions:rows.filter(s=>s.points.some(p=>p.model==="gpt-6-astra")).length,astra:sumHarvest(rows.flatMap(s=>s.points.filter(p=>p.model==="gpt-6-astra"))),guardians:sumHarvest(rows.filter(s=>s.source==="guardian").flatMap(s=>s.points)),requests:rows.reduce((n,s)=>n+s.requests,0)})),
    coverage:{malformedLines:sessions.reduce((n,s)=>n+s.malformedLines,0),reconciledRequests:sessions.reduce((n,s)=>n+s.requests,0),repeatedCounters:sessions.reduce((n,s)=>n+s.repeatedCounters,0),rejectedCounters:sessions.reduce((n,s)=>n+s.rejectedCounters,0),accountAttribution:"Rollouts do not identify the account. Quota samples are observations, not per-session charges.",scope:"Locally readable Codex rollouts only; other devices, web activity and unrecorded requests may be missing."}}
}
