import { questReference } from "../core/references"
import { assignmentContext } from './assignment-context'
import { questLane } from "../board/board"
import { nextQuestStep, nextStepAction } from "../core/steps"
import type { Quest } from "../types"

export function compactQuestSummary(q: Quest) {
  const stage = nextQuestStep(q)
  const stageIndex = stage ? q.stages.indexOf(stage) + 1 : q.stages.length
  return {
    id: questReference(q),
    title: q.title,
    state: q.state,
    lane: questLane(q),
    stage: q.stages.length ? `${stageIndex}/${q.stages.length}` : undefined,
    nextAction: nextStepAction(q),
    running: q.executingCount,
    updatedAt: q.updatedAt,
  }
}

export function compactQuestDispatch(q: Quest, task: string): string {
  const step = nextQuestStep(q)
  return [
    assignmentContext(q, step ? [step.id] : [], task),
    "Report only actual outcomes. Update assigned steps with an explicit pending, working, blocked, or done state and a short result or blocker. Never invent passing tests. Keep incomplete work unfinished.",
    "Save each step with the quest_report call the message gives. Never create Quests or spawn workers.",
  ].filter(Boolean).join("\n")
}
