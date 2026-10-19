import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import {writeFileDurable} from "../quest/core/durable-file.mjs"
import { randomUUID } from 'node:crypto'
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { canonicalWorkerTitle, workerIdentityFromEvent, type ReasoningEffort, type WorkerRuntime } from "./dispatch"

export const LEDGER_FILE = process.env.OPENCODE_ORCHESTRATION_LEDGER?.trim() || join(homedir(), ".local", "state", "opencode", "orchestration.jsonl")
const MAX_BYTES = 2 * 1024 * 1024
const PRUNE_HEADROOM = 128 * 1024
const LOCK_WAIT_MS = 5
const LOCK_TIMEOUT_MS = 25
const STALE_LOCK_MS = 30_000
export function ledgerLockStatus(file = LEDGER_FILE): { state: 'available' | 'unknown-owner' | 'live-owner' | 'dead-owner'; retryable: boolean } {
  const lock = `${file}.lock`
  if (!existsSync(lock)) return { state: 'available', retryable: true }
  try {
    const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return { state: 'unknown-owner', retryable: false }
    try { process.kill(owner.pid, 0); return { state: 'live-owner', retryable: true } }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? { state: 'dead-owner', retryable: true } : { state: 'unknown-owner', retryable: false } }
  } catch { return { state: 'unknown-owner', retryable: false } }
}

export type LedgerEvent = {
  journalID?: string
  provenance?: "runtime" | "synthetic"
  v: 1
  at: string
  kind: "spawn" | "bound" | "lifecycle" | "heartbeat" | "terminal" | "notification" | "completion-delivery" | "scope-rejected" | "queued-message" | "message-delivered"
  parentID: string
  callID: string
  childID?: string
  agent?: string
  agentRole?: string
  providerID?: string
  modelID?: string
  reasoningEffort?: ReasoningEffort
  fast?: boolean
  runtime?: WorkerRuntime
  openCodeSessionId?: string
  runtimeSessionId?: string
  runID?: string
  task?: string
  openCodeSessionID?: string
  harnessSessionID?: string
  taskDescription?: string
  description?: string
  state?: "accepted" | "executing" | "blocked" | "completed" | "failed" | "cancelled" | "stopped" | "missing-result"
  scopeDelta?: Record<string, unknown>
  errorCode?: string
  questID?: string
  role?: string
  deliverables?: string[]
  messageID?: string
  deliveryKey?: string
  deliveryState?: "claimed" | "failed" | "delivered"
}

export type CompletionEvidence = {
  idempotencyKey: string; parentID: string; callID: string; runID: string
  openCodeSessionId?: string; runtimeSessionId?: string; questID?: string
  state: "completed" | "failed" | "cancelled" | "stopped" | "missing-result"
  summary: string; providerID?: string; modelID?: string; reasoningEffort?: ReasoningEffort; fast?: boolean; agentRole?: string; runtime?: WorkerRuntime; task?: string
}

const COMPLETION_HANDLERS = Symbol.for("opencode-config.orchestration.completion-handlers")
function completionHandlers(): Set<(completion: CompletionEvidence) => void> {
  const global = globalThis as { [COMPLETION_HANDLERS]?: Set<(completion: CompletionEvidence) => void> }
  return global[COMPLETION_HANDLERS] ??= new Set()
}

function completionFromEvent(event: LedgerEvent): CompletionEvidence | undefined {
  if (event.kind !== "notification" || !event.deliveryKey || !event.state) return
  return {
    idempotencyKey: event.deliveryKey,
    parentID: event.parentID,
    callID: event.callID,
    runID: event.runID ?? event.callID,
    openCodeSessionId: event.openCodeSessionId ?? event.openCodeSessionID,
    runtimeSessionId: event.runtimeSessionId ?? event.harnessSessionID,
    questID: event.questID,
    state: event.state as CompletionEvidence["state"],
    summary: event.description ?? "Quest session finished",
    providerID: event.providerID,
    modelID: event.modelID,
    reasoningEffort: event.reasoningEffort,
    fast: event.fast,
    agentRole: event.agentRole,
    runtime: event.runtime,
    task: event.task ?? event.taskDescription,
  }
}

