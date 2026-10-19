import { QuestError } from '../api'
import { WORKER_CANNOT_REACH_GIVER } from '../review/plain-words'
import { questMemberships } from '../permissions/shared-guard'
import type { QuestStore } from '../store'

export const GIVER_REACHING_ACTIONS = new Set(['succeed_giver', 'message', 'create', 'start'])

export const workerCannotReachGiver = () => new QuestError('WORKER_CANNOT_REACH_GIVER', WORKER_CANNOT_REACH_GIVER)

const unwrapRow = (value: any) => value?.data ?? value
const parentOf = (row: any): string | undefined => row?.parentID ?? row?.parent_id ?? row?.parentSessionID

export async function withinWorkerLineage(store: QuestStore, host: { get: (input: { sessionID: string }) => Promise<unknown> }, row: any): Promise<boolean> {
  const seen = new Set<string>()
  let current = unwrapRow(row)
  while (current?.id && !seen.has(current.id)) {
    seen.add(current.id)
    if (questMemberships(store, current.id).length) return true
    const parent = parentOf(current)
    if (!parent) return false
    try { current = unwrapRow(await host.get({ sessionID: parent })) } catch { return false }
  }
  return false
}
