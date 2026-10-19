import { isQuestID } from "./schema"
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs"
import {writeFileDurable,readJsonRecord} from "./durable-file.mjs"
import { createHash } from "node:crypto"
import { acquireLock } from "../locking.mts"
import { dirname, join } from "node:path"
import { validEvent } from "./events"
import { externalizeBlobs, hasBlobReference, resolveBlobs } from "./journal-blobs"
import { finishedQuests } from "./retention"
import { enforceDirectoryBudget, retentionFrom, TELEMETRY_BUDGET } from "../../scripts/telemetry-budget.mjs"
import type { Quest, QuestEvent } from "../types"

const PARSED_LIMIT = 8
const parsed = new Map<string, { stamp: string; events: QuestEvent[] }>()

export function journalPath(runtimeRoot: string, questID: string): string { return join(runtimeRoot, "journals", `${questID}.jsonl`) }
export function snapshotDue(events: QuestEvent[]): boolean {
  return events.length - events.findLastIndex(event => event.type === "snapshot") >= TELEMETRY_BUDGET.journalSnapshotEvents
}

function fileStamp(path: string) { try { const stat = statSync(path); return stat.mtimeMs + ":" + stat.size } catch { return "" } }
function journalState(path: string) {
  return { size: existsSync(path) ? statSync(path).size : 0, stamp: fileStamp(path) + "|" + fileStamp(path + ".recovery.json") }
}
function lastLine(fd: number, size: number) {
  const parts: Buffer[] = []
  for (let end = size; end > 0;) {
    const from = Math.max(0, end - 65536), part = Buffer.alloc(end - from)
    readSync(fd, part, 0, part.length, from)
    const at = part.lastIndexOf(0x0a)
    if (at >= 0) { parts.unshift(part.subarray(at + 1)); break }
    parts.unshift(part); end = from
  }
  return Buffer.concat(parts).toString("utf8")
}
function readLastByte(fd: number, size: number) { const byte = Buffer.alloc(1); readSync(fd, byte, 0, 1, size - 1); return byte[0] }
function separatorFor(path: string) {
  if (!existsSync(path)) return ""
  const size = statSync(path).size
  if (!size) return ""
  const fd = openSync(path, "r")
  try {
    if (readLastByte(fd, size) === 0x0a) return ""
    const tail = lastLine(fd, size)
    try { if (!validEvent(JSON.parse(tail))) throw Error("invalid") } catch { throw new Error("Interrupted Quest journal append; preserve and repair the final line before writing " + path) }
    return "\n"
  } finally { closeSync(fd) }
}
export function appendEvent(runtimeRoot: string, event: QuestEvent): void {
  if (!validEvent(event)) throw new Error("Invalid Quest event: a complete event envelope and object payload are required. Journal preserved.")
  const path = journalPath(runtimeRoot, event.questID); mkdirSync(dirname(path), { recursive: true })
  const separator = separatorFor(path)
  const line = `${separator}${JSON.stringify(externalizeBlobs(runtimeRoot, event))}\n`
  const held = parsed.get(path), before = journalState(path)
  appendFileSync(path, line, "utf8")
  const fd = openSync(path, "r+"); try { fsyncSync(fd) } finally { closeSync(fd) }
  const finished = finishedQuests(runtimeRoot)
  enforceDirectoryBudget(dirname(path), TELEMETRY_BUDGET.journalsBytes, { cutoff: retentionFrom(), deletable: entry => finished(entry.name.replace(/\.jsonl$/, "")) })
  if (!held) return
  const after = journalState(path)
  if (held.stamp === before.stamp && after.size === before.size + Buffer.byteLength(line)) { held.events.push(JSON.parse(JSON.stringify(event))); held.stamp = after.stamp }
  else parsed.delete(path)
}
export function readEvents(runtimeRoot: string, questID: string): QuestEvent[] {
  const path = journalPath(runtimeRoot, questID); if (!existsSync(path)) return []
  const stamp = journalState(path).stamp
  const held = parsed.get(path)
  if (held && held.stamp === stamp) return held.events.slice()
  const events = parseJournal(runtimeRoot, path)
  parsed.delete(path); parsed.set(path, { stamp, events })
  if (parsed.size > PARSED_LIMIT) parsed.delete(parsed.keys().next().value!)
  return events.slice()
}
function parseJournal(runtimeRoot: string, path: string): QuestEvent[] {
  const bytes=readFileSync(path),text=bytes.toString("utf8"),lines=text.split(/\r?\n/),events:QuestEvent[]=[]
  const recoveryFile=path+".recovery.json"
  const recovery=readJsonRecord(recoveryFile)
  if(recovery && (recovery.schema!==1 || !Number.isSafeInteger(recovery.bytes) || recovery.bytes<1 || recovery.bytes>bytes.length || sha(bytes.subarray(0,recovery.bytes))!==recovery.sha256))throw new Error("Quest journal recovery evidence does not match; journal preserved")
  for(const [index,line]of lines.entries()){
    if(!line.trim())continue
    let event:unknown
    try{event=JSON.parse(line)}catch{
      if(index===lines.length-1&&!text.endsWith("\n"))break
      throw new Error("Unreadable Quest journal line "+(index+1)+" in "+path+"; preserve and repair the journal before writing this Quest")
    }
    if(recovery && index+1===recovery.line && !validEvent(event) && sha(Buffer.from(line))===recovery.lineSha256)continue
    if(!validEvent(event))throw new Error("Invalid Quest event at line "+(index+1)+" in "+path+"; a complete event envelope and object payload are required. Journal preserved.")
    events.push(hasBlobReference(line) ? resolveBlobs(runtimeRoot, event) : event)
  }
  return events
}

const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex")
export function recoverIncompleteClaim(runtimeRoot:string,questID:string,input:{expectedSha256:string;reason:string;apply?:boolean}) {
 if(!isQuestID(questID))throw Error("Invalid Quest ID")
 if(!input.reason?.trim())throw Error("Recovery reason required")
 const lock=acquireLock(runtimeRoot,questID)
 try {
  const path=journalPath(runtimeRoot,questID),bytes=readFileSync(path),digest=sha(bytes)
  if(digest!==input.expectedSha256)throw Error("Quest journal changed since inspection")
  if(existsSync(path+".recovery.json"))throw Error("Quest already has a recovery receipt; inspect it")
  const text=bytes.toString("utf8"),lines=text.trimEnd().split(/\r?\n/)
  const events=lines.map(line=>JSON.parse(line)),last=events.at(-1)
  if(!text.endsWith("\n") || events.slice(0,-1).some(e=>!validEvent(e)) || !last || last.type!=="session-claimed" || Object.hasOwn(last,"payload") || !validEvent({...last,payload:{}}) || last.questID!==questID)throw Error("Recovery supports only a complete final session-claimed envelope missing payload")
  const receipt={schema:1,questID,line:lines.length,bytes:bytes.length,sha256:digest,lineSha256:sha(Buffer.from(lines.at(-1)!)),eventID:last.eventID,action:"discard-incomplete-claim",reason:input.reason,at:new Date().toISOString()}
  if(input.apply){
   const backup=path+"."+digest+".preserved";if(!existsSync(backup))writeFileSync(backup,bytes,{flag:"wx"})
   if(sha(readFileSync(backup))!==digest)throw Error("Recovery backup mismatch")
   writeFileDurable(path+".recovery.json",JSON.stringify(receipt,null,2)+"\n",{temporary:path+".recovery."+process.pid+".tmp",flag:"wx"})
  }
  return {...receipt,applied:input.apply===true}
 }finally{lock.release()}
}