export function completionEvidence(parentID: string, callID: string, childID: string, file = LEDGER_FILE): CompletionEvidence | undefined {
  const event = readLedger(file).findLast((row) => row.kind === "notification" && row.parentID === parentID && row.callID === callID && row.childID === childID)
  return event ? completionFromEvent(event) : undefined
}

export function claimCompletionDelivery(completion: CompletionEvidence, file = LEDGER_FILE): boolean {
  return withLedgerLock(file, () => {
    const events = readLedger(file)
    if (events.some((event) => event.kind === "message-delivered" && event.messageID === completion.idempotencyKey)) return false
    const latest = events.findLast((event) => event.kind === "completion-delivery" && event.deliveryKey === completion.idempotencyKey)
    if (latest && latest.deliveryState !== "failed") return false
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({
      v: 1, at: new Date().toISOString(), kind: "completion-delivery",
      parentID: completion.parentID, callID: completion.callID, deliveryKey: completion.idempotencyKey,
      runID: completion.runID, openCodeSessionId: completion.openCodeSessionId,
      runtimeSessionId: completion.runtimeSessionId, questID: completion.questID, deliveryState: "claimed",
    }) + "\n", "utf8")
    pruneLedger(file)
    return true
  }) === true
}

export function registerCompletionEvidenceHandler(handler: (completion: CompletionEvidence) => void, file = LEDGER_FILE): () => void {
  const handlers = completionHandlers()
  handlers.add(handler)
  for (const event of readLedger(file)) {
    const completion = completionFromEvent(event)
    if (completion) { try { handler(completion) } catch {} }
  }
  return () => handlers.delete(handler)
}

const DELIVERY_CLAIMANTS = Symbol.for("opencode-config.orchestration.delivery-claimants")
function deliveryClaimants(): Set<(completion: CompletionEvidence) => boolean> {
  const global = globalThis as { [DELIVERY_CLAIMANTS]?: Set<(completion: CompletionEvidence) => boolean> }
  return global[DELIVERY_CLAIMANTS] ??= new Set()
}

export function registerCompletionDeliveryClaimant(claimant: (completion: CompletionEvidence) => boolean): () => void {
  const claimants = deliveryClaimants()
  claimants.add(claimant)
  return () => claimants.delete(claimant)
}

export function completionDeliveryClaimed(completion: CompletionEvidence): boolean {
  for (const claimant of deliveryClaimants()) {
    try { if (claimant(completion)) return true } catch {}
  }
  return false
}

export function pendingCompletionEvidence(parentID?: string, file = LEDGER_FILE): CompletionEvidence[] {
  const events = readLedger(file)
  const legacyDelivered = new Set(events.filter((event) => event.kind === "message-delivered" && event.messageID).map((event) => event.messageID))
  const delivery = new Map<string, LedgerEvent>()
  for (const event of events) if (event.kind === "completion-delivery" && event.deliveryKey) delivery.set(event.deliveryKey, event)
  return events.flatMap((event) => {
    const completion = completionFromEvent(event)
    const latest = completion ? delivery.get(completion.idempotencyKey) : undefined
    return completion && (!parentID || completion.parentID === parentID) && !legacyDelivered.has(completion.idempotencyKey) && (!latest || latest.deliveryState === "failed") ? [completion] : []
  })
}

export function recordCompletionDelivered(parentID: string, idempotencyKey: string, file = LEDGER_FILE): boolean {
  if (!validID(parentID) || !validID(idempotencyKey)) return false
  return withLedgerLock(file, () => {
    const events = readLedger(file)
    if (!events.some((event) => event.kind === "notification" && event.parentID === parentID && event.deliveryKey === idempotencyKey)) return false
    const latest = events.findLast((event) => event.kind === "completion-delivery" && event.parentID === parentID && event.deliveryKey === idempotencyKey)
    if (latest?.deliveryState === "delivered") return true
    if (latest?.deliveryState !== "claimed") return false
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ v: 1, at: new Date().toISOString(), kind: "completion-delivery", parentID, callID: latest.callID, deliveryKey: idempotencyKey, deliveryState: "delivered" }) + "\n", "utf8")
    pruneLedger(file)
    return true
  }) === true
}

