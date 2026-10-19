import { savedProfile } from '../../models/work-profile'
import { warningEmitter, warningRow } from './warnings'
import { findingsOf } from './findings'
import { questReference } from '../core/references'
import { landingLine } from '../workers/completion-return'
import { questPullRequests } from './detail-evidence'
import { compactQuestSummary } from '../workers/context'
import { questWorkflow } from '../runs/workflow'
import { observationFromActivity, withQuestActivity, questActivity, type ActivitySnapshot } from './activity'
import { questCounts, questTruth, type AdmissionRecords } from '../runs/reachability'
import { questReport } from './quest-report'
import { resultCard } from './result-card'
import { frozenRun, latestSessionAttempts, nativeRunID } from '../runs/session-lineage'
import { runReviews } from '../review/review-record'
import { branchCounts } from '../landing/branch-outcomes'
import type { Quest, QuestSession } from '../types'

const active = (run: QuestSession) => ['planned', 'executing', 'waiting', 'blocked'].includes(run.state)
const outcome = (run: QuestSession) => ({
  runID: run.sessionRef ?? run.runID ?? run.callID, sessionRef: run.sessionRef, sessionTitle: run.sessionTitle, sessionID: run.openCodeSessionId ?? run.sessionID,
  state: run.state, model: run.model, reasoning: run.reasoningEffort, steps: run.deliverables, ...(run.permissionDecisions?.length ? { permissions: run.permissionDecisions.length } : {}),
  result: run.result ?? run.evidence.at(-1), updatedAt: run.updatedAt,
})

