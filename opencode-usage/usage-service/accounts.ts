import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, unlinkSync, statSync, utimesSync, watch, type FSWatcher } from "node:fs"
import { writeFileDurable } from "./durable"
import { usageHooks } from "./hooks"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { discoverAllConnections, discoverConnections, type Connection } from "./connections"
import { probeConnection, type Observation, type ProbeFailure } from "./adapters"
import type { AccountSnapshot, AccountUsage, AccountWindow, PublicConnection } from "./types"
import { ACCOUNT_USAGE_TTL_MS, accountIsStale, ageSeconds, windowNeedsRefresh } from "./freshness"
import { proxyAccountProvider } from "./proxy-owners"
export type { AccountSnapshot, AccountUsage, AccountWindow } from "./types"

export const ACCOUNT_USAGE_FILE = process.env.OPENCODE_ACCOUNT_USAGE_FILE ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "opencode", "account-usage.json")
export { ACCOUNT_USAGE_TTL_MS, accountIsStale, windowNeedsRefresh }
const PLAN_TTL_MS = 6 * 3600_000
export const throttleBackoffMs = (throttles: number) => throttles <= 0 ? 0 : Math.min(300_000, ACCOUNT_USAGE_TTL_MS * 2 ** Math.min(throttles - 1, 4))
const serviceFolder = import.meta.dirname.replaceAll("\\", "/")
const stateKey = Symbol.for("opencode.account-usage.service" + (/\/generations\/[^/]+\/usage-service$/.test(serviceFolder) ? "@" + serviceFolder : ""))
type State = { flights: Map<string, Promise<AccountSnapshot>>; refresher?: AccountUsageRefresher }
function state(): State {
  const root = globalThis as any
  return root[stateKey] ??= { flights: new Map() }
}
const span = <T,>(name: string, run: () => Promise<T>): Promise<T> => { const wrap = usageHooks().span; return wrap ? wrap(name, run) : run() }
const empty = (): AccountSnapshot => ({ schema: 1, updatedAt: "", accounts: [], diagnostics: [] })
function readRaw(file: string): AccountSnapshot {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"))
    return data.schema === 1 && Array.isArray(data.accounts) && Array.isArray(data.diagnostics) && data.accounts.every((a: any) =>
      a && typeof a.id === "string" && a.plan && Array.isArray(a.windows) && Array.isArray(a.connections) &&
      a.windows.every((w: any) => w && typeof w.id === "string")) ? data : empty()
  } catch { return empty() }
}
export function readAccountUsage(file = ACCOUNT_USAGE_FILE, now = Date.now()): AccountSnapshot {
  const snapshot = readRaw(file)
  return { ...snapshot, accounts: snapshot.accounts.map(a => ({
    ...a,
    freshness: { stale: accountIsStale(a, now), ageSeconds: ageSeconds(a, now), resetPending: a.windows.some(w => windowNeedsRefresh(w, now)) },
    state: ["auth-required", "unsupported"].includes(a.state) ? a.state : accountIsStale(a, now) || a.windows.some(w => w.scope === "shared" && windowNeedsRefresh(w, now)) ? "unknown" : a.state,
  })) }
}
function publicConnection(c: Connection): PublicConnection {
  return { id: c.id, owner: c.owner, routeProviders: c.routeProviders, modelPrefix: c.modelPrefix }
}
function sameConnections(account: AccountUsage, connections: Connection[]): boolean {
  return JSON.stringify(account.connections) === JSON.stringify(connections.map(publicConnection))
}
function newAccount(c: Connection): AccountUsage {
  return {
    id: c.accountID, provider: c.provider, identity: c.identity, connections: [], plan: c.plan,
    windows: [], extraUsage: { enabled: null }, state: "unknown", observedAt: null,
    attemptedAt: null, nextAttemptAt: null, failures: 0, error: null,
  }
}
export type AccountServiceOptions = {
  refresh?: boolean
  file?: string
  now?: () => number
  discover?: () => ReturnType<typeof discoverConnections> | Promise<ReturnType<typeof discoverConnections>>
  probe?: (connection: Connection, options: { now: () => number; fetch: typeof fetch; refreshPlan: boolean }) => Promise<Observation | ProbeFailure>
  fetch?: typeof fetch
  lockWaitMs?: number
  accounts?: string[]
  leaseOwner?: string
}
function writeAtomic(file: string, snapshot: AccountSnapshot) {
  writeFileDurable(file, JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 })
}
const LOCK_STALE_MS = 120_000
function lockReleased(lockFile: string, until: number): Promise<void> {
  return new Promise(resolve => {
    let watcher: FSWatcher | undefined, timer: ReturnType<typeof setTimeout> | undefined, settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { watcher?.close() } catch {}
      resolve()
    }
    try {
      watcher = watch(dirname(lockFile), () => { if (!existsSync(lockFile)) done() })
      watcher.on("error", done)
    } catch {}
    timer = setTimeout(done, Math.max(0, until - Date.now()))
    if (!existsSync(lockFile)) done()
  })
}

