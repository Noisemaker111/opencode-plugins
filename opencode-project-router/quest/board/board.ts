import { nextQuestStep, nextStepAction } from "../core/steps"
import type { Quest, QuestSession, TerminalSessionState } from "../types"
import { whyNotRunning, type AdmissionRecords } from "../runs/reachability"
import { branchCounts } from "../landing/branch-outcomes"
import { categoryOf } from "../workers/quest-queue"
import { markOf } from "../hygiene/verdict"
import { FAILURE_CAUSE_TEXT, failureCause, type Fault } from "../routing/failure-cause"
import { OWNED_RUN, nativeRunID } from "../runs/session-lineage"
import { classifyWorker, landedWithin, workerCounts, type TreeProgress, type WorkerCounts } from "./worker-counts"
import type { RunEvidence, ToolTimes } from "../runs/run-status"
export { WORKER_STATES, workerCountsLine, type WorkerCounts, type WorkerState } from "./worker-counts"

export const QUEST_LANES = ["attention", "assigned", "unassigned", "ready", "done", "archived"] as const
export type QuestLane = typeof QUEST_LANES[number]

export const LANE_LABEL: Record<QuestLane, string> = {
  attention: "Needs attention",
  assigned: "Assigned",
  unassigned: "Unassigned",
  ready: "Ready to turn in",
  done: "Done",
  archived: "Archived",
}

export const ACTIVE_LANE_ORDER: QuestLane[] = ["attention", "assigned", "unassigned", "ready", "done"]

export const NEEDS_WORK_LANES: QuestLane[] = ["attention", "assigned", "unassigned"]
export const STALLED_QUEST_SILENCE_MS = 24 * 60 * 60_000
export const CAUSE_WINDOW_MS = 7 * 24 * 60 * 60_000
const TOP_CAUSES = 5
const ENDED_RUN_STATES: TerminalSessionState[] = ["completed", "failed", "stale", "missing", "cancelled"]

export type RunCauseCount = { code: string; text: string; fault: Fault; count: number; share: number; example: string }
export type RunOutcomes = Record<TerminalSessionState, number> & { ended: number; failureShare: number | null; causes: RunCauseCount[] }
export type WaitReason = "slot" | "after" | "category"
export type BoardWaits = Record<WaitReason, number>
export type LockWaits = { count: number; p95Ms: number | null; p99Ms: number | null }
export type BoardCounts = { open: number; ready: number; attention: number; waiting: number; waits: BoardWaits; stalled: number; runs: RunOutcomes; lockWaits?: LockWaits }
export type WaitContext = {
  categories: Record<string, boolean>
  slot(id: string): boolean
  unfinished(after: string[]): boolean
}

export type BoardSummary = {
  id: string
  archived: boolean
  lane: QuestLane
  latest: number
  active: boolean
  started?: boolean
  ready?: boolean
  category?: string
  after?: string[]
  ended: Partial<Record<TerminalSessionState, number>>
  causes: { code: string; text: string; fault: Fault; run: string }[]
  owned: { run: QuestSession; landed: boolean }[]
  landings: { state?: string; at?: string }[]
  updatedAt: string
  project?: { id?: string; root?: string }
}

