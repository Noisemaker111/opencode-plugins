import { clearResolvedNotices } from "./giver/notice-ledger"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { generateReadableReference } from "./core/readable-reference"
import { ensureQuestReferences, questReference, readReferenceRegistry, referenceRegistryView, saveReferenceRegistry } from "./core/references"
import { basename, dirname, join } from "node:path"
import { acquireLock } from "./locking.mts"
import { appendEvent, journalPath, readEvents, snapshotDue } from "./core/journal"
import { enforceDirectoryBudget, retentionFrom, TELEMETRY_BUDGET } from "../scripts/telemetry-budget.mjs"
import { makeEvent } from "./core/events"
import { parseQuestMarkdown, serializeQuestMarkdown } from "./core/cst"
import {writeFileDurable,reportUnreadableRecord,zeroFilled} from "./core/durable-file.mjs"
import { listQuestFiles, listArchivedQuestFiles, readAllQuests } from "./index"
import { ledgerWritten } from "./core/ledger-changes"
import { questStamps, readQuestSnapshot, stamp, writeQuestSnapshot } from "./core/snapshot"
import { readBoardSummary, rebuildBoardSummary, removeBoardSummary, updateBoardSummary } from "./board/board-summary"
import { newQuest, isQuestID } from "./core/schema"
import { reduceQuest } from "./core/reducer"
import { NEEDS_JON_RENAMED } from "./types"
import { capQuestState } from "./core/md-caps"
import { extensionPatch } from "./core/extension-patch"
import { stagesPatch } from "./core/stage-patch"
import { completionMissing } from "./workers/completion"
import { TERMINAL_RUN } from "./runs/session-lineage"
import { runEndPayload } from "./runs/run-telemetry"
import type { Quest, QuestEvent } from "./types"

