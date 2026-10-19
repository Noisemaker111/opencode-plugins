import type { Quest, QuestResult } from '../types'

export const RESULT_FIELDS = ['summary', 'howToUse', 'where'] as const

const sentence = (value: string) => {
  const text = value.trim()
  return text ? text[0].toUpperCase() + text.slice(1).replace(/([^.!?])$/, '$1.') : ''
}

export function draftedResult(quest: Pick<Quest, 'stages'>): QuestResult | undefined {
  const drafts = quest.stages.flatMap(step => step.result ? [step.result] : [])
  if (!drafts.length) return
  const joined = (key: typeof RESULT_FIELDS[number]) => [...new Set(drafts.map(draft => draft[key]?.trim()).filter(Boolean))].join(' ')
  return { summary: joined('summary'), howToUse: joined('howToUse'), where: joined('where') }
}

export function questResult(quest: Pick<Quest, 'result' | 'stages'>): QuestResult | undefined {
  return quest.result ?? draftedResult(quest)
}

export function deliveredResult(quest: Pick<Quest, 'result' | 'stages' | 'title'>, where: string): QuestResult {
  const result = questResult(quest)
  if (result) return { ...result, where: result.where || sentence(where) }
  return { summary: sentence(quest.title + ' is done'), howToUse: '', where: sentence(where) }
}

export const awaitingGotIt = (quest: Pick<Quest, 'delivered' | 'archive' | 'state'>) => !!quest.delivered && !quest.archive && quest.state !== 'Archived'

export const resultCard = (quest: Pick<Quest, 'result' | 'stages' | 'delivered' | 'archive'>): QuestResult | undefined =>
  quest.delivered || quest.archive ? questResult(quest) : undefined
