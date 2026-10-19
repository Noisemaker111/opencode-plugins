import { randomBytes } from "node:crypto"
import type { QuestEvent, QuestEventType } from "../types"
import { historyOrigin } from './history-origin'

export function eventID(): string { return `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}` }
let lastSourceSequence = 0
export function makeEvent(questID: string, type: QuestEventType, payload: Record<string, unknown>, options: Partial<QuestEvent> = {}): QuestEvent {
  const sourceSequence = options.sourceSequence ?? (lastSourceSequence = Math.max(Date.now(), lastSourceSequence + 1))
  return {
    v: 1, eventID: options.eventID ?? eventID(), questID, type, payload,
    at: options.at ?? new Date().toISOString(), source: options.source ?? `process:${process.pid}`,
    sourceSequence, causationID: options.causationID ?? eventID(),
    lifecycleEpoch: options.lifecycleEpoch ?? 1, expectedRevision: options.expectedRevision,
    ...(options.origin ?? historyOrigin() ? { origin: options.origin ?? historyOrigin() } : {}),
  }
}
export function validEvent(v: any): v is QuestEvent {
  return v?.payload !== null && typeof v?.payload === "object" && !Array.isArray(v.payload) && v?.v === 1 && typeof v.eventID === "string" && typeof v.questID === "string" && typeof v.type === "string" && typeof v.source === "string" && Number.isSafeInteger(v.sourceSequence)
}
