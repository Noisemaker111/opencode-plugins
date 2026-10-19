import { Database } from "bun:sqlite"
import { existsSync, readdirSync } from "node:fs"
import { HOST_USAGE_DB } from "./host-counters"
import { join } from "node:path"
import { readJsonRecord } from "../quest/core/durable-file.mjs"
import { readAllQuests } from "../quest/index"
import { questReference } from "../quest/core/references"
import { readUserGiver, giverFile } from "../quest/giver-registry.mjs"
import { allReplays } from "../quest/bench/replay-record"
import { readAccountUsage, ACCOUNT_USAGE_FILE, ageSeconds, clock, readingState } from "../usage-service/on-computer"
import { readLedger, PASSIVE_LEDGER_FILE, type LedgerRow } from "./passive-ledger"
import { nonNegativeLeastSquares, RESET_TOLERANCE_MS } from "./plan-capacity"
import { outputIncludingReasoning } from "./telemetry"
import type { AccountUsage, AccountWindow } from "../usage-service/on-computer"
import type { Observation } from "./calibration"

export const BUDGET_ROLES = ["Quest Giver", "worker", "bench", "Claude Code", "Codex", "other"] as const
export type BudgetRole = typeof BUDGET_ROLES[number]
export const TOKEN_KIND_ORDER = ["input", "cacheRead", "cacheWrite", "output"] as const
type Kinds = [number, number, number, number]
type Who = { role: BudgetRole; quest?: string; title?: string }
export type BudgetSources = { projectRoot: string; runtime: string; ledgerFile?: string; accountFile?: string; hostFile?: string; now?: () => number }

const WEEK = 604800, FIVE_HOURS = 18000
const zero = (): Kinds => [0, 0, 0, 0]
const two = (n: number) => Math.round(n * 100) / 100
const kindsOf = (r: LedgerRow): Kinds => [r.tokens.input ?? 0, r.tokens.cacheRead ?? 0, r.tokens.cacheWrite ?? 0, outputIncludingReasoning(r) ?? (r.tokens.output ?? 0) + (r.tokens.reasoning ?? 0)]
const named = (k: Kinds) => ({ input: k[0], cacheRead: k[1], cacheWrite: k[2], output: k[3] })

export function sessionRoles(projectRoot: string, runtime: string) {
  const known = new Map<string, Who>()
  for (const { quest } of readAllQuests(projectRoot, { includeArchived: true })) if (quest)
    for (const run of quest.sessions) for (const id of [run.openCodeSessionId, run.openCodeSessionID, run.sessionID, run.runtimeSessionId, run.harnessSessionID])
      if (id) known.set(id, { role: "worker", quest: questReference(quest), title: quest.title.slice(0, 80) })
  for (const replay of allReplays(runtime)) if (replay.sessionID) known.set(replay.sessionID, { role: "bench", quest: replay.questID })
  try { const giver = readUserGiver(runtime); if (giver?.sessionID) known.set(giver.sessionID, { role: "Quest Giver" }) } catch {}
  const folder = join(giverFile(runtime), "..")
  if (existsSync(folder)) for (const name of readdirSync(folder)) if (name.startsWith("user-giver.json.released-")) {
    const row = readJsonRecord<{ sessionID?: string }>(join(folder, name)); if (row?.sessionID) known.set(row.sessionID, { role: "Quest Giver" })
  }
  return known
}

const AGENT_ROLES: Record<string, BudgetRole> = { "quest-giver": "Quest Giver", worker: "worker", build: "worker" }
export function hostAgents(sessionIDs: string[], file = HOST_USAGE_DB) {
  const agents = new Map<string, { role: BudgetRole; parent: string | null }>()
  if (!sessionIDs.length || !existsSync(file)) return agents
  let db: Database | undefined
  try {
    db = new Database(file, { readonly: true }); db.exec("PRAGMA busy_timeout=1000")
    const query = db.query("SELECT agent, parent_id FROM session_v2 WHERE id=?")
    for (const id of sessionIDs) { const row = query.get(id) as { agent?: string; parent_id?: string | null } | null; if (row) agents.set(id, { role: AGENT_ROLES[row.agent ?? ""] ?? "other", parent: row.parent_id ?? null }) }
  } catch {} finally { db?.close() }
  return agents
}

