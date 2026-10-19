import { isReadableReference } from "./readable-reference"
import { DEFAULT_COMPLETION_POLICY, QUEST_SCHEMA, type Quest } from "../types"

const ID = /^[0-9a-hjkmnp-tv-z]{26}$/
export function isQuestID(id: unknown): id is string { return typeof id === "string" && (ID.test(id) || isReadableReference(id)) }
export function inferQuestKind(title: string, objective = ""): Quest["kind"] {
  const text = `${title} ${objective}`
  if (/\b(bug|fix|hotfix|regression)\b/i.test(text)) return "fix"
  if (/\b(investigat|debug|root.?cause)/i.test(text)) return "investigation"
  if (/\bmigrat/i.test(text)) return "migration"
  return "feature"
}
export function validateQuest(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["frontmatter is not an object"]
  const q = value as any, errors: string[] = []
  if (q.schema !== QUEST_SCHEMA) errors.push(q.schema?.startsWith?.("opencode.quest/") ? `future or unsupported schema: ${q.schema}` : "missing schema")
  if (!isQuestID(q.id)) errors.push("invalid Quest reference")
  if (q.ref !== undefined && !isReadableReference(q.ref)) errors.push("invalid readable Quest reference")
  if (!Number.isSafeInteger(q.revision) || q.revision < 0) errors.push("invalid revision")
  if (!Number.isSafeInteger(q.lifecycleEpoch) || q.lifecycleEpoch < 1) errors.push("invalid lifecycle epoch")
  if (typeof q.state !== "string") errors.push("invalid state")
  for (const key of ["title", "objective", "reason", "nextAction"]) if (typeof q[key] !== "string") errors.push(`invalid ${key}`)
  for (const key of ["deliverables", "acceptanceCriteria", "usageInstructions", "stages", "setbacks", "sessions", "claims", "unresolvedWork", "history", "appliedEventIDs"]) if (!Array.isArray(q[key])) errors.push(`invalid ${key}`)
  if (!q.extensions || typeof q.extensions !== "object" || Array.isArray(q.extensions)) errors.push("invalid extensions")
  return errors
}

export function newQuest(input: Partial<Quest> & Pick<Quest, "id" | "title" | "objective">, now = new Date().toISOString()): Quest {
  return {
    contractVersion: input.contractVersion, description: input.description, reward: input.reward, request: input.request, project: input.project, archive: input.archive,
    schema: QUEST_SCHEMA, id: input.id, ref: input.ref, revision: 0, lifecycleEpoch: 1, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now,
    title: input.title, objective: input.objective, kind: input.kind ?? "feature", priority: input.priority ?? "normal",
    state: "Waiting", reason: input.reason ?? "Ready for work to be assigned", nextAction: input.nextAction ?? "Assign an execution session",
    executingCount: 0, owner: input.owner, integrationOwner: input.integrationOwner, requestFingerprint: input.requestFingerprint,
    scope: input.scope ?? { blastRadius: "Not assessed", risk: "medium", repos: [], include: [], exclude: [] },
    relationships: input.relationships ?? { parents: [], subquests: [], dependencies: [], supersedes: [], mergedFrom: [] },
    deliverables: input.deliverables ?? [], acceptanceCriteria: input.acceptanceCriteria ?? [], usageInstructions: input.usageInstructions ?? [],
    stages: input.stages ?? [], setbacks: input.setbacks ?? [],
    sessions: input.sessions ?? [], claims: input.claims ?? [],
    evidence: input.evidence ?? { commits: [], tests: [], builds: [], artifacts: [], publish: [] },
    unresolvedWork: input.unresolvedWork ?? [], completionPolicy: input.completionPolicy ?? { ...DEFAULT_COMPLETION_POLICY }, missingRequirements: [],
    migration: input.migration ?? { records: [] }, eventCursors: {}, appliedEventIDs: [], history: [], extensions: input.extensions ?? {},
  }
}