export function summaryOf(q: Quest): BoardSummary {
  const ended: Partial<Record<TerminalSessionState, number>> = {}
  for (const run of q.sessions) if (ENDED_RUN_STATES.includes(run.state as TerminalSessionState)) ended[run.state as TerminalSessionState] = (ended[run.state as TerminalSessionState] ?? 0) + 1
  const since = Date.now() - CAUSE_WINDOW_MS
  const causes = q.sessions.flatMap((run) => {
    if (!ENDED_RUN_STATES.includes(run.state as TerminalSessionState) || !(Date.parse(run.updatedAt) >= since)) return []
    const cause = failureCause(run)
    return cause ? [{ ...cause, run: run.runID ?? run.callID }] : []
  })
  const landings = (q.extensions?.landings ?? {}) as Record<string, { state?: string }>
  const owned = q.sessions.filter((run) => OWNED_RUN.has(run.state))
  return {
    id: q.id,
    archived: q.state === "Archived",
    lane: questLane(q),
    latest: Math.max(Date.parse(q.createdAt), ...q.sessions.map((run) => Date.parse(run.updatedAt)).filter(Number.isFinite)),
    active: owned.length > 0,
    started: q.sessions.length > 0,
    ready: !q.archive && !q.delivered && q.state !== "Archived" && q.stages.some((step) => step.status === "pending") && !q.sessions.some((run) => ["planned", "executing", "waiting", "blocked"].includes(run.state)),
    ...(categoryOf(q) ? { category: categoryOf(q) } : {}),
    ...(q.relationships?.dependencies?.length ? { after: q.relationships.dependencies } : {}),
    ended,
    causes,
    owned: owned.map((run) => ({ run, landed: landings[run.runID ?? run.callID]?.state === "landed" })),
    landings: landingsOf(q),
    updatedAt: q.updatedAt,
    project: q.project ? { id: q.project.id, root: q.project.root } : undefined,
  }
}

const silentSummary = (summary: BoardSummary, now: number) => summary.started !== false && !summary.active && now - summary.latest > STALLED_QUEST_SILENCE_MS

export function waitOf(summary: BoardSummary, context: WaitContext): WaitReason | undefined {
  if (summary.archived || summary.lane === "attention" || summary.active || !summary.ready) return undefined
  if (summary.category && context.categories[summary.category] === false) return "category"
  if (summary.after?.length && context.unfinished(summary.after)) return "after"
  if (context.slot(summary.id)) return "slot"
  return undefined
}

export function questStalled(q: Quest, now: number, context?: WaitContext): boolean {
  const summary = summaryOf(q)
  return silentSummary(summary, now) && !(context && waitOf(summary, context))
}

export function runOutcomesOf(summaries: BoardSummary[]): RunOutcomes {
  const counts = Object.fromEntries(ENDED_RUN_STATES.map((state) => [state, 0])) as Record<TerminalSessionState, number>
  for (const summary of summaries) for (const state of ENDED_RUN_STATES) counts[state] += summary.ended[state] ?? 0
  const ended = ENDED_RUN_STATES.reduce((total, state) => total + counts[state], 0)
  const grouped = new Map<string, { code: string; text: string; fault: Fault; count: number; example: string }>()
  const failures = summaries.flatMap((summary) => summary.causes)
  for (const cause of failures) {
    const row = grouped.get(cause.code) ?? { code: cause.code, text: FAILURE_CAUSE_TEXT[cause.code] ?? cause.text, fault: cause.fault, count: 0, example: cause.run }
    row.count++
    grouped.set(cause.code, row)
  }
  const saved = failures.find((cause) => cause.code === 'other' && cause.text !== FAILURE_CAUSE_TEXT.other)
  const other = grouped.get('other')
  if (other && saved) other.text = `not yet classified, e.g. "${saved.text}"`
  const causes = [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, TOP_CAUSES).map((row) => ({ ...row, share: Math.round(row.count / failures.length * 1000) / 1000 }))
  return { ...counts, ended, failureShare: ended ? Math.round((ended - counts.completed) / ended * 1000) / 1000 : null, causes }
}

export function runOutcomes(quests: Quest[]): RunOutcomes {
  return runOutcomesOf(quests.map(summaryOf))
}

export function countsOf(summaries: BoardSummary[], now: number, context?: WaitContext): BoardCounts {
  const shown = summaries.filter((summary) => !summary.archived)
  const needsWork = shown.filter((summary) => NEEDS_WORK_LANES.includes(summary.lane))
  const waits: BoardWaits = { slot: 0, after: 0, category: 0 }
  let stalled = 0
  for (const summary of needsWork) {
    const reason = context && waitOf(summary, context)
    if (reason) waits[reason]++
    else if (silentSummary(summary, now)) stalled++
  }
  return {
    open: needsWork.length,
    ready: shown.filter((summary) => summary.lane === "ready").length,
    attention: shown.filter((summary) => summary.lane === "attention").length,
    waiting: waits.slot + waits.after + waits.category,
    waits,
    stalled,
    runs: runOutcomesOf(needsWork),
  }
}

