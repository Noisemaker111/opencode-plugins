import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { runFileStem } from "./core/durable-file.mjs"
import { createRequire } from "node:module"
import type { Fiber } from "effect"
import { workerData } from "node:worker_threads"

export const START = `${Math.floor(Date.now() - process.uptime() * 1000)}-${process.pid}`
function sleep(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" } }
const created: (pid: number) => number | undefined = (() => {
  try {
    if (process.platform === "win32") {
      const { dlopen, FFIType, ptr } = createRequire(import.meta.url)("bun:ffi")
      const kernel = dlopen("kernel32.dll", {
        OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
        GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
        CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
      }).symbols
      return (pid: number) => {
        const handle = kernel.OpenProcess(0x1000, false, pid)
        if (!handle) return undefined
        try {
          const times = [0, 1, 2, 3].map(() => new BigUint64Array(1))
          return kernel.GetProcessTimes(handle, ptr(times[0]), ptr(times[1]), ptr(times[2]), ptr(times[3])) ? Number(times[0][0] / 10000n) - 11644473600000 : undefined
        } finally { kernel.CloseHandle(handle) }
      }
    }
    if (process.platform === "linux") {
      const boot = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]) * 1000
      return (pid: number) => {
        try { const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19]); return Number.isFinite(ticks) && boot ? boot + ticks * 10 : undefined } catch { return undefined }
      }
    }
  } catch {}
  return () => undefined
})()
const SAME_PROCESS_MS = 2000
export const processStartedAt=(pid:number)=>pid===process.pid?Number(START.split('-')[0]):created(pid)
const WORKER_OWNER_TOKEN = typeof workerData?.lockOwnerToken === "string" ? workerData.lockOwnerToken : undefined
export function ownerAlive(pid: number, start: string): boolean {
  if (pid === process.pid) return start === START
  if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return false
  const recorded = Number(/^(\d+)-\d+$/.exec(start)?.[1]), actual = created(pid)
  return !Number.isFinite(recorded) || actual === undefined || Math.abs(actual - recorded) <= SAME_PROCESS_MS
}
export type LockWait = { name: string; start: number; waitedMs: number; outcome: 'acquired' | 'timeout' }
const waitObservers = new Set<(wait: LockWait) => void>()
export function observeLockWaits(observer: (wait: LockWait) => void) { waitObservers.add(observer); return () => { waitObservers.delete(observer) } }
function waited(wait: LockWait) { for (const observer of waitObservers) try { observer(wait) } catch {} }
export type HeldLock = { path: string; nonce: string; heartbeat(): void; release(): void }

function releaseLocksWhere(runtimeRoot: string, gone: (data: OwnerRecord) => boolean): string[] {
  const directory = join(runtimeRoot, "locks"), released: string[] = []
  let names: string[] = []
  try { names = readdirSync(directory).filter(name => name.endsWith(".lock")) } catch { return released }
  for (const name of names) {
    const path = join(directory, name)
    try {
      const file = statSync(path).isDirectory() ? join(path, "owner.json") : path, text = readFileSync(file, "utf8"), data = parsed(text)
      if (!data || !gone(data) || readFileSync(file, "utf8") !== text) continue
      rmSync(path, { recursive: true, force: true })
      released.push(name.slice(0, -5))
    } catch {}
  }
  return released
}

export function releaseWorkerLocks(runtimeRoot: string, workerOwnerToken: string): string[] {
  return releaseLocksWhere(runtimeRoot, data => data.workerOwnerToken === workerOwnerToken)
}

export class LockBusyError extends Error {
  constructor(name:string,holder?:string) { super(`lock timeout: ${name}${holder?'; held by '+holder:''}`); this.name='LockBusyError' }
}

