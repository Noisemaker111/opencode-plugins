import { join } from 'node:path'
import { readJsonRecord, writeFileDurable } from '../core/durable-file.mjs'
import { boundedInspection } from '../worker-observation.mjs'
import { readUserGiver } from '../giver-registry.mjs'
import { questMemberships } from '../permissions/shared-guard'
import type { QuestStore } from '../store'

export type KnownSession = { id: string; location: { directory: string }; agent?: string; title?: string; parentID?: string }
type Ledger = { version: 1; sessions: Record<string, KnownSession> }

const LEDGERS = Symbol.for('questgiver.session-identity')
const ledgers: Map<string, Ledger> = (globalThis as any)[LEDGERS] ??= new Map()
const resolving = new Map<string, Promise<KnownSession | undefined>>()

const ledgerFile = (runtime: string) => join(runtime, 'session-identity.json')
const unwrap = (value: any) => value?.data ?? value

function ledger(runtime: string): Ledger {
 let row = ledgers.get(runtime)
 if (row) return row
 let saved: any
 try { saved = readJsonRecord(ledgerFile(runtime)) } catch {}
 row = saved?.version === 1 && saved.sessions && typeof saved.sessions === 'object' ? saved as Ledger : { version: 1, sessions: {} }
 ledgers.set(runtime, row)
 return row
}

function identityOf(value: any): KnownSession | undefined {
 const row = unwrap(value)
 const id = row?.id, directory = row?.location?.directory ?? row?.directory
 if (typeof id !== 'string' || !id || typeof directory !== 'string' || !directory) return undefined
 const parentID = row.parentID ?? row.parent_id ?? row.parentSessionID
 return { id, location: { directory },
  ...(typeof row.agent === 'string' ? { agent: row.agent } : {}),
  ...(typeof row.title === 'string' ? { title: row.title } : {}),
  ...(typeof parentID === 'string' ? { parentID } : {}) }
}

export function rememberSession(runtime: string, value: unknown): KnownSession | undefined {
 const known = identityOf(value)
 if (!known) return undefined
 const row = ledger(runtime), before = row.sessions[known.id]
 if (before && JSON.stringify(before) === JSON.stringify(known)) return known
 row.sessions[known.id] = known
 try { writeFileDurable(ledgerFile(runtime), JSON.stringify(row)) } catch (error) { console.error('[quests] session identity not saved', error instanceof Error ? error.message : error) }
 return known
}

export const knownSession = (runtime: string, sessionID: string): KnownSession | undefined => ledger(runtime).sessions[sessionID]

export function rememberSessionFromEvent(runtime: string, event: any) {
 const type = String(event?.type ?? '')
 if (!/^session\.(created|updated|.*moved)$/.test(type)) return
 rememberSession(runtime, event?.data?.info ?? event?.data?.session ?? event?.data)
}

function recordedSession(store: QuestStore, sessionID: string): KnownSession | undefined {
 try { const giver = readUserGiver(store.runtime); if (giver?.state === 'bound' && giver.sessionID === sessionID && giver.directory) return { id: sessionID, location: { directory: giver.directory }, agent: 'quest-giver' } } catch {}
 const member = questMemberships(store, sessionID).at(-1)
 const directory = member && (member.run.worktree ?? (member.run.scope as any)?.worktree ?? member.quest.project?.root)
 if (typeof directory === 'string' && directory) return { id: sessionID, location: { directory }, ...(member.run.parentID ? { parentID: member.run.parentID } : {}) }
}

export function resolveSessionInBackground(store: QuestStore, host: { get: Function }, sessionID: string): Promise<KnownSession | undefined> {
 const key = store.runtime + '\0' + sessionID
 const prior = resolving.get(key)
 if (prior) return prior
 const task = boundedInspection((signal: AbortSignal) => host.get({ sessionID }, { signal }))
  .then(row => rememberSession(store.runtime, row), () => undefined)
  .finally(() => resolving.delete(key))
 resolving.set(key, task)
 return task
}

export async function sessionForRequest(store: QuestStore, host: { get: Function }, sessionID: string): Promise<KnownSession | undefined> {
 const known = knownSession(store.runtime, sessionID), recorded = recordedSession(store, sessionID)
 if (known) return recorded?.agent === 'quest-giver' ? { ...known, location: recorded.location } : known
 const lookup = resolveSessionInBackground(store, host, sessionID)
 if (recorded) return recorded
 return await sessionUnknownToStoreAndCache(lookup)
}

const sessionUnknownToStoreAndCache = (lookup: Promise<KnownSession | undefined>) => lookup

export function cachedLineageHost(store: QuestStore, host: { get: Function }) {
 return { get: async ({ sessionID }: { sessionID: string }) => {
  const known = knownSession(store.runtime, sessionID) ?? recordedSession(store, sessionID)
  if (!known) void resolveSessionInBackground(store, host, sessionID)
  return known ?? { id: sessionID }
 } }
}