export function questBranch(q: Quest, sessions = q.sessions): string | undefined {
  const attempts = [...latestSessionAttempts(sessions)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  for (const run of attempts) {
    const scope = run.scope as { branch?: unknown } | undefined
    const branch = (typeof scope?.branch === 'string' && scope.branch.trim()) || run.branch
    if (branch) return branch.trim()
  }
  return undefined
}

export function stepGaps(q: Quest, stepID: string): string[] {
  const latest = Object.values(runReviews(q)).filter(review => review.stepIDs.includes(stepID) && review.verdict !== 'cannot tell').sort((a, b) => b.at.localeCompare(a.at))[0]
  return latest?.verdict === 'rework' ? (latest.gaps?.length ? latest.gaps.map(gap => gap.action) : latest.reasons) : []
}

function sentBack(q: Quest) {
  return q.stages.filter(step => step.status !== 'done').flatMap(step => { const gaps = stepGaps(q, step.id); return gaps.length ? [{ step: step.title, gaps }] : [] })
}

export function toolSummary(q: Quest) {
  const attention = latestSessionAttempts(q.sessions).reduce((counts, run) => {
    if (frozenRun(run)) return counts
    if (run.state === 'stale' || run.state === 'failed' || run.state === 'cancelled' || run.state === 'missing' || run.state === 'blocked') counts[run.state]++
    return counts
  }, { stale: 0, failed: 0, cancelled: 0, missing: 0, blocked: 0 })
  const branch = questBranch(q)
  const landed = Object.entries((q.extensions.landings ?? {}) as Record<string, { at?: string }>).sort((a, b) => String(b[1]?.at).localeCompare(String(a[1]?.at)))[0]
  const delivered = landed && landingLine(q, q.sessions.find(run => (run.runID ?? run.callID) === landed[0]))
  const card = resultCard(q)
  const referenceIssues = (q.unresolvedWork ?? []).filter(issue => issue.startsWith('Invalid readable session reference for call '))
  const returned = sentBack(q)
  const branches = branchCounts(q)
  const warned = warningEmitter().list().filter(warning => warning.quest === q.id)
  const startedAt = [...q.sessions.flatMap(run => run.startedAt ? [run.startedAt] : []), ...q.history.filter(event => event.type === 'session-bound').map(event => event.at)].filter(at => Number.isFinite(Date.parse(at))).sort()[0]
  return { ...compactQuestSummary(q), title: q.title, revision: q.revision, project: q.project, ...(startedAt ? { startedAt } : {}),
    ...(referenceIssues.length ? { referenceIssues } : {}),
    ...(q.extensions.prOwner ? { prOwner: q.extensions.prOwner } : {}),
    ...(branch ? { branch } : {}),
    ...(delivered ? { delivered } : {}),
    ...(card ? { result: card } : {}),
    ...(returned.length ? { sentBack: returned } : {}),
    progress: { done: q.stages.filter(s => s.status === 'done').length, total: q.stages.length },
    ...(branches ? { branches } : {}),
    ...(warned.length ? { warnings: warned.map(warning => warningRow(warning, Date.now())) } : {}),
    ...(findingsOf(q).length ? { findings: findingsOf(q) } : {}),
    attention,
  }
}

export function toolStatus(q: Quest) {
  return { ...toolSummary(q), steps: q.stages.map(step => ({ id: step.id, state: step.status, ...(step.deferred ? { deferred: step.deferred.until } : {}) })),
    runs: q.sessions.filter(active).map(run => ({ runID: run.sessionRef ?? run.runID ?? run.callID, sessionRef: run.sessionRef, sessionTitle: run.sessionTitle, sessionID: run.openCodeSessionId ?? run.sessionID, state: run.state, model: run.model, reasoning: run.reasoningEffort })) }
}

export function toolAdmission(q: Quest, start?: unknown, confirmation?: unknown) {
  const admission=start as {state?:string;reason?:string}|undefined
  const execution=confirmation as {executionConfirmed?:boolean}|undefined
  const waiting=!execution?.executionConfirmed&&admission?.reason&&['waiting','failed','unknown','stopped'].includes(admission.state??'')
  return { ...toolStatus(q), ...(start ? { start } : {}), ...(confirmation ? { confirmation:waiting?{...execution,reason:admission.reason,state:admission.state}:confirmation } : {}) }
}

export function dispatchConfirmation(q: Quest, activity: ActivitySnapshot, runID?: string) {
  const activityRows = questActivity(q, activity).runs
  const target = runID ? q.sessions.find(run => run.runID === runID || run.callID === runID || run.sessionRef === runID || nativeRunID(run) === runID) : undefined
  const identities = new Set([runID, target?.sessionRef, target && nativeRunID(target)].filter(Boolean))
  const rows = activityRows.filter(row => !runID || identities.has(row.runID) || identities.has(row.sessionRef) || identities.has(row.sessionID))
  const confirmed = rows.some(row => row.confirmed)
  const row = rows.find(row => row.confirmed) ?? rows.at(-1)
  return {
    admitted: true,
    executionConfirmed: confirmed,
    ...(row ? { runID: row.runID } : {}),
    ...(row?.sessionID ? { sessionID: row.sessionID } : {}),
    ...(row ? { state: row.state } : {}),
    reason: confirmed
      ? 'The owning host is running it.'
      : 'Saved; the owning host does not yet confirm it running. Its return arrives on its own, so do not dispatch again.',
  }
}

export function leanAdmission(value: any) {
  const continuation = value?.continuation
  const result=value?.result&&typeof value.result==='object'?value.result:undefined
  const reason = value?.error ?? result?.reason ?? (typeof value?.result==='string'?value.result:undefined) ?? continuation?.reason
  const runID = continuation?.runID ?? result?.runID ?? value?.runID
  const sessionID = continuation?.sessionID ?? result?.sessionID ?? value?.sessionID
  return {
    state: continuation?.state ?? result?.state ?? value?.state,
    ...(value?.requestID ? { requestID: value.requestID } : {}),
    ...(continuation?.id ?? result?.continuationID ?? value?.continuationID ? { continuationID: continuation?.id ?? result?.continuationID ?? value.continuationID } : {}),
    ...(runID ? { runID } : {}), ...(sessionID ? { sessionID } : {}),
    ...(reason ? { reason: String(reason) } : {}),
  }
}

export function toolPlan(q: Quest, continuations: any[] = []) {
  const detail = toolDetail(q, continuations)
  return { ...toolSummary(q), description: detail.description, workflow: detail.workflow,
    steps: detail.steps.map(({ note, runs, lastOutcome, checks, ...step }) => step), continuation: detail.continuation }
}

export function toolMutation(q: Quest, update: any) {
  const stepIDs = new Set((update?.steps ?? []).map((step: any) => step.id))
  const saved = Object.fromEntries(Object.keys(update ?? {}).flatMap(key => {
    if (key === 'steps' || key === 'artifacts') return []
    if (key === 'title' || key === 'description' || key === 'reward') return [[key, 'saved']]
    if (key === 'workflow') return [[key, questWorkflow(q)]]
    if (key === 'projectRoot') return [[key, q.project?.root]]
    if (key === 'archive') return [[key, q.archive ?? null]]
    return [[key, (q as any)[key]]]
  }))
  return {
    id: questReference(q), revision: q.revision,
    saved,
    steps: q.stages.filter(step => stepIDs.has(step.id)).map(step => ({
      id: step.id, state: step.status,
      saved: Object.keys(update.steps.find((input: any) => input.id === step.id) ?? {}).filter(key => key !== 'id'),
      ...(step.needsJon ? { needsJon: step.needsJon } : {}), ...(step.blocker ? { blocker: step.blocker } : {}), ...(step.resolution ? { resolution: step.resolution } : {}),
    })),
    ...(update?.artifacts === undefined ? {} : { artifacts: { count: q.evidence.artifacts.length } }),
  }
}

export function toolDetail(q: Quest, continuations: any[] = []) {
  const queued = continuations.filter(c => !['done', 'stopped'].includes(c.state))
  return {
    ...toolSummary(q), description: q.description || q.objective, reward: q.reward, workflow: questWorkflow(q),
    steps: q.stages.map(step => {
      const runs = q.sessions.filter(run => run.deliverables.includes(step.id))
      const owners = runs.filter(active)
      const latest = runs.at(-1)
      const dependencies = step.needs.filter(id => q.stages.find(s => s.id === id)?.status !== 'done')
      const continuation = queued.find(c => c.steps?.some((s: any) => s.id === step.id))
      const reason = step.status === 'done' ? 'Already done' : step.deferred ? (step.deferred.until === 'jon' ? 'Deferred until the user asks' : 'Deferred until the current steps are done') : owners.length ? 'Owned by an active or unconfirmed run'
        : continuation ? 'Owned by a continuation' : dependencies.length ? 'Dependencies unfinished'
        : step.blocker ? step.blocker.owner + ': ' + step.blocker.requires : step.status !== 'pending' ? 'Review the saved note and outcome before returning this step to pending' : undefined
      return { id: step.id, title: step.title, state: step.status, ...(step.needsJon ? { needsJon: step.needsJon } : {}), ...(step.deferred ? { deferred: step.deferred } : {}), detail: step.detail, note: step.note, blocker: step.blocker, resolution: step.resolution, commandID: step.commandID, ...savedProfile(step), ...(step.attempts !== undefined ? { attempts: step.attempts } : {}),
        ...(stepGaps(q, step.id).length ? { gaps: stepGaps(q, step.id) } : {}),
        needs: step.needs, ready: !reason, blockedBy: reason, checks: q.evidence.tests.filter(check => check.stepID === step.id),
        runs: owners.map(outcome), lastOutcome: latest ? outcome(latest) : undefined }
    }),
    continuation: continuations.map(c => ({ id: c.id, state: c.state, reason: c.reason,
      stepIDs: c.steps?.map((s: any) => s.id), model: c.model })),
    artifacts: q.evidence.artifacts, pullRequests: questPullRequests(q),
  }
}

export function toolSection(value: unknown, section: string, offset = 0, limit = 8000) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid detail pagination')
  if (!Array.isArray(value)) {
    if (offset) throw new Error('This section is one value; omit offset')
    return { section, data: value ?? null, nextOffset: null }
  }
  const data: unknown[] = []
  let size = 2
  for (const item of value.slice(offset)) {
    const length = JSON.stringify(item).length + 1
    if (data.length && size + length > limit) break
    data.push(item); size += length
  }
  return { section, offset, totalItems: value.length, data,
    nextOffset: offset + data.length < value.length ? offset + data.length : null }
}

