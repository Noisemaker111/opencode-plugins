import { TERMINAL_RUN } from '../runs/session-lineage'
import { plainWords, sentence, noteReason } from '../review/plain-words'
import type { Quest, QuestSession, QuestStage } from '../types'

export const briefReason = (value: unknown, fallback = '') => {
  const text = plainWords(typeof value === 'string' && value.trim() ? value : fallback)
    .split(' | candidates:')[0].replace(/\s*Retry this Quest with run on .*$/i, '').trim()
  if (!/^(?:Worker )?Dispatch (?:failed|error|response error):/i.test(text)) return text
  const [first] = text.split(/(?:\s+\||;|\s+Caused by:)\s+/i)
  return first.trim()
}

const returnedStep = (quest: Quest, stepIDs: string[]): QuestStage | undefined => {
  const assigned = stepIDs.flatMap(id => quest.stages.find(step => step.id === id) ?? [])
  return assigned.findLast(step => step.status === 'done') ?? assigned.at(-1)
    ?? quest.stages.findLast(step => step.status === 'done') ?? quest.stages.at(-1)
}

const latestStepRun = (quest: Quest, stepID?: string): QuestSession | undefined =>
  stepID ? quest.sessions.findLast(run => run.deliverables.includes(stepID)) : undefined

export function landedPlaces(quest: Quest): string[] {
  const landings = Object.values((quest.extensions.landings ?? {}) as Record<string, any>)
  return [...new Set(landings.filter(landing => landing?.state === 'landed').map(landing => landing.remote ? `${landing.remote}/${landing.into}` : String(landing.into ?? landing.branch)))]
}

export function landingLine(quest: Quest, run?: QuestSession): string | undefined {
  const landing = run && (quest.extensions.landings as Record<string, any> | undefined)?.[run.runID ?? run.callID]
  if (!landing || typeof landing !== 'object') return
  if (landing.state === 'landed') return `The work is in ${plainWords(landing.into ?? landing.branch)}${landing.check?.passed ? ' and the project check passed' : ''}.`
  return `${sentence('The work has not landed: ' + noteReason(briefReason(landing.reason, 'the merge was refused')))} The worker's branch is kept.`
}
type ReturnInput = { quest: Quest; stepIDs?: string[]; run?: QuestSession }

function returnLine(input: ReturnInput): string {
  const step = returnedStep(input.quest, input.stepIDs ?? [])
  const run = input.run ?? latestStepRun(input.quest, step?.id)
  const name = `"${plainWords(input.quest.title)}"`
  if (run && run.state !== 'completed' && TERMINAL_RUN.has(run.state))
    return sentence(`${name} stopped: ${noteReason(briefReason(run.result, 'the worker ended before finishing'))}`)
  const outcome = noteReason(briefReason(step?.note, briefReason(run?.result, step?.status === 'done' ? 'The step is done' : 'The worker ended without saving a result')))
  return [sentence(`${name}: ${outcome}`), landingLine(input.quest, run)].filter(Boolean).join(' ')
}

export function questCompletionReturn(input: ReturnInput & { label: 'Automatic Quest worker update' }) {
  return questRunsReturn(input.label, [input])
}

export function questRunsReturn(label: 'Automatic Quest worker update', inputs: ReturnInput[]) {
  return inputs.map(returnLine).join('\n')
}
