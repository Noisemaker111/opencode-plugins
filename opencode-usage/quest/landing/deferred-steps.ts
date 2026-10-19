import type { Quest, QuestRequest, QuestStage } from "../types"
import { isLandingStep } from "./landing-step"

export type DeferredUntil = "parent-done" | "jon"

export const DEFERRED_UNTIL: DeferredUntil[] = ["parent-done", "jon"]

export const isDeferred = (step: Pick<QuestStage, "deferred"> | undefined) => !!step?.deferred

export function startDueDeferred(stages: QuestStage[]): string[] {
  const deferred = stages.filter(step => step.deferred?.until === "parent-done" && step.status === "pending")
  if (!deferred.length) return []
  const current = stages.filter(step => !isDeferred(step) && !isLandingStep(step))
  if (!current.length || current.some(step => step.status !== "done")) return []
  for (const step of deferred) delete step.deferred
  return deferred.map(step => step.id)
}

const open = (q: Quest) => !["Archived", "Complete"].includes(q.state) && !q.delivered

export function laterItemParent(quests: Quest[], asked: Pick<QuestRequest, "messageID">[]): Quest | undefined {
  if (!asked.length) return
  return quests.find(q => open(q) && asked.every(row => q.request?.some(held => held.messageID === row.messageID && !held.context)))
}

export const DEFERRED_NOT_STARTED = "This step is deferred: it waits on its parent Quest until the user asks for it, or until the current steps are done. Ask the user, or finish the current steps first."
