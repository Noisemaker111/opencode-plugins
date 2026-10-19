import { TERMINAL_RUN, ownedRuns, observedRun } from "./session-lineage"
import { landingBlocked, questLane, type QuestLane } from "../board/board"
import { jonGates } from "../core/state-machine"
import { awaitingGotIt } from "../board/result-card"
import type { Quest, QuestSession, QuestState } from "../types"

export type ReachabilityTone = "live" | "blocked" | "uncertain" | "failed" | "done" | "idle"
export type ObservationOf = (run: QuestSession) => any

type Spec = { label: string; tone: ReachabilityTone; over?: boolean }
const SPEC: Record<string, Spec> = {
  running: { label: "RUNNING", tone: "live" },
  blocked: { label: "BLOCKED", tone: "blocked" },
  completed: { label: "WORKER DONE", tone: "done", over: true },
  failed: { label: "FAILED", tone: "failed", over: true },
  cancelled: { label: "CANCELLED", tone: "failed", over: true },
  missing: { label: "MISSING", tone: "failed", over: true },
  stale: { label: "STALE", tone: "failed", over: true },
  interrupted: { label: "INTERRUPTED", tone: "failed", over: true },
  unreachable: { label: "UNREACHABLE", tone: "uncertain" },
  unknown: { label: "UNKNOWN", tone: "uncertain" },
  external: { label: "EXTERNAL", tone: "idle" },
  queued: { label: "QUEUED", tone: "idle" },
  launching: { label: "LAUNCHING", tone: "idle" },
}

export type RunReachability = {
  run: QuestSession
  state: string
  label: string
  tone: ReachabilityTone
  confirmed: boolean
  over: boolean
  terminal: boolean
  reason: string
  pendingPermissions: number
  pending: Array<{ id?: string; action: string; resources: string[] }>
  decisions: NonNullable<QuestSession["permissionDecisions"]>
  lastActivityAt?: string
}

export function runReachability(run: QuestSession, observation: ObservationOf): RunReachability {
  const live = observedRun(run, observation) ?? {}
  const state = typeof live.state === "string" ? live.state : "unknown"
  const spec = SPEC[state] ?? SPEC.unknown
  const permissions = Array.isArray(live.permissions) ? live.permissions
    : run.awaiting && !TERMINAL_RUN.has(run.state) ? [{ id: run.awaiting.requestID, action: run.awaiting.ask }] : []
  return {
    run, state, label: spec.label, tone: spec.tone,
    confirmed: state === "running",
    over: spec.over === true || TERMINAL_RUN.has(run.state),
    terminal: TERMINAL_RUN.has(run.state),
    reason: typeof live.reason === "string" ? live.reason : "",
    pendingPermissions: permissions.length,
    pending: permissions.map((request: any) => ({
      ...(request?.id ? { id: String(request.id) } : {}),
      action: String(request?.action ?? "permission"),
      resources: Array.isArray(request?.resources) ? request.resources.map(String) : [],
    })),
    decisions: run.permissionDecisions ?? [],
    lastActivityAt: typeof live.lastActivityAt === "string" ? live.lastActivityAt : undefined,
  }
}

export type QuestLifecycle = { label: string; short: string; tone: ReachabilityTone; rank: number }

export function questLifecycle(q: Quest, state: QuestState = q.state): QuestLifecycle {
  const lane = questLane(q, state)
  if (lane === "archived") return { label: "Archived", short: "ARCHIVED", tone: "idle", rank: 5 }
  if (lane === "attention") return { label: "Needs attention", short: "ATTENTION", tone: "failed", rank: 0 }
  if (lane === "ready") return { label: "Ready for review", short: "REVIEW", tone: "done", rank: 1 }
  if (lane === "done") return { label: "Done", short: "DONE", tone: "done", rank: 5 }
  if ((q.stages ?? []).some(s => s.status === "working") || (q.executingCount ?? 0) > 0) return { label: "Work recorded", short: "RECORDED", tone: "uncertain", rank: 3 }
  return { label: "Planned", short: "PLANNED", tone: "idle", rank: 4 }
}

