export type InstructionRevisionSnapshot = { revision: number; eventCreatedAt?: number; observedAt: number }

const revisions = new Map<string, InstructionRevisionSnapshot>()

export function recordInstructionRevision(sessionID: string, revision: number, observedAt: number, eventCreatedAt?: number) {
  if (!sessionID || !Number.isSafeInteger(revision) || revision < 0 || !Number.isFinite(observedAt)) return
  revisions.set(sessionID, { revision, observedAt, ...(Number.isFinite(eventCreatedAt) ? {eventCreatedAt} : {}) })
}

export function instructionRevision(sessionID: string) { return revisions.get(sessionID) }
