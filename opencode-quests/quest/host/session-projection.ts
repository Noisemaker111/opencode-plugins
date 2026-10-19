import { existsSync } from 'node:fs'
import type { QuestWorkspaces } from '../workspaces'
import { isReadableReference } from '../core/readable-reference'
import { SessionReferences } from './session-references'
import { questReference } from '../core/references'
import type { Quest } from '../types'
import type { QuestStore } from '../store'

export function hydrateSessionReferences(store: QuestStore, quests: Quest[]): void {
  const registry = new SessionReferences(store.runtime)
  for (const q of quests) for (const run of q.sessions) {
    if ((run.sessionRef && !isReadableReference(run.sessionRef)) || run.runID?.includes('[REDACTED]')) {
      const issue = `Invalid readable session reference for call ${run.callID}`
      if (!q.unresolvedWork.includes(issue)) q.unresolvedWork.push(issue)
      run.sessionRef = undefined
      continue
    }
    const native = run.openCodeSessionId ?? run.sessionID ?? run.runtimeSessionId
    const identity = native ?? run.runID ?? run.callID
    const title = run.sessionTitle || q.stages.filter(step => run.deliverables.includes(step.id)).map(step => step.title).join(' and ') || q.title + ' worker'
    if (!native && isReadableReference(run.sessionRef ?? run.runID)) { run.sessionRef ??= run.runID; run.sessionTitle ??= title; continue }
    const source = native ? (run.harness === 'codex' ? 'codex' : 'opencode') : 'quest-run'
    let row = registry.get(identity, source)
    if (!row) {
      const priorRun = native ? registry.get(run.runID ?? run.callID, 'quest-run') : undefined
      row = registry.register({ sessionID: identity, title, source, runID: run.runID ?? run.callID, ...(priorRun?.ref ?? run.sessionRef ? { ref: priorRun?.ref ?? run.sessionRef } : {}) })
    }
    run.sessionRef = row.ref; run.sessionTitle = row.title
  }
}

export function resolveRunReference(store: QuestStore, q: Quest, value: string): string {
  const registry = new SessionReferences(store.runtime)
  const identities = [value, ...['opencode', 'codex', 'quest-run'].flatMap(source => registry.get(value, source)?.sessionID ?? [])]
  const run = q.sessions.find(run => identities.some(id => [run.runID, run.callID, run.sessionRef, run.sessionID, run.openCodeSessionId, run.runtimeSessionId].includes(id)))
  return run?.runID ?? run?.callID ?? value
}

export function agentReferenceProjection(store: QuestStore, value: unknown, quests: Quest[]): any {
  const names = new Map<string, string>(), registry = new SessionReferences(store.runtime)
  for (const q of quests) {
    names.set(q.id, questReference(q))
    for (const run of q.sessions) if (isReadableReference(run.sessionRef)) for (const id of [run.runID, run.callID, run.sessionID, run.openCodeSessionId, run.runtimeSessionId]) if (id) names.set(id, run.sessionRef)
  }
  const keys = new Set(['id', 'questID', 'runID', 'callID', 'sessionID', 'parentID', 'parentSessionID', 'resumedFrom', 'resumeRoot', 'integrationOwner', 'reviewer'])
  const reference = (id: string) => names.get(id) ?? ['opencode', 'codex', 'quest-run'].map(source => registry.get(id, source)?.ref).find(Boolean) ?? id
  const arrays = new Set(['sessions', 'sessionIDs', 'runIDs', 'parents', 'subquests', 'dependencies', 'supersedes', 'mergedFrom'])
  const visit = (item: any): any => {
    if (Array.isArray(item)) return item.map(visit)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.entries(item).filter(([key]) => !['openCodeSessionId', 'runtimeSessionId'].includes(key)).map(([key, entry]) => [key, typeof entry === 'string' && keys.has(key) ? reference(entry) : Array.isArray(entry) && arrays.has(key) ? entry.map(id => typeof id === 'string' ? reference(id) : visit(id)) : visit(entry)]))
  }
  return visit(value)
}

export function workspaceReferenceProjection(store: QuestStore, quests: Quest[], workspaces: QuestWorkspaces) {
  const byPath = new Map<string, { directory: string; ref: string; title: string } | null>()
  const present = new Map<string, boolean>()
  const exists = (key: string, path: string) => { let known = present.get(key); if (known === undefined) present.set(key, known = existsSync(path)); return known }
  for (const q of quests) for (const run of q.sessions) {
    try {
      const workspace = workspaces.peek(run.runID ?? run.callID)
      if (!workspace || workspace.questID !== q.id || workspace.mode === 'shared' || workspace.mode === 'research') continue
      const home = workspace.continuationOf ? workspaces.peek(workspace.continuationOf) : workspace
      if (!home || home.questID !== q.id || home.path !== workspace.path) continue
      const key = home.path.replaceAll('\\', '/').toLocaleLowerCase()
      if (!exists(key, home.path)) continue
      const owner = q.sessions.find(s => (s.runID ?? s.callID) === home.runID)
      if (!owner) continue
      hydrateSessionReferences(store, [{ ...q, sessions: [owner] }])
      if (!owner.sessionRef) continue
      const prior = byPath.get(key)
      if (prior === null || prior && prior.ref !== owner.sessionRef) { byPath.set(key, null); continue }
      byPath.set(key, { directory: home.path, ref: owner.sessionRef, title: owner.sessionTitle ?? q.title })
    } catch {}
  }
  return [...byPath.values()].filter((row): row is { directory: string; ref: string; title: string } => row !== null)
}
