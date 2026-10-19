import { OWNED_RUN } from '../runs/session-lineage'
import { plainWords } from '../review/plain-words'
import { branchOutcomes } from './branch-outcomes'
import { timed, type SpanWriter } from '../../scripts/plugin-spans'
import type { Quest, QuestSession } from '../types'

export const FAR_PAST_FINISH_MULTIPLE = 3
export const FAR_PAST_FINISH = 'far past its expected finish'
export const STILL_WORKING_MS = 2 * 60_000

export type RunProgress = { lastAt: number; settled: number; paceMs?: number; remaining?: number }
export type FarPastFinish = { runID: string; route: string; expectedMs: number; elapsedMs: number; dueAt: number; progress?: RunProgress }

const routeOf = (run: QuestSession) => [run.providerID && run.modelID ? run.providerID + '/' + run.modelID : run.model, run.reasoningEffort].filter(Boolean).join('#') || 'an unrecorded route'
const startOf = (run: QuestSession) => { const at = Date.parse(run.startedAt ?? run.updatedAt); return Number.isFinite(at) ? at : undefined }
export const savedAStep = (quest: Pick<Quest, 'stages'>, run: QuestSession) => run.deliverables.some(id => quest.stages.find(step => step.id === id)?.status === 'done')

const REMAINING = /\b(\d+)\s+(?:more\s+)?(?:branch(?:es)?\s+)?(?:remaining|remain|left)\b/i
export function runProgress(quest: Pick<Quest, 'stages'> & Partial<Pick<Quest, 'extensions'>>, run: QuestSession): RunProgress | undefined {
  const started = startOf(run)
  if (started === undefined) return undefined
  const own = new Set(run.deliverables), steps = quest.stages.filter(step => own.has(step.id))
  const settledAt = Object.values(branchOutcomes(quest as Pick<Quest, 'extensions'>)).filter(row => row && own.has(row.stepID)).map(row => Date.parse(row.at)).filter(at => Number.isFinite(at) && at > started).sort((a, b) => a - b)
  const notedAt = steps.map(step => Date.parse(step.noteAt ?? '')).filter(at => Number.isFinite(at) && at > started)
  const lastAt = Math.max(...settledAt, ...notedAt)
  if (!Number.isFinite(lastAt)) return undefined
  const remaining = steps.map(step => REMAINING.exec(step.note ?? '')?.[1]).find(Boolean)
  return { lastAt, settled: settledAt.length, ...(settledAt.length ? { paceMs: Math.round((settledAt[settledAt.length - 1] - started) / settledAt.length) } : {}), ...(remaining !== undefined ? { remaining: Number(remaining) } : {}) }
}

export function finishBudget(quest: Pick<Quest, 'stages'> & Partial<Pick<Quest, 'extensions'>>, run: QuestSession): Omit<FarPastFinish, 'elapsedMs'> | undefined {
  const expectedMs = run.expectedFinishMs, started = startOf(run)
  if (!expectedMs || started === undefined || !OWNED_RUN.has(run.state) || savedAStep(quest, run)) return undefined
  const progress = runProgress(quest, run), base = { runID: run.runID ?? run.callID, route: routeOf(run), expectedMs }
  if (!progress) return { ...base, dueAt: started + FAR_PAST_FINISH_MULTIPLE * expectedMs }
  return { ...base, progress, dueAt: Math.max(started + FAR_PAST_FINISH_MULTIPLE * expectedMs, progress.lastAt + FAR_PAST_FINISH_MULTIPLE * (progress.paceMs || expectedMs)) }
}

const pastExpectedFinish = (budget: Omit<FarPastFinish, 'elapsedMs'>, started: number, now: number) =>
  now >= started + budget.expectedMs && (!budget.progress || now >= budget.progress.lastAt + (budget.progress.paceMs || budget.expectedMs))

export function farPastFinish(quest: Pick<Quest, 'stages'> & Partial<Pick<Quest, 'extensions'>>, run: QuestSession, now = Date.now()): FarPastFinish | undefined {
  const budget = finishBudget(quest, run), started = startOf(run)
  if (!budget || started === undefined || now < budget.dueAt) return undefined
  return { ...budget, elapsedMs: now - started }
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000)) + ' minutes'
export const NO_ACTIVITY_SINCE_START = 'shows no activity since it started'
const activitySince = (run: QuestSession, late: FarPastFinish, hostActivityAt?: string) => {
  const started = startOf(run), last = Math.max(...[run.lastHeartbeatAt, hostActivityAt].map(at => Date.parse(at ?? '')).filter(Number.isFinite))
  if (started === undefined || !Number.isFinite(last) || last <= started) return 'It ' + NO_ACTIVITY_SINCE_START + '.'
  return 'Its last activity was ' + minutes(started + late.elapsedMs - last) + ' ago.'
}
const branchCount = (count: number) => count + (count === 1 ? ' branch' : ' branches')
const progressLine = (run: QuestSession, late: FarPastFinish, progress: RunProgress) => {
  const silent = minutes((startOf(run) ?? progress.lastAt) + late.elapsedMs - progress.lastAt)
  const pace = progress.paceMs ? 'It settled ' + branchCount(progress.settled) + ' at about ' + minutes(progress.paceMs) + ' per branch' + (progress.remaining !== undefined ? ', with ' + progress.remaining + ' remaining, about ' + minutes(progress.remaining * progress.paceMs) + ' of work left' : '') + '. ' : ''
  return pace + 'Its last saved progress was ' + silent + ' ago, more than three times ' + (progress.paceMs ? 'its pace per branch.' : 'the routing estimate.')
}
const lateBody = (quest: Pick<Quest, 'title' | 'stages'>, run: QuestSession, late: FarPastFinish, hostActivityAt?: string) => {
  const steps = run.deliverables.map(id => quest.stages.find(step => step.id === id)?.title ?? id).join(', ')
  const finish = late.elapsedMs >= FAR_PAST_FINISH_MULTIPLE * late.expectedMs ? FAR_PAST_FINISH : 'past its expected finish'
  return late.progress
    ? plainWords(steps) + ': running ' + minutes(late.elapsedMs) + ' on ' + late.route + ' with no step done. ' + progressLine(run, late, late.progress)
    : plainWords(steps) + ': running ' + minutes(late.elapsedMs) + ' on ' + late.route + ' with no step saved; routing expected it to finish in ' + minutes(late.expectedMs) + ', so it is ' + finish + '. ' + activitySince(run, late, hostActivityAt)
}
export function farPastFinishText(quest: Pick<Quest, 'title' | 'stages'>, run: QuestSession, late: FarPastFinish, hostActivityAt?: string) {
  return ['RUN FAR PAST FINISH "' + plainWords(quest.title) + '"',
    lateBody(quest, run, late, hostActivityAt),
    '(look at its run; stop it with stop runID ' + (run.sessionRef ?? late.runID) + ' and start the step on another route, or wait)'].join('\n')
}

