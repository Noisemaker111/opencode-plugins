import { Database } from "bun:sqlite"
import { existsSync, statSync } from "node:fs"
import { TELEMETRY_BUDGET } from "./telemetry-budget.mjs"

const DAY = 86_400_000
const SESSION_TABLES = ["session_message", "session_inbox", "instruction_entry", "session_pending"]

const BATCH_ROWS = 40
const BATCH_SESSIONS = 4
const BUSY_MS = 200
const BUSY_RETRIES = 6
const BUSY_BACKOFF_MS = 250
const VACUUM_FREE_SHARE = 0.1

const sleep = ms => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
const isBusy = error => /SQLITE_(BUSY|LOCKED)|database is locked/.test(`${error?.code} ${error?.message}`)
function retryBusy(work) {
  for (let attempt = 0; ; attempt++) {
    try { return work() } catch (error) {
      if (!isBusy(error) || attempt >= BUSY_RETRIES) throw error
      sleep(BUSY_BACKOFF_MS * 2 ** attempt)
    }
  }
}

export function enforceHostDatabaseBudget(file, { now = Date.now(), budget = TELEMETRY_BUDGET.hostDatabaseBytes, protectedSessionIDs = new Set(), pauseMs = 3, report = {} } = {}) {
  if (!existsSync(file)) return false
  let db
  try {
    db = new Database(file)
    db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`)
    prune(db, file, { now, budget, protectedSessionIDs, pauseMs, report })
    return true
  } catch (error) {
    if (isBusy(error)) { report.busy = true; report.error = String(error?.message); return false }
    throw error
  } finally {
    db?.close()
  }
}

function prune(db, file, { now, budget, protectedSessionIDs, pauseMs, report }) {
  const started = performance.now()
  Object.assign(report, { slimmed: 0, droppedSessions: 0, vacuumed: false, longestWriteMs: 0, bytesBefore: sizeOf(file) })
  const write = work => {
    const at = performance.now()
    retryBusy(() => db.transaction(work).immediate())
    report.longestWriteMs = Math.max(report.longestWriteMs, Math.round(performance.now() - at))
    sleep(pauseMs)
  }
  const running = runningSessions(db, protectedSessionIDs)
  const cutoff = now - TELEMETRY_BUDGET.hostHistoryDays * DAY
  const stale = db.query("select id, session_id from session_message where time_created < ? and data not like '%\"pruned\":true%'").all(cutoff).filter(row => !running.has(row.session_id))
  const read = db.query("select data from session_message where id = ?")
  const update = db.query("update session_message set data = ? where id = ?")
  for (let at = 0; at < stale.length; at += BATCH_ROWS) {
    write(() => {
      for (const { id } of stale.slice(at, at + BATCH_ROWS)) {
        const slim = slimMessage(read.get(id)?.data ?? "")
        if (slim !== undefined) { update.run(slim, id); report.slimmed++ }
      }
    })
  }
  checkpoint(db, "PASSIVE")
  if (sizeOf(file) > budget) {
    const target = budget * TELEMETRY_BUDGET.keepRatio
    const droppable = db.query("select id from session_v2 order by time_updated").all().map(row => row.id).filter(id => !running.has(id))
    for (let at = 0; at < droppable.length && liveBytes(db) > target; at += BATCH_SESSIONS) {
      const ids = droppable.slice(at, at + BATCH_SESSIONS)
      write(() => dropSessions(db, ids))
      report.droppedSessions += ids.length
    }
    const size = sizeOf(file)
    if (size > budget && freeBytes(db) >= size * VACUUM_FREE_SHARE) {
      try {
        retryBusy(() => db.exec("VACUUM"))
        report.vacuumed = true
        checkpoint(db, "TRUNCATE")
      } catch (error) {
        if (!isBusy(error)) throw error
        report.vacuumSkipped = "busy after " + BUSY_RETRIES + " retries"
      }
    } else if (size > budget) report.vacuumSkipped = "free space below " + VACUUM_FREE_SHARE * 100 + "%"
  }
  report.bytesAfter = sizeOf(file)
  report.ms = Math.round(performance.now() - started)
}

function runningSessions(db, extra) {
  const ids = new Set(extra)
  for (const row of db.query("select id from session_v2 where agent = 'quest-giver' order by time_updated desc limit 1").all()) ids.add(row.id)
  for (const table of ["session_inbox", "session_pending"]) {
    if (!tableExists(db, table)) continue
    for (const row of db.query(`select distinct session_id from ${table}`).all()) ids.add(row.session_id)
  }
  return ids
}

function dropSessions(db, ids) {
  const tables = SESSION_TABLES.filter(table => tableExists(db, table))
  for (const id of ids) {
    for (const table of tables) db.query(`delete from ${table} where session_id = ?`).run(id)
    db.query("delete from session_v2 where id = ?").run(id)
  }
}

export function slimMessage(text) {
  let message
  try { message = JSON.parse(text) } catch { return undefined }
  if (Array.isArray(message.content)) message.content = message.content.map(slimPart)
  message.pruned = true
  return JSON.stringify(message)
}

function slimPart(part) {
  if (part?.type === "reasoning" && part.state) {
    const state = { ...part.state }
    delete state.reasoningEncryptedContent
    return { ...part, state }
  }
  if (part?.type !== "tool" || !part.state) return part
  const cap = TELEMETRY_BUDGET.hostToolOutputBytes, state = { ...part.state }
  if (Array.isArray(state.content)) state.content = capParts(state.content, cap)
  if (typeof state.output === "string") state.output = state.output.slice(0, cap)
  for (const key of ["input", "metadata"]) {
    const text = JSON.stringify(state[key] ?? null)
    if (text.length > cap) state[key] = { truncated: text.slice(0, cap) }
  }
  return { ...part, state }
}

function capParts(items, cap) {
  let left = cap
  return items.map(item => {
    if (typeof item?.uri === "string" && item.uri.startsWith("data:")) return { ...item, uri: "[image removed]" }
    const text = typeof item?.text === "string" ? item.text : JSON.stringify(item)
    if (text.length <= left) {
      left -= text.length
      return item
    }
    const kept = text.slice(0, left)
    left = 0
    return { type: item?.type ?? "text", text: kept }
  })
}

function tableExists(db, name) {
  return !!db.query("select 1 from sqlite_master where type = 'table' and name = ?").get(name)
}

function checkpoint(db, mode) {
  db.exec(`PRAGMA wal_checkpoint(${mode})`)
}

const pragma = (db, name) => Object.values(db.query(`PRAGMA ${name}`).get())[0]
const liveBytes = db => (pragma(db, "page_count") - pragma(db, "freelist_count")) * pragma(db, "page_size")
const freeBytes = db => pragma(db, "freelist_count") * pragma(db, "page_size")

function sizeOf(file) {
  return statSync(file).size
}
