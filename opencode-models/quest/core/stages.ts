import type { Quest, QuestStage } from "../types"
import { isLandingStep } from "../landing/landing-step"

export function dependentStageIDs(stages: QuestStage[], rootID: string): Set<string> {
  const reset = new Set([rootID])
  let changed = true
  while (changed) {
    changed = false
    for (const stage of stages) if (!reset.has(stage.id) && stage.needs.some((id) => reset.has(id))) { reset.add(stage.id); changed = true }
  }
  return reset
}

export function runnableStages(q: Pick<Quest, "stages">): QuestStage[] {
  const done = new Set(q.stages.filter((stage) => stage.status === "done").map((stage) => stage.id))
  return q.stages.filter((stage) => stage.status === "pending" && !isLandingStep(stage) && !stage.deferred && stage.needs.every((id) => done.has(id)))
}
