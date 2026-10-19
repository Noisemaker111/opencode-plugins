import { frozenRun, giverChangedAtStart, latestSessionAttempts, lostToInfrastructure, OWNED_RUN, passingBindingChange, refusedInReply, stoppedByGiver, stoppedOnPurpose, takenOverBy, TERMINAL_RUN } from '../runs/session-lineage'
import { briefReason, landingLine } from '../workers/completion-return'
import { awaitingGotIt, questResult } from '../board/result-card'
import { giverBlockers, handoffsOf, NEEDS_JON_LABEL, runKey, SAVED_BY_GIVER, savedByGiver, stepBlockerKey } from '../core/state-machine'
import { recordHandoff, type HandoffVia } from './giver-handoff'
import { ownedBlocker, ownerWait, waitingOnOwner } from '../runs/blocker-owner'
import type { Quest, QuestSession, QuestStage } from '../types'
import type { QuestStore } from '../store'
import { causeKey, claimCause, noticeCleared, noticeDue, noticeKindOf, releaseCause, type NoticeSlot } from './notice-ledger'
import { noteReason, plainWords, sentence } from '../review/plain-words'
import { reworkRequested } from '../review/review-record'
import { isLandingStep, LANDING_STEP_ID, landingDone, RELOAD_FAILED_NOTE, workDone } from '../landing/landing-step'
import { landingBlocked } from '../board/board'

export const LANDED_SETTLED = 'The landing step is done, so the Quest completes itself; no notice is needed.'
export const LANDING_HOLD = 'Waiting for the landing on v2 and the service reload; the return wakes the Quest Giver once the landing step is recorded.'

export function landingUnderway(quest: Quest): boolean {
  const step = quest.stages.find(isLandingStep)
  return step?.status === 'pending' && workDone(quest.stages) && !landingBlocked(quest) && !quest.stages.some(other => other.status === 'blocked')
}

export const CAPACITY_FAILURE = /cooling down|rate[_ ]?limit|server_is_overloaded|servers are currently overloaded|usage reached|no evidenced, funded route|window is exhausted/i

export const HOST_NEVER_STARTED = 'The host never started this run.'
export const WORKER_ENDED_EMPTY = "The worker's session ended without a result."
const READY_AGAIN = new Set([HOST_NEVER_STARTED, WORKER_ENDED_EMPTY])

const runID = (run: QuestSession) => run.runID ?? run.callID

function reDispatched(quest: Quest, run: QuestSession): boolean {
  return quest.sessions.some(other => runID(other) !== runID(run)
    && other.deliverables.some(step => run.deliverables.includes(step))
    && (OWNED_RUN.has(other.state) || other.attempt > run.attempt))
}

export function newerRunOn(quest: Pick<Quest, 'sessions'>, run: QuestSession): QuestSession | undefined {
  const at = quest.sessions.findIndex(other => runID(other) === runID(run))
  return quest.sessions.find((other, index) => runID(other) !== runID(run) && OWNED_RUN.has(other.state)
    && (index > at || other.attempt > run.attempt) && other.deliverables.some(step => run.deliverables.includes(step)))
}

export const NEWER_RUN_SETTLED = 'A newer run of this step is already going, so a notice about the earlier stop says nothing new.'

export const savedItsSteps = (quest: Pick<Quest, 'stages'>, run: QuestSession) => run.state === 'completed'
  || TERMINAL_RUN.has(run.state) && run.deliverables.length > 0 && run.deliverables.every(id => quest.stages.find(step => step.id === id)?.status === 'done')

export const RESOLVE = 'Honor each saved blocker owner and prerequisite. When the runtime or another Quest owns it, wait for that owner; do not bypass native permissions or re-dispatch unchanged work. For a prerequisite you own, resolve it under the saved authorization, then save resolution.evidence naming the observed change before resuming or dispatching the step. A new worker or reworded note is not resolution. It goes to the user only when only they can clear it: save the step blocked with needsJon (sign-in, spend, main-release, destructive or choice) and the user\'s one question in the note.'

export type Wake = { wake: true; text: string } | { wake: false; settled: string }

export type NoticeKind = 'DONE' | 'BLOCKED' | 'STOPPED' | 'NEEDS YOU'

export const STILL_RUNNING = 'remaining steps are still running'

