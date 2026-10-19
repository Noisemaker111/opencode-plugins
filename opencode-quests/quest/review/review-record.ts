import { redact } from '../privacy'
import type { Quest, QuestSession } from '../types'

export type ReviewVerdict = 'pass' | 'rework' | 'cannot tell'
export type ReviewVerification = { command: string; exitCode: number; artifact: string }
export type ReviewCheck = { command: string; exitCode: number | null; source: 'host record' | 'reviewer run' }
export type ReviewJudgment = { accepted: boolean; firstPass: boolean; reviewer: string; verification: ReviewVerification[] }
export type ReviewGap = { asked: string; missing: string; action: string; kind: 'missing' | 'wrong'; removal?: true }
export type RunReview = {
  runID: string; at: string; verdict: ReviewVerdict; reasons: string[]; stepIDs: string[]
  branch?: string; workspace?: string; commit?: string; redispatched?: boolean; why?: string
  check?: ReviewCheck; gaps?: ReviewGap[]; judgment?: ReviewJudgment; heldJudgment?: ReviewJudgment
}

const TEXT = 300, REASONS = 8, GAPS = 12, VERIFICATIONS = 5
const short = (text: string) => redact(text, TEXT)
const slimGap = (gap: ReviewGap): ReviewGap => ({ asked: short(gap.asked), missing: short(gap.missing), action: short(gap.action), kind: gap.kind, ...(gap.removal ? { removal: true as const } : {}) })
const slimVerification = (row: ReviewVerification): ReviewVerification => ({ command: short(row.command), exitCode: row.exitCode, artifact: short(row.artifact) })
const failingFirst = (rows: ReviewVerification[]) => [...rows].sort((a, b) => Number(a.exitCode === 0) - Number(b.exitCode === 0))
const slimJudgment = (judgment: ReviewJudgment): ReviewJudgment => ({ accepted: judgment.accepted, firstPass: judgment.firstPass, reviewer: judgment.reviewer, verification: failingFirst(judgment.verification).slice(0, VERIFICATIONS).map(slimVerification) })

export function slimReview(review: RunReview): RunReview {
  return {
    runID: review.runID, at: review.at, verdict: review.verdict, reasons: review.reasons.slice(0, REASONS).map(short), stepIDs: review.stepIDs,
    ...(review.branch ? { branch: short(review.branch) } : {}),
    ...(review.workspace ? { workspace: short(review.workspace) } : {}),
    ...(review.commit ? { commit: review.commit } : {}),
    ...(review.redispatched === undefined ? {} : { redispatched: review.redispatched }),
    ...(review.why ? { why: short(review.why) } : {}),
    ...(review.check ? { check: { command: short(review.check.command), exitCode: review.check.exitCode, source: review.check.source } } : {}),
    ...(review.gaps ? { gaps: review.gaps.slice(0, GAPS).map(slimGap) } : {}),
    ...(review.judgment ? { judgment: slimJudgment(review.judgment) } : {}),
    ...(review.heldJudgment ? { heldJudgment: slimJudgment(review.heldJudgment) } : {}),
  }
}

const runKey = (run: QuestSession) => run.runID ?? run.callID
export const runReviews = (q: Quest) => Object.fromEntries(Object.entries((q.extensions.reviews ?? {}) as Record<string, RunReview>).map(([id, review]) => [id, slimReview(review)]))
export const runReview = (q: Quest, runID: string): RunReview | undefined => runReviews(q)[runID]
export const reworkRequested = (q: Quest, run: QuestSession) => { const review = runReview(q, runKey(run)); return review?.verdict === 'rework' && review.redispatched === true }
export const reworkedRun = (q: Quest, run: QuestSession) => runReview(q, runKey(run))?.verdict === 'rework'
export const reviewJudgment = (q: Quest | undefined, runID: string) => q ? runReview(q, runID)?.judgment : undefined
export const priorReworks = (q: Quest, runID: string, stepIDs: string[]) => Object.values(runReviews(q)).filter(review => review.runID !== runID && review.verdict === 'rework' && review.stepIDs.some(id => stepIDs.includes(id)))
const gapsNamed = (review: RunReview) => (review.gaps?.length ? review.gaps.map(gap => gap.action) : review.reasons).map(text => text.trim().toLowerCase()).filter(Boolean).sort().join('\n')
export const sentBackWithSameGaps = (q: Quest, runID: string, stepIDs: string[]) => {
  const latest = runReview(q, runID)
  if (latest?.verdict !== 'rework') return false
  const named = gapsNamed(latest)
  return !!named && priorReworks(q, runID, stepIDs).some(review => gapsNamed(review) === named)
}