export function recordCompletionDeliveryFailed(parentID: string, idempotencyKey: string, file = LEDGER_FILE): boolean {
  if (!validID(parentID) || !validID(idempotencyKey)) return false
  return withLedgerLock(file, () => {
    const latest = readLedger(file).findLast((event) => event.kind === "completion-delivery" && event.parentID === parentID && event.deliveryKey === idempotencyKey)
    if (latest?.deliveryState !== "claimed") return false
    appendFileSync(file, JSON.stringify({ v: 1, at: new Date().toISOString(), kind: "completion-delivery", parentID, callID: latest.callID, deliveryKey: idempotencyKey, deliveryState: "failed" }) + "\n", "utf8")
    pruneLedger(file)
    return true
  }) === true
}

export function suppressCompletionDelivery(completion: CompletionEvidence, file = LEDGER_FILE, reason = "parked dependency; parent delivery suppressed"): boolean {
  return withLedgerLock(file, () => {
    const events = readLedger(file)
    const latest = events.findLast((event) => event.kind === "completion-delivery" && event.deliveryKey === completion.idempotencyKey)
    if (latest?.deliveryState === "delivered") return true
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ v: 1, at: new Date().toISOString(), kind: "completion-delivery", parentID: completion.parentID, callID: completion.callID, deliveryKey: completion.idempotencyKey, deliveryState: "delivered", description: reason }) + "\n", "utf8")
    pruneLedger(file)
    return true
  }) === true
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function withLedgerLock<T>(file: string, action: () => T): T | undefined {
  const lock = `${file}.lock`
  const started = Date.now()
  while (true) {
    try {
      mkdirSync(lock)
      try { writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, started }), "utf8"); return action() } finally { rmSync(lock, { recursive: true, force: true }) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          let owner: { pid?: number } | undefined
          try { owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) } catch {}
          if (Number.isInteger(owner?.pid) && owner!.pid! > 0 && owner!.pid !== process.pid) { try { process.kill(owner!.pid!, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') rmSync(lock, { recursive: true, force: true }) } }
        }
      } catch {}
      if (Date.now() - started >= LOCK_TIMEOUT_MS) return undefined
      sleepSync(LOCK_WAIT_MS)
    }
  }
}

function validID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length < 300
}

export function appendLedger(event: Omit<LedgerEvent, "v" | "at">, file = LEDGER_FILE): { state: 'appended' | 'pending'; lock?: ReturnType<typeof ledgerLockStatus> } {
  const line = JSON.stringify({ v: 1, at: new Date().toISOString(), ...event, journalID: randomUUID() }) + "\n"
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const acquired = withLedgerLock(file, () => {
        appendFileSync(file, line, "utf8")
        drainPendingLocked(file)
        pruneLedger(file)
        return true
      })
      if (acquired) return { state: 'appended' }
    } catch {}
  }
  const pending = `${file}.pending`
  mkdirSync(pending, { recursive: true })
  if (readdirSync(pending).length >= 10000) throw new Error('ORCHESTRATION_PENDING_FULL: reconcile pending lineage before admission')
  const name = join(pending, randomUUID())
  writeFileDurable(name + '.json', line, { temporary: name + '.tmp', flag: 'wx' })
  if(ledgerLockStatus(file).state!=='unknown-owner')schedulePendingDrain(file)
  return { state: 'pending', lock: ledgerLockStatus(file) }
}

const pendingDrains=new Set<string>()
function drainPendingLocked(file:string){
 const directory=file+'.pending';if(!existsSync(directory))return
 const files=readdirSync(directory).filter(n=>n.endsWith('.json')).slice(0,10000)
 const existing=new Set((existsSync(file)?readFileSync(file,'utf8'):'').split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line).journalID]}catch{return []}}))
 for(const name of files){const path=join(directory,name),line=readFileSync(path,'utf8');const id=JSON.parse(line).journalID;if(!existing.has(id)){appendFileSync(file,line,'utf8');existing.add(id)}rmSync(path)}
}
function schedulePendingDrain(file:string){
 if(pendingDrains.has(file))return;pendingDrains.add(file);let attempts=0
 const retry=()=>{try{if(ledgerLockStatus(file).state==='unknown-owner'){pendingDrains.delete(file);return}const ok=withLedgerLock(file,()=>{drainPendingLocked(file);return true});if(ok||++attempts>=20){pendingDrains.delete(file);return}}catch{pendingDrains.delete(file);return}setTimeout(retry,10)}
 setTimeout(retry,10)
}

