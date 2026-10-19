import { existsSync } from 'node:fs'
import { collectReviewEvidence, type EvidenceCheck, type EvidenceSources, type ReviewEvidence } from './review-evidence'
import { runReview, priorReworks, slimReview, type ReviewCheck, type ReviewJudgment, type ReviewVerdict, type ReviewVerification, type RunReview } from './review-record'
import { waterfallSources } from '../bench/quest-waterfall'
import { removalGaps } from './review-removals'
import { commandRun, driveAsync } from '../landing/git-steps'
import { bootstrapStepTimeout, bootstrapWorkspacePath } from '../checkouts/workspace-bootstrap'
import { amendContinuationStep } from '../runs/continuation'
import { questReference } from '../core/references'
import { redact } from '../privacy'
import type { QuestStore } from '../store'
import type { QuestWorkspaces, Workspace } from '../workspaces'
import type { Quest, QuestSession } from '../types'
import { now as spanNow, recordSpan } from '../../scripts/plugin-spans'

const CHECKS = 'checks'
const runKey = (run: QuestSession) => run.runID ?? run.callID
const productionDependencies = { sources: (): EvidenceSources => ({ hostDB: waterfallSources().hostDB }) }
export type ReviewDependencies = typeof productionDependencies

async function runCheck(path: string, check: EvidenceCheck): Promise<ReviewCheck> {
  const step = { argv: check.argv, description: 'project check', ...(check.cwd ? { cwd: check.cwd } : {}), ...(check.timeoutMilliseconds ? { timeoutMilliseconds: check.timeoutMilliseconds } : {}) }
  const result = await driveAsync(commandRun(bootstrapWorkspacePath(path, step), check.argv, bootstrapStepTimeout(step), check.shell))
  return { command: check.command, exitCode: Number.isInteger(result.status) ? result.status : null, source: 'reviewer run' }
}

function verificationRows(quest: Quest, evidence: ReviewEvidence, check: ReviewCheck | undefined, passingOnly: boolean): ReviewVerification[] {
  const rows: ReviewVerification[] = []
  if (check && check.exitCode !== null) rows.push({ command: check.command, exitCode: check.exitCode, artifact: check.source })
  const latest = new Map<string, ReviewEvidence['verification'][number]>()
  for (const row of evidence.verification) latest.set((row.stepID ?? '') + '\0' + row.command, row)
  for (const row of latest.values()) if (row.exitCode !== null && (!passingOnly || row.exitCode === 0) && !rows.some(other => other.command === row.command && other.exitCode === row.exitCode))
    rows.push({ command: row.command, exitCode: row.exitCode, artifact: row.artifact ?? 'Quest ' + questReference(quest) + ' step ' + (row.stepID ?? '') + ' report' })
  return rows
}

function findings(evidence: ReviewEvidence, check: ReviewCheck | undefined): string[] {
  return [
    ...(check && check.exitCode !== 0 ? ['the project check `' + check.command + '` ' + (check.exitCode === null ? 'did not finish' : 'exited ' + check.exitCode) + ' on the final tree'] : []),
    ...evidence.undone.map(row => 'left undone on ' + row.stepID + ' (' + row.state + ')' + (row.note ? ': ' + redact(row.note, 300) : '')),
    ...[...new Map(evidence.verification.map(row => [(row.stepID ?? '') + '\0' + row.command, row])).values()].filter(row => row.exitCode !== null && row.exitCode !== 0).map(row => 'the worker recorded `' + row.command + '` exiting ' + row.exitCode),
  ]
}

export function saveReview(store: QuestStore, questID: string, review: RunReview) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = store.read(questID)
    if (!current) return
    try { store.apply(questID, 'patched', { extensions: { ...current.extensions, reviews: { ...(current.extensions.reviews as Record<string, RunReview> ?? {}), [review.runID]: slimReview(review) } } }, 'quest:reviewer', { expectedRevision: current.revision }); break }
    catch (error) { if (attempt === 2) throw error }
  }
}

