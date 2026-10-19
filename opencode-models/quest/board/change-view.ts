import { isSafeReference } from "../core/readable-reference"
import type { Quest } from "../types"
import { QuestWorkspaces } from "../workspaces"
import { driveAsync } from "../landing/git-steps"
import { redact } from "../privacy"

export function workspaceRunID(id: string): boolean { return isSafeReference(id) }

export async function questChanges(q: Quest, manager: QuestWorkspaces) {
  const changes = []
  for (const session of q.sessions) {
    const runID = session.runID ?? session.callID
    const empty = { runID, available: false, files: [] as any[], commits: [] as string[] }
    if (!workspaceRunID(runID)) { changes.push({ ...empty, note: "Historical attempt · no owned workspace identity recorded" }); continue }
    try {
      const owned = manager.get(runID)
      if (!owned) { changes.push({ ...empty, note: "No owned workspace recorded for this attempt" }); continue }
      if (owned.questID !== q.id || owned.projectID !== q.project?.id) throw new Error("Workspace ownership does not match this Quest and project")
      const w = await driveAsync(manager.collectSteps(runID))
      changes.push({ ...empty, ...w.changes, workspace: w.path, integration: w.integration ?? null })
    } catch (error) { changes.push({ ...empty, error: redact(error instanceof Error ? error.message : String(error), 1000) }) }
  }
  return changes
}
