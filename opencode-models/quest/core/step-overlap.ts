import type { Quest, QuestStage } from "../types"
import { isLandingStep } from "../landing/landing-step"

type Step = Pick<QuestStage, "id" | "needs"> & Partial<Pick<QuestStage, "claim" | "commandID">>

const WORKER_STATES = new Set(["planned", "executing", "waiting", "blocked"])
const GLOB = /[*?[{]/

const normalized = (path: string) => path.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase()
const everything = (path: string) => !path || path === "." || /^\*\*?(\/\*+)?$/.test(path)

export function pathsOverlap(left: string, right: string): boolean {
  const a = normalized(left), b = normalized(right)
  if (everything(a) || everything(b)) return true
  const globA = GLOB.exec(a)?.index, globB = GLOB.exec(b)?.index
  if (globA === undefined && globB === undefined) return a === b || a.startsWith(b + "/") || b.startsWith(a + "/")
  const fixedA = globA === undefined ? a : a.slice(0, globA), fixedB = globB === undefined ? b : b.slice(0, globB)
  return fixedA.startsWith(fixedB) || fixedB.startsWith(fixedA)
}

export const stepArea = (step: Partial<Pick<QuestStage, "claim">>) => step.claim?.include ?? []

export function sharesArea(a: Partial<Pick<QuestStage, "claim">>, b: Partial<Pick<QuestStage, "claim">>): boolean {
  const left = stepArea(a), right = stepArea(b)
  return left.some(x => right.some(y => pathsOverlap(x, y)))
}

export function needsOutputOf(stages: Step[], id: string, earlier: string): boolean {
  const byID = new Map(stages.map(step => [step.id, step])), seen = new Set<string>()
  const visit = (current: string): boolean => (byID.get(current)?.needs ?? []).some(need => need === earlier || (!seen.has(need) && (seen.add(need), visit(need))))
  return visit(id)
}

export function stepsRelated(stages: Step[], a: string, b: string): boolean {
  if (a === b) return true
  const left = stages.find(step => step.id === a), right = stages.find(step => step.id === b)
  if (!left || !right || isLandingStep(left) || isLandingStep(right) || left.commandID || right.commandID) return false
  return needsOutputOf(stages, a, b) || needsOutputOf(stages, b, a) || sharesArea(left, right)
}

const workerRuns = (q: Pick<Quest, "sessions">) => q.sessions.filter(run => WORKER_STATES.has(run.state) && run.agentRole !== "command" && run.role !== "command")

export function activeWorkerSteps(q: Pick<Quest, "sessions">): string[] {
  return [...new Set(workerRuns(q).flatMap(run => run.deliverables))]
}

export function overlapRefusal(q: Pick<Quest, "stages" | "sessions">, stepIDs: string[], busy: string[] = activeWorkerSteps(q)): string | undefined {
  const held = busy.filter(id => !stepIDs.includes(id))
  for (const id of stepIDs) for (const other of held) if (stepsRelated(q.stages, id, other)) {
    const step = q.stages.find(s => s.id === id)!, running = q.stages.find(s => s.id === other)!
    const why = needsOutputOf(q.stages, id, other) || needsOutputOf(q.stages, other, id) ? "depends on" : "touches the same files or code area as"
    return `No second worker started. Step "${step.title}" ${why} step "${running.title}", which a worker on this Quest already runs. That worker runs it next, or it starts when that worker ends.`
  }
}