export function whoIs(row: LedgerRow, known: Map<string, Who>, parents: Map<string, string>, agents: Map<string, { role: BudgetRole; parent: string | null }>): Who {
  let id: string | undefined = row.sessionID
  for (let hop = 0; id && hop < 6; hop++) { const found = known.get(id); if (found) return found; id = parents.get(id) ?? agents.get(id)?.parent ?? undefined }
  const agent = agents.get(row.sessionID)
  if (agent && agent.role !== "other") return { role: agent.role }
  if (row.source === "codex") return { role: "Codex" }
  return { role: "other" }
}

type Chunk = { from: number; to: number; points: number; total: Kinds; bySession: Map<string, Kinds> }
function chunks(observations: Observation[], rows: LedgerRow[]): { list: Chunk[]; before: number; first: number | null } {
  const ordered = [...observations].sort((a, b) => a.at - b.at)
  if (!ordered.length) return { list: [], before: 0, first: null }
  const list: Chunk[] = []
  let anchor = ordered[0], cursor = 0
  const sorted = [...rows].sort((a, b) => a.at - b.at)
  while (cursor < sorted.length && sorted[cursor].at <= anchor.at) cursor++
  for (const reading of ordered.slice(1)) {
    if (reading.usedPoints < anchor.usedPoints) { anchor = reading; while (cursor < sorted.length && sorted[cursor].at <= anchor.at) cursor++; continue }
    if (reading.usedPoints - anchor.usedPoints <= 0) continue
    const total = zero(), bySession = new Map<string, Kinds>()
    while (cursor < sorted.length && sorted[cursor].at <= reading.at) {
      const row = sorted[cursor++], k = kindsOf(row), mine = bySession.get(row.sessionID) ?? zero()
      for (let i = 0; i < 4; i++) { total[i] += k[i]; mine[i] += k[i] }
      bySession.set(row.sessionID, mine)
    }
    list.push({ from: anchor.at, to: reading.at, points: reading.usedPoints - anchor.usedPoints, total, bySession })
    anchor = reading
  }
  return { list, before: ordered[0].usedPoints, first: ordered[0].at }
}

function fitWeights(list: Chunk[]) {
  const usable = list.filter(c => c.total.some(n => n > 0))
  const present = [0, 1, 2, 3].filter(i => usable.some(c => c.total[i] > 0))
  if (present.length && usable.length >= Math.max(8, present.length * 3)) {
    const beta = nonNegativeLeastSquares(usable.map(c => present.map(i => c.total[i])), usable.map(c => c.points))
    const weights = zero(); present.forEach((i, j) => { weights[i] = beta[j] })
    if (weights.some(w => w > 0)) return { weights, basis: "fitted" as const, intervals: usable.length }
  }
  return { weights: [1, 1, 1, 1] as Kinds, basis: "equal" as const, intervals: usable.length }
}

const score = (k: Kinds, w: Kinds) => k.reduce((n, v, i) => n + v * w[i], 0)

function attribute(list: Chunk[], weights: Kinds, fitted: boolean) {
  const share = new Map<string, number>()
  let attributed = 0, unattributed = 0
  for (const chunk of list) {
    const all = score(chunk.total, weights)
    if (all <= 0) { unattributed += chunk.points; continue }
    const points = fitted ? Math.min(chunk.points, 2 * all + 1) : chunk.points
    attributed += points; unattributed += chunk.points - points
    for (const [session, k] of chunk.bySession) share.set(session, (share.get(session) ?? 0) + points * score(k, weights) / all)
  }
  return { share, attributed, unattributed }
}

function confidence(basis: "fitted" | "equal", intervals: number, covered: number | null) {
  if (!intervals) return "none"
  if (basis === "fitted" && intervals >= 20 && (covered ?? 0) >= 0.8) return "solid"
  if (basis === "fitted" || intervals >= 8) return "fair"
  return "thin"
}

function windowReadings(observations: Observation[], account: AccountUsage, window: AccountWindow) {
  const resetAt = Date.parse(window.resetAt ?? ""), from = resetAt - (window.durationSeconds ?? 0) * 1000
  return { resetAt, from, readings: observations.filter(o => o.accountID === account.id && o.windowID === window.id && o.resetAt != null && Math.abs(o.resetAt - resetAt) <= RESET_TOLERANCE_MS && o.at >= from) }
}

