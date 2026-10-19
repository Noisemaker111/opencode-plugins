import { readAllQuests } from './index'
import { QuestStore } from './store'
import { questRoot } from './root.mts'
import { acquireLock } from './locking.mts'
import { createHash } from 'node:crypto'
export { physicalDirectory, projectIdentity, projectIdentityWithoutGit } from './core/project'
export { explicitDirectory, namedDirectories } from './core/explicit-path'
export function claimRouterRequest(key: string) {
  return acquireLock(new QuestStore(questRoot()).runtime, 'project-router-' + createHash('sha256').update(key).digest('hex'), { timeoutMs: 0 })
}
export function routerQuestInventory() {
  return readAllQuests(questRoot(), { includeArchived: true }).flatMap(row => row.quest ? [{
    id: row.quest.id, title: row.quest.title, project: row.quest.project,
    workers: row.quest.sessions.flatMap(run => {
      const sessionID = run.openCodeSessionId ?? run.sessionID
      return sessionID ? [{ sessionID, runID: run.runID, stepIDs: run.deliverables, state: run.state }] : []
    }),
  }] : [])
}
export function routerQuestHistory() {
  const history: Record<string, string[]> = {}
  for (const row of readAllQuests(questRoot(), { includeArchived: true })) {
    const quest = row.quest, projectID = quest?.project?.id
    if (!quest || !projectID) continue
    const texts = history[projectID] ?? (history[projectID] = [])
    texts.push([quest.title, quest.description ?? quest.objective].filter(Boolean).join('\n'))
  }
  return history
}
export function routerWorker(sessionID: string) {
  return routerQuestInventory().flatMap(q => q.workers.filter(w => w.sessionID === sessionID).map(w => ({ questID: q.id, ...w })))
}