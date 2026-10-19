import { existsSync, readFileSync, rmSync } from "node:fs"
import { acquireLock } from "../locking.mts"
import { listArchivedQuestFiles, listQuestFiles } from "../index"
import { TERMINAL_RUN } from "../runs/session-lineage"
import { TELEMETRY_BUDGET } from "../../scripts/telemetry-budget.mjs"
import type { QuestStore } from "../store"
import { parseQuestMarkdown, serializeQuestMarkdown } from "./cst"
import { writeFileDurable } from "./durable-file.mjs"
import { makeEvent } from "./events"
import { externalizeBlobs } from "./journal-blobs"
import { journalPath, readEvents } from "./journal"
import { reduceQuest } from "./reducer"
import { capQuestState } from "./md-caps"

const SETTLED = new Set(["Complete", "Archived"])
const DAY = 86_400_000

export function compactSettledJournals(store: QuestStore, now = Date.now()): number {
  let compacted = 0
  for (const file of [...listQuestFiles(store.projectRoot), ...listArchivedQuestFiles(store.projectRoot)]) {
    const parsed = parseQuestMarkdown(readFileSync(file, "utf8"))
    if (parsed.quest && compactQuest(store, parsed.quest.id, now)) compacted++
  }
  return compacted
}

export function trimStoredQuests(store: QuestStore): number {
  let trimmed = 0
  for (const file of [...listQuestFiles(store.projectRoot), ...listArchivedQuestFiles(store.projectRoot)]) {
    const head = existsSync(file) ? parseQuestMarkdown(readFileSync(file, "utf8")) : undefined
    if (!head?.quest || head.readonly) continue
    let lock: ReturnType<typeof acquireLock>
    try { lock = acquireLock(store.runtime, head.quest.id, { timeoutMs: 1000 }) } catch { continue }
    try {
      if (!existsSync(file)) continue
      const parsed = parseQuestMarkdown(readFileSync(file, "utf8"))
      if (!parsed.quest || parsed.readonly) continue
      const state = readEvents(store.runtime, parsed.quest.id).reduce(reduceQuest, parsed.quest)
      const capped = capQuestState(state, store.runtime)
      if (JSON.stringify(capped) === JSON.stringify(state)) continue
      writeFileDurable(file, serializeQuestMarkdown(capped, parsed.body, parsed))
      trimmed++
    } finally { lock.release() }
  }
  return trimmed
}

export function compactQuest(store: QuestStore, id: string, now = Date.now()): boolean {
  let lock: ReturnType<typeof acquireLock>
  try { lock = acquireLock(store.runtime, id, { timeoutMs: 1000 }) } catch { return false }
  try {
    const file = store.find(id)
    if (!file) return false
    const parsed = parseQuestMarkdown(readFileSync(file, "utf8"))
    if (!parsed.quest || parsed.readonly) return false
    const events = readEvents(store.runtime, id)
    if (events.length < 2) return false
    const quest = events.reduce(reduceQuest, parsed.quest)
    const settledFor = now - Date.parse(quest.updatedAt)
    if (!SETTLED.has(quest.state) || !(settledFor >= TELEMETRY_BUDGET.settledJournalDays * DAY) || !quest.sessions.every(run => TERMINAL_RUN.has(run.state))) return false
    const snapshot = capQuestState({ ...quest, appliedEventIDs: [] }, store.runtime)
    const event = makeEvent(id, "snapshot", { quest: snapshot }, { source: "quest:compaction", lifecycleEpoch: quest.lifecycleEpoch })
    writeFileDurable(journalPath(store.runtime, id), JSON.stringify(externalizeBlobs(store.runtime, event)) + "\n")
    rmSync(journalPath(store.runtime, id) + ".recovery.json", { force: true })
    writeFileDurable(file, serializeQuestMarkdown(snapshot, parsed.body, parsed))
    return true
  } finally { lock.release() }
}
