import type { QuestStore } from '../store'
import type { Quest } from '../types'

export type FindingKind = 'refused-create' | 'refused-handoff' | 'check-in' | 'stall' | 'stop' | 'blocked' | 'host'
export type Finding = { at: string; kind: FindingKind; text: string }

const KEEP = 20

export const findingsOf = (quest: Pick<Quest, 'extensions'>): Finding[] => {
  const held = quest.extensions?.findings
  return Array.isArray(held) ? held.filter((row): row is Finding => !!row && typeof row.text === 'string' && typeof row.kind === 'string' && typeof row.at === 'string') : []
}

export function recordFinding(store: Pick<QuestStore, 'read' | 'apply'>, questID: string, kind: FindingKind, text: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = store.read(questID)
    if (!current) return undefined
    const held = findingsOf(current)
    if (held.some(row => row.kind === kind && row.text === text)) return current
    const next = [...held, { at: new Date().toISOString(), kind, text }].slice(-KEEP)
    try { return store.apply(questID, 'patched', { extensions: { ...current.extensions, findings: next } }, 'quest:finding', { expectedRevision: current.revision }) }
    catch (error) { if (attempt === 2) throw error }
  }
  return undefined
}

const WARNING_KINDS: Record<string, FindingKind> = { 'run-no-host': 'host', 'reload-storm': 'host', 'folder-missing': 'host', 'process-no-cpu': 'stall', 'tool-past-p99': 'stall', 'ask-unanswered': 'blocked', 'step-restarted': 'blocked' }
export const warningFindingKind = (type: string): FindingKind => WARNING_KINDS[type] ?? 'check-in'

export const findingLine = (findings: Finding[]) => findings.length ? findings.length + (findings.length === 1 ? ' finding: ' : ' findings: ') + findings.slice(-3).map(row => row.text).join(' ') : ''