export function giverDecides(text: string): boolean {
  const kind = noticeKindOf(text)
  if (kind === 'NEEDS YOU') return false
  return !(kind === 'BLOCKED' && (text.split('\n')[1] ?? '').trim().endsWith(plainWords(STILL_RUNNING)))
}

export function questNotice(kind: NoticeKind, quest: Pick<Quest, 'title'>, lines: (string | undefined)[], action: string): string {
  return [`QUEST ${kind} "${plainWords(quest.title)}"`, lines.filter((line): line is string => !!line?.trim()).map(line => plainWords(line)).join(' '), `(${action})`].join('\n')
}

const needsLine = (step: QuestStage) => step.needsJon ? `Needs: ${NEEDS_JON_LABEL[step.needsJon]}`
  : step.blocker?.requires ? `Needs: ${noticeReason(step.blocker.requires)}${step.blocker.owner ? ` (${step.blocker.owner})` : ''}` : undefined

const DISPATCH_ERROR = /(?:Worker )?Dispatch (?:failed|error|response error):/i

export function noticeReason(value: unknown, fallback = ''): string {
  const text = briefReason(value, fallback), at = text.search(DISPATCH_ERROR)
  if (at < 0) return noteReason(text)
  const [first] = text.slice(at).split(/(?:\s+\||;|\s+Caused by:|(?<=[.!?]))\s+/i)
  return noteReason(`${text.slice(0, at)}${first.trim()}`)
}

export const NO_SAVED_REASON = 'no reason was saved; find out what stopped it'
const NO_BLOCKED_STEP = 'no blocked step was saved'

export const runCause = (run: QuestSession | undefined): string | undefined => run?.result?.trim() || run?.evidence.at(-1)?.trim() || undefined

export function stopCause(quest: Pick<Quest, 'sessions'>, step: QuestStage): string | undefined {
  if (step.note?.trim()) return step.note
  return runCause(latestSessionAttempts(quest.sessions).filter(run => TERMINAL_RUN.has(run.state) && run.deliverables.includes(step.id)).at(-1))
}

export const noticeHasReason = (text: string) => !text.includes(plainWords(NO_SAVED_REASON)) && !text.includes(plainWords(NO_BLOCKED_STEP))

export function blockedNotice(quest: Quest, steps = quest.stages.filter(step => step.status === 'blocked')): string {
  const step = steps.find(row => row.needsJon) ?? steps[0]
  const others = steps.length > 1 ? `${steps.length - 1} more step${steps.length > 2 ? 's are' : ' is'} blocked too` : undefined
  if (step?.needsJon) return questNotice('NEEDS YOU', quest, [`${step.title}: ${noticeReason(stopCause(quest, step), 'a decision only the user can make')}`, needsLine(step), others], 'click to decide')
  return questNotice('BLOCKED', quest, [step ? `${step.title}: ${noticeReason(stopCause(quest, step), step.blocker?.requires ? 'it waits for its saved prerequisite' : NO_SAVED_REASON)}` : NO_BLOCKED_STEP, step && needsLine(step), others], 'click to resolve')
}

function doneNotice(quest: Quest, where: string): string {
  const result = questResult(quest)
  const text = [briefReason(result?.summary, 'Every step is done'), result?.howToUse, result?.where || where]
    .filter((part): part is string => !!part?.trim()).map(part => plainWords(part).replace(/[.!?]$/, '')).join('; ')
  return questNotice('DONE', quest, [sentence(text)], quest.state === 'Complete' ? 'click to see the result' : 'click to complete it')
}

export const GIVER_CHANGED_SETTLED = 'The Quest Giver changed while this run started. The step moved to the current Quest Giver and starts again on its own. No decision is needed.'
export const GIVER_STOPPED_SETTLED = 'The Quest Giver stopped this run itself, so it already knows; no notice is needed.'
export const GIVER_SAVED_SETTLED = 'The Quest Giver saved these blockers itself, so it already knows; no notice is needed.'

export const REFUSAL_REPLIED_SETTLED = 'The runtime refused this start and its caller got the refusal in its reply; no notice is needed.'
const REPLY_UNSETTLED = new Set(['DISPATCH_OUTCOME_UNKNOWN', 'DISPATCH_RESPONSE_FAILED'])

