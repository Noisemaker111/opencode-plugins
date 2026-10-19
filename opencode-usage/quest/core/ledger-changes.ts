import { watch, mkdirSync, type FSWatcher } from "node:fs"
import { join, resolve } from "node:path"

type Listener = (projectRoot: string) => void
type Channel = { listeners: Set<Listener>; watches: Map<string, { watchers: FSWatcher[]; live: boolean }> }
const KEY = Symbol.for("questgiver.ledger-changes")
const channel = (): Channel => ((globalThis as any)[KEY] ??= { listeners: new Set(), watches: new Map() })
const key = (projectRoot: string) => { const path = resolve(projectRoot); return process.platform === "win32" ? path.toLowerCase() : path }

export function onLedgerChange(listener: Listener): () => void {
  const { listeners } = channel()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function ledgerWritten(projectRoot: string) {
  const root = key(projectRoot)
  for (const listener of [...channel().listeners]) try { listener(root) } catch (error) { console.error("[quests] ledger change listener failed", error) }
}

export const ledgerKey = key

export function watchLedger(projectRoot: string): boolean {
  const root = key(projectRoot), watches = channel().watches
  const held = watches.get(root)
  if (held) return held.live
  const entry = { watchers: [] as FSWatcher[], live: true }
  watches.set(root, entry)
  const close = () => { entry.live = false; for (const watcher of entry.watchers) try { watcher.close() } catch {} }
  try {
    for (const [folder, recursive] of [[join(projectRoot, ".opencode", "quests"), false], [join(projectRoot, ".opencode", "quests-archive"), true]] as const) {
      mkdirSync(folder, { recursive: true })
      const watcher = watch(folder, { recursive }, (_event, name) => { if (!name || String(name).includes(".md")) ledgerWritten(projectRoot) })
      watcher.on("error", error => {
        if (!entry.live) return
        close(); if (watches.get(root) === entry) watches.delete(root)
        console.error("[quests] ledger watch lost", projectRoot, error)
        ledgerWritten(projectRoot)
      })
      watcher.unref?.()
      entry.watchers.push(watcher)
    }
  } catch (error) {
    close(); console.error("[quests] ledger cannot be watched; readers re-read it", projectRoot, error)
  }
  return entry.live
}