function pruneLedger(file: string) {
  try {
    if (statSync(file).size <= MAX_BYTES) return
    const contents = readFileSync(file, "utf8")
    if (Buffer.byteLength(contents, "utf8") <= MAX_BYTES) return
    const kept: string[] = []
    const budget = MAX_BYTES - PRUNE_HEADROOM
    let bytes = 0
    for (const line of contents.trim().split(/\r?\n/).reverse()) {
      const size = Buffer.byteLength(line, "utf8") + 1
      if (bytes + size > budget) continue
      kept.push(line)
      bytes += size
    }
    const lines = kept.reverse()
    writeFileDurable(file, lines.length ? `${lines.join("\n")}\n` : "")
  } catch {}
}

export function readLedger(file = LEDGER_FILE): LedgerEvent[] {
  try {
    const pending = `${file}.pending`
    const contents = (existsSync(file) ? readFileSync(file, 'utf8') : '') + (existsSync(pending) ? readdirSync(pending).filter(n=>n.endsWith('.json')).slice(0,10000).map(n=>readFileSync(join(pending,n),'utf8')).join('') : '')
    const seen=new Set<string>()
    return contents.split(/\r?\n/).flatMap((line) => {
      try {
        const value = JSON.parse(line)
        if(value.journalID){if(seen.has(value.journalID))return [];seen.add(value.journalID)}
        return value?.v === 1 && (value.kind === "spawn" || value.kind === "bound" || value.kind === "lifecycle" || value.kind === "heartbeat" || value.kind === "terminal" || value.kind === "notification" || value.kind === "completion-delivery" || value.kind === "scope-rejected" || value.kind === "queued-message" || value.kind === "message-delivered") && validID(value.parentID) && validID(value.callID) ? [value as LedgerEvent] : []
      } catch { return [] }
    }).sort((a,b)=>a.at.localeCompare(b.at))
  } catch { return [] }
}

export type TrackedState = "pending" | "running" | "stopped" | "completed" | "failed" | "cancelled" | "missing-result"
export type TrackedChild = {
  parentID: string; callID: string; childID?: string; agent?: string; agentRole?: string
  providerID?: string; modelID?: string; reasoningEffort?: ReasoningEffort; fast?: boolean; runtime?: WorkerRuntime; openCodeSessionId?: string
  runtimeSessionId?: string; runID?: string; task?: string
  description?: string; state: TrackedState; lastEventAt?: string
}
export type ReconciledDisposition = "active" | "completed" | "failed" | "cancelled" | "stale" | "unresolved"
export type ReconciledChild = TrackedChild & { disposition: ReconciledDisposition; evidence: string[]; resumeSessionID?: string }

type EvidenceRow = { id?: string; state?: unknown; lastActivity?: unknown; parentID?: string; parent_id?: string; agent?: string; runtime?: string }

function terminalState(state: unknown): Extract<TrackedState, "completed" | "failed" | "cancelled"> | undefined {
  if (state === "completed" || state === "cancelled" || state === "failed") return state
  return undefined
}

function dbTerminalState(state: unknown) {
  const text = String(state ?? "").toLowerCase()
  if (/cancel/.test(text)) return "cancelled" as const
  if (/complete|success|done|idle:completed/.test(text)) return "completed" as const
  if (/fail|error/.test(text)) return "failed" as const
  return undefined
}

function setEventTime(child: TrackedChild, at: string) {
  Object.defineProperty(child, "lastEventAt", { value: at, writable: true, configurable: true, enumerable: false })
}

