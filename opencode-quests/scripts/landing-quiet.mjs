#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Duration, Effect } from 'effect'
import { writeFileDurable } from '../quest/core/durable-file.mjs'
import { resolveChannel } from '../quest/channel.mjs'
import { enforceJsonlBudget, TELEMETRY_BUDGET } from './telemetry-budget.mjs'
import { busyCount } from './host-busy.mjs'
import { clearFailure } from './surface-record.mjs'
import { holdReloadLock, hostMoved, hostUpdateNeeded, mainCheckout, reloadDirectory, reloadReport, reloadServices, tryReloadLock } from './fresh-services.mjs'

export const PENDING = 'reload.pending'
export const RESULT = 'reload.result.json'
const RECORD_LOCK = 'reload-records.lock'
const stamp = () => new Date().toISOString()
const readJSON = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined } }
const channelNow = () => resolveChannel().name
const pendingFile = top => join(reloadDirectory(top), PENDING)
const resultFile = top => join(reloadDirectory(top), RESULT)
const pendingChannels = top => {
  const value = readJSON(pendingFile(top))
  if (value?.channels) return value.channels
  return value ? { [value.channel ?? 'v2']: value } : {}
}
const resultChannels = top => {
  const value = readJSON(resultFile(top)), stored = value?.channels ?? (value ? { [value.channel ?? 'v2']: value } : {})
  return Object.fromEntries(Object.entries(stored).map(([channel, records]) => [channel, Array.isArray(records) ? records : [records]]))
}
const enforceReloadRecordsBudget = (top, pending = pendingChannels(top), results = resultChannels(top)) => {
  const pendingBytes = Buffer.byteLength(JSON.stringify({ channels: pending })), resultBytes = Buffer.byteLength(JSON.stringify({ channels: results }))
  const size = pendingBytes + resultBytes
  return size > TELEMETRY_BUDGET.reloadRecordsBytes
    ? `reload record budget exceeded: ${size} bytes exceeds ${TELEMETRY_BUDGET.reloadRecordsBytes}; ${TELEMETRY_BUDGET.reloadRecordsRetention} were preserved`
    : undefined
}
const writePending = (top, channels) => {
  const failure = enforceReloadRecordsBudget(top, channels)
  if (failure) for (const [channel, pending] of Object.entries(channels)) channels[channel] = { ...pending, budgetError: failure }
  writeFileDurable(pendingFile(top), JSON.stringify({ channels }))
  return failure
}

export const reloadLog = top => join(reloadDirectory(top), 'landings.log')
export const pendingUpdate = (top, channel = channelNow()) => pendingChannels(top)[channel]

export async function markPending(top, why, waiter, now = stamp(), channel = channelNow(), restartsHost = true) {
  mkdirSync(reloadDirectory(top), { recursive: true })
  const release = await holdReloadLock(top, 5_000, () => {}, RECORD_LOCK)
  try {
    const channels = pendingChannels(top)
    const earlier = channels[channel]
    const waiting = [...(earlier?.waiting ?? [])]
    if (waiter && !waiting.some(row => row.questID === waiter.questID && row.runID === waiter.runID)) waiting.push(waiter)
    const host = restartsHost || (earlier ? earlier.host !== false : false)
    const pending = { channel, generation: randomUUID(), first: earlier?.first ?? now, last: now, landings: (earlier?.landings ?? 0) + 1, why, host, waiting, ...(earlier?.attempt ? { attempt: earlier.attempt } : {}) }
    channels[channel] = pending
    const failure = writePending(top, channels)
    if (failure) throw Error(failure)
    return channels[channel]
  } finally { release() }
}

export async function markLanded(dir, why, waiter) {
  const top = await mainCheckout(dir)
  const channel = channelNow()
  const pending = await markPending(top, why, waiter, stamp(), channel)
  const classified = classifyPending(top, channel, pending.generation).catch(() => {})
  return { top, pending, classified }
}

async function classifyPending(top, channel, generation) {
  if (await hostUpdateNeeded(top, channel)) return
  const release = await holdReloadLock(top, 5_000, () => {}, RECORD_LOCK)
  try {
    const pending = pendingUpdate(top, channel)
    if (pending?.generation === generation && pending.host !== false) writeChannelPending(top, channel, { ...pending, host: false })
  } finally { release() }
}


export const reloadRunner = (execPath = process.execPath) => /(?:^|[\\/])(?:node|bun)(?:\.exe)?$/i.test(execPath) ? execPath : 'node'