function sendBack(store: QuestStore, quest: Quest, run: QuestSession, review: RunReview, who = 'the checks') {
  const runID = runKey(run), reasons = review.reasons.join('; ')
  const prior = priorReworks(quest, runID, run.deliverables)
  if (prior.length) {
    const attempts = [...new Set([...prior.map(row => row.branch), review.branch].filter(Boolean))].join(' and ')
    const gaps = review.gaps?.length ? review.gaps : review.reasons.map(reason => ({ asked: '', missing: reason, action: reason, kind: 'missing' as const }))
    const missing = gaps.filter(gap => gap.kind === 'missing'), wrong = gaps.filter(gap => gap.kind === 'wrong')
    const stages = structuredClone(quest.stages), taken = new Set(stages.map(step => step.id)), added: typeof stages = []
    const Who = who[0].toUpperCase() + who.slice(1)
    for (const step of stages) if (run.deliverables.includes(step.id)) {
      delete step.resolution
      if (missing.length) {
        const ids = missing.map((gap, index) => {
          let id = step.id + '-gap-' + (index + 1), n = 1
          while (taken.has(id)) id = step.id + '-gap-' + (index + 1) + '-' + ++n
          taken.add(id)
          const base = review.branch ? ' Build on branch ' + review.branch + (review.workspace ? ' (checkout ' + review.workspace + ')' : '') + ', which holds what was delivered so far.' : ''
          added.push({ id, title: gap.action, detail: gap.action + '.' + (gap.asked ? ' The message asks: "' + gap.asked + '".' : '') + ' Missing from the result: ' + gap.missing + '.' + base, status: 'pending', needs: [], todos: [], claim: structuredClone(step.claim), proofs: [], attempt: 0, ...(step.depth ? { depth: step.depth } : {}), ...(step.workType ? { workType: step.workType } : {}) })
          return id
        })
        for (const other of stages) if (other.needs.includes(step.id)) other.needs = [...new Set([...other.needs, ...ids])]
      }
      if (wrong.length) {
        step.status = 'blocked'
        step.note = Who + ' sent this step back a second time: ' + wrong.map(gap => gap.removal ? gap.missing : gap.action + ' (' + gap.missing + ')').join('; ') + '. The earlier attempts are on ' + attempts + '.' + (missing.length ? ' The missing parts are new steps.' : '')
        step.blocker = { kind: 'work', owner: 'Quest Giver', requires: wrong.every(gap => gap.removal) ? wrong.map(gap => gap.action).join('; ') : 'Decide how to finish this step: ' + wrong.map(gap => gap.removal ? gap.action : gap.action + (gap.asked ? ' (the message asks: "' + gap.asked + '")' : '')).join('; ') }
      } else if (missing.length) {
        step.status = 'done'
        delete step.blocker
        step.note = 'Delivered partly. The missing parts are new steps.'
      } else {
        step.status = 'blocked'
        step.note = Who + ' sent this step back a second time with no gap named. The earlier attempts are on ' + attempts + '.'
        step.blocker = { kind: 'work', owner: 'Quest Giver', requires: 'Decide how to finish this step: no gap was named' }
      }
    }
    store.apply(quest.id, 'patched', { stages: [...stages, ...added] }, 'quest:reviewer')
    return false
  }
  const where = review.branch ? ' The attempt is on branch ' + review.branch + (review.workspace ? ' (checkout ' + review.workspace + ')' : '') + '; build on it, or start clean if it misleads.' : ''
  const block = 'Sent back by ' + who + ' after run ' + runID + ': ' + reasons + '.' + where
  const stages = structuredClone(quest.stages), results = structuredClone((quest.extensions.stepResults ?? {}) as Record<string, { runIDs: string[]; state: string; recordedAt: string }>)
  for (const step of stages) if (run.deliverables.includes(step.id)) {
    step.detail = step.detail?.trim() ? step.detail.trim() + '\n\n' + block : block
    results[step.id] = { ...results[step.id], runIDs: [...new Set([...(results[step.id]?.runIDs ?? []), runID])], state: 'pending', recordedAt: review.at }
  }
  store.apply(quest.id, 'patched', { stages, extensions: { ...quest.extensions, stepResults: results } }, 'quest:reviewer')
  for (const step of stages.filter(step => run.deliverables.includes(step.id))) {
    store.apply(quest.id, 'proof-added', { stageID: step.id, proof: { id: 'review-' + runID + '-' + step.id, kind: 'judgment', at: review.at, attempt: step.attempt, verdict: 'FAIL', reason: redact(reasons, 2000) } }, 'quest:reviewer')
    amendContinuationStep(store.runtime, quest.id, step.id, step.detail)
  }
  return true
}

function record(store: QuestStore, quest: Quest, run: QuestSession, review: RunReview): RunReview {
  if (review.verdict === 'rework') review = { ...review, redispatched: false }
  saveReview(store, quest.id, review)
  if (review.verdict === 'rework') {
    const fresh = store.read(quest.id) ?? quest, redispatched = sendBack(store, fresh, run, review)
    if (redispatched) { review = { ...review, redispatched }; saveReview(store, quest.id, review) }
  }
  const said = (review.verdict === 'rework' ? 'The checks sent it back' : review.verdict === 'pass' ? 'The checks passed it' : 'The checks could not tell') + (review.reasons.length ? ': ' + review.reasons.join('; ') : '') + (review.why ? ' (' + review.why + ')' : '')
  const current = store.read(quest.id)?.sessions.find(row => row.callID === run.callID)
  if (current) store.apply(quest.id, 'session-state', { callID: run.callID, state: current.state, preserveTerminal: true, evidence: redact(said, 2000) }, 'quest:reviewer')
  return review
}