export type QuestReachability = {
  lifecycle: QuestLifecycle
  run?: RunReachability
  state: string
  label: string
  tone: ReachabilityTone
  confirmed: boolean
  over: boolean
  terminal: boolean
  reason: string
  pendingPermissions: number
  decisions: NonNullable<QuestSession["permissionDecisions"]>
}

function representativeRun(runs: RunReachability[]): RunReachability | undefined {
  return runs.find(run => run.confirmed)
    ?? runs.find(run => run.pendingPermissions > 0)
    ?? [...runs].sort((a, b) => a.run.updatedAt.localeCompare(b.run.updatedAt)).at(-1)
}

export function questReachability(q: Quest, observation: ObservationOf, state: QuestState = q.state, owned?: RunReachability[]): QuestReachability {
  const lifecycle = questLifecycle(q, state)
  const run = representativeRun(owned ?? ownedRuns(q).map(row => runReachability(row, observation)))
  if (!run) return {
    lifecycle, state: "idle", label: lifecycle.label, tone: lifecycle.tone,
    confirmed: false, over: false, terminal: false, reason: q.reason, pendingPermissions: 0, decisions: [],
  }
  return {
    lifecycle, run, state: run.state, label: run.label, tone: run.tone,
    confirmed: run.confirmed, over: run.over, terminal: run.terminal, reason: run.reason,
    pendingPermissions: run.pendingPermissions, decisions: run.decisions,
  }
}

export type AdmissionRecords = {
  continuations: any[]
  starts: { quest: string; kind?: string; state: string }[]
  now: number
  queued?: (q: Quest) => string | undefined
}

const ACTIVE_RUN = new Set(["planned", "executing", "waiting", "blocked"])
const OPEN_ADMISSION = new Set(["waiting", "claiming", "running", "unknown"])
const clock = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
const firstClause = (reason: string) => String(reason ?? "").split(" | candidates:")[0].trim()

function waitingAdmission(reason: string, nextAt: number, now: number): string {
  const said = firstClause(reason)
  const paced = /Burn pacing hold: (.*)/.exec(said)
  if (paced) return `Paced: ${paced[1]}`
  if (/^Waiting for a free slot:/.test(said)) return `${said}.`
  const account = /account (\S+?):? .*?(?:capacity|slot|concurren)/i.exec(said)
  if (account) return `Waiting for an account slot on ${account[1]}${nextAt > now ? `; admission retries at ${clock(nextAt)}` : ""}.`
  if (nextAt > now) return `Admission retries at ${clock(nextAt)}: ${said}`
  return `Admission is due now and runs on the next scheduler pass: ${said}`
}