export function boardCounts(quests: Quest[], now: number, context?: WaitContext): BoardCounts {
  return countsOf(quests.map(summaryOf), now, context)
}

export function boardSentences(counts: BoardCounts): string[] {
  const runs = counts.runs.failureShare === null ? "No runs on Quests that need work have ended yet." : "Runs on Quests that need work: " + Math.round(counts.runs.failureShare * 100) + "% of " + counts.runs.ended + " ended failed, stale, missing or cancelled."
  const why = [
    counts.waits.slot ? counts.waits.slot + " for a free slot" : "",
    counts.waits.after ? counts.waits.after + " after another Quest" : "",
    counts.waits.category ? counts.waits.category + " in a turned-off category" : "",
  ].filter(Boolean)
  const waiting = counts.waiting ? [counts.waiting + " waiting, not stalled: " + why.join(", ") + "."] : []
  const causes = counts.runs.causes.length ? ["Top causes of failed runs this week: " + counts.runs.causes.map((row) => row.text + " (" + row.count + (row.count === 1 ? " run" : " runs") + ")").join("; ") + "."] : []
  const locks = counts.lockWaits?.count ? ["Lock waits in the last day: " + counts.lockWaits.count + (counts.lockWaits.p95Ms === null ? "" : " (95% under " + counts.lockWaits.p95Ms + " ms, 99% under " + counts.lockWaits.p99Ms + " ms).")] : []
  return [counts.open + " Quests need work: " + counts.attention + " need attention, " + counts.stalled + " stalled (ready to run with a free slot, no run update for a day). " + counts.ready + " ready for Got it.", ...waiting, runs, ...causes, ...locks]
}

export const boardHeadline = (counts: BoardCounts) => boardSentences(counts).join(" ")

export type WorkerEvidenceReader = { evidence(run: QuestSession, now: number): RunEvidence; toolTimes(now: number): Pick<ToolTimes, "medianMs"> & Partial<Pick<ToolTimes, "p99Ms">> }
export type WorkerHostSignals = { hostLive?(sessionID: string): boolean | undefined; tree?(sessionID: string): TreeProgress | undefined }

const landingsOf = (q: Quest) => Object.values((q.extensions?.landings ?? {}) as Record<string, { state?: string; at?: string }>).filter(row => row && typeof row === "object")

export function workerReadingsOf(summaries: BoardSummary[], now: number, reader: WorkerEvidenceReader, signals: WorkerHostSignals = {}) {
  const times = reader.toolTimes(now)
  return summaries.filter((summary) => !summary.archived).flatMap((summary) => summary.owned.map(({ run, landed }) => {
    const sessionID = nativeRunID(run)
    let evidence: RunEvidence = { tools: 0 }
    try { evidence = reader.evidence(run, now) } catch {}
    return { quest: summary.id, run, evidence, times, reading: classifyWorker({ evidence, landed, hostLive: sessionID ? signals.hostLive?.(sessionID) : undefined, tree: sessionID ? signals.tree?.(sessionID) : undefined }, now, times) }
  }))
}

export function workerCountsOf(summaries: BoardSummary[], now: number, reader: WorkerEvidenceReader, signals: WorkerHostSignals = {}): WorkerCounts {
  const readings = workerReadingsOf(summaries, now, reader, signals).map((row) => row.reading)
  return workerCounts(readings, landedWithin(summaries.flatMap((summary) => summary.landings), now))
}

export function workerBoardCounts(quests: Quest[], now: number, reader: WorkerEvidenceReader, signals: WorkerHostSignals = {}): WorkerCounts {
  return workerCountsOf(quests.map(summaryOf), now, reader, signals)
}

export function isAssigned(q: Quest): boolean {
  return Boolean(q.owner || q.integrationOwner || q.sessions.some((s) => ["planned", "executing", "waiting", "blocked"].includes(s.state)))
}