export function budgetPicture(sources: BudgetSources) {
  const now = (sources.now ?? Date.now)()
  const snapshot = readAccountUsage(sources.accountFile ?? ACCOUNT_USAGE_FILE, now)
  const ledger = readLedger({ from: now - WEEK * 1000, to: now }, sources.ledgerFile ?? PASSIVE_LEDGER_FILE)
  const known = sessionRoles(sources.projectRoot, sources.runtime)
  const parents = new Map<string, string>()
  for (const row of ledger.rows) if (row.parentID) parents.set(row.sessionID, row.parentID)
  const latest = new Map<string, LedgerRow>()
  for (const row of ledger.rows) if (row.source !== "opencode-host" && row.state !== "running") latest.set(row.id, row)
  const rows = [...latest.values()]
  const openaiAccounts = snapshot.accounts.filter(a => a.provider === "openai").length
  const accounts = snapshot.accounts.flatMap(account => {
    const weekly = account.windows.find(w => w.durationSeconds === WEEK && w.scope === "shared" && w.resetAt)
    if (!weekly) return []
    const fiveHour = account.windows.find(w => w.durationSeconds === FIVE_HOURS && w.scope === "shared" && w.resetAt)
    const mine = rows.filter(r => r.accountID === account.id || !r.accountID && r.source === "codex" && account.provider === "openai" && openaiAccounts === 1)
    const week = windowReadings(ledger.observations, account, weekly)
    const inWeek = mine.filter(r => r.at > week.from)
    const weekChunks = chunks(week.readings, inWeek)
    const fit = fitWeights(weekChunks.list)
    const weekShare = attribute(weekChunks.list, fit.weights, fit.basis === "fitted")
    const five = fiveHour ? windowReadings(ledger.observations, account, fiveHour) : null
    const fiveShare = five ? attribute(chunks(five.readings, mine.filter(r => r.at > five.from)).list, fit.weights, fit.basis === "fitted") : null
    const tokens = new Map<string, Kinds>(), rowOf = new Map<string, LedgerRow>()
    for (const r of inWeek) { const k = kindsOf(r), t = tokens.get(r.sessionID) ?? zero(); for (let i = 0; i < 4; i++) t[i] += k[i]; tokens.set(r.sessionID, t); rowOf.set(r.sessionID, r) }
    const agents = hostAgents([...tokens.keys()].filter(id => id.startsWith("ses_")), sources.hostFile)
    const sessions = [...tokens.keys()].map(id => {
      const who = whoIs(rowOf.get(id)!, known, parents, agents)
      return { session: id, role: who.role, quest: who.quest ?? null, title: who.title ?? null, sharePercent: two(weekShare.share.get(id) ?? 0), fiveHourPercent: fiveShare ? two(fiveShare.share.get(id) ?? 0) : null, tokens: named(tokens.get(id)!) }
    }).sort((a, b) => b.sharePercent - a.sharePercent || b.tokens.output - a.tokens.output)
    const roles = BUDGET_ROLES.map(role => {
      const of = sessions.filter(s => s.role === role)
      const sum = zero(); for (const s of of) TOKEN_KIND_ORDER.forEach((k, i) => { sum[i] += s.tokens[k] })
      return { role, sessions: of.length, sharePercent: two(of.reduce((n, s) => n + (weekShare.share.get(s.session) ?? 0), 0)), fiveHourPercent: fiveShare ? two(of.reduce((n, s) => n + (fiveShare.share.get(s.session) ?? 0), 0)) : null, tokens: named(sum) }
    }).filter(r => r.sessions)
      .sort((a, b) => b.sharePercent - a.sharePercent)
    const observed = weekChunks.list.reduce((n, c) => n + c.points, 0)
    const covered = observed > 0 ? weekShare.attributed / observed : null
    const allTokens = zero(); for (const c of weekChunks.list) for (let i = 0; i < 4; i++) allTokens[i] += c.total[i]
    const weightedPerPercent = weekShare.attributed > 0 ? score(allTokens, fit.weights) / weekShare.attributed : null
    return [{
      account: account.id, provider: account.provider, plan: account.plan.name ?? account.plan.rateLimitTier ?? null,
      reading: { state: readingState(account, now), ageSeconds: ageSeconds(account, now) },
      blocked: account.windows.filter(w => w.scope === "shared" && w.state === "exhausted").map(w => ({ window: w.label, resetAt: w.resetAt })),
      week: { window: weekly.id, usedPercent: weekly.usedPercent, resetAt: weekly.resetAt, firstReadingAt: weekChunks.first === null ? null : new Date(weekChunks.first).toISOString(),
        beforeFirstReadingPercent: two(weekChunks.before), measuredPercent: two(observed), attributedPercent: two(weekShare.attributed), unattributedPercent: two(weekShare.unattributed) },
      fiveHour: fiveHour ? { window: fiveHour.id, usedPercent: fiveHour.usedPercent, resetAt: fiveHour.resetAt, attributedPercent: two(fiveShare!.attributed), unattributedPercent: two(fiveShare!.unattributed) } : null,
      mapping: { basis: fit.basis, intervals: fit.intervals, confidence: confidence(fit.basis, fit.intervals, covered),
        tokensPerPercent: TOKEN_KIND_ORDER.map((kind, i) => ({ kind, tokensPerPercent: fit.weights[i] > 1e-9 ? Math.round(1 / fit.weights[i]) : null })),
        tokensPerPercentAtThisMix: weightedPerPercent === null ? null : Math.round(TOKEN_KIND_ORDER.reduce((n, _, i) => n + allTokens[i], 0) / weekShare.attributed) },
      roles, sessions: sessions.slice(0, 15), sessionCount: sessions.length,
    }]
  }).sort((a, b) => b.week.attributedPercent - a.week.attributedPercent)
  return { at: now, basis: "Each rise in an account's window percent is split across the sessions that sent tokens to that account between the two readings, weighted per token kind by a fit of percent movement against tokens; 100% is the whole window.",
    accounts, answer: budgetAnswer(accounts), diagnostics: [...snapshot.diagnostics, ...ledger.diagnostics] }
}