export function whyNotRunning(q: Quest, records: AdmissionRecords): string | undefined {
  if (q.state === "Archived" || q.archive || q.delivered) return undefined
  if (!q.stages.some(step => step.status === "pending")) return undefined
  if (q.sessions.some(run => ACTIVE_RUN.has(run.state))) return undefined
  const queued = records.queued?.(q)
  if (queued) return `${queued}.`
  const start = records.starts.find(row => row.quest === q.id && !row.kind && ["queued", "admitting"].includes(row.state))
  if (start) return start.state === "queued" ? "Start is queued; the active host admits it next." : "Start is being admitted now."
  const rows = records.continuations.filter(row => row?.questID === q.id && !row.goal && !row.worker)
  const open = rows.filter(row => !["done", "stopped"].includes(row.state))
  if (!open.length) {
    const last = rows.at(-1)
    return last ? `Its continuation stopped: ${firstClause(last.reason)}. Start it again.` : "No continuation yet; start it."
  }
  const row = open.at(-1)
  const admissions: any[] = row.admissions ?? []
  if (admissions.some(a => a.state === "unknown")) return "A launch did not confirm; it is checked before the step runs again."
  if (admissions.some(a => a.state === "claiming")) return "A worker is being launched now."
  const waiting = admissions.filter(a => a.state === "waiting").sort((a, b) => a.nextAt - b.nextAt)[0]
  if (waiting) return waitingAdmission(waiting.reason, waiting.nextAt, records.now)
  if (row.nextAt > records.now) return waitingAdmission(row.reason, row.nextAt, records.now)
  if (/^Waiting for a free slot:/.test(firstClause(row.reason))) return `${firstClause(row.reason)}.`
  if (/Desired concurrency reached/.test(row.reason)) return `Waiting for a free slot: this Quest runs ${row.maxConcurrent ?? 1} worker${(row.maxConcurrent ?? 1) === 1 ? "" : "s"} at a time.`
  if (!admissions.some(a => OPEN_ADMISSION.has(a.state)) && row.state === "waiting") return `Admission is due now and runs on the next scheduler pass: ${firstClause(row.reason)}`
  return firstClause(row.reason)
}

export const REPORT_GROUPS = ["you", "result", "working", "queued", "done"] as const
export type ReportGroup = typeof REPORT_GROUPS[number]

export type QuestTruth = {
  quest: Quest
  state: QuestState
  recordedState: QuestState
  recordedExecuting: number
  confirmed: boolean
  reason: string
  lane: QuestLane
  group: ReportGroup
  runs: RunReachability[]
  run?: RunReachability
  reach: QuestReachability
  pendingPermissions: number
  notRunning?: string
}

const UNCONFIRMED_REASON = "Recorded as executing, but the owning host does not confirm an execution for it"

export function questTruth(q: Quest, observation: ObservationOf, records?: AdmissionRecords): QuestTruth {
  const runs = ownedRuns(q).map(run => runReachability(run, observation))
  const confirmed = runs.some(run => run.confirmed)
  const pendingPermissions = runs.reduce((total, run) => total + run.pendingPermissions, 0)
  const recordedState = q.state
  let state = recordedState
  let reason = q.reason
  if (recordedState === "Working" && !confirmed) {
    state = jonGates(q).length ? "Needs attention" : "Waiting"
    const observed = runs.find(run => run.reason)?.reason
    reason = observed && observed !== UNCONFIRMED_REASON ? observed : UNCONFIRMED_REASON
  }
  const reach = questReachability(q, observation, state, runs)
  const group = questGroup(state, pendingPermissions, awaitingGotIt(q), !!landingBlocked(q))
  const notRunning = group === "queued" && records ? whyNotRunning(q, records) : undefined
  if (notRunning) reason = notRunning
  return {
    quest: q, state, recordedState, recordedExecuting: q.executingCount ?? 0, confirmed, reason,
    lane: questLane(q, state), group, runs,
    run: reach.run, reach, pendingPermissions, ...(notRunning ? { notRunning } : {}),
  }
}

export function questGroup(state: QuestState, pendingPermissions = 0, delivered = false, landingRefused = false): ReportGroup {
  if (landingRefused && (state === "Ready to complete" || state === "Complete")) return "you"
  if (delivered && state === "Ready to complete") return "result"
  if (state === "Archived" || state === "Complete" || state === "Ready to complete") return "done"
  if (pendingPermissions > 0 || state === "Needs attention") return "you"
  if (state === "Working") return "working"
  return "queued"
}

export type QuestCounts = Record<ReportGroup, number> & { open: number; total: number }

export function questCounts(truths: QuestTruth[]): QuestCounts {
  const counts = { you: 0, result: 0, working: 0, queued: 0, done: 0, open: 0, total: truths.length }
  for (const truth of truths) {
    counts[truth.group]++
    if (truth.group === "you" || truth.group === "working" || truth.group === "queued") counts.open++
  }
  return counts
}
