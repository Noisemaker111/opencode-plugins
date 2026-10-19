import { dirname } from "node:path"
import { acquireLock, releaseAbandonedLocks, releaseRunLocks, type HeldLock, type LockOptions, type RunOwner } from "../locking.mts"
import { QuestStore } from "../store"
import { TERMINAL_RUN_STATES } from "../runs/wait"

const stores = new Map<string, QuestStore>()
function storeFor(runtime: string): QuestStore {
  let store = stores.get(runtime)
  if (!store) { store = new QuestStore(dirname(dirname(runtime))); stores.set(runtime, store) }
  return store
}

export function runEnded(runtime: string, owner: RunOwner): boolean {
  const quest = storeFor(runtime).read(owner.quest)
  if (!quest) return false
  const run = quest.sessions.find(session => (session.runID ?? session.callID) === owner.run)
  if (!run) return false
  return (TERMINAL_RUN_STATES as readonly string[]).includes(run.state)
}

export function runLockOptions(runtime: string, owner?: RunOwner): Pick<LockOptions, "owner" | "ownerEnded"> {
  return { ...(owner ? { owner } : {}), ownerEnded: ended => runEnded(runtime, ended) }
}

export function acquireRunLock(runtime: string, name: string, owner: RunOwner | undefined, options: Omit<LockOptions, "owner" | "ownerEnded"> = {}): HeldLock {
  return acquireLock(runtime, name, { ...options, ...runLockOptions(runtime, owner) })
}

export function releaseAbandonedRunLocks(runtime: string, holderEnded?: LockOptions["holderEnded"]): string[] {
  return releaseAbandonedLocks(runtime, { ownerEnded: ended => runEnded(runtime, ended), ...(holderEnded ? { holderEnded } : {}) })
}

export { releaseRunLocks }