export type RunOwner = { quest: string; run: string }
export type LockOptions = { timeoutMs?: number; staleMs?: number; isAlive?: (pid: number, start: string) => boolean; holder?: string; holderEnded?: (holder: string) => boolean; owner?: RunOwner; ownerEnded?: (owner: RunOwner) => boolean }
type OwnerRecord = { pid?: unknown; processStart?: unknown; nonce?: unknown; heartbeat?: unknown; holder?: unknown; workerOwnerToken?: unknown; quest?: unknown; run?: unknown }
function runOwner(data: OwnerRecord): RunOwner | undefined {
  return typeof data.quest === "string" && typeof data.run === "string" ? { quest: data.quest, run: data.run } : undefined
}
function confirms<T>(ended: ((value: T) => boolean) | undefined, value: T | undefined): boolean {
  if (!ended || value === undefined) return false
  try { return !!ended(value) } catch { return false }
}
function ownerGone(data: OwnerRecord, isAlive: (pid: number, start: string) => boolean, options: Pick<LockOptions, "holderEnded" | "ownerEnded">): boolean {
  return !isAlive(Number(data.pid), String(data.processStart))
    || confirms(options.holderEnded, typeof data.holder === "string" ? data.holder : undefined)
    || confirms(options.ownerEnded, runOwner(data))
}
function parsed(text: string): OwnerRecord | undefined {
  try { const data = JSON.parse(text); return data && typeof data === "object" ? data : undefined } catch { return undefined }
}
function breakUnreadable(path: string, file: string, text: string, stale: number) {
  const lock = statSync(path), age = Date.now() - Math.max(lock.mtimeMs, statSync(file).mtimeMs)
  if (age <= stale) return
  const again = statSync(path)
  if (again.ino === lock.ino && again.mtimeMs === lock.mtimeMs && readFileSync(file, "utf8") === text) rmSync(path, { recursive: true, force: true })
}

function breakOwnerless(path: string, stale: number) {
  try {
    const lock = statSync(path)
    if (!lock.isDirectory() || Date.now() - lock.mtimeMs <= stale || readdirSync(path).length) return false
    const again = statSync(path)
    if (again.ino !== lock.ino || again.mtimeMs !== lock.mtimeMs) return false
    rmdirSync(path)
    return true
  } catch { return false  }
}

function holderDescription(path: string): string | undefined {
  try {
    const data = parsed(readFileSync(statSync(path).isDirectory() ? join(path, "owner.json") : path, "utf8"))
    if (!data) return undefined
    const idle = Date.now() - statSync(path).mtimeMs, scope = runOwner(data)
    return `pid ${String(data.pid)}${typeof data.holder === "string" ? ` (${data.holder})` : ""}${scope ? ` for quest ${scope.quest} run ${scope.run}` : ""}, last touched ${idle < 120_000 ? Math.round(idle / 1000) + " s" : Math.round(idle / 60_000) + " min"} ago`
  } catch { return undefined }
}

export function acquireLock(runtimeRoot: string, name: string, options: LockOptions = {}): HeldLock {
  const path = join(runtimeRoot, "locks", `${runFileStem(name)}.lock`), started = Date.now(), nonce = randomBytes(12).toString("hex")
  const timeout = options.timeoutMs ?? 15_000, stale = options.staleMs ?? 30_000, isAlive = options.isAlive ?? ownerAlive
  mkdirSync(join(runtimeRoot, "locks"), { recursive: true })
  const candidate = join(runtimeRoot, "locks", `.owner-${process.pid}-${nonce}.json`)
  const owner = () => statSync(path).isDirectory() ? join(path, "owner.json") : path
  writeFileSync(candidate, JSON.stringify({ pid: process.pid, processStart: START, nonce, ...(options.holder ? { holder: options.holder } : {}), ...(options.owner ? { quest: options.owner.quest, run: options.owner.run } : {}), ...(WORKER_OWNER_TOKEN ? { workerOwnerToken: WORKER_OWNER_TOKEN } : {}) }), { flag: "wx" })
  let contended = false
  try {
  while (true) {
    try {
      linkSync(candidate, path)
      if (contended) waited({ name, start: started, waitedMs: Date.now() - started, outcome: 'acquired' })
      const heartbeat = () => { const current = JSON.parse(readFileSync(owner(), "utf8")); if (current.nonce === nonce) { const now = new Date(); utimesSync(path, now, now) } }
      return { path, nonce, heartbeat, release: () => { try { const current = JSON.parse(readFileSync(owner(), "utf8")); if (current.nonce === nonce) rmSync(path, { recursive: true, force: true }) } catch {} } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && !existsSync(path)) throw error
      try {
        const file = owner(), text = readFileSync(file, "utf8"), data = parsed(text)
        if (data) {
          if (ownerGone(data, isAlive, options) && readFileSync(file, "utf8") === text) { rmSync(path, { recursive: true, force: true }); continue }
        } else breakUnreadable(path, file, text, stale)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && breakOwnerless(path, stale)) continue
      }
      contended = true
      if (Date.now() - started >= timeout) { if (timeout > 0) waited({ name, start: started, waitedMs: Date.now() - started, outcome: 'timeout' }); throw new LockBusyError(name, holderDescription(path)) }
      sleep(5)
    }
  }
  } finally { unlinkSync(candidate) }
}