export function recordRefusalReplied(store: QuestStore, questID: string | undefined, error: unknown) {
  const { code, runID } = (error ?? {}) as { code?: unknown; runID?: unknown }
  if (!questID || typeof runID !== 'string' || typeof code !== 'string' || REPLY_UNSETTLED.has(code)) return
  try {
    const run = store.read(questID)?.sessions.find(row => runID === (row.runID ?? row.callID))
    if (run?.state !== 'failed') return
    if (!run.refusalReplied) store.apply(questID, 'session-state', { callID: run.callID, state: 'failed', preserveTerminal: true, refusalReplied: true }, 'quest:refusal-replied')
    const current = store.read(questID)
    if (current) recordHandoff(store, questID, [runKey(run), ...current.stages.filter(step => run.deliverables.includes(step.id) && step.status === 'blocked' && !step.needsJon).map(stepBlockerKey)], SAVED_BY_GIVER)
  } catch (failure) { console.error('[quests] refusal reply not recorded', questID, runID, failure) }
}

export function blockerWakeSettled(quest: Quest, run: QuestSession): string | undefined {
  if (refusedInReply(run)) return REFUSAL_REPLIED_SETTLED
  if (stoppedByGiver(run)) return GIVER_STOPPED_SETTLED
  if (waitingOnOwner(quest, run)) return `${ownerWait(quest)}; the saved owner must resolve the prerequisite before resuming`
  const steps = quest.stages.filter(step => run.deliverables.includes(step.id) && step.status !== 'done')
  const blocked = quest.stages.filter(step => step.status === 'blocked')
  if (blocked.length && blocked.every(step => savedByGiver(quest, step)) && steps.every(step => step.status === 'blocked')) return GIVER_SAVED_SETTLED
  if (steps.length && steps.every(step => step.status === 'blocked' && !step.needsJon && (ownedBlocker(step) || handoffsOf(quest)[stepBlockerKey(step)]))) return 'These blockers were already handed to their owners; no prerequisite has changed'
}

export function holdFor(quest: Quest, run: QuestSession, continuing: boolean): QuestSession | undefined {
  if (run.state !== 'completed') return
  const own = quest.stages.filter(step => run.deliverables.includes(step.id))
  if (!own.length || own.some(step => step.status !== 'done') || quest.stages.some(step => step.status === 'blocked')) return
  const dependents = quest.stages.filter(step => step.status === 'pending' && !isLandingStep(step) && step.needs.some(id => run.deliverables.includes(id)))
  if (dependents.length && !continuing) return
  return latestSessionAttempts(quest.sessions).find(other => runID(other) !== runID(run) && OWNED_RUN.has(other.state))
}

export function deliveredBefore(quest: Pick<Quest, 'delivered' | 'state' | 'archive'>, run?: QuestSession): boolean {
  if (!quest.delivered && quest.state !== 'Complete' && quest.state !== 'Archived') return false
  const at = quest.delivered?.at ?? quest.archive?.at
  return !run || !at || run.updatedAt >= at
}

export const DELIVERED_SETTLED = 'The Quest was already delivered; a run that ended after delivery changes nothing.'
export const stoppedAfterDone = (quest: Pick<Quest, 'stages'>, run: QuestSession) => stoppedOnPurpose(run) && savedItsSteps(quest, run)
export const STOPPED_AFTER_DONE_SETTLED = 'The Quest Giver stopped this run on purpose after its steps were saved done; no notice is needed.'

