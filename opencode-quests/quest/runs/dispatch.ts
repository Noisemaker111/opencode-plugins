import type { StartRun } from '../api'
import type { QuestStore } from '../store'
import { startQuestRun, type QuestHost } from './runtime'
import { configuredDispatchPolicyFile } from '../../models/dispatch-planner'
import { trackedStart } from '../routing/outcome-tracking'
import { QuestWorkerReturns } from '../workers/worker-returns'
import { timed } from '../../scripts/plugin-spans'

export function questDispatch(store: QuestStore, host: QuestHost, options: { policyFile?: string; settingsFile?: string; startRun?: StartRun } = {}) {
  const launch = options.startRun ?? startQuestRun(store, host, {
    policyFile: options.policyFile ?? configuredDispatchPolicyFile(),
    settingsFile: options.settingsFile,
    spares: true,
  })
  const returns = new QuestWorkerReturns(store, host)
  const start: StartRun = Object.assign(trackedStart(store, async input => {
    await timed({ plugin: 'quests', name: 'dispatch.return-watch', op: input.runID }, () => returns.watch(input))
    return launch(input)
  }, options.settingsFile), launch.admit ? { admit: launch.admit } : {})
  return { start, returns }
}
