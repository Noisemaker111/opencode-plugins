import { landedPlaces } from "../workers/completion-return"
import { questResult } from "./result-card"
import { v2QueueGeneration } from "../core/runtime-queues"
import { REPORT_GROUPS, questCounts, type QuestCounts, type QuestTruth, type ReportGroup } from "../runs/reachability"
import { NEEDS_JON_LABEL, deriveState, jonGates } from "../core/state-machine"
import type { Quest, QuestSession, QuestStage } from "../types"
import { plainWords } from '../review/plain-words'
import { landingBlocked } from "./board"
import { unfinishedPredecessor } from "../workers/quest-queue"
import { GIVER_REFUSAL_LINE, runtimeFault } from "../runs/blocker-owner"

const STATE_WORD = /\b(?:Needs attention|Ready to complete|Archived|executing|unconfirmed|reachability)\b/g

export const plain = (value: unknown): string =>
  plainWords(value).replace(STATE_WORD, "")
    .replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/\(\s*\)/g, "").trim()

export function workerLabel(session: QuestSession): string {
  const base = session.providerID && session.modelID ? `${session.providerID}/${session.modelID}` : session.model
  if (!base) return session.agentRole && session.agentRole !== "worker" ? session.agentRole : "worker"
  const tags = [session.fast ? "fast" : undefined, session.reasoningEffort ? `${session.reasoningEffort} reasoning` : undefined].filter(Boolean)
  return tags.length ? `${base} (${tags.join(" · ")})` : base
}

export function workerTask(quest: Quest, session: QuestSession): string {
  return session.deliverables.map(id => quest.stages.find(step => step.id === id)?.title ?? id).join(" · ")
    || session.task || session.taskDescription || "delegated work"
}

const quoted = (value: string) => `"${plain(value)}"`
const stepTitle = (q: Quest, id: string) => q.stages.find(step => step.id === id)?.title ?? id
const nextStep = (q: Quest): QuestStage | undefined =>
  q.stages.find(step => step.status === "working") ?? q.stages.find(step => step.status === "pending")
const lastDone = (q: Quest): QuestStage | undefined => [...q.stages].reverse().find(step => step.status === "done")
const done = (q: Quest) => q.stages.filter(step => step.status === "done").length

function pendingAction(truth: QuestTruth): string | undefined {
  const request = truth.runs.flatMap(run => run.pending).at(0)
  if (!request) return undefined
  return plain([request.action, ...request.resources.slice(0, 2)].join(" ")) || undefined
}

function youBullet(truth: QuestTruth): { sentence: string; ask: string } {
  const q = truth.quest
  const blocked = q.stages.find(step => step.status === "blocked")
  if (truth.pendingPermissions > 0) {
    const action = pendingAction(truth)
    return {
      sentence: `A worker is paused waiting for permission${action ? ` to ${action}` : ""} and cannot continue until you decide.`,
      ask: "Open the pending approval in Quest Web and allow or reject the request.",
    }
  }
  const gated = jonGates(q)[0]
  if (gated) return {
    sentence: `${quoted(gated.title)} needs you for ${NEEDS_JON_LABEL[gated.needsJon!]}${gated.note ? ": " + gated.note : ""}`.replace(/([^.!?])$/, "$1."),
    ask: "Tell the Quest Giver what you decide.",
  }
  const refused = landingBlocked(q)
  if (refused && !blocked) return {
    sentence: `The work is marked done but nothing was landed: ${refused}`.replace(/([^.!?])$/, "$1."),
    ask: "Tell the Quest Giver to land it again.",
  }
  if (blocked && runtimeFault(blocked)) return { sentence: GIVER_REFUSAL_LINE, ask: "Reply `retry it`." }
  if (blocked) return {
    sentence: `Work stopped on ${quoted(blocked.title)} and it cannot go further without a decision.`,
    ask: "Reply `retry it` or `drop it`.",
  }
  const over = truth.runs.find(run => run.over) ?? truth.runs.at(-1)
  const step = over ? workerTask(q, over.run) : nextStep(q)?.title
  return {
    sentence: `The last worker stopped without finishing${step ? ` ${quoted(step)}` : " its step"}, so nothing is moving it.`,
    ask: "Reply `retry it` or `drop it`.",
  }
}