async function refreshUnderLock(opts: AccountServiceOptions): Promise<AccountSnapshot> {
  const file = opts.file ?? ACCOUNT_USAGE_FILE, now = opts.now ?? Date.now
  if (!opts.refresh && !opts.accounts) {
    const holder = refreshLeaseHolder(file, now())
    if (holder && holder.owner !== opts.leaseOwner) {
      const cached = readAccountUsage(file, now())
      if (cached.accounts.length && !cached.accounts.some(account => accountIsStale(account, now()))) return cached
    }
  }
  mkdirSync(dirname(file), { recursive: true })
  const lockFile = file + ".lock", owner = randomUUID(), deadline = Date.now() + (opts.lockWaitMs ?? 18_000)
  let acquired = false
  while (!acquired) {
    try { writeFileSync(lockFile, owner, { flag: "wx", mode: 0o600 }); acquired = true } catch (error: any) {
      if (error?.code !== "EEXIST") throw error
      let staleAt = Infinity
      try {
        const touched = statSync(lockFile).mtimeMs
        if (Date.now() - touched > LOCK_STALE_MS) { const aside = lockFile + "." + randomUUID() + ".stale"; renameSync(lockFile, aside); unlinkSync(aside); continue }
        staleAt = touched + LOCK_STALE_MS + 1
      } catch {}
      if (Date.now() >= deadline) {
        const cached = readAccountUsage(file, now())
        return { ...cached, diagnostics: [...cached.diagnostics, "Account refresh is still in progress; returning last observations."] }
      }
      await lockReleased(lockFile, Math.min(deadline, staleAt))
    }
  }
  const heartbeat = setInterval(() => { try { if (readFileSync(lockFile, "utf8") === owner) utimesSync(lockFile, new Date(), new Date()) } catch {} }, 10_000)
  heartbeat.unref?.()
  try {
    const previous = readRaw(file)
    const discovery = await span("account refresh: discovery", async () => (opts.discover ?? discoverAllConnections)())
    const groups = new Map<string, Connection[]>()
    for (const c of discovery.connections) groups.set(c.accountID, [...(groups.get(c.accountID) ?? []), c])
    const entries = [...groups.entries()], accounts: AccountUsage[] = new Array(entries.length)
    let index = 0
    const worker = async () => {
      for (;;) {
        const i = index++
        if (i >= entries.length) return
        const [id, connections] = entries[i]
        const old = previous.accounts.find(a => a.id === id)
        const current = old ?? newAccount(connections[0])
        const clock = now(), attempt = Date.parse(current.attemptedAt ?? "")
        const recentAttempt = Number.isFinite(attempt) && clock - attempt >= 0 && clock - attempt < 5000
        const retry = Date.parse(current.nextAttemptAt ?? "")
        const atReset = current.windows.some(w => windowNeedsRefresh(w, clock))
        const retained = old && sameConnections(old, connections)
        if (retained && opts.accounts && !opts.accounts.includes(id)) {
          accounts[i] = current
          continue
        }
        if (retained && (recentAttempt || (retry > clock && (current.failures > 0 || !opts.refresh && !atReset)))) {
          accounts[i] = current
          continue
        }
        const base = { ...current, connections: connections.map(publicConnection), attemptedAt: new Date(clock).toISOString() }
        let failure: ProbeFailure = { state: "unknown", error: "No working usage connection." }
        let observation: Observation | undefined
        let activeConnectionID: string | undefined
        const planAge = clock - Date.parse(current.plan.observedAt ?? "")
        const refreshPlan = current.plan.provenance !== "provider-observed" || !Number.isFinite(planAge) || planAge < 0 || planAge >= PLAN_TTL_MS
        const ordered = [...connections].sort((a, b) => Number(b.id === current.activeConnectionID) - Number(a.id === current.activeConnectionID))
        for (const connection of ordered) {
          try {
            const result = await (opts.probe ?? probeConnection)(connection, { now, fetch: opts.fetch ?? fetch, refreshPlan })
            if ("windows" in result) { observation = result; activeConnectionID = connection.id; break }
            failure = result
          } catch (error) { failure = { state: "unknown", error: "Usage adapter failed: " + (error instanceof Error ? error.message : String(error)) } }
        }
        if (observation) {
          const observed = now()
          const shared = observation.windows.filter(w => w.scope === "shared")
          const exhausted = shared.some(w => w.state === "exhausted")
          const available = shared.length > 0 && shared.every(w => w.state === "available" && !windowNeedsRefresh(w, observed))
          const upcoming = observation.windows.flatMap(w => w.resetAt && Date.parse(w.resetAt) > observed ? [Date.parse(w.resetAt) + 100] : [])
          const throttledAt = Date.parse(current.throttledAt ?? "")
          const throttles = Number.isFinite(throttledAt) && observed - throttledAt < ACCOUNT_USAGE_TTL_MS ? current.throttles ?? 0 : 0
          accounts[i] = {
            ...base, activeConnectionID, windows: observation.windows, plan: observation.plan ?? current.plan,
            extraUsage: observation.extraUsage ?? current.extraUsage,
            state: exhausted ? "exhausted" : available ? "available" : "unknown",
            observedAt: new Date(observed).toISOString(),
            nextAttemptAt: new Date(Math.min(observed + Math.max(ACCOUNT_USAGE_TTL_MS, throttleBackoffMs(throttles)), ...upcoming)).toISOString(),
            failures: 0, error: null, throttles, throttledAt: throttles ? current.throttledAt : null,
          }
        } else {
          const failures = current.failures + 1
          const throttled = /\b429\b/.test(failure.error ?? "")
          const throttles = throttled ? (current.throttles ?? 0) + 1 : 0
          const advised = (failure.retryAfterSeconds ?? Math.min(300, 15 * 2 ** Math.min(failures - 1, 5))) * 1000
          const retryMs = Math.max(5000, advised, throttled ? throttleBackoffMs(throttles) : 0)
          accounts[i] = { ...base, state: failure.state, failures, error: failure.error,
            throttles, throttledAt: throttled ? new Date(now()).toISOString() : current.throttledAt ?? null,
            nextAttemptAt: new Date(now() + retryMs).toISOString() }
        }
      }
    }
    await span("account refresh: probes", () => Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker)))
    const snapshot: AccountSnapshot = { schema: 1, updatedAt: new Date(now()).toISOString(), accounts, diagnostics: discovery.diagnostics }
    writeAtomic(file, snapshot)
    try { usageHooks().recorded?.(snapshot, file) } catch { snapshot.diagnostics.push("Quota observation history could not be saved") }
    if (opts.leaseOwner) try { usageHooks().refreshed?.(snapshot, { now: now(), pollIntervalMs: ACCOUNT_USAGE_TTL_MS }) } catch {}
    return readAccountUsage(file, now())
  } finally {
    clearInterval(heartbeat)
    try { if (readFileSync(lockFile, "utf8") === owner) unlinkSync(lockFile) } catch {}
  }
}
export function onAccountsChanged(listener: () => void, file = ACCOUNT_USAGE_FILE): () => void {
  mkdirSync(dirname(file), { recursive: true })
  const name = basename(file)
  const watcher = watch(dirname(file), (_event, changed) => { if (!changed || String(changed) === name) listener() })
  watcher.on("error", () => { try { watcher.close() } catch {} })
  return () => { try { watcher.close() } catch {} }
}
export function getAccountUsage(options: AccountServiceOptions = {}): Promise<AccountSnapshot> {
  const key = (options.file ?? ACCOUNT_USAGE_FILE) + (options.accounts ? "#" + [...options.accounts].sort().join(",") : "")
  const flights = state().flights
  const existing = flights.get(key)
  if (existing) return existing
  const pending = refreshUnderLock(options).finally(() => { if (flights.get(key) === pending) flights.delete(key) })
  flights.set(key, pending)
  return pending
}
export const REFRESH_LEASE_MS = 90_000
const leaseFile = (file: string) => file + ".refresh-owner"
export function refreshLeaseHolder(file = ACCOUNT_USAGE_FILE, now = Date.now()): { owner: string; pid: number; at: number } | null {
  try {
    const held = JSON.parse(readFileSync(leaseFile(file), "utf8"))
    if (typeof held?.owner !== "string" || !Number.isFinite(held?.at) || now - held.at >= REFRESH_LEASE_MS) return null
    return held
  } catch { return null }
}
export function claimRefreshLease(owner: string, file = ACCOUNT_USAGE_FILE, now = Date.now()): boolean {
  const path = leaseFile(file)
  const held = refreshLeaseHolder(file, now)
  if (held && held.owner !== owner) return false
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileDurable(path, JSON.stringify({ owner, pid: process.pid, at: now }), { flag: "wx", mode: 0o600 })
    return refreshLeaseHolder(file, now)?.owner === owner
  } catch { return false }
}
export const ACCOUNT_ACTIVITY_DEBOUNCE_MS = 2000
const MAX_TIMER_MS = 2 ** 31 - 1
export type AccountUsageRefresher = { requestCompleted(accountID: string): void; stop(): void }
export function startAccountUsageRefresh(options: Pick<AccountServiceOptions, "file" | "now" | "discover" | "probe" | "fetch"> = {}): AccountUsageRefresher {
  const st = state()
  if (st.refresher) return st.refresher
  const file = options.file ?? ACCOUNT_USAGE_FILE, now = options.now ?? Date.now
  const owner = randomUUID()
  const pending = new Map<string, { at: number; timer?: ReturnType<typeof setTimeout> }>()
  let resetTimer: ReturnType<typeof setTimeout> | undefined, stopped = false
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(run, Math.min(MAX_TIMER_MS, Math.max(0, ms)))
    timer.unref?.()
    return timer
  }
  const read = (accounts?: string[], leased = claimRefreshLease(owner, file, now())) =>
    getAccountUsage({ ...options, file, accounts, leaseOwner: leased ? owner : undefined }).catch(() => undefined)
  const accountOf = (id: string) => readRaw(file).accounts.find(a => a.id === id)

  const armReset = () => {
    clearTimeout(resetTimer)
    if (stopped) return
    const clock = now()
    const next = Math.min(...readRaw(file).accounts.flatMap(a => a.windows.flatMap(w => {
      const at = Date.parse(w.resetAt ?? "")
      return at > clock ? [at + 100] : []
    })))
    if (!Number.isFinite(next)) return
    resetTimer = later(next - clock, () => {
      if (stopped) return
      if (now() < next) return armReset()
      const due = readRaw(file).accounts.filter(a => a.windows.some(w => windowNeedsRefresh(w, now()))).map(a => a.id)
      if (!due.length || !claimRefreshLease(owner, file, now())) return armReset()
      void read(due, true).then(armReset)
    })
  }

  const answer = async (id: string, event: { at: number; timer?: ReturnType<typeof setTimeout>; retried?: boolean }) => {
    event.timer = undefined
    if (stopped) return
    const account = accountOf(id)
    if (!account || Date.parse(account.attemptedAt ?? "") >= event.at) return void pending.delete(id)
    const notBefore = Date.parse(account.nextAttemptAt ?? "")
    if (notBefore > now()) { event.timer = later(notBefore - now(), () => void answer(id, event)); return }
    pending.delete(id)
    await read([id])
    armReset()
    const after = accountOf(id)
    if (after && !(Date.parse(after.attemptedAt ?? "") >= event.at) && !event.retried && !pending.has(id)) {
      const retry = { ...event, retried: true }
      pending.set(id, retry)
      retry.timer = later(ACCOUNT_ACTIVITY_DEBOUNCE_MS, () => void answer(id, retry))
    }
  }
  const requestCompleted = (accountID: string) => {
    if (stopped || !accountID) return
    const at = now(), waiting = pending.get(accountID)
    if (waiting) { waiting.at = Math.max(waiting.at, at); return }
    const event: { at: number; timer?: ReturnType<typeof setTimeout> } = { at }
    pending.set(accountID, event)
    event.timer = later(ACCOUNT_ACTIVITY_DEBOUNCE_MS, () => void answer(accountID, event))
  }
  const stop = () => {
    stopped = true
    clearTimeout(resetTimer)
    for (const event of pending.values()) clearTimeout(event.timer)
    pending.clear()
    if (st.refresher === refresher) delete st.refresher
  }
  const refresher: AccountUsageRefresher = { requestCompleted, stop }
  st.refresher = refresher
  if (claimRefreshLease(owner, file, now())) void read(undefined, true).then(armReset)
  else armReset()
  return refresher
}
export function formatAccountUsage(snapshot: AccountSnapshot, now = Date.now()): string {
  const lines = snapshot.accounts.map(account => {
    const plan = account.plan.name ?? account.plan.rateLimitTier ?? "plan unknown"
    const tier = account.plan.multiplier ? " " + account.plan.multiplier + "x" : ""
    const windows = account.windows.map(w => {
      const time = w.resetAt ? Math.max(0, Math.ceil((Date.parse(w.resetAt) - now) / 60000)) : null
      return w.id + " " + (w.usedPercent == null ? "usage not reported" : w.usedPercent + "% used") + (w.remainingPercent == null ? '' : ', ' + w.remainingPercent + '% remaining') + (time == null ? "; reset not reported" : "; resets " + w.resetAt + ' (' + time + 'm)')
    }).join("; ")
    return account.id + " [" + plan + tier + "; " + account.state + (accountIsStale(account, now) ? "; stale" : "") + "] " + windows + (account.error ? " — " + account.error : "")
  })
  return lines.length ? lines.join("\n") : "No readable account connections discovered."
}

