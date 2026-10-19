import { homedir } from "node:os"
import { isAbsolute, normalize, parse } from "node:path"

export function questRoot(): string { return questRootSource().root }

export function questRootSource(): { root: string; pinned: boolean; pinVar?: "OPENCODE_QUEST_ROOT" } {
  const pin = (process.env.OPENCODE_QUEST_ROOT ?? "").trim()
  if (pin) {
    if (!isAbsolute(pin) || process.platform === "win32" && parse(normalize(pin)).root === "\\") throw new Error("OPENCODE_QUEST_ROOT must be an absolute ledger parent path; relative paths depend on project cwd.")
    return { root: normalize(pin), pinned: true, pinVar: "OPENCODE_QUEST_ROOT" }
  }
  return { root: homedir(), pinned: false }
}