export function trackedChildren(parentID: string, payload: any, file = LEDGER_FILE): TrackedChild[] {
  const calls = new Map<string, TrackedChild>()
  const terminalCalls = new Map<string, Extract<TrackedState, "completed" | "failed" | "cancelled" | "stopped" | "missing-result">>()
  const childToCall = new Map<string, string>()
  for (const event of readLedger(file)) {
    if (event.parentID !== parentID) continue
    const key = event.kind === "terminal" && event.childID ? childToCall.get(event.childID) ?? event.callID : event.callID
    const prior = calls.get(key) ?? { parentID, callID: key, state: "pending" as const }
    if (event.kind === "spawn") {
      Object.assign(prior, { state: "pending" })
      if (event.agent !== undefined) prior.agent = event.agent
      if (event.agentRole !== undefined) prior.agentRole = event.agentRole
      if (event.providerID !== undefined) prior.providerID = event.providerID
      if (event.modelID !== undefined) prior.modelID = event.modelID
      if (event.reasoningEffort !== undefined) prior.reasoningEffort = event.reasoningEffort
      if (event.fast !== undefined) prior.fast = event.fast
      if (event.runtime !== undefined) prior.runtime = event.runtime
      if (event.runID !== undefined) prior.runID = event.runID
      if (event.task !== undefined || event.taskDescription !== undefined) prior.task = event.task ?? event.taskDescription
      if (event.description !== undefined) prior.description = event.description
      setEventTime(prior, event.at)
    }
    if (event.kind === "bound" && validID(event.childID)) {
      childToCall.set(event.childID, key)
      Object.assign(prior, { childID: event.childID, state: "pending" })
      if (event.runtime !== undefined) prior.runtime = event.runtime
      if (event.openCodeSessionId !== undefined || event.openCodeSessionID !== undefined) prior.openCodeSessionId = event.openCodeSessionId ?? event.openCodeSessionID
      if (event.runtimeSessionId !== undefined || event.harnessSessionID !== undefined) prior.runtimeSessionId = event.runtimeSessionId ?? event.harnessSessionID
      setEventTime(prior, event.at)
    }
    if (event.kind === "terminal" || event.kind === "notification" || (event.kind === "lifecycle" && terminalState(event.state))) {
      const state = event.state === "stopped" || event.state === "missing-result" ? event.state : terminalState(event.state)
      if (state) terminalCalls.set(key, state)
      setEventTime(prior, event.at)
    }
    calls.set(key, prior)
  }
  const running = Array.isArray(payload?.running) ? payload.running as EvidenceRow[] : []
  const all = [...running, ...(Array.isArray(payload?.recent) ? payload.recent as EvidenceRow[] : [])]
  for (const child of calls.values()) {
    const explicit = terminalCalls.get(child.callID)
    if (explicit) { child.state = explicit; continue }
    if (!child.childID) { child.state = "missing-result"; continue }
    const row = all.find((item) => item?.id === child.childID)
    const dbState = dbTerminalState(row?.state)
    if (dbState) { child.state = dbState; continue }
    if (running.some((item) => item?.id === child.childID)) { child.state = "running"; continue }
    if (!row) { child.state = "missing-result"; continue }
    child.state = "stopped"
  }
  return [...calls.values()]
}

export function reconcileTrackedChildren(parentID: string, payload: unknown, file = LEDGER_FILE): TrackedChild[] {
  return trackedChildren(parentID, payload, file)
}

export function reconcileLedger(file = LEDGER_FILE, payload: any = {}, manifest = `${file}.reconciliation.json`) {
  const result = withLedgerLock(file, () => {
    const events = readLedger(file)
    const parents = [...new Set(events.map((event) => event.parentID))]
    const records: ReconciledChild[] = parents.flatMap((parentID) => trackedChildren(parentID, payload, file).map((child) => {
      const evidence = events.filter((event) => event.parentID === parentID && (event.callID === child.callID || event.childID === child.childID)).map((event) => `${event.kind}:${event.state ?? ""}:${event.at}`)
      const disposition: ReconciledDisposition = child.state === "running" ? "active" : child.state === "completed" || child.state === "failed" || child.state === "cancelled" ? child.state : child.childID ? "stale" : "unresolved"
      return { ...child, disposition, evidence, resumeSessionID: child.openCodeSessionId ?? child.childID }
    }))
    const counts = Object.fromEntries((['active', 'completed', 'failed', 'cancelled', 'stale', 'unresolved'] as ReconciledDisposition[]).map((state) => [state, records.filter((record) => record.disposition === state).length]))
    const result = { schema: "opencode.orchestration-reconciliation/v1", source: file, generatedAt: new Date().toISOString(), sourceRows: events.length, records, counts }
    mkdirSync(dirname(manifest), { recursive: true })
    const backup = `${file}.pre-reconciliation-${Date.now()}.bak`
    if (existsSync(file)) copyFileSync(file, backup)
    writeFileDurable(manifest, JSON.stringify(result, null, 2) + "\n")
    return { ...result, backup }
  })
  if (!result) throw new Error(`ledger lock timeout: ${file}`)
  return result
}