export function reworkRun(store: QuestStore, questID: string, review: RunReview, who: string): RunReview {
  const quest = store.read(questID), run = quest?.sessions.find(row => runKey(row) === review.runID)
  if (!quest || !run) return review
  saveReview(store, questID, { ...review, verdict: 'rework', redispatched: false })
  const redispatched = sendBack(store, store.read(questID) ?? quest, run, review, who)
  const saved = { ...review, verdict: 'rework' as const, redispatched }
  saveReview(store, questID, saved)
  return saved
}

export type ReviewSubject = { quest: Quest; run: QuestSession; workspace: Workspace | undefined; existing: RunReview | undefined; keep: (review: RunReview) => RunReview }
export async function reviewFinishedRun(store: QuestStore, questID: string, runID: string, workspaces: QuestWorkspaces, dependencies: Partial<ReviewDependencies> = {}, subject?: ReviewSubject): Promise<RunReview | undefined> {
  const start = spanNow()
  let outcome = 'skipped'
  try {
    const deps = { ...productionDependencies, ...dependencies }
    const quest = subject?.quest ?? store.read(questID), run = subject?.run ?? quest?.sessions.find(row => runKey(row) === runID)
    if (!quest || !run || run.agentRole === 'command' || run.scope?.readOnly === true) return
    const existing = subject ? subject.existing : runReview(quest, runID)
    if (existing) return existing
    const save = subject?.keep ?? ((review: RunReview) => record(store, store.read(questID) ?? quest, run, review))
    const keep = (review: RunReview) => { const saved = save(review); outcome = saved.verdict; return saved }
    const at = () => new Date().toISOString()
    const cannotTell = (why: string) => keep({ runID, at: at(), verdict: 'cannot tell', reasons: [], stepIDs: run.deliverables, why: redact(why, 1000) })
    try {
      const workspace = subject ? subject.workspace : workspaces.get(runID)
      const evidence = await collectReviewEvidence(quest, run, workspace, deps.sources())
      const base: Partial<RunReview> = { ...(workspace?.branch ? { branch: workspace.branch } : {}), ...(workspace?.path ? { workspace: workspace.path } : {}), ...(evidence.diff.head ? { commit: evidence.diff.head } : {}) }
      const recorded = evidence.check?.ranOnFinalTree && evidence.check.recorded ? { command: evidence.check.recorded.command, exitCode: evidence.check.recorded.exitCode, source: 'host record' as const } : undefined
      const decide = (verdict: ReviewVerdict, reasons: string[], check: ReviewCheck | undefined, extra: Partial<RunReview> = {}) => {
        let judgment: ReviewJudgment | undefined, why: string | undefined
        if (verdict === 'rework') judgment = { accepted: false, firstPass: false, reviewer: CHECKS, verification: verificationRows(quest, evidence, check, false) }
        if (verdict === 'pass') {
          const rows = verificationRows(quest, evidence, check, true)
          if (rows.length) judgment = { accepted: true, firstPass: true, reviewer: CHECKS, verification: rows }
          else why = 'the checks passed, but no passing check is recorded to save as its verification, so no judgment was saved'
        }
        return keep({ runID, at: at(), verdict, reasons, stepIDs: run.deliverables, ...base, ...(check ? { check } : {}), ...extra, ...(judgment ? { judgment } : {}), ...(why ? { why } : {}) })
      }
      if (recorded && recorded.exitCode !== 0) return decide('rework', findings(evidence, recorded), recorded)
      const removed = await removalGaps(evidence.diff.patch, evidence.request, workspace?.path)
      if (removed.length) return decide('rework', [...removed.map(gap => gap.action), ...findings(evidence, recorded)], recorded, { gaps: removed })
      const check = recorded ?? (evidence.check && workspace && existsSync(workspace.path) ? await runCheck(workspace.path, evidence.check) : undefined)
      if (check && check.exitCode !== 0) return decide('rework', findings(evidence, check), check)
      return decide('pass', check ? ['`' + check.command + '` exited 0 on the final tree' + (check.source === 'reviewer run' ? ' when the checks ran it' : '')] : [], check)
    } catch (error) {
      const saved = subject ? undefined : runReview(store.read(questID) ?? quest, runID)
      if (saved) return saved
      return cannotTell(error instanceof Error ? error.message : String(error))
    }
  } catch (error) { outcome = 'failed'; throw error }
  finally { recordSpan({ plugin: 'quests', name: 'review', op: runID, start, end: spanNow(), outcome }) }
}
