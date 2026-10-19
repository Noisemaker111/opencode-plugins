import { RECONCILED_NOTE } from './session-lineage'
import type { QuestStore } from '../store'
import type { Quest, QuestSession, QuestStage } from '../types'
import type { Workspace } from '../workspaces'

type Prompting = { prompt?: (input: { sessionID: string; id: string; text: string; metadata: Record<string, unknown> }) => Promise<unknown> }

const runID = (run: QuestSession) => run.runID ?? run.callID
const requests = (q: Quest) => (q.extensions.reportRequests ?? {}) as Record<string, string>

export function unreportedSteps(q: Quest, run: QuestSession): QuestStage[] {
  return q.stages.filter(step => run.deliverables.includes(step.id)
    && (step.status === 'working' || step.status === 'pending' && (!step.note || RECONCILED_NOTE.test(step.note))))
}

export async function askForReport(store: QuestStore, host: Prompting | undefined, questID: string, run: QuestSession): Promise<boolean> {
  const q = store.read(questID), sessionID = run.openCodeSessionId ?? run.sessionID
  if (!q || !sessionID || typeof host?.prompt !== 'function' || requests(q)[runID(run)]) return false
  const steps = unreportedSteps(q, run)
  if (!steps.length) return false
  store.apply(questID, 'patched', { extensions: { ...q.extensions, reportRequests: { ...requests(q), [runID(run)]: new Date().toISOString() } } }, 'quest:report-request')
  try {
    await host.prompt({
      sessionID, id: 'msg_questreport' + runID(run).replace(/[^A-Za-z0-9]/g, '').slice(0, 40),
      text: `Save the result of ${steps.map(step => `"${step.title}"`).join(', ')}: done if finished and checked, pending if work remains, or blocked with what must change. Wait for any command or computer-use task you already started, without polling or starting it again; this request does not change the user's task or override a stop from them.`,
      metadata: { questReportRequest: true, questID, runID: runID(run) },
    })
    return true
  } catch (error) {
    console.error('[quests] report request', questID, error)
    const current = store.read(questID)
    if (current) { const { [runID(run)]: _failed, ...rest } = requests(current); store.apply(questID, 'patched', { extensions: { ...current.extensions, reportRequests: rest } }, 'quest:report-request') }
    return false
  }
}

export function unreportedNote(workspace: Workspace | undefined, asked: boolean): string {
  const ended = 'The worker ended without reporting this step' + (asked ? ', even when asked' : '')
  if (!workspace) return ended + '. Find its work before trying again; no checkout was saved.'
  return `${ended}. Review the work kept in its checkout and save the result before continuing.`
}

export function blockUnreported(store: QuestStore, questID: string, run: QuestSession, workspace: Workspace | undefined): number {
  const q = store.read(questID)
  if (!q) return 0
  const steps = unreportedSteps(q, run), note = unreportedNote(workspace, !!requests(q)[runID(run)])
  for (const step of steps) store.apply(questID, 'stage-state', { stageID: step.id, status: 'blocked', evidence: note }, 'quest:unreported-step')
  return steps.length
}