function findSessionIDs(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const id of value.match(/ses_[A-Za-z0-9_-]+/g) ?? []) out.add(id)
  } else if (Array.isArray(value)) value.forEach((item) => findSessionIDs(item, out))
  else if (value && typeof value === "object") Object.values(value).forEach((item) => findSessionIDs(item, out))
  return out
}

export function childSessionID(event: unknown, parentID?: string): string | undefined {
  const ids = [...findSessionIDs(event)]
  return ids.find((id) => id !== parentID)
}

function verifiedNativeSession(value: unknown, parentID: string): string | undefined {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = verifiedNativeSession(item, parentID)
      if (found) return found
    }
    return
  }
  const row = value as Record<string, unknown>
  const id = [row.id, row.sessionID, row.sessionId].find((item): item is string => typeof item === "string" && /^ses_[A-Za-z0-9_-]+$/.test(item))
  const parent = row.parentID ?? row.parentId
  if (id && parent === parentID) return id
  for (const nested of Object.values(row)) {
    const found = verifiedNativeSession(nested, parentID)
    if (found) return found
  }
}

export function recordSpawn(event: any, file = LEDGER_FILE) {
  const input = event?.input ?? event?.args ?? {}
  const parentID = event?.sessionID
  const callID = event?.callID ?? event?.id ?? event?.messageID
  if (!validID(parentID) || !validID(callID)) return
  const identity = workerIdentityFromEvent(event)
  const agent = String(input.agent ?? "")
  appendLedger({
    kind: "spawn", parentID, callID, agent,
    agentRole: identity?.agentRole,
    providerID: identity?.providerID,
    modelID: identity?.modelID,
    reasoningEffort: identity?.reasoningEffort,
    fast: identity?.fast,
    runtime: identity?.runtime ?? "native",
    runID: identity?.runID ?? callID,
    task: identity?.task,
    description: identity ? canonicalWorkerTitle(identity) : String(input.description ?? input.title ?? ""),
    questID: validID(input.questID) ? input.questID : undefined,
    role: validID(input.role) ? input.role : undefined,
    deliverables: Array.isArray(input.deliverables) ? input.deliverables.slice(0, 50).map(String) : undefined,
  }, file)
}

export function recordLifecycle(parentID: string, callID: string, state: LedgerEvent["state"], childID?: string, file = LEDGER_FILE) {
  if (validID(parentID) && validID(callID) && state) appendLedger({ kind: "lifecycle", parentID, callID, childID, state }, file)
}

export function recordSpawnResult(event: any, output?: unknown, file = LEDGER_FILE) {
  const parentID = event?.sessionID
  const callID = event?.callID ?? event?.id ?? event?.messageID
  if (!validID(parentID) || !validID(callID)) return
  const identity = workerIdentityFromEvent(event)
  const childID = childSessionID(output ?? event, parentID)
  if (childID) {
    const openCodeSessionId = verifiedNativeSession(output ?? event, parentID)
    appendLedger({ kind: "bound", parentID, callID, childID, runtime: "native", openCodeSessionId, runID: identity?.runID ?? callID }, file)
  }
}

export function recordNativeSessionLineage(parentID: string, callID: string, openCodeSessionId: string, file = LEDGER_FILE) {
  if (!validID(parentID) || !validID(callID) || !/^ses_[A-Za-z0-9_-]+$/.test(openCodeSessionId)) return
  appendLedger({ kind: "bound", parentID, callID, childID: openCodeSessionId, runtime: "native", openCodeSessionId }, file)
}

