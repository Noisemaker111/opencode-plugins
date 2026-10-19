import { questReference } from '../core/references'
import type { Quest, QuestStage } from '../types'
import { workSteps } from '../landing/landing-step'

export const UNATTRIBUTED_LABEL="These messages reached the Quest Giver together; do the part this Quest's title names."
const RUN_KINDS=new Set(['coding','review','planning','utility'])

export const CONTEXT_LABEL="Background only: the Quest Giver had already acted on this user message when it opened this Quest. It is not this Quest's task and not approval for it."

export const FRONT_ORDERS_LABEL="Background: the front wrote this to the Quest Giver, which planned this Quest from it. Its orders to the Quest Giver, model choices and hub checkout paths are the Quest Giver's job, not yours. Do only the part named above, in this checkout."

export const TRIVIAL_STEP_LINE="This step is trivial. Do the one thing it names. Read the target once. If it asks for an edit, make it. Verify once with the check the step names. Save the step done, then stop. Do not list directories or re-read files."

const fromFront = (row: { origin?: { from: string } }) => row.origin?.from === 'front'

function userWords(quest: Quest) {
 return (quest.request ?? []).filter(row => row.text.trim() && !row.context)
}

function contextWords(quest: Quest) {
 const rows = (quest.request ?? []).filter(row => row.text.trim() && row.context)
 return rows.length ? CONTEXT_LABEL + '\n' + rows.map(row => '<<<\n' + row.text + '\n>>>').join('\n') : ''
}

export function siblingQuests(quest: Quest, quests: Quest[]): string[] {
 const messages = new Set(userWords(quest).map(row => row.messageID))
 return quests.flatMap(other => other.id !== quest.id && other.state !== 'Archived' && userWords(other).some(row => messages.has(row.messageID)) ? [other.title] : [])
}

function delivered(quest: Quest, steps: QuestStage[]) {
 const dependencies = [...new Set(steps.flatMap(step => step.needs))].filter(id => !steps.some(own => own.id === id)).flatMap(id => quest.stages.find(step => step.id === id) ?? [])
 return dependencies.flatMap(step => [
  'Earlier step [' + step.id + '] "' + step.title + '" (' + step.status + ')' + (step.note?.trim() ? ' delivered: ' + step.note.trim() : ''),
  ...[...new Set(step.proofs.flatMap(proof => proof.artifact ? [proof.artifact] : []))].map(path => 'Evidence for ' + step.id + ': ' + path),
 ])
}

const stepName = (step: QuestStage) => '[' + step.id + '] ' + step.title

function wordsContext(quest: Quest, stepIDs: string[], task: string | undefined, siblings: string[]): string {
 const messages = userWords(quest)
 const said = new Set(messages.map(row => row.text.trim()))
 const added = (text?: string) => text?.trim() && !said.has(text.trim()) ? text.trim() : ''
 const work = workSteps(quest.stages)
 const steps = work.filter(step => stepIDs.includes(step.id))
 const whole = !steps.length || work.every(step => stepIDs.includes(step.id))
 const others = work.filter(step => !stepIDs.includes(step.id) && !steps.some(own => own.needs.includes(step.id)))
 const unattributed = messages.some(row => row.unattributed), stated = quest.description ?? quest.objective
 const description = unattributed && stated?.trim() === quest.title.trim() ? '' : added(stated), assignment = task && !RUN_KINDS.has(task.trim()) ? added(task) : ''
 const mine = whole ? (steps.length > 1 ? '. Steps, in order: ' + steps.map(stepName).join('; ') : '') : '; your step' + (steps.length > 1 ? 's: ' : ' is ') + steps.map(stepName).join('; ')
 const label = (name: string, step: QuestStage) => name + (steps.length > 1 ? ' for [' + step.id + ']: ' : ': ')
 const byStatus = [...new Set(others.map(step => step.status))].map(status => status + ': ' + others.filter(step => step.status === status).map(step => step.title).join('; '))
 return [
  'Quest ' + questReference(quest),
  (messages.every(fromFront) ? 'Do "' + quest.title + '", planned from the front\'s message below' : 'Do the request below') + mine + '.' + (unattributed ? ' ' + UNATTRIBUTED_LABEL : siblings.length ? ' Other Quests own: ' + siblings.map(title => '"' + title + '"').join(', ') + '.' : ''),
  messages.map((row, index) => (index && !row.unattributed ? 'Later message:\n' : '') + '<<<\n' + row.text + '\n>>>').join('\n'),
  messages.some(fromFront) && FRONT_ORDERS_LABEL,
  description && 'Detail: ' + description,
  assignment && 'Detail: ' + assignment,
  ...steps.flatMap(step => [
   added(step.detail) && label('Detail', step) + step.detail!.trim(),
   added(step.note) && label('Note', step) + step.note!.trim(),
  ]),
  ...delivered(quest, steps),
  contextWords(quest),
  !whole && others.length && 'Other steps, ' + byStatus.join('. ') + '.',
 ].filter(Boolean).join('\n\n')
}

