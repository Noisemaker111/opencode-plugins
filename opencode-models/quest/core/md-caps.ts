import { existsSync } from "node:fs"
import { join } from "node:path"
import { TELEMETRY_BUDGET } from "../../scripts/telemetry-budget.mjs"
import { routingDecisionsDirectory } from "../routing/routing-history"
import { TERMINAL_RUN } from "../runs/session-lineage"
import type { Quest, QuestSession } from "../types"

const SETTLED = new Set(["Complete", "Archived"])

function identifiers(run: QuestSession): string[] {
  return [run.runID, run.callID, run.sessionID, run.openCodeSessionId, run.resumedFrom, run.resumeRoot].filter((value): value is string => typeof value === "string")
}

function names(value: unknown, into: Set<string>) {
  if (typeof value === "string") into.add(value)
  else if (Array.isArray(value)) for (const item of value) names(item, into)
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { into.add(key); names(item, into) }
}

function keptSessions(quest: Quest, runtime: string): Set<QuestSession> {
  const named = new Set<string>(), kept = new Set<QuestSession>()
  names({ ...quest, sessions: undefined, history: undefined }, named)
  const decisions = routingDecisionsDirectory(runtime)
  for (const run of quest.sessions) if (identifiers(run).some(value => named.has(value)) || existsSync(join(decisions, (run.runID ?? run.callID) + ".json"))) kept.add(run)
  if (quest.sessions[0]) kept.add(quest.sessions[0])
  let added = true
  while (added) {
    added = false
    const wanted = new Set([...kept].flatMap(run => [run.resumedFrom, run.resumeRoot]).filter((value): value is string => typeof value === "string"))
    for (const run of quest.sessions) if (!kept.has(run) && identifiers(run).some(value => wanted.has(value))) { kept.add(run); added = true }
  }
  const steps = new Set(quest.sessions.flatMap(run => run.deliverables ?? []))
  for (const step of steps) quest.sessions.filter(run => run.deliverables?.includes(step)).slice(-TELEMETRY_BUDGET.sessionsPerStep).forEach(run => kept.add(run))
  quest.sessions.filter(run => !run.deliverables?.length).slice(-TELEMETRY_BUDGET.sessionsPerStep).forEach(run => kept.add(run))
  return kept
}

export function capQuestState(quest: Quest, runtime: string): Quest {
  const next: Quest = { ...quest }
  const cap = TELEMETRY_BUDGET.historyEntries
  if (quest.history.length > cap) {
    const dropped = quest.history.length - cap
    next.history = quest.history.slice(dropped)
    next.earlierCount = (quest.earlierCount ?? 0) + dropped
  }
  if (SETTLED.has(quest.state) && quest.sessions.every(run => TERMINAL_RUN.has(run.state))) {
    const kept = keptSessions(quest, runtime), sessions = quest.sessions.filter(run => kept.has(run)), dropped = quest.sessions.length - sessions.length
    if (dropped) {
      next.sessions = sessions
      next.earlierSessions = (quest.earlierSessions ?? 0) + dropped
    }
  }
  return next
}