export function recordTerminal(parentID: string, childID: string, state: "completed" | "failed" | "cancelled", file = LEDGER_FILE) {
  if (validID(parentID) && validID(childID)) {
    const callID = readLedger(file).filter((event) => event.parentID === parentID && event.childID === childID).at(-1)?.callID ?? childID
    appendLedger({ kind: "terminal", parentID, callID, childID, state }, file)
  }
}

export function recordNotification(parentID: string, callID: string, childID: string, state: "completed" | "failed" | "cancelled" | "stopped" | "missing-result", description: string, file = LEDGER_FILE): boolean {
  if (!validID(parentID) || !validID(callID) || !validID(childID)) return false
  const result = withLedgerLock(file, () => {
    const events = readLedger(file)
    const lineage = events.filter((event) => event.parentID === parentID && event.callID === callID)
    const spawn = lineage.find((event) => event.kind === "spawn")
    const deliveryKey = `${parentID}:${spawn?.runID ?? callID}:terminal`
    if (events.some((event) => event.kind === "notification" && (event.deliveryKey === deliveryKey || (event.parentID === parentID && event.callID === callID && event.childID === childID)))) return undefined
    const bound = lineage.findLast((event) => event.kind === "bound")
    const notification: Omit<LedgerEvent, "v" | "at"> = {
      kind: "notification", parentID, callID, childID, state, deliveryKey,
      description: description.length > 4000 ? description.slice(-4000) : description,
      questID: spawn?.questID,
      providerID: spawn?.providerID,
      modelID: spawn?.modelID,
      reasoningEffort: spawn?.reasoningEffort,
      fast: spawn?.fast,
      agentRole: spawn?.agentRole,
      runtime: spawn?.runtime,
      runID: spawn?.runID ?? callID,
      task: spawn?.task ?? spawn?.taskDescription,
      openCodeSessionId: bound?.openCodeSessionId ?? bound?.openCodeSessionID,
      runtimeSessionId: bound?.runtimeSessionId ?? bound?.harnessSessionID,
    }
    mkdirSync(dirname(file), { recursive: true })
    const event = { v: 1 as const, at: new Date().toISOString(), ...notification }
    appendFileSync(file, JSON.stringify(event) + "\n", "utf8")
    pruneLedger(file)
    return event
  })
  const completion = result ? completionFromEvent(result) : undefined
  if (!completion) return false
  for (const handler of completionHandlers()) { try { handler(completion) } catch {} }
  return true
}

export function enqueueMessage(parentID: string, messageID: string, description: string, file = LEDGER_FILE): boolean {
  if (!validID(parentID) || !validID(messageID)) return false
  return withLedgerLock(file, () => {
    if (readLedger(file).some((event) => event.kind === "queued-message" && event.parentID === parentID && event.messageID === messageID)) return false
    mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify({ v: 1, at: new Date().toISOString(), kind: "queued-message", parentID, callID: messageID, messageID, description: description.slice(0, 4000) }) + "\n", "utf8"); pruneLedger(file); return true
  }) === true
}

export function pendingMessages(parentID: string, file = LEDGER_FILE): LedgerEvent[] {
  const events = readLedger(file), delivered = new Set(events.filter((e) => e.kind === "message-delivered" && e.messageID).map((e) => e.messageID))
  return events.filter((e) => e.kind === "queued-message" && e.parentID === parentID && e.messageID && !delivered.has(e.messageID))
}

export function deliverMessage(parentID: string, messageID: string, file = LEDGER_FILE): boolean {
  if (!pendingMessages(parentID, file).some((e) => e.messageID === messageID)) return false
  appendLedger({ kind: "message-delivered", parentID, callID: messageID, messageID }, file); return true
}

export function recordScopeRejection(parentID: string, callID: string, errorCode: string, scopeDelta: Record<string, unknown>, childID?: string, file = LEDGER_FILE) {
  if (!validID(parentID) || !validID(callID)) return
  appendLedger({ kind: "scope-rejected", parentID, callID, childID, errorCode, scopeDelta: { value: "[REDACTED]" }, state: "failed" }, file)
}