export function questListResult(
  result: { diagnostics: string[]; items: any[]; records: Quest[]; page: Quest[]; scope: string; total: number; nextOffset: number | null },
  activity: ActivitySnapshot,
  project: (item: any) => any,
  view?: string,
  records?: AdmissionRecords,
) {
  const observation = observationFromActivity(activity)
  const truths = result.records.map(q => questTruth(q, observation, records))
  const byID = new Map(truths.flatMap(truth => [[truth.quest.id, truth], [questReference(truth.quest), truth]] as const))
  const page = result.page.flatMap(q => byID.get(q.id) ?? [])
  return {
    diagnostics: result.diagnostics.slice(0, 10),
    items: result.items.map(item => withQuestActivity(byID.get(item.id)!.quest, project(item), activity, records)),
    scope: result.scope, counts: questCounts(truths),
    ...(view === 'report' ? { report: questReport(page, truths, result.scope) } : {}),
    total: result.total, nextOffset: result.nextOffset,
  }
}

const zero = (value: unknown) => !!value && typeof value === 'object' && Object.values(value).every(count => count === 0)
const empty = (value: unknown) => Array.isArray(value) && !value.length

function agentActivity(activity: any) {
  const { sessionReferences: _references, sessions: _sessions, checkedAt: _checkedAt, history: _history, ...rest } = activity
  if (empty(rest.runs)) delete rest.runs
  if (empty(rest.preparing)) delete rest.preparing
  if (empty(rest.currentSteps)) delete rest.currentSteps
  if (!rest.running && !rest.unconfirmed && !rest.assigned) { delete rest.running; delete rest.unconfirmed; delete rest.assigned }
  return Object.keys(rest).length ? rest : undefined
}