export const workspaceLockHolder = (sessionID: string) => "session:" + sessionID

export function lockHolder(runtimeRoot: string, name: string): string | undefined {
  const path = join(runtimeRoot, "locks", `${runFileStem(name)}.lock`)
  try { const holder = parsed(readFileSync(statSync(path).isDirectory() ? join(path, "owner.json") : path, "utf8"))?.holder; return typeof holder === "string" ? holder : undefined } catch { return undefined }
}

export function releaseLockHeldBy(runtimeRoot: string, name: string, holder: string): boolean {
  const path = join(runtimeRoot, "locks", `${runFileStem(name)}.lock`)
  try {
    const file = statSync(path).isDirectory() ? join(path, "owner.json") : path, text = readFileSync(file, "utf8")
    if (parsed(text)?.holder !== holder || readFileSync(file, "utf8") !== text) return false
    rmSync(path, { recursive: true, force: true })
    return true
  } catch { return false }
}

const abortDelayError = (): Error => { const error = new Error("The operation was aborted"); error.name = "AbortError"; (error as NodeJS.ErrnoException).code = "ABORT_ERR"; return error }
export async function acquireLockAsync(runtimeRoot:string,name:string,signal:AbortSignal,options:Omit<LockOptions,"timeoutMs">={}):Promise<HeldLock> {
  signal.throwIfAborted()
  const { Effect, Schedule, Duration } = await import("effect")
  signal.throwIfAborted()
  return await new Promise<HeldLock>((resolve,reject) => {
    const attempt = Effect.callback<HeldLock,unknown>(resume => {
      try { resume(Effect.succeed(acquireLock(runtimeRoot,name,{...options,timeoutMs:0}))) }
      catch(error) { resume(Effect.fail(error)) }
    })
    let ended = false
    const conclude = () => { ended = true; signal.removeEventListener("abort",onAbort) }
    let fiber: Fiber.Fiber<void,never> | undefined
    const onAbort = () => { if(ended)return; conclude(); fiber?.interruptUnsafe(); reject(abortDelayError()) }
    signal.addEventListener("abort",onAbort)
    fiber = Effect.runFork(attempt.pipe(
      Effect.retry({ while: error => error instanceof LockBusyError, schedule: Schedule.spaced(Duration.millis(50)) }),
      Effect.matchEffect({
        onSuccess: held => Effect.sync(() => { if(!ended){conclude();resolve(held)} }),
        onFailure: error => Effect.sync(() => { if(!ended){conclude();reject(error)} })
      })
    ))
  })
}

export function releaseRunLocks(runtimeRoot: string, owner: RunOwner): string[] {
  return releaseLocksWhere(runtimeRoot, data => { const run = runOwner(data); return !!run && run.quest === owner.quest && run.run === owner.run })
}

export function releaseAbandonedLocks(runtimeRoot: string, ended: Pick<LockOptions, "holderEnded" | "ownerEnded">, isAlive: (pid: number, start: string) => boolean = ownerAlive): string[] {
  return releaseLocksWhere(runtimeRoot, data => ownerGone(data, isAlive, ended))
}
