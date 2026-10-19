import { projectToolInputs } from '../../project-router/tool-schemas.mjs'
import { operationSignature, questSignatureLines } from '../interfaces/operation-signatures.mjs'
import { questOperations } from '../operations.mjs'
import type { QuestStore } from '../store'
import {pacingInstruction} from './giver-settings'
import {COMPUTER_USE_LINE} from '../permissions/computer-use'
import {RESOLVE} from './giver-wake'
import {SIMPLE_ENGLISH} from '../review/simple-english'
import {spendInstruction} from '../host/spend-mode'
import {readAccountUsage} from '../../usage-service/on-computer'

const spendAccounts=()=>readAccountUsage().accounts

export const GIVER_DENIED_OPERATIONS = ['wait', 'report', 'message', 'waterfall', 'routing', 'roles', 'routingHistory', 'routingMap', 'routingSimulate', 'owners']
export function giverOperations() {
  return Object.fromEntries(Object.entries(questOperations).filter(([name]) => !GIVER_DENIED_OPERATIONS.includes(name)))
}

export function projectSignatureLines() {
  return Object.entries(projectToolInputs).map(([name, input]) => operationSignature(name, input))
}

export const PROJECT_LINE = 'Every create needs projectRoot. Use a path the user named. Otherwise call project_resolve with request set to their words and create only from a resolved target; a request about Quest Giver, Quest Web or "this" app resolves to the project you run from. On clarify, ask the user with 2-4 of its candidates, then project_resolve their pick by directory. Never ask the user what a tool answers: "audit all the quests" is quests.list with allProjects:true, not a question about which project. Existing Quests keep their project, and update projectRoot moves one.'

export function giverBrief(store: QuestStore, sessionID: string) {
  return [
    'Quest operations, called inside native `execute` as `tools.quests.<name>({...})`:',
    ...questSignatureLines(giverOperations()),
    '',
    'Project tools, called the same way as `tools.<name>({...})`:',
    ...projectSignatureLines(),
    '',
    PROJECT_LINE,
    SIMPLE_ENGLISH,
    RESOLVE,
    'Saved worker outcomes are not independent verification. Read full Quest notes only when needed.',
    '',
    'create, update, start and run answer with a decision-sized summary: id, title, state, lane, step states and the run state. The description, workflow, artifacts and notes you sent are not read back; use get, plan or inspect when a view you do not already hold is needed.',
    'A started step that lacks a need it requires: once its workers are idle, declare the need and quests.run that step with recoverDependencies:true, which keeps its branch and evidence.',
    COMPUTER_USE_LINE,
    ...[pacingInstruction(),spendInstruction(store.runtime,id=>{try{return store.read(id)}catch{return undefined}},spendAccounts)].filter(Boolean),
  ].join('\n')
}
