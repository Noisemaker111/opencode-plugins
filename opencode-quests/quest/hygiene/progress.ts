import type { Quest, QuestEvent } from "../types"
import { HYGIENE_SOURCE } from "./policy"

const USER_EDITS = ["title", "description", "reward", "result", "workflow", "category", "delivered"]

export function isProgress(event: QuestEvent): boolean {
  if (event.source === HYGIENE_SOURCE) return false
  const payload = event.payload ?? {}
  if (event.type === "stage-state") return payload.status === "done"
  if (event.type === "session-state") return payload.state === "completed"
  if (event.type !== "patched") return false
  const landings = (payload.extensionsPatch as { landings?: unknown } | undefined)?.landings
  return USER_EDITS.some(key => key in payload) || landings !== undefined
}

export function progressAt(q: Pick<Quest, "createdAt" | "sessions">, events: QuestEvent[]): string {
  let at = q.createdAt
  for (const run of q.sessions) if (run.state === "completed" && run.updatedAt > at) at = run.updatedAt
  for (const event of events) if (isProgress(event) && event.at > at) at = event.at
  return at
}