const INVALID_REFERENCE="Invalid Quest reference: pass the Quest id, a lowercase slug ending in six letters or digits (fix-the-bug-k7p3x2), not its title. Find the id with list and its text filter."
export class QuestStore {
  readonly root: string
  readonly runtime: string
  readonly archiveRoot: string
  private listeners = new Map<string, Set<() => void>>()
  constructor(public readonly projectRoot: string) {
    this.root = join(projectRoot, ".opencode", "quests")
    this.runtime = join(projectRoot, ".opencode", ".quest-runtime")
    this.archiveRoot = join(projectRoot, ".opencode", "quests-archive")
  }
  private path(ref: string) { return join(this.root, `${ref}.md`) }
  subscribe(id: string, listener: () => void) {
    id = this.resolveID(id)
    let listeners = this.listeners.get(id)
    if (!listeners) { listeners = new Set(); this.listeners.set(id, listeners) }
    listeners.add(listener)
    return () => { listeners!.delete(listener); if (!listeners!.size) this.listeners.delete(id) }
  }
  private changed(id: string) {
    ledgerWritten(this.projectRoot)
    try {
      const quest = this.read(id)
      if (quest) updateBoardSummary(this.runtime, quest)
      else removeBoardSummary(this.runtime, id)
    } catch (error) { console.error("[quests] board summary not updated", id, error) }
    for (const listener of this.listeners.get(id) ?? []) try { listener() } catch {}
  }
  private writeSnapshot(file: string, stamps: string, quest: Quest) {
    try {
      writeQuestSnapshot(this.runtime, file, stamps, quest)
      enforceDirectoryBudget(join(this.runtime, "snapshots"), TELEMETRY_BUDGET.questSnapshotsBytes, { cutoff: retentionFrom(), deletable: () => true })
    } catch (error) { console.error("[quests] snapshot not written", file, error) }
  }
  create(input: Partial<Quest> & Pick<Quest, "id" | "title" | "objective">): Quest {
    mkdirSync(this.root, { recursive: true })
    const lock = acquireLock(this.runtime, "admission")
    try { return this.createUnlocked(input) } finally { lock.release() }
  }
  private createUnlocked(input: Partial<Quest> & Pick<Quest, "id" | "title" | "objective">): Quest {
    if (!isQuestID(input.id)) throw new Error(INVALID_REFERENCE)
    const existing = this.find(input.id)
    if (existing) {
      const current = this.read(input.id, true)
      if (current && current.id === input.id && current.requestFingerprint === input.requestFingerprint) return current
      throw new Error(`Quest already exists with a different request: ${input.id}`)
    }
    const q = newQuest(input)
    ensureQuestReferences(this.projectRoot, [q], true)
    const path = this.path(questReference(q))
    const event = makeEvent(q.id, "created", { stages: q.stages, request: q.request ?? [] }, { lifecycleEpoch: q.lifecycleEpoch, expectedRevision: 0 })
    appendEvent(this.runtime, event); writeFileDurable(path, serializeQuestMarkdown(q, "")); this.changed(q.id); return q
  }
  admit(input: Omit<Partial<Quest>, "id"> & Pick<Quest, "title" | "objective" | "requestFingerprint">): Quest {
    mkdirSync(this.root, { recursive: true })
    const lock = acquireLock(this.runtime, "admission")
    try {
      const duplicate = listQuestFiles(this.projectRoot).map((path) => {
        const parsed = parseQuestMarkdown(readFileSync(path, "utf8")); return parsed.quest
      }).find((q): q is Quest => !!q && q.requestFingerprint === input.requestFingerprint && q.state !== "Archived")
      if (duplicate) { ensureQuestReferences(this.projectRoot, [duplicate], true); return duplicate }
      return this.createNamedUnlocked(input)
    } finally { lock.release() }
  }
  createNamed(input: Omit<Partial<Quest>, "id" | "ref"> & Pick<Quest, "title" | "objective">, requestKey?: string): Quest {
    mkdirSync(this.root, { recursive: true })
    const lock = acquireLock(this.runtime, "admission")
    try { return this.createNamedUnlocked(input, requestKey) } finally { lock.release() }
  }
  readRequest(requestKey: string): Quest | undefined {
    const id = readReferenceRegistry(this.projectRoot).requests.find(entry => entry.key === requestKey)?.id
    return id ? this.read(id) : undefined
  }
  private createNamedUnlocked(input: Omit<Partial<Quest>, "id" | "ref"> & Pick<Quest, "title" | "objective">, requestKey?: string): Quest {
    const registry = readReferenceRegistry(this.projectRoot)
    let id = requestKey === undefined ? undefined : registry.requests.find(entry => entry.key === requestKey)?.id
    if (id) {
      const existing = this.read(id, true)
      if (existing) return existing
      if (existsSync(join(this.runtime, "deleted", id + ".md"))) throw new Error("The Quest for this request was deleted")
    } else {
      do { id = generateReadableReference(input.title) } while (registry.entries.some(entry => entry.id === id || entry.ref === id) || this.find(id))
      registry.entries.push({ id, ref: id })
      if (requestKey !== undefined) registry.requests.push({ key: requestKey, id })
      saveReferenceRegistry(this.projectRoot, registry)
    }
    return this.createUnlocked({ ...input, id, ref: id })
  }
  private resolveID(reference: string): string {
    if (!isQuestID(reference)) throw new Error(INVALID_REFERENCE)
    const saved = referenceRegistryView(this.projectRoot).entries.find(entry => entry.ref === reference || entry.id === reference)
    if (saved) return saved.id
    const files = [...listQuestFiles(this.projectRoot), ...listArchivedQuestFiles(this.projectRoot)]
    if (files.some(file => basename(file).startsWith(reference + "--"))) return reference
    const named = files.find(file => basename(file) === reference + ".md")
    if (named) {
      const q = parseQuestMarkdown(readFileSync(named, "utf8")).quest
      return q?.ref === reference ? q.id : reference
    }
    for (const file of files) {
      const q = parseQuestMarkdown(readFileSync(file, "utf8")).quest
      if (q?.ref === reference) return q.id
    }
    return reference
  }
  private replays = new Map<string, { stamps: string; quest: Quest }>()
  private stamps(file: string, questID: string) { return questStamps(this.runtime, file, questID) }
  read(id: string, admissionLocked = false): Quest | undefined {
    const file = this.find(id); if (!file) return
    const held = this.replays.get(file)
    if (held && held.stamps === this.stamps(file, held.quest.id)) { const quest = structuredClone(held.quest); ensureQuestReferences(this.projectRoot, [quest], admissionLocked); return quest }
    this.replays.delete(file)
    const stored = readQuestSnapshot(this.runtime, file)
    if (stored) { ensureQuestReferences(this.projectRoot, [stored], admissionLocked); return stored }
    const record = stamp(file)
    const text = readFileSync(file, "utf8")
    if (!text.length || zeroFilled(text)) { reportUnreadableRecord(file, text.length ? text.length + " zero bytes" : "empty"); return undefined }
    const parsed = parseQuestMarkdown(text); if (parsed.readonly || !parsed.quest) return parsed.quest
    const stamps = this.stamps(file, parsed.quest.id)
    const quest = readEvents(this.runtime, parsed.quest.id).reduce(reduceQuest, parsed.quest)
    for (const step of quest.stages) if (step.needsJon && NEEDS_JON_RENAMED[step.needsJon]) step.needsJon = NEEDS_JON_RENAMED[step.needsJon]
    if (record && stamps.startsWith(record + "|") && dirname(file) === this.root) {
      this.writeSnapshot(file, stamps, quest)
      this.replays.set(file, { stamps, quest: structuredClone(quest) })
    }
    ensureQuestReferences(this.projectRoot, [quest], admissionLocked)
    return quest
  }
  apply(id: string, type: QuestEvent["type"], payload: Record<string, unknown>, source = `process:${process.pid}`, options: { expectedRevision?: number } = {}): Quest {
    if (type === "session-state" && TERMINAL_RUN.has(String(payload.state))) try { payload = runEndPayload(this, this.resolveID(id), payload) } catch (error) { console.error("[quests] run telemetry not recorded", id, error) }
    return this.write(id, type, payload, source, options)
  }
  private write(id: string, type: QuestEvent["type"], payload: Record<string, unknown>, source: string, options: { expectedRevision?: number }): Quest {
    if (type === "stage-state" && !["pending", "working", "blocked", "done"].includes(String(payload.status))) throw new Error("step state must be pending, working, blocked, or done")
    id = this.resolveID(id)
    const lock = acquireLock(this.runtime, id)
    try {
      const file = this.find(id); if (!file) throw new Error(`Quest not found: ${id}`)
      const raw = readFileSync(file, "utf8"), parsed = parseQuestMarkdown(raw); if (!parsed.quest || parsed.readonly) throw new Error(`Quest is read-only: ${parsed.errors.join("; ")}`)
      if (parsed.quest.id !== id) throw new Error("Quest file identity does not match its reference")
      const events = readEvents(this.runtime, id), current = events.reduce(reduceQuest, parsed.quest)
      ensureQuestReferences(this.projectRoot, [current])
      if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) throw new Error(`Quest ${id} changed since it was read: expected revision ${options.expectedRevision}, found ${current.revision}; re-read and retry`)
      if (type === "complete") {
        const missing = completionMissing(current)
        if (missing.length) throw new Error(`completion policy failed: ${missing.join(", ")}`)
      }
      const freshBefore = parseQuestMarkdown(readFileSync(file, "utf8")); if (freshBefore.humanHash !== parsed.humanHash) throw new Error("concurrent human content conflict; reload and retry")
      const event = makeEvent(id, type, patchPayload(current, type, payload), { source, lifecycleEpoch: current.lifecycleEpoch, expectedRevision: current.revision })
      const reduced = reduceQuest(current, event)
      if (!questChanged(current, reduced)) return current
      const next = capQuestState(reduced, this.runtime)
      appendEvent(this.runtime, event)
      if (snapshotDue(events)) appendEvent(this.runtime, makeEvent(id, "snapshot", { quest: next }, { source: "quest:snapshot", lifecycleEpoch: next.lifecycleEpoch }))
      const fresh = parseQuestMarkdown(readFileSync(file, "utf8")); if (fresh.humanHash !== parsed.humanHash) throw new Error("concurrent human content conflict; reload and retry")
      writeFileDurable(file, serializeQuestMarkdown(next, fresh.body, fresh))
      this.relocate(file, current.state, next)
      try { clearResolvedNotices(this.runtime, current, next) } catch (error) { console.error('[quests] notice ledger not cleared', id, error) }
      this.changed(id)
      return next
    } finally { lock.release() }
  }
  private relocate(file: string, fromState: Quest["state"], next: Quest) {
    const wasArchived = fromState === "Archived", isArchived = next.state === "Archived"
    const name = questReference(next) + ".md"
    const destination = wasArchived === isArchived ? join(dirname(file), name) : isArchived ? join(this.archiveRoot, next.updatedAt.slice(0, 10), name) : join(this.root, name)
    if (destination === file) return
    if (existsSync(destination)) throw new Error("Quest destination already exists: " + destination)
    mkdirSync(dirname(destination), { recursive: true })
    renameSync(file, destination)
  }
  delete(id: string, confirmed = false): Quest {
    if (!confirmed) throw new Error("Quest deletion requires confirmed=true")
    id = this.resolveID(id)
    const lock = acquireLock(this.runtime, id)
    try {
      const file = this.find(id); if (!file) throw new Error(`Quest not found: ${id}`)
      const parsed = parseQuestMarkdown(readFileSync(file, "utf8")); if (!parsed.quest || parsed.readonly) throw new Error(`Quest is read-only: ${parsed.errors.join("; ")}`)
      if (parsed.quest.id !== id) throw new Error("Quest file identity does not match its reference")
      const current = readEvents(this.runtime, id).reduce(reduceQuest, parsed.quest)
      ensureQuestReferences(this.projectRoot, [current])
      const event = makeEvent(id, "delete", { reason: "Explicitly deleted by user" }, { lifecycleEpoch: current.lifecycleEpoch, expectedRevision: current.revision })
      appendEvent(this.runtime, event)
      const deleted = reduceQuest(current, event)
      writeFileDurable(file, serializeQuestMarkdown(deleted, parsed.body, parsed))
      const destination = join(this.runtime, "deleted", `${id}.md`)
      mkdirSync(dirname(destination), { recursive: true })
      renameSync(file, destination)
      this.changed(id)
      return deleted
    } finally { lock.release() }
  }
  private located = new Map<string, string>()
  private locateAll(files: string[]) {
    const refs = new Map(referenceRegistryView(this.projectRoot).entries.map(entry => [entry.ref, entry.id]))
    for (const file of files) {
      const name = basename(file, ".md")
      const id = /^[0-9a-hjkmnp-tv-z]{26}--/.test(name) ? name.slice(0, 26) : refs.get(name)
      if (id && !this.located.has(id)) this.located.set(id, file)
    }
  }
  find(reference: string): string | undefined {
    const id = this.resolveID(reference)
    const entry = referenceRegistryView(this.projectRoot).entries.find(entry => entry.id === id)
    const names = (file: string) => { const name = basename(file); return name === (entry?.ref ?? id) + ".md" || name.startsWith(id + "--") }
    const known = this.located.get(id)
    if (known && names(known) && existsSync(known)) return known
    if (known) this.replays.delete(known)
    const files = [...listQuestFiles(this.projectRoot), ...listArchivedQuestFiles(this.projectRoot)]
    this.locateAll(files)
    const named = files.find(names)
    if (named) { this.located.set(id, named); return named }
    this.located.delete(id)
    if (entry) return undefined
    return files.find(file => {
      const q = parseQuestMarkdown(readFileSync(file, "utf8")).quest
      return q?.id === id || q?.ref === reference
    })
  }
}
export function patchPayload(current: Quest, type: QuestEvent["type"], payload: Record<string, unknown>): Record<string, unknown> {
  if (type !== "patched") return payload
  let body = payload
  const steps = Array.isArray(payload.stages) ? stagesPatch(current.stages, payload.stages) : undefined
  if (steps) { body = { ...payload, stagesPatch: steps }; delete body.stages }
  body = evidencePayload(current, body)
  if (!body.extensions || typeof body.extensions !== "object") return body
  const { extensions, ...rest } = body
  const { patch, removed } = extensionPatch(current.extensions, extensions as Record<string, unknown>)
  return { ...rest, extensionsPatch: patch, ...(removed.length ? { extensionsRemoved: removed } : {}) }
}
function evidencePayload(current: Quest, body: Record<string, unknown>): Record<string, unknown> {
  const next = body.evidence
  if (!next || typeof next !== "object" || Array.isArray(next)) return body
  const before = (current.evidence ?? {}) as Record<string, unknown>, after = next as Record<string, unknown>
  if (Object.keys(before).some(key => !(key in after))) return body
  const changed = Object.fromEntries(Object.entries(after).filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value)))
  const rest = { ...body }
  delete rest.evidence
  return { ...rest, evidencePatch: changed }
}
const BOOKKEEPING = new Set(["eventCursors", "appliedEventIDs", "history", "revision", "updatedAt"])
export const settledState = (quest: Quest) => Object.fromEntries(Object.entries(quest).filter(([key]) => !BOOKKEEPING.has(key)))
const settled = (quest: Quest) => JSON.stringify(settledState(quest))
export const questChanged = (before: Quest, after: Quest) => settled(before) !== settled(after)

export function backfillQuestSnapshots(store: QuestStore) {
  const rows = readAllQuests(store.projectRoot)
  const ids = rows.flatMap(row => row.quest ? [row.quest.id] : [])
  const diagnostics = rows.flatMap(row => row.quest ? [] : ["Unreadable Quest record: " + row.errors.join("; ")])
  const quests: Quest[] = []
  const before = readBoardSummary(store.runtime)
  let next = 0
  const step = () => {
    for (let count = 0; count < 5 && next < ids.length; count++, next++) try { const quest = store.read(ids[next]); if (quest) quests.push(quest) } catch {}
    if (next < ids.length) setImmediate(step)
    else rebuildBoardSummary(store.runtime, quests, diagnostics, before, id => store.read(id))
  }
  setImmediate(step)
}