export function completionWake(quest: Quest, run: QuestSession, healing = false, earlier: QuestSession[] = []): Wake {
  const delivered = awaitingGotIt(quest) && savedItsSteps(quest, run)
  const turnedIn = delivered || quest.state === 'Archived' && quest.archive?.automatic === true && savedItsSteps(quest, run)
  if (quest.state === 'Archived' && !turnedIn) return { wake: false, settled: 'Quest archived before delivery; the result stays on the Quest' }
  if (!latestSessionAttempts(quest.sessions).some(row => runID(row) === runID(run)))
    return { wake: false, settled: 'A newer worker has taken over this work.' }
  if (!earlier.length && stoppedOnPurpose(run) && takenOverBy(quest.sessions, run))
    return { wake: false, settled: 'This run was stopped on purpose and a newer run of its step is already going; no notice is needed.' }
  if (!earlier.length && passingBindingChange(run) && takenOverBy(quest.sessions, run))
    return { wake: false, settled: 'The Git repository changed while this run started, and another run of its step is already going; no notice is needed.' }
  if (!delivered && [...earlier, run].every(row => row.state !== 'completed' && newerRunOn(quest, row)))
    return { wake: false, settled: NEWER_RUN_SETTLED }
  if (!earlier.length && frozenRun(run) && !delivered)
    return { wake: false, settled: 'The run froze, so the runtime stopped it and is starting the step again. No decision is needed.' }
  if (delivered) return { wake: true, text: doneNotice(quest, quest.delivered!.where) }
  if (turnedIn) return { wake: true, text: doneNotice(quest, quest.archive!.reason) }
  if (deliveredBefore(quest, run)) return { wake: false, settled: DELIVERED_SETTLED }
  if ([...earlier, run].every(row => stoppedAfterDone(quest, row)))
    return { wake: false, settled: STOPPED_AFTER_DONE_SETTLED }
  const settled = [...earlier, run].map(row => blockerWakeSettled(quest, row))
  if (settled.every(Boolean)) return { wake: false, settled: settled.join('; ') }
  const failure = `${run.result ?? ''} ${run.evidence.at(-1) ?? ''}`
  if (!earlier.length && run.state === 'failed' && CAPACITY_FAILURE.test(failure) && reDispatched(quest, run))
    return { wake: false, settled: 'The model was unavailable, so the runtime already started these steps again. No decision is needed.' }
  if (!earlier.length && giverChangedAtStart(run) && (healing || reDispatched(quest, run)))
    return { wake: false, settled: GIVER_CHANGED_SETTLED }
  if (!earlier.length && healing && lostToInfrastructure(run))
    return { wake: false, settled: 'The worker lost its connection or checkout. The runtime is starting the step again.' }
  if (!earlier.length && healing && reworkRequested(quest, run))
    return { wake: false, settled: 'The checks sent the step back. The runtime is starting it again.' }
  const unconfirmed = run.evidence.at(-1)
  if (run.state === 'failed' && unconfirmed && READY_AGAIN.has(unconfirmed)) {
    const steps = quest.stages.filter(step => run.deliverables.includes(step.id))
    if (steps.length && steps.every(step => step.status === 'pending'))
      return { wake: false, settled: `${unconfirmed} The step is ready again and starts on its own. No decision is needed.` }
  }
  if (run.state !== 'completed') return { wake: true, text: questNotice('STOPPED', quest, [noticeReason(runCause(run), 'the worker stopped before finishing')], 'click to resolve') }
  const blocked = quest.stages.filter(step => step.status === 'blocked')
  if (blocked.length) return { wake: true, text: blockedNotice(quest, blocked) }
  const owned = latestSessionAttempts(quest.sessions).some(other => runID(other) !== runID(run) && OWNED_RUN.has(other.state))
  const pending = quest.stages.filter(step => step.status === 'pending' && !isLandingStep(step))
  const returned = [...earlier, run].flatMap(row => row.deliverables).flatMap(id => quest.stages.find(step => step.id === id && step.status === 'done') ?? [])
  const finished = returned.map(step => `${step.title}: ${noticeReason(step.note, 'done')}`)
  if (pending.length && !owned) return { wake: true, text: questNotice('BLOCKED', quest, [...finished, `${pending.length} step${pending.length === 1 ? ' is' : 's are'} not running: next "${pending[0].title}"`, 'Needs: a worker dispatched to it'], 'click to resolve') }
  if (!pending.length && !owned && landingDone(quest.stages)) return { wake: false, settled: LANDED_SETTLED }
  if (!pending.length && !owned) return { wake: true, text: questNotice('BLOCKED', quest, [...finished, 'every step is done but the result was not delivered', `Needs: ${landingLine(quest, run) ?? 'the landing to be repeated'}`], 'click to resolve') }
  if (holdFor(quest, run, healing)) return { wake: true, text: questNotice('BLOCKED', quest, [...finished, STILL_RUNNING], 'click to resolve') }
  return { wake: false, settled: 'The remaining steps are still running and the Quest waits on them, so no notice is needed until they end.' }
}

export const stopReasonOf = (text: string): string | undefined => noticeKindOf(text) === 'STOPPED' ? text.split('\n')[1]?.trim() || undefined : undefined