export type LateRun = { run: QuestSession; late: FarPastFinish; hostActivityAt?: string }
export function farPastFinishesText(quest: Pick<Quest, 'title' | 'stages'>, rows: LateRun[]) {
  if (rows.length === 1) return farPastFinishText(quest, rows[0].run, rows[0].late, rows[0].hostActivityAt)
  return ['RUN FAR PAST FINISH "' + plainWords(quest.title) + '"',
    rows.length + ' runs of this Quest are past their expected finish:',
    ...rows.map(row => '- ' + lateBody(quest, row.run, row.late, row.hostActivityAt)),
    '(look at its runs; stop each with stop runID ' + rows.map(row => row.run.sessionRef ?? row.late.runID).join(', ') + ' and start its step on another route, or wait)'].join('\n')
}

export type FinishWatchOptions = {
  quests: () => Quest[]
  notify: (quest: Quest, run: QuestSession, late: FarPastFinish, rows: { run: QuestSession; late: FarPastFinish }[]) => void | Promise<void>
  active?: (questID: string, runID: string) => boolean
  lastActivity?: (quest: Quest, run: QuestSession) => Promise<number | undefined>
  wait?: (milliseconds: number, fire: () => void) => () => void
  clock?: () => number
  spans?: SpanWriter
}

export class FinishWatch {
  private readonly armed = new Map<string, { dueAt: number; cancel: () => void }>()
  private readonly told = new Set<string>()
  constructor(readonly options: FinishWatchOptions) {}
  private now() { return (this.options.clock ?? Date.now)() }
  private wait(milliseconds: number, fire: () => void) {
    if (this.options.wait) return this.options.wait(milliseconds, fire)
    const timer: any = setTimeout(fire, Math.max(0, Math.min(milliseconds, 2 ** 31 - 1))); timer.unref?.(); return () => clearTimeout(timer)
  }
  sync() {
    const live = new Set<string>()
    for (const quest of this.options.quests()) for (const run of quest.sessions) {
      const budget = finishBudget(quest, run)
      if (!budget || this.told.has(budget.runID)) continue
      live.add(budget.runID)
      if ((this.armed.get(budget.runID)?.dueAt ?? -Infinity) >= budget.dueAt) continue
      this.armed.get(budget.runID)?.cancel()
      const cancel = this.wait(budget.dueAt - this.now(), () => { this.armed.delete(budget.runID); void this.check(quest.id, budget.runID) })
      this.armed.set(budget.runID, { dueAt: budget.dueAt, cancel })
    }
    for (const [runID, row] of this.armed) if (!live.has(runID)) { row.cancel(); this.armed.delete(runID) }
  }
  async check(questID: string, runID: string) {
    const quest = this.options.quests().find(row => row.id === questID), run = quest?.sessions.find(row => (row.runID ?? row.callID) === runID)
    if (!quest || !run || this.told.has(runID)) return undefined
    const late = farPastFinish(quest, run, this.now())
    if (!late) { this.sync(); return undefined }
    if (this.options.active && !this.options.active(questID, runID)) { this.sync(); return undefined }
    const lastActive = await this.options.lastActivity?.(quest, run)
    if (lastActive !== undefined && this.now() - lastActive < STILL_WORKING_MS) {
      const dueAt = lastActive + STILL_WORKING_MS
      this.armed.get(runID)?.cancel()
      this.armed.set(runID, { dueAt, cancel: this.wait(dueAt - this.now(), () => { this.armed.delete(runID); void this.check(questID, runID) }) })
      return undefined
    }
    const now = this.now(), rows = [{ run, late }, ...quest.sessions.flatMap(other => {
      const otherID = other.runID ?? other.callID, budget = otherID === runID || this.told.has(otherID) ? undefined : finishBudget(quest, other), started = startOf(other)
      if (!budget || started === undefined || !pastExpectedFinish(budget, started, now)) return []
      if (this.options.active && !this.options.active(questID, otherID)) return []
      return [{ run: other, late: { ...budget, elapsedMs: now - started } }]
    })]
    for (const row of rows) { this.told.add(row.late.runID); this.armed.get(row.late.runID)?.cancel(); this.armed.delete(row.late.runID) }
    await timed({ plugin: 'quests', name: 'far-past-finish.notice', op: questID, quests: rows.length }, async () => this.options.notify(quest, run, late, rows), this.options.spans)
    return late
  }
  dispose() { for (const row of this.armed.values()) row.cancel(); this.armed.clear() }
}