export function startReload(top, waiting = [], channel = channelNow(), generation, createChild = spawn) {
  mkdirSync(reloadDirectory(top), { recursive: true })
  const out = openSync(reloadLog(top), 'a')
  try {
    const runner = join(top, 'scripts', 'landing-quiet.mjs')
    const child = createChild(reloadRunner(), [runner, '--run', top, JSON.stringify(waiting), channel, generation ?? ''], { cwd: top, detached: true, windowsHide: true, stdio: ['ignore', out, out] })
    child.once('error', () => clearAttempt(top, channel, generation))
    child.unref()
    return { pid: child.pid, log: reloadLog(top) }
  } finally { closeSync(out) }
}

const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
export const reloadAttempting = (top, channel = channelNow()) => alive(pendingUpdate(top, channel)?.attempt?.pid)
const writeChannelPending = (top, channel, pending) => {
  const channels = pendingChannels(top)
  if (pending) channels[channel] = pending
  else delete channels[channel]
  if (Object.keys(channels).length) return writePending(top, channels)
  try { unlinkSync(pendingFile(top)) } catch {}
  return undefined
}
const clearAttemptLocked = (top, channel, generation) => {
  const pending = pendingUpdate(top, channel)
  if (!pending || pending.attempt?.generation !== generation) return
  const { attempt, ...remaining } = pending
  return writeChannelPending(top, channel, remaining)
}
const clearAttempt = (top, channel, generation) => {
  const release = tryReloadLock(top, RECORD_LOCK)
  if (!release) return
  try {
    const failure = clearAttemptLocked(top, channel, generation)
    if (failure) process.stderr.write('[reload] ' + failure + '\n')
  } finally { release() }
}

export function reloadIfIdle(top, { start = startReload, channel = channelNow() } = {}) {
  const release = tryReloadLock(top, RECORD_LOCK)
  if (!release) return undefined
  try {
    let pending = pendingUpdate(top, channel)
    if (!pending) return undefined
    const prior = resultChannels(top)[channel] ?? []
    if (prior.some(result => result.generation === pending.generation)) {
      const failure = writeChannelPending(top, channel, undefined)
      if (failure) process.stderr.write('[reload] ' + failure + '\n')
      return undefined
    }
    if (pending.attempt) {
      if (pending.attempt.pid && alive(pending.attempt.pid)) return undefined
      const { attempt, ...remaining } = pending
      pending = remaining
    }
    const generation = pending.generation ?? randomUUID()
    const claimed = { ...pending, generation, attempt: { generation } }
    const claimFailure = writeChannelPending(top, channel, claimed)
    if (claimFailure) process.stderr.write('[reload] ' + claimFailure + '\n')
    try {
      const result = start(top, pending.waiting ?? [], channel, generation)
      const startFailure = writeChannelPending(top, channel, { ...claimed, attempt: { generation, pid: result?.pid } })
      if (startFailure) process.stderr.write('[reload] ' + startFailure + '\n')
      return result
    } catch (error) {
      clearAttemptLocked(top, channel, generation)
      throw error
    }
  } finally { release() }
}

const writeReloadResultLocked = (top, { ok, revision, text, waiting = [], channel = channelNow(), generation }) => {
  mkdirSync(reloadDirectory(top), { recursive: true })
  const channels = resultChannels(top), records = channels[channel] ?? []
  let record = { channel, ...(generation ? { generation } : {}), ok, ...(revision ? { revision } : {}), text, at: stamp(), waiting }
  records.push(record)
  channels[channel] = records
  const budgetError = enforceReloadRecordsBudget(top, pendingChannels(top), channels)
  if (budgetError) {
    record = { ...record, ok: false, text: text + '; ' + budgetError, budgetError }
    records[records.length - 1] = record
  }
  writeFileDurable(resultFile(top), JSON.stringify({ channels }))
  return record
}
export async function writeReloadResult(top, value) {
  const release = await holdReloadLock(top, 30_000, () => {}, RECORD_LOCK)
  try { return writeReloadResultLocked(top, value) } finally { release() }
}

export function takeReloadResult(top, channel = channelNow()) {
  const release = tryReloadLock(top, RECORD_LOCK)
  if (!release) return undefined
  try {
    const channels = resultChannels(top), records = channels[channel] ?? []
    const record = records.shift()
    if (!record) return undefined
    if (record.generation) {
      const pending = pendingUpdate(top, channel)
      const failure = pending?.generation === record.generation
        ? writeChannelPending(top, channel, undefined)
        : clearAttemptLocked(top, channel, record.generation)
      if (failure) process.stderr.write('[reload] ' + failure + '\n')
    }
    if (records.length) channels[channel] = records
    else delete channels[channel]
    if (Object.keys(channels).length) writeFileDurable(resultFile(top), JSON.stringify({ channels }))
    else try { unlinkSync(resultFile(top)) } catch {}
    return record
  } finally { release() }
}

