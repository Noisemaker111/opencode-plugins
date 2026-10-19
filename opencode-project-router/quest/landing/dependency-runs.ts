import { OWNED_RUN } from "../runs/session-lineage"
import type { Quest, QuestSession } from "../types"

export function dependencyStepIDs(q: Pick<Quest, "stages">, stepIDs: string[]): string[] {
  const found = new Set<string>()
  const visit = (id: string) => { if (found.has(id)) return; found.add(id); for (const parent of q.stages.find(step => step.id === id)?.needs ?? []) visit(parent) }
  for (const step of q.stages.filter(step => stepIDs.includes(step.id))) for (const id of step.needs) if (!stepIDs.includes(id)) visit(id)
  return [...found]
}

export const latestDependencyRun = (q: Pick<Quest, "sessions">, stepID: string): QuestSession | undefined =>
  [...q.sessions].reverse().find(run => run.deliverables.includes(stepID) && !!run.runID)

const stepTitle = (q: Pick<Quest, "stages">, stepID: string) => q.stages.find(step => step.id === stepID)?.title ?? stepID

export function dependencyRunningMessage(q: Pick<Quest, "stages">, stepID: string, run: QuestSession): string {
  return `The step "${stepTitle(q, stepID)}" is still owned by its run ${run.runID ?? run.callID}, which is ${run.state}. No worker was started. The dependent step starts again when that run ends.`
}

export function dependencyUnfinishedMessage(q: Pick<Quest, "stages">, stepID: string, run: QuestSession): string {
  return `The step "${stepTitle(q, stepID)}" is not saved done, and its last run ${run.runID ?? run.callID} ended ${run.state}. No worker was started. Save that step done with its result, or start it again.`
}

export type DependencyInheritance = { inherit: string[]; landedProof: { stepID: string; run: QuestSession }[] } | { refused: { code: "DEPENDENCY_RUNNING" | "DEPENDENCY_UNFINISHED"; message: string } }

export function dependencyInheritance(q: Pick<Quest, "stages" | "sessions">, stepIDs: string[]): DependencyInheritance {
  const inherit: string[] = [], landedProof: { stepID: string; run: QuestSession }[] = []
  for (const stepID of dependencyStepIDs(q, stepIDs)) {
    const run = latestDependencyRun(q, stepID)
    if (!run) continue
    if (OWNED_RUN.has(run.state)) return { refused: { code: "DEPENDENCY_RUNNING", message: dependencyRunningMessage(q, stepID, run) } }
    if (run.state === "completed") { inherit.push(run.runID!); continue }
    if (q.stages.find(step => step.id === stepID)?.status !== "done") return { refused: { code: "DEPENDENCY_UNFINISHED", message: dependencyUnfinishedMessage(q, stepID, run) } }
    if (!run.deliverables.some(id => stepIDs.includes(id))) landedProof.push({ stepID, run })
  }
  return { inherit, landedProof }
}

export function dependencyNotLandedMessage(q: Pick<Quest, "stages">, stepID: string, run: QuestSession, reason: string): string {
  return `The step "${stepTitle(q, stepID)}" is saved done, but its last run ${run.runID ?? run.callID} ended ${run.state} and its work is not on v2: ${reason}. No worker was started. Land that run's branch on v2, or start that step again.`
}

export function runningDependency(q: Pick<Quest, "stages" | "sessions">, stepIDs: string[]): { stepID: string; run: QuestSession } | undefined {
  for (const stepID of dependencyStepIDs(q, stepIDs)) {
    const run = latestDependencyRun(q, stepID)
    if (run && OWNED_RUN.has(run.state)) return { stepID, run }
  }
}
