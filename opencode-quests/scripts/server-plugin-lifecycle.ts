import type { Context, Cleanup } from '@opencode-ai/plugin/v2/promise'
import { resolve } from 'node:path'
type Plugin = { id: string; load: () => Promise<{setup:(context:Context)=>Promise<Cleanup|void>|Cleanup|void}> }
export async function setupServerPlugins(context: Context, plugins: Iterable<Plugin>, observe: { loaded: (id: string) => void; failed: (id: string, error: unknown) => void }) {
  const cleanups: Cleanup[] = [], directory: string | undefined = (context as any)?.location?.directory
  const dispose = async () => {
    if (directory) beginLocationPlugins(directory)
    const failures: unknown[] = []
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Server plugin cleanup failed')
  }
  if (directory) beginLocationPlugins(directory)
  try {
    for (const { id, load } of plugins) {
      try {
        const cleanup = await (await load()).setup(context)
        if (cleanup) cleanups.push(cleanup)
      } catch (error) {
        console.error(`[generation-bootstrap] server plugin ${id} failed to load${directory ? ' at ' + directory : ''}; the other plugins stay loaded without it:`, error)
        if (directory) recordLocationPlugin(directory, id, error)
        observe.failed(id, error)
        continue
      }
      if (directory) recordLocationPlugin(directory, id)
      observe.loaded(id)
    }
  } finally { if (directory) settleLocationPlugins(directory) }
  return dispose
}

export type LocationPlugins = { settled: boolean; loading: boolean; loaded: string[]; failed: Record<string, string> }
type Entry = Omit<LocationPlugins, 'loading'> & { began: boolean; listeners: Set<(state: LocationPlugins) => void> }
type Registry = { locations: Map<string, Entry>; blocked: Map<string, string> }
const KEY = Symbol.for('questgiver.location-plugins')
const registry = (): Registry => (globalThis as any)[KEY] ??= { locations: new Map(), blocked: new Map() }
const key = (directory: string) => process.platform === 'win32' ? resolve(directory).toLowerCase() : resolve(directory)
const entry = (directory: string) => {
  const locations = registry().locations, id = key(directory)
  let row = locations.get(id)
  if (!row) locations.set(id, row = { settled: false, began: false, loaded: [], failed: {}, listeners: new Set() })
  return row
}
const snapshot = (row: Entry): LocationPlugins => ({ settled: row.settled, loading: row.began && !row.settled, loaded: [...row.loaded], failed: { ...row.failed } })
export function beginLocationPlugins(directory: string) { const row = entry(directory); row.settled = false; row.began = true; row.loaded = []; row.failed = {} }
export function recordLocationPlugin(directory: string, id: string, ...error: [unknown?]) {
  const row = entry(directory)
  if (error.length) row.failed[id] = error[0] instanceof Error ? error[0].message : String(error[0])
  else if (!row.loaded.includes(id)) row.loaded.push(id)
}
export function settleLocationPlugins(directory: string) {
  const row = entry(directory); row.settled = true
  for (const listener of [...row.listeners]) try { listener(snapshot(row)) } catch (error) { console.error('[generation-bootstrap] location listener failed', error) }
}
export function locationPlugins(directory: string): LocationPlugins | undefined {
  const row = registry().locations.get(key(directory))
  return row && snapshot(row)
}
export function onLocationSettled(directory: string, listener: (state: LocationPlugins) => void) {
  const row = entry(directory); row.listeners.add(listener)
  return () => { row.listeners.delete(listener) }
}
export function blockQuestWorker(sessionID: string, reason: string) { registry().blocked.set(sessionID, reason) }
export function unblockQuestWorker(sessionID: string) { registry().blocked.delete(sessionID) }
export function questWorkerBlocked(sessionID: string) { return registry().blocked.get(sessionID) }
