import { QuestError } from '../api'
import { depthOf, workTypeOf, type Depth } from '../../models/work-profile'
import type { Quest } from '../types'
import type { QuestStore } from '../store'
import { acquireLock } from '../locking.mts'
import { questPullRequests } from '../board/detail-evidence'
import { confirmWorkerIdle, inspectWorker } from '../workers/worker-inspection'
import type { QuestHost } from './runtime'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
export type QuestWorkflow = {
  readOnly?: boolean
  task?: 'coding' | 'review' | 'planning' | 'utility'
  depth?: Depth
  workType?: string
  model?: string
  maxConcurrent?: number
  delivery?: 'project' | 'quest-pr' | 'step-pr' | 'none'
  branch?: string
  handoff?: { readiness?: string[]; acceptance?: string[]; pointers?: string[] }
}

const validBranch = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9][\w./-]*$/.test(value) && !/\.\.|\/\/|\/$|\.$|\.lock$/.test(value)

export function parseWorkflow(value: unknown): QuestWorkflow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QuestError('INVALID_INPUT', 'workflow must be an object')
  const { size: legacySize, attempts: droppedAttempts, helpers: droppedHelpers, ...input } = value as Record<string, unknown>
  void [droppedAttempts, droppedHelpers]
  if (legacySize !== undefined && input.depth === undefined) input.depth = legacySize
  if (Object.keys(input).some(key => !['readOnly', 'task', 'depth', 'workType', 'model', 'maxConcurrent', 'delivery', 'branch', 'handoff'].includes(key))) throw new QuestError('INVALID_INPUT', 'Unknown workflow setting')
  if (input.branch !== undefined && !validBranch(input.branch)) throw new QuestError('INVALID_INPUT', 'workflow.branch must be a valid git branch name, such as quest-test/routing-doc-date')
  if (input.readOnly !== undefined && typeof input.readOnly !== 'boolean') throw new QuestError('INVALID_INPUT', 'workflow.readOnly must be a boolean')
  if (input.task !== undefined && !['coding', 'review', 'planning', 'utility'].includes(String(input.task))) throw new QuestError('INVALID_INPUT', 'Unknown workflow task')
  try { if (input.depth !== undefined) input.depth = depthOf(input.depth); if (input.workType !== undefined) input.workType = workTypeOf(input.workType) } catch (error) { throw new QuestError('INVALID_INPUT', 'workflow: ' + (error instanceof Error ? error.message : String(error))) }
  if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim())) throw new QuestError('INVALID_INPUT', 'workflow.model must be an exact route')
  if (input.maxConcurrent !== undefined && (!Number.isSafeInteger(input.maxConcurrent) || Number(input.maxConcurrent) < 1)) throw new QuestError('INVALID_INPUT', 'workflow.maxConcurrent must be a positive integer')
  if (input.delivery !== undefined && !['project', 'quest-pr', 'step-pr', 'none'].includes(String(input.delivery))) throw new QuestError('INVALID_INPUT', 'Unknown workflow delivery')
  if (input.handoff !== undefined) {
    if (!input.handoff || typeof input.handoff !== 'object' || Array.isArray(input.handoff)) throw new QuestError('INVALID_INPUT', 'workflow.handoff must be an object')
    for (const [key, value] of Object.entries(input.handoff)) {
      if (!['readiness', 'acceptance', 'pointers'].includes(key) || !Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new QuestError('INVALID_INPUT', 'Handoff observations and pointers must be arrays of nonempty text')
    }
  }
  return { ...input } as QuestWorkflow
}

export const questWorkflow = (quest: Quest): QuestWorkflow => parseWorkflow(quest.extensions.workflow ?? {})

export function assertFullRoute(model: string | undefined, field: string) {
  if (model === undefined) return
  const route = model.trim()
  if (route.startsWith('route:') && route.length > 6) return
  const [identity, reasoning, ...extra] = route.split('#')
  const slash = identity.indexOf('/')
  if (slash > 0 && slash < identity.length - 1 && reasoning?.trim() && !extra.length) return
  throw new QuestError('REASONING_REQUIRED', field + ' "' + model + '" names a model without a reasoning level. Name a full route as provider/model#reasoning, such as ' + (slash > 0 ? identity : 'openai/gpt-6.1-sol') + '#high, or leave ' + field + ' out so automatic routing chooses. Nothing was started.')
}

export function standingDeliveryAuthorization(directory:string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>
    const declared = (manifest.quest as Record<string, unknown> | undefined)?.delivery
    const parts = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
    const text = parts.filter((part): part is string => typeof part === 'string' && !!part.trim()).map(part => part.trim()).join('; ')
    return text ? text.slice(0, 1200) : undefined
  } catch { return undefined }
}

