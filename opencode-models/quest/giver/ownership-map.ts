import { readUserGiver } from '../giver-registry.mjs'
import { liveHostRecords, type HostRecord } from '../host/host-role'
import { readAllQuests } from '../index'
import type { QuestStore } from '../store'
import type { Quest, QuestSession } from '../types'

export type HostPlace = { id: string; pid: number; generation?: string; state: string }
export type WorkerOwnership = { runID: string; sessionID: string; state: string; host?: HostPlace }
export type QuestOwnership = { questID: string; giver?: { sessionID: string; current: boolean; host?: HostPlace }; workers: WorkerOwnership[] }
export type OwnershipMap = {
  activeHost?: HostPlace
  currentGiver?: { sessionID: string; host?: HostPlace }
  quests: QuestOwnership[]
  ownerOf: (questID: string) => QuestOwnership | undefined
}

const OPEN_RUN_STATES = new Set(['planned', 'executing', 'waiting', 'blocked'])
const runSession = (run: QuestSession) => run.openCodeSessionId ?? run.sessionID

const place = (host: HostRecord): HostPlace => ({ id: host.id, pid: host.pid, ...(host.generation ? { generation: host.generation } : {}), state: host.state })

export function ownershipMap(input: { quests: Quest[]; giverSessionID?: string; hosts: HostRecord[] }): OwnershipMap {
  const active = input.hosts.filter(host => host.state === 'active')
  const activeHost = active.length === 1 ? place(active[0]!) : undefined
  const quests = input.quests.filter(quest => quest.state !== 'Archived').map((quest): QuestOwnership => {
    const giverID = quest.integrationOwner?.startsWith('ses_') ? quest.integrationOwner : undefined
    const workers = quest.sessions.flatMap(run => {
      const sessionID = runSession(run)
      if (!sessionID || !OPEN_RUN_STATES.has(run.state)) return []
      return [{ runID: run.runID ?? run.callID, sessionID, state: run.state, ...(activeHost ? { host: activeHost } : {}) }]
    })
    return { questID: quest.id, ...(giverID ? { giver: { sessionID: giverID, current: giverID === input.giverSessionID, ...(activeHost ? { host: activeHost } : {}) } } : {}), workers }
  })
  const byQuest = new Map(quests.map(row => [row.questID, row]))
  return {
    ...(activeHost ? { activeHost } : {}),
    ...(input.giverSessionID ? { currentGiver: { sessionID: input.giverSessionID, ...(activeHost ? { host: activeHost } : {}) } } : {}),
    quests,
    ownerOf: questID => byQuest.get(questID),
  }
}

export function readOwnershipMap(store: Pick<QuestStore, 'projectRoot' | 'runtime'>): OwnershipMap {
  const quests = readAllQuests(store.projectRoot).flatMap(row => row.quest ? [row.quest] : [])
  let giverSessionID: string | undefined
  try { const giver = readUserGiver(store.runtime); if (giver?.state === 'bound') giverSessionID = giver.sessionID } catch {}
  return ownershipMap({ quests, giverSessionID, hosts: liveHostRecords() })
}
