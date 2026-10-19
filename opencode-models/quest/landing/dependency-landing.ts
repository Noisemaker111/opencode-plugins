import { judgeLandedSteps, type Landing } from "./delivery"
import { driveAsync, gitRun } from "./git-steps"
import { landingLocation } from "./settle"
import type { QuestWorkspaces } from "../workspaces"
import type { Quest, QuestSession } from "../types"

export async function unlandedDependency(q: Pick<Quest, "extensions">, run: QuestSession, workspaces: QuestWorkspaces): Promise<string | undefined> {
  const runID = run.runID ?? run.callID
  if ((q.extensions.landings as Record<string, Landing> | undefined)?.[runID]?.state === "landed") return
  const workspace = workspaces.get(runID)
  if (!workspace || workspace.mode === "research" || workspace.mode === "shared") return
  const branchHead = workspace.branch ? (await driveAsync(gitRun(workspace.root, ["rev-parse", "-q", "--verify", "refs/heads/" + workspace.branch + "^{commit}"], 30_000))).stdout.trim() : ""
  const head = branchHead || workspace.changes?.commits?.[0]
  if (!head || head === workspace.base) return
  let place: Awaited<ReturnType<typeof landingLocation>>
  try { place = await landingLocation(workspace, workspaces) } catch (error) { return "the landing place cannot be read: " + (error instanceof Error ? error.message : String(error)) }
  if (place.policy.landed === "remote" && place.policy.remote) await driveAsync(gitRun(place.cwd, ["fetch", "--quiet", place.policy.remote, `+refs/heads/${place.policy.into}:${place.ref}`], 60_000))
  const verdict = await driveAsync(judgeLandedSteps(place.cwd, place.ref, head))
  return verdict.landed ? undefined : `${workspace.branch || "its branch"} is not merged into ${place.place}`
}

export async function landedRunIDs(q: Pick<Quest, "extensions" | "sessions">, runIDs: string[], workspaces: QuestWorkspaces): Promise<string[]> {
  const landed: string[] = []
  for (const runID of runIDs) {
    if ((q.extensions.landings as Record<string, Landing> | undefined)?.[runID]?.state === "landed") { landed.push(runID); continue }
    const run = q.sessions.find(session => (session.runID ?? session.callID) === runID)
    const workspace = workspaces.get(runID)
    if (!run || run.state !== "completed" || !workspace || workspace.mode === "research" || workspace.mode === "shared") continue
    const branchHead = workspace.branch ? (await driveAsync(gitRun(workspace.root, ["rev-parse", "-q", "--verify", "refs/heads/" + workspace.branch + "^{commit}"], 30_000))).stdout.trim() : ""
    const head = branchHead || workspace.changes?.commits?.[0]
    if (!head || head === workspace.base) continue
    if (await unlandedDependency(q, run, workspaces) === undefined) landed.push(runID)
  }
  return landed
}