export function landingBlocked(q: Pick<Quest, "extensions">): string | undefined {
  const rows = Object.values((q.extensions?.landings ?? {}) as Record<string, { state?: string; reason?: string; at?: string }>).filter(row => row && typeof row === "object")
  const latest = [...rows].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? ""))).at(-1)
  return latest?.state === "blocked" ? latest.reason ?? "the landing was refused" : undefined
}

export function questLane(q: Quest, state: Quest["state"] = q.state): QuestLane {
  if (state === "Archived") return "archived"
  if (markOf(q)?.kind === "needs a look") return "attention"
  if ((state === "Ready to complete" || state === "Complete") && landingBlocked(q)) return "attention"
  if (state === "Complete") return "done"
  if (state === "Ready to complete") return "ready"
  if (state === "Needs attention") return "attention"
  if (state === "Working" || isAssigned(q)) return "assigned"
  return "unassigned"
}

export function sortNewestFirst(quests: Quest[]): Quest[] {
  return [...quests].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}

export function questBoard(quests: Quest[]): Record<QuestLane, Quest[]> {
  const lanes: Record<QuestLane, Quest[]> = { attention: [], assigned: [], unassigned: [], ready: [], done: [], archived: [] }
  for (const q of sortNewestFirst(quests)) lanes[questLane(q)].push(q)
  return lanes
}

export type BoardRow =
  | { kind: "header"; lane: QuestLane; label: string }
  | { kind: "quest"; lane: QuestLane; quest: Quest }

export function boardRows(quests: Quest[], options: { filter?: string; includeArchived?: boolean } = {}): BoardRow[] {
  const lanes = questBoard(quests)
  const order = options.includeArchived ? [...ACTIVE_LANE_ORDER, "archived" as const] : ACTIVE_LANE_ORDER
  const rows: BoardRow[] = []
  const filter = options.filter?.toLowerCase()
  for (const lane of order) {
    const items = lanes[lane].filter((q) => !filter || `${q.title} ${q.state} ${q.reason}`.toLowerCase().includes(filter))
    if (!items.length) continue
    rows.push({ kind: "header", lane, label: LANE_LABEL[lane] })
    for (const quest of items) rows.push({ kind: "quest", lane, quest })
  }
  return rows
}

export function summarizeQuest(q: Quest, records?: AdmissionRecords) {
  const selected = nextQuestStep(q)
  const stage = selected ? q.stages.indexOf(selected) : -1
  return {
    id: q.id,
    title: q.title.slice(0, 100),
    state: q.state,
    lane: questLane(q),
    stage: q.stages.length ? `${stage < 0 ? q.stages.length : stage + 1}/${q.stages.length}` : undefined,
    nextAction: nextStepAction(q).slice(0, 140),
    notRunning: records && ["unassigned", "assigned"].includes(questLane(q)) ? whyNotRunning(q, records) : undefined,
    running: q.executingCount || undefined,
    branches: branchCounts(q),
  }
}

export function summarizeBoard(quests: Quest[], lane?: string, includeArchived = false, limit = 12, records?: AdmissionRecords) {
  const summary = (q: Quest) => summarizeQuest(q, records)
  const lanes = questBoard(quests)
  if (lane && lane in lanes) {
    const rows = lanes[lane as QuestLane]
    return { lane, quests: rows.slice(0, limit).map(summary), truncated: Math.max(0, rows.length - limit) }
  }
  const visible = includeArchived ? QUEST_LANES : QUEST_LANES.filter((key) => key !== "archived")
  let remaining = limit
  let lanesLeft = visible.length
  const board = Object.fromEntries(visible.map((key) => {
    const rows = lanes[key].slice(0, Math.ceil(remaining / lanesLeft))
    remaining -= rows.length
    lanesLeft--
    return [key, rows.map(summary)]
  }))
  const visibleCount = visible.reduce((total, key) => total + lanes[key].length, 0)
  return {
    counts: Object.fromEntries(QUEST_LANES.map((key) => [key, lanes[key].length])),
    board,
    truncated: Math.max(0, visibleCount - limit),
  }
}
