import { DEPTHS, DEPTH_LEVELS, type Depth } from '../../models/work-profile'
import type { WorkType } from '../../models/routing-settings'
import type { ProfileAnswer, ProfileShares } from '../../models/decision-trace'

export type ProfileAsk = { workTypes: WorkType[]; ask: { workType: boolean; depth: boolean } }
export type ProfileInference = { workType?: string; depth?: Depth; source: string; answer?: ProfileAnswer }
const typeKey = (index: number) => 't' + (index + 1)

export function profileQuestions({ workTypes, ask }: ProfileAsk) {
  return {
    ...(ask.workType ? { workType: { type: 'choice' as const, instructions: 'Which kind of work is this?', criteria: Object.fromEntries(workTypes.map((type, index) => [typeKey(index), type.label + ': ' + type.description])) } } : {}),
    ...(ask.depth ? { depth: { type: 'score' as const, instructions: 'How much thought does this need from an AI coding agent that has never seen the project?', criteria: DEPTHS.map(depth => DEPTH_LEVELS[depth]) } } : {}),
  }
}

export function depthFromAnswer(answers: Record<string, any>, frontierSure?: number): { depth: Depth; note?: string } {
  const scored = answers.depth
  if (scored?.type !== 'score' || !scored.probabilities || typeof scored.probabilities !== 'object') throw Error('The model router answered the thought-needed question without a scored level')
  const unknown = Object.keys(scored.probabilities).filter(key => !DEPTHS.some((_, index) => String(index) === key))
  if (unknown.length) throw Error('The model router named a thought-needed level it was not asked about: ' + unknown.join(', '))
  const levels = DEPTHS.map((_, index) => Number(scored.probabilities[String(index)] ?? 0))
  if (levels.some(probability => !Number.isFinite(probability) || probability < 0)) throw Error('The model router returned an invalid probability for a thought-needed level')
  const total = levels.reduce((sum, probability) => sum + probability, 0)
  const [first] = levels.map((probability, index) => ({ probability, index })).sort((a, b) => b.probability - a.probability || a.index - b.index)
  if (!(first.probability > 0)) throw Error('The model router gave no thought-needed level any probability')
  const likeliest = DEPTHS[first.index], share = first.probability / total
  if (likeliest === 'frontier' && frontierSure !== undefined && share < frontierSure) return { depth: 'deep', note: 'The model router rated it Hardest at ' + Math.round(share * 100) + '%, below the ' + Math.round(frontierSure * 100) + '% needed, so Deep' }
  return { depth: likeliest }
}

export function workTypeFromAnswer(answers: Record<string, any>, workTypes: WorkType[]): string {
  const chosen = answers.workType
  if (chosen?.type !== 'choice' || !chosen.probabilities || typeof chosen.probabilities !== 'object') throw Error('The model router answered the work type question without a choice')
  const keys = workTypes.map((_, index) => typeKey(index))
  const unknown = Object.keys(chosen.probabilities).filter(key => !keys.includes(key))
  if (unknown.length) throw Error('The model router named a work type it was not offered: ' + unknown.join(', '))
  const best = keys.map((key, index) => ({ index, probability: Number(chosen.probabilities[key] ?? 0) })).sort((a, b) => b.probability - a.probability || a.index - b.index)[0]
  if (!(best.probability > 0)) throw Error('The model router gave no work type any probability')
  return workTypes[best.index].id
}

function answerShares(answers: Record<string, any>, question: 'workType' | 'depth', names: string[], keyOf: (index: number) => string): ProfileShares | undefined {
  const given = answers[question]
  if (!given?.probabilities || typeof given.probabilities !== 'object') return undefined
  const shares = Object.fromEntries(names.flatMap((name, index) => { const value = Number(given.probabilities[keyOf(index)] ?? 0); return Number.isFinite(value) && value > 0 ? [[name, value]] : [] }))
  return { confidence: typeof given.confidence === 'number' && Number.isFinite(given.confidence) ? given.confidence : null, shares }
}

export function profileFromAnswers(answers: Record<string, any>, input: ProfileAsk & { frontierSure?: number; model: string; milliseconds: number }): ProfileInference {
  const workTypeShares = input.ask.workType ? answerShares(answers, 'workType', input.workTypes.map(type => type.id), typeKey) : undefined
  const inferredDepth = input.ask.depth ? depthFromAnswer(answers, input.frontierSure) : undefined
  const depthShares = input.ask.depth ? answerShares(answers, 'depth', [...DEPTHS], String) : undefined
  const detail: ProfileAnswer = { model: input.model, milliseconds: input.milliseconds, calls: 0, inputTokens: 0, cost: 0, ...(workTypeShares ? { workType: workTypeShares } : {}), ...(depthShares ? { depth: { ...depthShares, ...(inferredDepth?.note ? { note: inferredDepth.note } : {}) } } : {}) }
  const inferred = { ...(input.ask.workType ? { workType: workTypeFromAnswer(answers, input.workTypes) } : {}), ...(inferredDepth ? { depth: inferredDepth.depth } : {}) }
  return { ...inferred, source: 'inferred by ' + input.model + ' from the work', answer: detail }
}