export async function runReload(top, { reload, waiting = [], channel = channelNow(), generation, start, busy = busyCount } = {}) {
  mkdirSync(reloadDirectory(top), { recursive: true })
  const startedAt = Date.now()
  let report
  try { report = await (reload ? reload(top) : reloadReport(await reloadServices(top, { channel }))) } catch (error) { report = { top, error: error instanceof Error ? error.message : String(error) } }
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  if (report?.reloadOutcome === 'held') {
    const release = await holdReloadLock(top, 30_000, () => {}, RECORD_LOCK)
    try {
      if (generation) clearAttemptLocked(top, channel, generation)
      const pending = pendingUpdate(top, channel)
      if (pending && pending.host === false) writeChannelPending(top, channel, { ...pending, host: true })
    } finally { release() }
    appendFileSync(reloadLog(top), JSON.stringify({ at: Date.now(), text: 'held: ' + (report.heldReason ?? 'a worker is running') + '; the update stays pending' }) + '\n')
    if (!(await busy())) reloadIfIdle(top, { channel, start })
    return report
  }
  const failed = report?.error || report?.reloadOutcome === 'failed'
  const text = report?.error ? 'failed: ' + report.error : report?.reloadOutcome ?? 'unknown'
  const release = await holdReloadLock(top, 30_000, () => {}, RECORD_LOCK)
  let result, storageError, superseded = false
  try {
    const pending = pendingUpdate(top, channel)
    storageError = pending?.budgetError
    result = writeReloadResultLocked(top, { ok: !failed && !storageError, revision: report?.landedSha, text: `reload finished in ${seconds} s: ${text}${storageError ? '; ' + storageError : ''}`, waiting, channel, generation })
    if (generation) {
      if (pending?.generation === generation) {
        const { attempt, ...kept } = pending
        const unmoved = failed && !(report?.services && hostMoved(report.services))
        const failure = writeChannelPending(top, channel, unmoved ? { ...kept, generation: randomUUID(), lastFailure: text } : undefined)
        if (failure) process.stderr.write('[reload] ' + failure + '\n')
      } else {
        superseded = !!pending
        const failure = clearAttemptLocked(top, channel, generation)
        if (failure) process.stderr.write('[reload] ' + failure + '\n')
      }
    }
  } finally { release() }
  if (superseded) reloadIfIdle(top, { channel, start })
  const line = { at: Date.now(), text: result.text }
  appendFileSync(reloadLog(top), JSON.stringify(line) + '\n')
  enforceJsonlBudget(reloadLog(top), TELEMETRY_BUDGET.checksBytes)
  const failure = result.budgetError ?? storageError
  return failure ? { ...report, error: failure } : report
}

export const RETRY_DELAYS_MS = [60_000, 120_000, 300_000]

export async function scheduleRetry(top, { channel = channelNow(), report, now = Date.now() } = {}) {
  if (!(report?.error || report?.reloadOutcome === 'failed')) return undefined
  const release = await holdReloadLock(top, 30_000, () => {}, RECORD_LOCK)
  try {
    const pending = pendingUpdate(top, channel)
    if (!pending?.lastFailure || (pending.attempt && alive(pending.attempt.pid))) return undefined
    const used = pending.retries ?? 0
    if (used >= RETRY_DELAYS_MS.length) return { exhausted: true, attempts: used }
    const delayMs = RETRY_DELAYS_MS[used]
    const failure = writeChannelPending(top, channel, { ...pending, retries: used + 1, retryAt: new Date(now + delayMs).toISOString() })
    if (failure) process.stderr.write('[reload] ' + failure + '\n')
    for (const row of report?.services ?? []) if (row.state === 'reload failed') clearFailure(top, row.name)
    return { delayMs, attempt: used + 1 }
  } finally { release() }
}

export const resumeRetry = (top, { channel = channelNow(), delayMs, start } = {}) => Effect.gen(function* () {
  yield* Effect.sleep(Duration.millis(delayMs))
  yield* Effect.sync(() => reloadIfIdle(top, { channel, ...(start ? { start } : {}) }))
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args[0] === '--run' && args[1]) {
    const top = resolve(args[1]), channel = args[3] || channelNow()
    runReload(top, { waiting: JSON.parse(args[2] ?? '[]'), channel, generation: args[4] })
      .then(async report => {
        const { checkDrift } = await import('./version-drift.mjs')
        await checkDrift({ root: top, reason: 'pass end' })
        const retry = await scheduleRetry(top, { channel, report })
        if (retry?.delayMs) await Effect.runPromise(resumeRetry(top, { channel, delayMs: retry.delayMs }))
      })
      .catch(error => { console.error(error); process.exitCode = 1 })
  } else console.log('landing-quiet --run <checkout> [<waiting json>]')
}
