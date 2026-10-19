import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { journalPath } from "./journal"
import { writeFileDurable } from "./durable-file.mjs"
import type { Quest } from "../types"

export function stamp(path: string) { try { const info = statSync(path); return info.mtimeMs + ":" + info.size } catch { return "" } }

const snapshotFile = (runtime: string, file: string) => join(runtime, "snapshots", createHash("sha1").update(basename(file)).digest("hex") + ".json")

export function questStamps(runtime: string, file: string, id: string) {
  const journal = journalPath(runtime, id)
  return [file, journal, journal + ".recovery.json"].map(stamp).join("|")
}

export function readQuestSnapshot(runtime: string, file: string): Quest | undefined {
  try {
    const held = JSON.parse(readFileSync(snapshotFile(runtime, file), "utf8")) as { stamps?: string; quest?: Quest }
    return held.quest && held.stamps === questStamps(runtime, file, held.quest.id) ? held.quest : undefined
  } catch { return undefined }
}

export function writeQuestSnapshot(runtime: string, file: string, stamps: string, quest: Quest) {
  writeFileDurable(snapshotFile(runtime, file), JSON.stringify({ stamps, quest }))
}
