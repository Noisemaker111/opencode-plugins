import type { Quest } from "../types"
import { ARCHIVING, DAY_MS, NEW_QUEST_MS, type HygieneKind, type HygieneSettings } from "./policy"

export type HygieneMark = { kind: HygieneKind; reason: string; at: string }
export type Landing = { state: "landed"; evidence: string } | { state: "unlanded"; reason: string } | { state: "none" }
export type Facts = {
  running: boolean
  landing: Landing
  dirty?: string
  failedStarts: { count: number; reason: string }
  linked: boolean
  keeper?: string
  progressAt: string
}
export type Verdict = { kind: HygieneKind | "clear"; reason: string; keeper?: string } | undefined

export const markOf = (q: Quest): HygieneMark | undefined => q.extensions?.hygiene as HygieneMark | undefined
export const isArchiving = (kind: string) => (ARCHIVING as readonly string[]).includes(kind)

export function verdictOf(q: Quest, facts: Facts, now: number, settings: HygieneSettings): Verdict {
  if (q.state === "Archived" || q.archive || q.delivered || facts.running) return undefined
  if (now - Date.parse(q.createdAt) < NEW_QUEST_MS) return undefined
  const mark = markOf(q)
  const idleDays = Math.floor((now - Date.parse(facts.progressAt)) / DAY_MS)
  const clear: Verdict = mark ? { kind: "clear", reason: "" } : undefined
  if (facts.dirty) return { kind: "needs a look", reason: facts.dirty }
  if (facts.landing.state === "unlanded" && idleDays >= settings.staleDays) return { kind: "needs a look", reason: facts.landing.reason }
  if (facts.failedStarts.count >= 2) return { kind: "needs a look", reason: `Start failed ${facts.failedStarts.count} times: ${facts.failedStarts.reason}` }
  if (facts.linked) return clear
  if (facts.landing.state === "landed") return { kind: "done elsewhere", reason: facts.landing.evidence }
  if (facts.keeper && facts.landing.state !== "unlanded") return { kind: "duplicate", reason: `Same request as ${facts.keeper}, opened earlier.`, keeper: facts.keeper }
  if (idleDays < settings.staleDays) return clear
  if (mark?.kind === "stale") {
    if (facts.progressAt > mark.at) return clear
    if (now - Date.parse(mark.at) >= settings.supersedeDays * DAY_MS) return { kind: "superseded", reason: `Superseded: no run or progress for ${idleDays} days, then stale for ${settings.supersedeDays} more with nothing touched it.` }
    return undefined
  }
  return { kind: "stale", reason: `No run or progress for ${idleDays} days.` }
}