export function groupedStopNotice(notices: { title: string; text: string }[]): string {
  const reason = stopReasonOf(notices[0].text) ?? ''
  const titles = [...new Set(notices.map(row => `"${plainWords(row.title)}"`))]
  const extra = [...new Set(notices.flatMap(row => row.text.split('\n').slice(3)).filter(line => line.trim()))]
  const named = titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles.join('')
  return [`QUEST STOPPED ${named}`, `${titles.length} Quests stopped for the same reason: ${reason}`, '(click to resolve)', ...extra].join('\n')
}

export function handoffNoticeOf(quest: Quest, again = false): { text: string; stepIDs: string[] } {
  const blocked = quest.stages.filter(step => step.status === 'blocked' && !step.needsJon && !ownedBlocker(step) && (again || !handoffsOf(quest)[stepBlockerKey(step)]))
  if (blocked.length) return { text: blockedNotice(quest, blocked), stepIDs: blocked.map(step => step.id) }
  const unfinished = quest.stages.filter(step => step.status !== 'done')
  const ended = latestSessionAttempts(quest.sessions).filter(run => TERMINAL_RUN.has(run.state) && !stoppedByGiver(run) && !refusedInReply(run) && unfinished.some(step => run.deliverables.includes(step.id)))
  const run = ended.at(-1)
  if (!run) return { text: blockedNotice(quest, blocked), stepIDs: [] }
  const steps = unfinished.filter(step => ended.some(row => row.deliverables.includes(step.id)))
  return { text: questNotice('STOPPED', quest, [`${steps.map(step => step.title).join(', ')}: ${noticeReason(runCause(run), 'the worker stopped before finishing')}`, 'Needs: a worker started again'], 'click to resolve'), stepIDs: steps.map(step => step.id) }
}

export function attentionNotice(quest: Quest, run: QuestSession, undelivered?: string): string {
  const why = noticeReason(runCause(run), 'the last worker ended')
  return undelivered
    ? questNotice('BLOCKED', quest, ['every step is done but the result was not delivered', `Needs: ${noteReason(undelivered)}`], 'click to resolve')
    : questNotice('STOPPED', quest, [why, 'Needs: a worker started again'], 'click to resolve')
}

export type PendingRequest = { id?: string; action?: unknown; resources?: unknown }

export function permissionAsk(request: PendingRequest, source?: string): string {
  const action = String(request.action ?? 'permission')
  let tool: unknown, input: Record<string, unknown> = {}
  try { const parsed = JSON.parse(source ?? ''); tool = parsed?.tool; if (parsed?.input && typeof parsed.input === 'object') input = parsed.input }
  catch {}
  const text = (key: string) => typeof input[key] === 'string' ? input[key] as string : undefined
  const command = text('command')
  const target = command ? command + (text('workdir') ? ` (in ${text('workdir')})` : '') : text('filePath') ?? text('path') ?? text('pattern') ?? text('url')
  const resources = (Array.isArray(request.resources) ? request.resources : []).map(String).filter(Boolean)
  const detail = target ?? resources.join(', ')
  return `${typeof tool === 'string' && tool ? tool : action}${detail ? ' ' + detail : ''} (${action} permission)`
}

export function permissionWake(quest: Quest, request: PendingRequest, ask: string, reason: string | undefined, notified: Record<string, string> = {}): Wake {
  const id = typeof request.id === 'string' ? request.id : ''
  if (!id) return { wake: false, settled: 'The owning host reported a pending request with no identity; nothing to ask about' }
  if (notified[id]) return { wake: false, settled: 'Already asked about this request; a repeat says nothing new' }
  return { wake: true, text: questNotice('NEEDS YOU', quest, [`Allow or reject: ${ask}`, reason ? noteReason(reason) : undefined], 'click to allow or reject') }
}

export type CauseClaim = { key: string; questIDs: string[] }
export type NoticeGate = { send: true; slot: NoticeSlot; text?: string; cause?: CauseClaim } | { send: false; settled: string }

