import type { Quest, QuestSession } from "../types"
import { Effect } from "effect"

export const ACTIVE_RUN_STATES = ["planned", "executing", "waiting", "blocked"] as const
export const TERMINAL_RUN_STATES = ["completed", "failed", "cancelled"] as const
export const WAIT_CONDITIONS = ["changed", "run-ended", "step-done", "attention"] as const
export type WaitCondition = (typeof WAIT_CONDITIONS)[number]

export const DEFAULT_WAIT_SECONDS = 120
const RECONCILE_DEBOUNCE_MS = 250
const HEARTBEAT_MS = 5000
const ATTENTION_RUN_STATES = ["waiting", "blocked", "failed", "cancelled", "missing", "stale"]

const runKey = (run: QuestSession) => run.runID ?? run.callID
export const isRun = (run: QuestSession, runID?: string) => !runID || [run.runID, run.callID, run.sessionRef, run.openCodeSessionId, run.sessionID].includes(runID)
const isActive = (run: QuestSession) => (ACTIVE_RUN_STATES as readonly string[]).includes(run.state)
const runStages = (quest: Quest, runID?: string) => {
  if (!runID) return quest.stages
  const runs = quest.sessions.filter((run) => isRun(run, runID))
  return quest.stages.filter((stage) => runs.some((run) => run.deliverables.includes(stage.id)))
}

export function activeRuns(quest: Quest, runID?: string): QuestSession[] {
  return quest.sessions.filter((run) => isRun(run, runID) && isActive(run))
}

export function observedState(quest: Quest, runID?: string): string {
  const runs = quest.sessions.filter((run) => isRun(run, runID))
  const stages = runStages(quest, runID)
  const tests = quest.evidence.tests.filter((check) => !runID || stages.some((stage) => stage.id === check.stepID))
  return JSON.stringify([
    runID ? null : [quest.state, quest.title, quest.description ?? quest.objective, quest.reward ?? "", quest.evidence.artifacts.length],
    runs.map((run) => [runKey(run), run.state, run.result ?? "", run.evidence.at(-1) ?? ""]),
    stages.map((stage) => [stage.id, stage.status, stage.note ?? "", runID ? null : [stage.title, stage.detail ?? "", stage.needs]]),
    tests.length,
  ])
}

export type WaitStart = { fingerprint: string; steps: Record<string, string>; runs: Record<string, string> }
export function waitStart(quest: Quest, runID?: string): WaitStart {
  return {
    fingerprint: observedState(quest, runID),
    steps: Object.fromEntries(runStages(quest, runID).map((stage) => [stage.id, stage.status])),
    runs: Object.fromEntries(quest.sessions.filter((run) => isRun(run, runID)).map((run) => [runKey(run), run.state])),
  }
}

export type WaitVerdict = { satisfied: boolean; reason: string }
export function waitVerdict(until: WaitCondition, quest: Quest, start: WaitStart, runID?: string, pendingStart?: string): WaitVerdict {
  const running = activeRuns(quest, runID)
  const busy = running.length > 0 || (!runID && !!pendingStart)
  const still = running.length
    ? "Still active: " + running.map((run) => runKey(run) + " " + run.state).join(", ") + "."
    : pendingStart ?? ""
  const ended = runID
    ? "Run " + runID + " ended " + (quest.sessions.find((run) => isRun(run, runID))?.state ?? "unknown") + "."
    : "No run of this Quest is active or about to start."
  if (until === "changed") {
    const changed = observedState(quest, runID) !== start.fingerprint
    return { satisfied: changed, reason: changed ? "Saved state changed." : "No saved change yet. " + still }
  }
  if (until === "run-ended") return { satisfied: !busy, reason: busy ? still : ended }
  if (until === "step-done") {
    const done = runStages(quest, runID).filter((stage) => stage.status === "done" && start.steps[stage.id] !== "done")
    if (done.length) return { satisfied: true, reason: "Step " + done.map((stage) => stage.id).join(", ") + " done." }
    return { satisfied: !busy, reason: busy ? still : ended + " No step was finished." }
  }
  const runs = quest.sessions.filter((run) => isRun(run, runID) && ATTENTION_RUN_STATES.includes(run.state) && start.runs[runKey(run)] !== run.state)
  const blocked = runStages(quest, runID).filter((stage) => stage.status === "blocked" && start.steps[stage.id] !== "blocked")
  if (runs.length || blocked.length) {
    return { satisfied: true, reason: [...runs.map((run) => "Run " + runKey(run) + " is " + run.state + "."), ...blocked.map((stage) => "Step " + stage.id + " is blocked" + (stage.note ? ": " + stage.note : "."))].join(" ") }
  }
  return { satisfied: !busy, reason: busy ? still : ended }
}

