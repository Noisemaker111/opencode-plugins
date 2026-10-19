import { isQuestID } from "./schema"
import { mkdirSync, statSync } from "node:fs"
import {writeFileDurable,readJsonRecord} from "./durable-file.mjs"
import { join } from "node:path"
import { acquireLock } from "../locking.mts"
import { generateReadableReference, isReadableReference } from "./readable-reference"
import type { Quest } from "../types"

type Registry = { version: 1; entries: Array<{ id: string; ref: string }>; requests: Array<{ key: string; id: string }> }
export function questReference(q: Pick<Quest, "id" | "ref">): string { return q.ref ?? q.id }
export function readReferenceRegistry(projectRoot: string): Registry {
  const file = join(projectRoot, ".opencode", ".quest-runtime", "references.json")
  const value = readJsonRecord<Registry>(file)
  if (!value) return { version: 1, entries: [], requests: [] }
  if (value.version !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.requests) || value.entries.some(e => !isQuestID(e.id) || !isReadableReference(e.ref))) throw new Error("Invalid Quest reference registry")
  if (value.requests.some(e => typeof e.key !== "string" || !isQuestID(e.id))) throw new Error("Invalid Quest request identity registry")
  if (new Set(value.entries.map(e => e.id)).size !== value.entries.length || new Set(value.entries.map(e => e.ref)).size !== value.entries.length) throw new Error("Conflicting Quest reference registry")
  return value
}
const views = new Map<string, { stamp: string; value: Registry }>()
export function referenceRegistryView(projectRoot: string): Readonly<Registry> {
  const file = join(projectRoot, ".opencode", ".quest-runtime", "references.json")
  let stamp: string
  try { const stat = statSync(file); stamp = stat.mtimeMs + ":" + stat.size } catch { return { version: 1, entries: [], requests: [] } }
  const held = views.get(file)
  if (held?.stamp === stamp) return held.value
  const value = readReferenceRegistry(projectRoot)
  views.set(file, { stamp, value })
  return value
}
export function saveReferenceRegistry(projectRoot: string, value: Registry) {
  const root = join(projectRoot, ".opencode", ".quest-runtime")
  mkdirSync(root, { recursive: true })
  const file = join(root, "references.json")
  writeFileDurable(file, JSON.stringify(value, null, 2) + "\n")
}
export function ensureQuestReferences(projectRoot: string, quests: Quest[], admissionLocked = false): void {
  let registry: Readonly<Registry> = referenceRegistryView(projectRoot)
  const needsWrite = quests.some(q => !registry.entries.some(e => e.id === q.id))
  const lock = needsWrite && !admissionLocked ? acquireLock(join(projectRoot, ".opencode", ".quest-runtime"), "admission") : undefined
  try {
    if (needsWrite) registry = readReferenceRegistry(projectRoot)
    let changed = false
    for (const q of [...quests].sort((a, b) => Number(!!(b.ref || isReadableReference(b.id))) - Number(!!(a.ref || isReadableReference(a.id))))) {
      const entry = registry.entries.find(e => e.id === q.id)
      if (entry) {
        if (q.ref && q.ref !== entry.ref) throw new Error("Quest reference differs from its saved identity: " + q.id)
        q.ref = entry.ref
        continue
      }
      let ref = q.ref ?? (isReadableReference(q.id) ? q.id : undefined)
      if (ref && (!isReadableReference(ref) || registry.entries.some(e => e.ref === ref))) throw new Error("Quest reference already belongs to another record: " + ref)
      if (!ref) do { ref = generateReadableReference(q.title) } while (registry.entries.some(e => e.ref === ref || e.id === ref))
      registry.entries.push({ id: q.id, ref }); q.ref = ref; changed = true
    }
    if (changed) saveReferenceRegistry(projectRoot, registry)
  } finally { lock?.release() }
}