export function reloadFailureCause(quest: Pick<Quest, 'stages' | 'archive' | 'delivered' | 'state'>): string | undefined {
  if (quest.archive || quest.delivered || quest.state === 'Archived') return
  const blocked = quest.stages.filter(step => step.status === 'blocked')
  const step = blocked.length === 1 && isLandingStep(blocked[0]) ? blocked[0] : undefined
  return step && !step.needsJon && step.note?.startsWith(RELOAD_FAILED_NOTE) ? step.note : undefined
}

export const RELOAD_ONCE = 'Fix the cause and reload the services at the merged revision once, then set the landing step of each Quest listed pending with resolution evidence.'
export const RELOAD_CAUSE_SETTLED = 'One notice already named this reload failure and listed this Quest, so no second notice is sent.'

export function reloadCauseNotice(cause: string, quests: Pick<Quest, 'title'>[]): string {
  const titles = [...new Set(quests.map(quest => `"${plainWords(quest.title)}"`))]
  const named = titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles.join('')
  const count = titles.length === 1 ? '1 Quest is' : `${titles.length} Quests are`
  return [`QUEST BLOCKED ${named}`, [`${count} blocked by one reload failure: ${noticeReason(cause)}`, `Needs: ${RELOAD_ONCE} (Quest Giver)`].map(line => plainWords(line)).join(' '), '(click to resolve)'].join('\n')
}

function reloadCauseGate(runtime: string, quest: Quest, cause: string, peers: () => Quest[]): NoticeGate {
  const key = causeKey(cause), slot: NoticeSlot = { questID: quest.id, stepIDs: [LANDING_STEP_ID], kind: 'BLOCKED' }
  const sameCause = (other: Quest) => { const own = reloadFailureCause(other); return !!own && causeKey(own) === key }
  const sharing = [quest, ...peers().filter(other => other.id !== quest.id && sameCause(other))]
  const added = claimCause(runtime, key, cause, sharing.map(other => other.id))
  if (!added.includes(quest.id)) return { send: false, settled: RELOAD_CAUSE_SETTLED }
  return { send: true, slot, text: reloadCauseNotice(cause, sharing.filter(other => added.includes(other.id))), cause: { key, questIDs: added } }
}

export function causeNotDelivered(runtime: string, gate: NoticeGate) {
  if (gate.send && gate.cause) releaseCause(runtime, gate.cause.key, gate.cause.questIDs)
}

export function causeDelivered(store: QuestStore, gate: NoticeGate, via: HandoffVia) {
  if (!gate.send || !gate.cause) return
  for (const id of gate.cause.questIDs) {
    if (id === gate.slot.questID) continue
    try { const other = store.read(id); if (other) recordHandoff(store, id, giverBlockers(other), via) }
    catch (error) { console.error('[quests] hand-off not recorded', id, error) }
  }
}

export function noticeGate(runtime: string, quest: Quest, stepIDs: string[], text: string, run?: QuestSession, peers?: () => Quest[], again = false): NoticeGate {
  const kind = noticeKindOf(text)
  if (again) noticeCleared(runtime, { questID: quest.id, stepIDs, kind })
  if ((kind === 'BLOCKED' || kind === 'STOPPED') && deliveredBefore(quest, run)) return { send: false, settled: DELIVERED_SETTLED }
  const cause = (kind === 'BLOCKED' || kind === 'STOPPED') && peers ? reloadFailureCause(quest) : undefined
  if (cause) return reloadCauseGate(runtime, quest, cause, peers!)
  if (!noticeHasReason(text)) return { send: false, settled: 'No reason was saved for the blocked step, so the notice was held until the runtime records what stopped it.' }
  const slot: NoticeSlot = { questID: quest.id, stepIDs, kind }
  const due = noticeDue(runtime, slot, text, quest)
  return due.send ? { send: true, slot } : { send: false, settled: `The same ${kind} notice was already sent for this unchanged state; repeat ${due.suppressed} suppressed.` }
}

export function saveStopCauses(store: QuestStore, quest: Quest): Quest {
  let current = quest
  for (const step of quest.stages) {
    if (step.status !== 'blocked' || step.note?.trim()) continue
    const cause = stopCause(current, step)
    if (!cause) continue
    current = store.apply(quest.id, 'stage-state', { stageID: step.id, status: 'blocked', evidence: sentence('Stopped: ' + plainWords(cause)), ...(step.needsJon ? { needsJon: step.needsJon } : {}) }, 'quest:stop-cause')
  }
  return current
}
