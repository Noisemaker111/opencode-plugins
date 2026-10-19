import { exclusionOf, type RoutingSettings } from '../../models/routing-settings'
import { stepProfile, type Depth } from '../../models/work-profile'
import { requestNamesModel } from '../routing/chosen-by'
import { routingSettings } from '../routing/routing-settings'
import type { Quest, QuestSession } from '../types'

const depthOfRun = (quest: Pick<Quest, 'stages'>, run: Pick<QuestSession, 'deliverables'>): Depth | undefined => {
  for (const id of run.deliverables) {
    try { const depth = stepProfile(quest.stages.find(stage => stage.id === id)).depth; if (depth) return depth } catch {}
  }
  return undefined
}
const workTypeOfRun = (quest: Pick<Quest, 'stages'>, run: Pick<QuestSession, 'deliverables'>): string | undefined => {
  for (const id of run.deliverables) {
    try { const workType = stepProfile(quest.stages.find(stage => stage.id === id)).workType; if (workType) return workType } catch {}
  }
  return undefined
}

export function resumeExcludedBy(quest: Pick<Quest, 'stages' | 'request'>, run: Pick<QuestSession, 'deliverables' | 'providerID' | 'modelID' | 'reasoningEffort' | 'model'>, settings: () => RoutingSettings = routingSettings): string | undefined {
  const [identity, effort] = String(run.model ?? '').split('#'), slash = identity.indexOf('/')
  const providerID = run.providerID ?? (slash > 0 ? identity.slice(0, slash) : undefined)
  const modelID = run.modelID ?? (slash > 0 ? identity.slice(slash + 1) : undefined)
  if (!providerID || !modelID) return undefined
  const reasoning = run.reasoningEffort ?? effort ?? 'unknown'
  if (requestNamesModel(quest, providerID + '/' + modelID + '#' + reasoning)) return undefined
  let saved: RoutingSettings
  try { saved = settings() } catch { return undefined }
  return exclusionOf(saved, depthOfRun(quest, run), { providerID, modelID, reasoning }, workTypeOfRun(quest, run))
}