export function deliveryInstructions(quest: Quest, sessionID?: string): string {
  switch (questWorkflow(quest).delivery ?? 'project') {
    case 'none': return 'Deliver the requested result and evidence in your step notes. This Quest requests no pull request. When every path you changed is under docs/ or ends in .md or .txt, your check is git diff --check, not bun run check:affected.'
    case 'step-pr': return 'Deliver a focused pull request for your assigned step when it changes repository code. Follow the project conventions and existing publishing authorization; save its URL and verification in the step notes.'
    case 'quest-pr': {
      const owner = quest.extensions.prOwner as { sessionID: string; runID: string } | undefined
      return owner?.sessionID === sessionID
        ? 'You are the persisted PR owner for this Quest (' + owner.runID + '). Collect the other steps’ commits and evidence and open the one ready PR for the whole Quest against the project integration branch under existing authorization. Record its URL, checked revision and checks. Leave delivery unfinished if any required evidence or capability is missing.'
        : 'This Quest requests one PR. The persisted implementation-worker PR owner is ' + (owner?.runID ?? 'not yet assigned; a writable coding worker must be admitted') + '. Return your commits and check receipts in your step; do not open a separate PR. The giver coordinates results.'
    }
    case 'project': return ''
  }
}

type PROwner = { runID: string; sessionID: string; assignedAt: string }
function reconciledOwner(quest: Quest, owner: PROwner) {
  const run = quest.sessions.find(run => (run.runID ?? run.callID) === owner.runID && (run.openCodeSessionId ?? run.sessionID) === owner.sessionID)
  const results = quest.extensions.stepResults as Record<string, { runIDs: string[] }> | undefined
  if (!run || !['failed', 'completed', 'cancelled'].includes(run.state) || questPullRequests(quest).length || !run.deliverables.length || run.deliverables.some(id => !results?.[id]?.runIDs.includes(owner.runID))) return
  return run
}

export async function assignPROwner(store: QuestStore, questID: string, runID: string, sessionID: string, host: QuestHost): Promise<Quest> {
  const snapshot = store.read(questID)!
  if (questWorkflow(snapshot).delivery !== 'quest-pr') return snapshot
  const previous = snapshot.extensions.prOwner as PROwner | undefined
  let observation: { state: string; checkedAt?: string } | undefined
  if (previous) {
    if (previous.runID === runID) return snapshot
    const owner = reconciledOwner(snapshot, previous)
    if (!owner) return snapshot
    observation = await inspectWorker(host, owner)
    if (!observation || !['completed', 'failed', 'interrupted', 'cancelled'].includes(observation.state) || !await confirmWorkerIdle(host, previous.sessionID)) return store.read(questID)!
  }
  const lock = acquireLock(store.runtime, 'pr-owner-' + questID)
  try {
    const quest = store.read(questID)!
    if (quest.revision !== snapshot.revision) {
      const currentOwner = quest.extensions.prOwner as PROwner | undefined
      if (questWorkflow(quest).delivery === 'quest-pr' && (!currentOwner || reconciledOwner(quest, currentOwner))) throw new QuestError('PR_OWNER_CONFLICT', 'Quest changed during PR-owner inspection; retry ownership admission before prompting this worker', true, runID)
      return quest
    }
    if (previous && !reconciledOwner(quest, previous)) return quest
    const run = quest.sessions.find(run => run.runID === runID && (run.openCodeSessionId ?? run.sessionID) === sessionID)
    if (!run || run.agentRole === 'command' || run.scope?.readOnly || !['planned', 'executing', 'waiting'].includes(run.state) || !run.deliverables.length || run.deliverables.some(id => quest.sessions.findLast(candidate => candidate.deliverables.includes(id)) !== run)) throw new QuestError('PR_OWNER_UNAVAILABLE', 'PR ownership requires a current writable implementation worker')
    const assignedAt = new Date().toISOString(), prOwner = { runID, sessionID, assignedAt }
    const history = (quest.extensions.prOwnerHistory ?? []) as unknown[]
    return store.apply(questID, 'patched', { extensions: { ...quest.extensions, prOwner,
      prOwnerHistory: [...history, { ...(previous ? { from: previous, terminalState: reconciledOwner(quest, previous)!.state, observation, reason: 'Reconciled terminal owner confirmed idle without PR delivery' } : { reason: 'Initial implementation-worker assignment' }), to: prOwner, at: assignedAt }],
    } }, 'quest:pr-owner', { expectedRevision: quest.revision })
  } finally { lock.release() }
}

export function handoffInstructions(quest: Quest): string {
  const handoff = questWorkflow(quest).handoff
  const recorded = (label: string, rows?: string[]) => rows?.length ? label + ': ' + rows.join('\n') : undefined
  return [
    recorded('Parent readiness observations', handoff?.readiness),
    recorded('Parent acceptance receipts', handoff?.acceptance),
    recorded('Relevant source/evidence pointers', handoff?.pointers),
  ].filter((line): line is string => !!line).join('\n\n')
}