function workingSentence(truth: QuestTruth): string {
  const run = truth.runs.find(row => row.confirmed) ?? truth.run
  const model = run ? workerLabel(run.run) : "a worker"
  const step = run ? workerTask(truth.quest, run.run) : nextStep(truth.quest)?.title
  return plain(`${model} is working on ${step ? quoted(step) : "it"} right now.`)
}

function queuedSentence(truth: QuestTruth, byID: Map<string, Quest>): string {
  const q = truth.quest
  const derived = deriveState(q)
  if (derived.blockers) return derived.reason
  const dependency = unfinishedPredecessor(q, id => byID.get(id))
  if (dependency) return `It is waiting for ${quoted(dependency.title)} to land first.`
  const step = nextStep(q)
  const unmet = step?.needs.filter(id => q.stages.find(other => other.id === id)?.status !== "done") ?? []
  if (step && unmet.length) return `${quoted(step.title)} is waiting for ${unmet.map(id => quoted(stepTitle(q, id))).join(" and ")} to finish first.`
  if (truth.notRunning) return truth.notRunning
  if (truth.recordedState === "Working" && !truth.confirmed) return `Nothing is running it: the worker it was handed to is not executing, so ${step ? quoted(step.title) : "its next step"} is waiting to be picked up again.`
  if (step) return `${quoted(step.title)} is ready and waiting for a free worker.`
  return "It is saved and waiting for its next step to be planned."
}

function resultSentence(q: Quest): string {
  const card = questResult(q)
  return card ? [card.summary, card.howToUse, card.where].filter(text => text?.trim()).join(" ") : plain(doneSentence(q))
}

function doneSentence(q: Quest): string {
  const total = q.stages.length
  const finished = lastDone(q)
  const places = landedPlaces(q), blocked = Object.values((q.extensions.landings ?? {}) as Record<string, { state?: string; reason?: string }>).find(landing => landing?.state === "blocked")
  const merged = places.length ? `landed in ${places.join(" and ")}` : blocked ? `blocked: ${plain(blocked.reason ?? "landing was refused")}` : "nothing needed landing"
  const delivered = finished ? `Delivered ${quoted(finished.title)}` : "Delivered its saved result"
  return `${delivered}${total ? ` (${done(q)} of ${total} steps)` : ""}; ${merged}.`
}

export type ReportBullet = { group: ReportGroup; name: string; sentence: string; ask: string }
export type ReportSection = { group: ReportGroup; heading: string; bullets: ReportBullet[] }
export type QuestReport = {
  serving?: string
  counts: QuestCounts
  scope: string
  sections: ReportSection[]
}

const HEADING: Record<ReportGroup, string> = { you: "YOU", result: "DONE — SEE RESULT", working: "WORKING", queued: "QUEUED", done: "DONE" }
const NOTHING = "nothing from you"

export function reportBullet(truth: QuestTruth, byID: Map<string, Quest>): ReportBullet {
  const name = plain(truth.quest.title)
  if (truth.group === "you") { const built = youBullet(truth); return { group: "you", name, sentence: plain(built.sentence), ask: built.ask } }
  if (truth.group === "working") return { group: "working", name, sentence: workingSentence(truth), ask: NOTHING }
  if (truth.group === "queued") return { group: "queued", name, sentence: plain(queuedSentence(truth, byID)), ask: NOTHING }
  if (truth.group === "result") return { group: "result", name, sentence: resultSentence(truth.quest), ask: "Read the result, then press Got it on it in Quest Web." }
  return { group: "done", name, sentence: plain(doneSentence(truth.quest)), ask: NOTHING }
}

export function questReport(page: QuestTruth[], all: QuestTruth[], scope: string, serving = v2QueueGeneration()): QuestReport {
  const byID = new Map(all.map(truth => [truth.quest.id, truth.quest]))
  const bullets = page.map(truth => reportBullet(truth, byID))
  return {
    ...(serving ? { serving } : {}),
    counts: questCounts(all), scope,
    sections: REPORT_GROUPS.flatMap(group => {
      const rows = bullets.filter(bullet => bullet.group === group)
      return rows.length ? [{ group, heading: HEADING[group], bullets: rows }] : []
    }),
  }
}
