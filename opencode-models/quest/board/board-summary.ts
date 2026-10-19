import { readFileSync } from "node:fs"
import { writeFileDurable } from "../core/durable-file.mjs"
import { join } from "node:path"
import { acquireLock } from "../locking.mts"
import type { Quest } from "../types"
import { summaryOf, type BoardSummary } from "./board"
import { TELEMETRY_BUDGET } from "../../scripts/telemetry-budget.mjs"

export type BoardSnapshot = { entries: Record<string, BoardSummary>; diagnostics: string[] }

const boardFile = (runtime: string) => join(runtime, "board-summary.json")

export function readBoardSummary(runtime: string): BoardSnapshot | undefined {
  try { return JSON.parse(readFileSync(boardFile(runtime), "utf8")) as BoardSnapshot } catch { return undefined }
}

export function enforceBoardBudget(board: BoardSnapshot) {
  let text = JSON.stringify(board)
  while (Buffer.byteLength(text) > TELEMETRY_BUDGET.boardSummaryBytes) {
    const oldest = Object.values(board.entries).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0]
    if (!oldest) break
    delete board.entries[oldest.id]
    text = JSON.stringify(board)
  }
  return text
}

function writeBoard(runtime: string, board: BoardSnapshot) {
  writeFileDurable(boardFile(runtime), enforceBoardBudget(board))
}

export function updateBoardSummary(runtime: string, quest: Quest) {
  changeBoard(runtime, (board) => { if (quest.state === "Archived") delete board.entries[quest.id]; else board.entries[quest.id] = summaryOf(quest) })
}

export function removeBoardSummary(runtime: string, id: string) {
  changeBoard(runtime, (board) => { delete board.entries[id] })
}

function changeBoard(runtime: string, change: (board: BoardSnapshot) => void) {
  const lock = acquireLock(runtime, "board-summary")
  try {
    const board = readBoardSummary(runtime) ?? { entries: {}, diagnostics: [] }
    change(board)
    writeBoard(runtime, board)
  } finally { lock.release() }
}

const entryText = (board: BoardSnapshot | undefined, id: string) => JSON.stringify(board?.entries[id])

export function rebuildBoardSummary(runtime: string, quests: Quest[], diagnostics: string[], before: BoardSnapshot | undefined, read: (id: string) => Quest | undefined) {
  const entries: Record<string, BoardSummary> = Object.fromEntries(quests.filter((quest) => quest.state !== "Archived").map((quest) => [quest.id, summaryOf(quest)]))
  let seen = before
  while (true) {
    const lock = acquireLock(runtime, "board-summary")
    let moved: string[]
    try {
      const current = readBoardSummary(runtime)
      moved = [...new Set([...Object.keys(seen?.entries ?? {}), ...Object.keys(current?.entries ?? {})])].filter((id) => entryText(seen, id) !== entryText(current, id))
      if (!moved.length) { writeBoard(runtime, { entries, diagnostics }); return }
      seen = current
    } finally { lock.release() }
    for (const id of moved) {
      let quest: Quest | undefined
      try { quest = read(id) } catch { continue }
      if (quest && quest.state !== "Archived") entries[id] = summaryOf(quest)
      else delete entries[id]
    }
  }
}
