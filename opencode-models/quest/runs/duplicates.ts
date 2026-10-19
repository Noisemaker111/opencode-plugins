import { requestFingerprint } from "../privacy"
import type { Quest } from "../types"

export function unresolved(q: Quest): boolean { return !["Archived", "Complete"].includes(q.state) && !q.delivered }
export function normalizeRequestText(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() }
export function questRequestFingerprint(input: { projectID?: string; title: string; objective: string }): string {
  return requestFingerprint({ project: input.projectID ?? "", title: normalizeRequestText(input.title), objective: normalizeRequestText(input.objective) })
}
export function exactFingerprintMatch(quests: Quest[], fingerprint: string): Quest | undefined { return quests.find((q) => q.requestFingerprint === fingerprint && unresolved(q)) }
type Asking = { messageID?: string; turnID?: string; ownerSessionID?: string }
export function unresolvedDuplicate(quests: Quest[], request: { projectID?: string; title: string; objective: string; fingerprint: string } & Asking): Quest | undefined {
  const title = normalizeRequestText(request.title), objective = normalizeRequestText(request.objective)
  return quests.find((q) => unresolved(q) && (q.project?.id ?? "") === (request.projectID ?? "")
    && (q.requestFingerprint === request.fingerprint
      || normalizeRequestText(q.objective) === objective && !(request.messageID && q.request?.some(row => row.messageID === request.messageID))
      || !!request.turnID && !!request.ownerSessionID && q.integrationOwner === request.ownerSessionID && q.extensions?.giverTurnID === request.turnID && normalizeRequestText(q.title) === title))
}