export const waitRuns = (quest: Quest, start: WaitStart, runID?: string) =>
  quest.sessions
    .filter((run) => isRun(run, runID) && (!!runID || isActive(run) || !(runKey(run) in start.runs) || (ACTIVE_RUN_STATES as readonly string[]).includes(start.runs[runKey(run)])))
    .map((run) => ({ runID: runKey(run), state: run.state, ended: !isActive(run) }))

const RETURN_PATH =
  "When a run reaches completed, failed or cancelled this session is woken automatically with an " +
  '"Automatic Quest worker update" carrying the Quest state, finished step, one-line outcome and a pointer to its complete saved notes.'

export function waitSteering(quest: Quest, runID: string | undefined, waitedMs: number): string {
  const running = activeRuns(quest, runID)
  return (
    `No saved change in ${Math.round(waitedMs / 1000)}s. Still active: ` +
    (running.map((run) => `${runKey(run)} ${run.state}`).join(", ") || "none") +
    `. ${RETURN_PATH} End this turn rather than calling get again, or call wait with until "run-ended" to block once until the run ends instead of waiting again.`
  )
}

export type WaitOutcome = { changed: boolean; satisfied: boolean; quest?: Quest; milliseconds: number }

export async function awaitQuestChange(options: {
  signal?: AbortSignal
  read: () => Quest | undefined
  fingerprint: string
  runID?: string
  deadline: number
  satisfied?: (quest: Quest) => boolean
  reconcile?: () => Promise<unknown>
  onWaiting?: (waitedMs: number) => void
  events?: (listener: () => void) => () => void
}): Promise<WaitOutcome> {
  options.signal?.throwIfAborted()
  const started = Date.now()
  const waiters = new Set<() => void>()
  let arrived = true, latest: Quest | undefined
  const unsubscribe = options.events?.(() => { arrived = true; for (const wake of [...waiters]) wake() })
  const checked = () => { if (options.signal?.aborted) throw options.signal.reason }
  const reconcile = options.reconcile
    ? Effect.tryPromise({ try: () => options.reconcile!(), catch: (error) => error }).pipe(Effect.catch(() => Effect.void))
    : Effect.void
  const park = (ms: number): Effect.Effect<void> => Effect.callback<void>((resume, stop) => {
    let settled = false
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); waiters.delete(finish); resume(Effect.void) }
    const timer = setTimeout(finish, ms)
    waiters.add(finish)
    stop.addEventListener('abort', () => { if (settled) return; settled = true; clearTimeout(timer); waiters.delete(finish) }, { once: true })
  })
  const changed = (quest: Quest) => observedState(quest, options.runID) !== options.fingerprint
  try {
    return await Effect.runPromise(Effect.gen(function*() {
      let lastReconcileAt = Date.now()
      yield* reconcile
      checked()
      let announcedAt = Date.now()
      options.onWaiting?.(0)
      for (;;) {
        if (arrived) {
          arrived = false
          const quest = latest = options.read()
          if (!quest) return { changed: true, satisfied: true, quest, milliseconds: Date.now() - started }
          if (options.satisfied ? options.satisfied(quest) : changed(quest)) return { changed: changed(quest), satisfied: true, quest, milliseconds: Date.now() - started }
          if (options.reconcile && Date.now() - lastReconcileAt >= RECONCILE_DEBOUNCE_MS) {
            lastReconcileAt = Date.now()
            yield* reconcile
          }
        }
        checked()
        if (Date.now() >= options.deadline) return { changed: !!latest && changed(latest), satisfied: false, quest: latest, milliseconds: Date.now() - started }
        yield* park(Math.max(1, Math.min(options.deadline - Date.now(), Math.max(1, HEARTBEAT_MS - (Date.now() - announcedAt)))))
        if (Date.now() - announcedAt >= HEARTBEAT_MS) { announcedAt = Date.now(); options.onWaiting?.(Date.now() - started) }
      }
    }), { signal: options.signal })
  } catch (cause) {
    if (options.signal?.aborted) throw options.signal.reason
    throw cause
  } finally { unsubscribe?.() }
}