const ADMISSION_RESTATED = new Set(['stage', 'nextAction', 'progress', 'group', 'revision', 'updatedAt', 'project'])

export function agentView(value: any, parent?: any): any {
  if (Array.isArray(value)) return value.map(item => agentView(item, parent))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  const admission = value.confirmation !== null && typeof value.confirmation === 'object'
  for (const [key, entry] of Object.entries(value)) {
    if (admission && ADMISSION_RESTATED.has(key)) continue
    if (key === 'activity' && entry && typeof entry === 'object' && !Array.isArray(entry)) { const lean = agentActivity(agentView(entry)); if (lean) out[key] = lean; continue }
    if (key === 'ref' && entry === value.id) continue
    if (key === 'project' && entry && typeof entry === 'object' && typeof (entry as any).root === 'string') { const { id: _, ...rest } = entry as any; out[key] = rest; continue }
    if (key === 'items' && value.report !== undefined) continue
    if ((key === 'sessionRef' || key === 'sessionID') && value.runID !== undefined && entry === value.runID) continue
    if (key === 'attention' && zero(entry)) continue
    if (key === 'recordedState' && entry === value.state) continue
    if (key === 'recordedExecuting' && entry === value.running) continue
    if ((key === 'ready' || key === 'blockedBy') && value.state === 'done' && value.blockedBy === 'Already done') continue
    if (key === 'stepID' && parent?.id !== undefined && entry === parent.id && value.command !== undefined) continue
    if ((key === 'runs' || key === 'needs' || key === 'checks') && empty(entry) && value.state !== undefined && value.id !== undefined) continue
    out[key] = agentView(entry, value)
  }
  return out
}
