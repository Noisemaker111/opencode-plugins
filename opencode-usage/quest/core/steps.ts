import { planFromRequest } from "../runs/request-plan"
import type { Quest, QuestStage, QuestStageStatus } from "../types"
import { isLandingStep, isLandingWork } from "../landing/landing-step"
import { sharesArea } from "./step-overlap"
import { isDeferred } from "../landing/deferred-steps"

export type StepInput =
  | string
  | { id?: string; title: string; detail?:string; commandID?: string; depth?: QuestStage["depth"]; workType?: string; deferred?: "parent-done" | "jon"; todos?: string[]; needs?: string[]; include?: string[]; status?: QuestStageStatus }

const MAX_STEPS = 30
const STATUSES = new Set<QuestStageStatus>(["pending", "working", "blocked", "done"])

export function stepID(title: string, index: number, taken = new Set<string>()): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").filter(Boolean).slice(0, 4).join("-") || `step-${index + 1}`
  let id = base, n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  taken.add(id)
  return id
}

export function stagesFromSteps(steps: StepInput[], quest?: Pick<Quest, "scope">): QuestStage[] {
  const taken = new Set<string>()
  const stages: QuestStage[] = []
  for (const [index, raw] of steps.slice(0, MAX_STEPS).entries()) {
    const step = typeof raw === "string" ? { title: raw } : raw
    const title = String(step?.title ?? "").trim()
    if (!title) continue
    const id = typeof step.id === "string" && step.id.trim() && !taken.has(step.id.trim()) ? (taken.add(step.id.trim()), step.id.trim()) : stepID(title, index, taken)
    const todos = (Array.isArray(step.todos) ? step.todos : []).slice(0, 12).map((todo, i) => ({ id: `${id}-${i + 1}`, title: String(todo).trim(), status: "pending" as const })).filter((todo) => todo.title)
    stages.push({
      id, title, ...(step.detail?{detail:step.detail}:{}), ...(step.commandID ? { commandID: step.commandID } : {}), ...(step.depth ? { depth: step.depth } : {}), ...(step.workType ? { workType: step.workType } : {}), ...(step.deferred ? { deferred: { at: new Date().toISOString(), until: step.deferred } } : {}), status: STATUSES.has(step.status as QuestStageStatus) ? (step.status as QuestStageStatus) : "pending",
      needs: Array.isArray(step.needs) ? step.needs.map(String) : [],
      todos,
      claim: { repos: quest?.scope.repos ?? [], include: Array.isArray(step.include) ? step.include.map(String).slice(0, 20) : [], exclude: [] },
      proofs: [], attempt: 1,
    })
  }
  return stages
}

export function stepsFromObjective(objective: string): StepInput[] {
  return planFromRequest(objective).deliverables.map((item) => ({ id: item.id, title: item.title }))
}

export function findStep(q: Pick<Quest, "stages">, ref: string | number): QuestStage | undefined {
  const key = String(ref ?? "").trim()
  if (!key) return
  const byID = q.stages.find((stage) => stage.id === key)
  if (byID) return byID
  if (/^\d+$/.test(key)) return q.stages[Number(key) - 1]
  const lower = key.toLowerCase()
  const byTitle = q.stages.filter((stage) => stage.title.toLowerCase().startsWith(lower))
  return byTitle.length === 1 ? byTitle[0] : undefined
}

export function nextQuestStep(q: Pick<Quest, "stages">): QuestStage | undefined {
  const working = q.stages.find(step => step.status === "working")
  if (working) return working
  const done = new Set(q.stages.filter(step => step.status === "done").map(step => step.id))
  return q.stages.find(step => step.status === "pending" && !isLandingStep(step) && !isDeferred(step) && step.needs.every(id => done.has(id)))
    ?? q.stages.find(step => step.status === "blocked")
}

export function workerAssignment(stages: (Pick<QuestStage, "id" | "status" | "needs"> & Partial<Pick<QuestStage, "claim" | "commandID" | "deferred" | "blocker">>)[], first: string, joinable: (id: string) => boolean = () => true, serial = true): string[] {
  const done = new Set(stages.filter(step => step.status === "done").map(step => step.id))
  const chosen = [first]
  if (isLandingWork(first)) return chosen
  for (;;) {
    const ready = stages.filter(step => step.status === "pending" && !step.blocker && !isLandingStep(step) && !isLandingWork(step.id) && !isDeferred(step) && !chosen.includes(step.id) && step.needs.every(id => done.has(id) || chosen.includes(id)))
    const next = ready.find(step => !step.commandID && joinable(step.id)
      && (serial || step.needs.some(id => chosen.includes(id)) || chosen.some(id => sharesArea(step, stages.find(other => other.id === id)!))))
    if (!next) return chosen
    chosen.push(next.id)
  }
}

export function nextStepAction(q: Pick<Quest, "stages"> & Partial<Pick<Quest, "sessions">>): string {
  const ask = q.sessions?.find(run => run.state === "executing" && run.awaiting)?.awaiting?.ask
  if (ask) return `Allow or reject the worker's ask: ${ask}`
  const step = nextQuestStep(q)
  if (step) return step.status === "blocked" ? `Unblock step ${step.id}` : `Step ${q.stages.indexOf(step) + 1}/${q.stages.length}: ${step.title}`
  if (q.stages.some(step => isLandingStep(step) && step.status === "pending") && q.stages.every(step => isLandingStep(step) || step.status === "done")) return "Wait for the landing on v2 and the reload"
  if (!q.stages.length) return "Add steps"
  if (q.stages.some(step => isDeferred(step) && step.status !== "done") && q.stages.every(step => isDeferred(step) || step.status === "done")) return "Deferred steps wait until the user asks for them"
  return q.stages.every(step => step.status === "done") ? "Read the Quest reward" : "Resolve step dependencies"
}

export type Progress = { done: number; total: number; ratio: number }

export function questProgress(q: Pick<Quest, "stages" | "deliverables" | "acceptanceCriteria">): Progress {
  const count = (done: number, total: number): Progress => ({ done, total, ratio: total ? done / total : 0 })
  if (q.stages.length) return count(q.stages.filter((stage) => stage.status === "done").length, q.stages.length)
  if (q.deliverables.length) return count(q.deliverables.filter((item) => item.status === "done").length, q.deliverables.length)
  return count(q.acceptanceCriteria.filter((item) => item.satisfied).length, q.acceptanceCriteria.length)
}

const TRANSCRIPT = /^\s*(?:<(?:subagent|task|conversation-checkpoint|summary|system-reminder)\b|You are a subagent\b|\[?(?:system|assistant|user)\]?\s*:)/i

export function looksLikeTranscript(text: string): boolean {
  const value = String(text ?? "")
  return TRANSCRIPT.test(value) || /<subagent sessionID=|<task id=|<conversation-checkpoint>/i.test(value) || value.length > 400
}