export function accountsForRoute(snapshot: AccountSnapshot, providerID: string, modelID: string): AccountUsage[] {
  return snapshot.accounts.filter(account => account.connections.some(connection => {
    if (connection.owner === "usage") return false
    if (!connection.routeProviders.includes(providerID)) return false
    if (connection.modelPrefix && !modelID.startsWith(connection.modelPrefix + "/")) return false
    const model = connection.modelPrefix ? modelID.slice(connection.modelPrefix.length + 1) : modelID
    if (providerID !== "cliproxyapi") return true
    const owner = proxyAccountProvider(model)
    if (owner) return account.provider === owner
    return account.provider === "openai" ? /^gpt-|^o[1-9]/.test(model) :
      account.provider === "claude" ? /^claude-/.test(model) :
      account.provider === "grok" ? /^grok-/.test(model) : false
  }))
}
export function relevantAccountWindows(account: AccountUsage, modelID: string) {
  const upstreamModel = modelID.includes("/") ? modelID.slice(modelID.indexOf("/") + 1) : modelID
  return account.windows.filter(w => w.scope === "shared" || w.scope === "model" &&
    (w.model === upstreamModel || w.model + "-fast" === upstreamModel || w.model?.startsWith("claude-") && upstreamModel.startsWith(w.model + "-")))
}
