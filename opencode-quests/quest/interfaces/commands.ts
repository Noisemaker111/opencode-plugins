import type { Quest } from "../types"
import { completionMissing } from "../workers/completion"
import type { QuestStore } from "../store"

function sessionPayload(args: Record<string, unknown>) {
  const sessionID = typeof args.sessionID === "string" && args.sessionID ? args.sessionID : undefined
  const callID = typeof args.callID === "string" && args.callID ? args.callID : sessionID ? `session:${sessionID}` : undefined
  if (!callID) throw new Error("Quest execution requires an explicit callID or sessionID")
  return {
    callID,
    taskID: args.taskID,
    sessionID,
    parentID: args.parentID,
    role: args.role ?? "worker",
    model: args.model,
    scope: args.scope,
    deliverables: args.deliverables,
    resumeRoot: args.resumeRoot,
  }
}

function requireQuest(store: QuestStore, id: string): Quest {
  const q = store.read(id)
  if (!q) throw new Error("Quest not found")
  return q
}

function reopenIfArchived(store: QuestStore, id: string, args: Record<string, unknown>, reason: string): Quest {
  const q = requireQuest(store, id)
  if (q.state !== "Archived") return q
  return store.apply(id, "reopen", { ...args, reason: args.reason ?? reason, nextAction: args.nextAction ?? "Execute this Quest" })
}

export function runQuestCommand(store: QuestStore, command: string, id: string, args: Record<string, unknown> = {}): Quest {
  if (command === "complete") {
    const q = requireQuest(store, id)
    const missing = completionMissing(q)
    if (missing.length) throw new Error(`completion policy failed: ${missing.join(", ")}`)
    return store.apply(id, "complete", {})
  }
  if (command === "accept" || command === "assign" || command === "assign agent") {
    reopenIfArchived(store, id, args, "Reopened to accept work")
    const owner = typeof args.owner === "string" ? args.owner : typeof args.agent === "string" ? args.agent : "accepted"
    return store.apply(id, "patched", { owner, nextAction: "Start an exact linked session" })
  }
  if (command === "execute" || command === "start" || command === "start work" || command === "start-session") {
    reopenIfArchived(store, id, args, "Reopened to execute work")
    return store.apply(id, "session-claimed", sessionPayload(args))
  }
  if (command === "resume" || command === "reopen") {
    const q = requireQuest(store, id)
    if (q.state !== "Archived") throw new Error("only an archived Quest can be reopened")
    return store.apply(id, "reopen", args)
  }
  if (command === "abandon") return store.apply(id, "abandon", { ...args, reason: args.reason ?? "Explicitly abandoned by user" })
  if (command === "archive") return store.apply(id, "archive", { ...args, reason: args.reason ?? "Explicitly archived by user" })
  if (command === "delete") return store.delete(id, args.confirmed === true)
  if (command === "turn-in" || command === "turn in") return store.apply(id, "archive", { ...args, reason: args.reason ?? "Explicitly turned in by user" })
  if (command === "mark deliverable") return store.apply(id, "deliverable-state", args)
  if (command === "attach" || command === "view" || command === "refresh") return requireQuest(store, id)
  throw new Error(`unsupported Quest command: ${command}`)
}
