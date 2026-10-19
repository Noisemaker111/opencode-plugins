import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export function finishedQuests(runtimeRoot: string): (questID: string) => boolean {
  let finished: Set<string> | undefined
  return questID => (finished ??= archivedQuestIDs(join(runtimeRoot, "journals"))).has(questID)
}

function archivedQuestIDs(journals: string): Set<string> {
  const archived = new Set<string>()
  if (!existsSync(journals)) return archived
  for (const name of readdirSync(journals)) {
    if (!name.endsWith(".jsonl")) continue
    const isArchived = readFileSync(join(journals, name), "utf8").split("\n").some(line => {
      if (!line.includes('"archive"')) return false
      try {
        const event = JSON.parse(line)
        return event.type === "patched" && !!event.payload?.archive
      } catch {
        return false
      }
    })
    if (isArchived) archived.add(name.slice(0, -".jsonl".length))
  }
  return archived
}

export function activeSessionIDs(questsRoot: string): Set<string> {
  const ids = new Set<string>()
  if (!existsSync(questsRoot)) return ids
  for (const name of readdirSync(questsRoot)) {
    if (!name.endsWith(".md")) continue
    for (const id of readFileSync(join(questsRoot, name), "utf8").match(/ses_[A-Za-z0-9]+/g) ?? []) ids.add(id)
  }
  return ids
}