function plannedContext(quest: Quest, stepIDs: string[], task?: string): string {
 const seen = new Set<string>()
 const body = (label: string, text?: string) => {
  const key = text?.trim()
  if (!key || seen.has(key)) return ''
  seen.add(key)
  return label + ': ' + key
 }
 const steps = quest.stages.filter(step => stepIDs.includes(step.id))
 return [
  'Quest ' + questReference(quest) + ': ' + quest.title,
  body('Task', quest.description ?? quest.objective),
  task && !RUN_KINDS.has(task.trim()) && body('Detail', task),
  ...steps.flatMap(step => [
   'Your step ' + stepName(step),
   body('Detail for [' + step.id + ']', step.detail),
   body('Last note on [' + step.id + ']', step.note),
  ]),
  ...delivered(quest, steps),
  contextWords(quest),
 ].filter(Boolean).join('\n\n')
}

export function assignmentContext(quest: Quest, stepIDs: string[], task?: string, siblings: string[] = []): string {
 return userWords(quest).length ? wordsContext(quest, stepIDs, task, siblings) : plannedContext(quest, stepIDs, task)
}

export function checkoutLine(input: { branch?: string; into?: string; merge?: boolean; standing?: string }): string {
 const branch = input.branch ? 'Branch ' + input.branch + (input.into ? ' → ' + input.into : '') : ''
 const may = input.into && input.standing ? (input.merge ? 'you may merge it' : 'you may not merge it') : input.standing ? 'authorized: ' + input.standing.replace(/[.\s]+$/, '') : 'no standing push, pull request or merge authorization'
 const target = input.into ? ' Deliver to ' + input.into + ' only: base the work on it and open any pull request into it. A branch named in a step title, id or note is a legacy label.' : ''
 return [branch, may].filter(Boolean).join('; ').replace(/^./, first => first.toUpperCase()) + '.' + target
}

export function reportCall(questID: string, stepIDs: string[]): string {
 return stepIDs.map((stepID, index) => 'return await tools.quest_report({id:' + JSON.stringify(questID) + ',stepID:' + JSON.stringify(stepID) + ',state:"done",note:"..."' + (index === stepIDs.length - 1 ? ',result:{summary:"...",howToUse:"...",where:"..."}' : '') + '})').join('\n')
}

export type WorkerPromptInput = {
 quest: Quest
 stepIDs: string[]
 task?: string
 depth?: string
 siblings?: string[]
 readOnly?: string
 checkout?: string
 delivery?: string
 handoff?: string
 preserved?: string
 workspace?: string
}

export function workerPrompt(input: WorkerPromptInput): string {
 return [
  input.readOnly,
  assignmentContext(input.quest, input.stepIDs, input.task, input.siblings),
  input.depth === 'routine' ? TRIVIAL_STEP_LINE : undefined,
  input.checkout,
  input.delivery,
  input.handoff,
  input.preserved,
  input.workspace,
  reportCall(questReference(input.quest), input.stepIDs),
 ].filter(Boolean).join('\n\n')
}