const count = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n))
const kindLine = (t: { input: number; cacheRead: number; cacheWrite: number; output: number }) => "in " + count(t.input) + " · cache read " + count(t.cacheRead) + " · cache write " + count(t.cacheWrite) + " · out " + count(t.output)
export function formatBudget(value: ReturnType<typeof budgetPicture>) {
  return [...value.answer, ...value.accounts.flatMap(a => [
    "", a.provider + " " + (a.plan ?? "") + ": week " + (a.week.usedPercent ?? "?") + "% used, " + a.week.attributedPercent.toFixed(2) + "% attributed; mapping " + a.mapping.basis + " over " + a.mapping.intervals + " readings, " + a.mapping.confidence + " confidence" +
      (a.mapping.tokensPerPercentAtThisMix ? "; about " + count(a.mapping.tokensPerPercentAtThisMix) + " tokens per 1% at this mix" : ""),
    ...a.roles.map(r => "  " + r.role + ": " + r.sharePercent.toFixed(2) + "% week" + (r.fiveHourPercent !== null ? ", " + r.fiveHourPercent.toFixed(2) + "% 5h" : "") + " · " + r.sessions + " session(s) · " + kindLine(r.tokens)),
    ...a.sessions.slice(0, 8).map(s => "    " + s.role + (s.quest ? " " + s.quest : "") + ": " + s.sharePercent.toFixed(2) + "% · " + kindLine(s.tokens)),
  ]), ...value.diagnostics].join("\n")
}

export function budgetAnswer(accounts: { provider: string; blocked?: { window: string; resetAt: string | null }[]; week: { usedPercent: number | null; attributedPercent: number; unattributedPercent: number; beforeFirstReadingPercent: number }; mapping: { confidence: string }; roles: { role: string; sessions: number; sharePercent: number }[]; sessions: { role: string; quest: string | null; sharePercent: number }[] }[]) {
  return accounts.filter(a => a.week.attributedPercent > 0 || a.roles.length || a.blocked?.length).map(a => {
    const roles = a.roles.filter(r => r.sharePercent > 0).slice(0, 4).map(r => r.role + " " + r.sharePercent.toFixed(2) + "%" + (r.sessions > 1 ? " across " + r.sessions + " sessions" : ""))
    const top = a.sessions[0]
    const rest = two(a.week.unattributedPercent + a.week.beforeFirstReadingPercent)
    return a.provider + " week " + (a.week.usedPercent ?? "?") + "% used: " + (roles.length ? roles.join(", ") : "no session measured yet") +
      (top && top.sharePercent > 0 ? "; largest single session: " + top.role + (top.quest ? " on " + top.quest : "") + " at " + top.sharePercent.toFixed(2) + "%" : "") +
      (rest > 0 ? "; " + rest.toFixed(2) + "% came from use this computer did not record (another app or computer on the same plan)" : "") +
      (a.blocked?.length ? "; BLOCKED: " + a.blocked.map(b => b.window + " limit reached" + (b.resetAt ? " until " + clock(b.resetAt, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone) : "")).join(", ") : "") +
      " (" + a.mapping.confidence + " confidence)."
  })
}
