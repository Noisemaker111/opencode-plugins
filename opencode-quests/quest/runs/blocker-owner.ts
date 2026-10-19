import type { Quest, QuestSession, QuestStage } from '../types'

export const ownedBlocker = (step: QuestStage): boolean => step.status === 'blocked' && !step.needsJon && !!step.blocker && step.blocker.owner.trim().toLowerCase() !== 'quest giver'

export function waitingOnOwner(quest: Quest, run?: QuestSession): boolean {
  const steps = quest.stages.filter(step => step.status !== 'done' && (!run || run.deliverables.includes(step.id)))
  return steps.length > 0 && steps.every(ownedBlocker)
}

export function ownerWait(quest: Quest): string {
  return quest.stages.filter(ownedBlocker).map(step => `${step.title} waits for ${step.blocker!.owner}: ${step.blocker!.requires}`).join('; ')
}

export const GIVER_REFUSAL = /Continue in your existing Quest Giver|must continue in the existing Quest Giver session|message to the Quest Giver was refused/i
export const GIVER_REFUSAL_LINE = 'The worker tried to reach the Quest Giver, which workers cannot do. Start the step again.'
export const runtimeFault = (step: QuestStage): boolean => step.status === 'blocked' && GIVER_REFUSAL.test(`${step.note ?? ''} ${step.blocker?.requires ?? ''}`)
export const blockerLine = (step: QuestStage): string | undefined => runtimeFault(step) ? GIVER_REFUSAL_LINE : step.note
