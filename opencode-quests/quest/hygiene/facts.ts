import { existsSync } from "node:fs"
import { latestSessionAttempts, OWNED_RUN } from "../runs/session-lineage"
import { reworkedRun } from "../review/review-record"
import { readOnly, landingLocation } from "../landing/settle"
import { driveAsync, gitRun, refRun } from "../landing/git-steps"
import { judgeLandedSteps } from "../landing/delivery"
import { readEvents } from "../core/journal"
import { normalizeRequestText } from "../runs/duplicates"
import { QuestWorkspaces, type Workspace } from "../workspaces"
import type { QuestStore } from "../store"
import type { Quest } from "../types"
import { progressAt } from "./progress"
import type { Facts, Landing } from "./verdict"

const runID = (run: Quest["sessions"][number]) => run.runID ?? run.callID
const checkable = (workspace: Workspace | undefined): workspace is Workspace =>
  !!workspace && !workspace.removed && workspace.mode !== "research" && workspace.mode !== "shared" && existsSync(workspace.path)

async function landingFacts(q: Quest, workspaces: QuestWorkspaces): Promise<Landing> {
  if (readOnly(q)) return { state: "none" }
  const judged: Array<{ ok: true; evidence: string } | { ok: false; reason: string }> = []
  for (const run of latestSessionAttempts(q.sessions)) {
    if (run.agentRole === "command" || (run.scope as { readOnly?: unknown } | undefined)?.readOnly === true || reworkedRun(q, run)) continue
    const workspace = workspaces.get(runID(run))
    if (!workspace || workspace.mode === "research" || !workspace.changes?.commits?.[0]) continue
    try {
      const place = await landingLocation(workspace, workspaces)
      const branch = workspace.branch ? (await driveAsync(refRun(workspace.root, ["rev-parse", "-q", "--verify", "refs/heads/" + workspace.branch + "^{commit}"], 30_000))).stdout.trim() : ""
      const verdict = await driveAsync(judgeLandedSteps(place.cwd, place.ref, branch || workspace.changes.commits[0]))
      judged.push(verdict.landed
        ? { ok: true, evidence: `Its work is already in ${place.place} at ${verdict.tip.slice(0, 12)} (${verdict.how === "cherry" ? "same change, different commit" : "merged"}).` }
        : { ok: false, reason: `${workspace.branch || "Its branch"} is not in ${place.place} yet.` })
    } catch (error) {
      judged.push({ ok: false, reason: `Its landing place cannot be read: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  if (!judged.length) return { state: "none" }
  const open = judged.find(row => !row.ok)
  if (open && !open.ok) return { state: "unlanded", reason: open.reason }
  return { state: "landed", evidence: judged.map(row => row.ok ? row.evidence : "").join(" ").trim() }
}

async function dirtyFacts(q: Quest, workspaces: QuestWorkspaces): Promise<string | undefined> {
  for (const run of latestSessionAttempts(q.sessions)) {
    const workspace = workspaces.get(runID(run))
    if (!checkable(workspace)) continue
    const status = await driveAsync(gitRun(workspace.path, ["status", "--porcelain"], 30_000))
    if (status.status === 0 && status.stdout.trim()) return `Its worktree has uncommitted changes on ${workspace.branch || "its branch"}; nothing was archived.`
  }
}

function failedStarts(q: Quest): Facts["failedStarts"] {
  const runs = q.sessions.filter(run => run.agentRole !== "command").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  let count = 0, last: (typeof runs)[number] | undefined
  for (const run of runs) {
    if (run.state !== "failed") break
    count++
    last ??= run
  }
  const reason = last ? (last.result || last.evidence?.at(-1) || "no reason was saved").slice(0, 120) : ""
  return { count, reason }
}

export function keeperOf(q: Quest, open: Quest[]): string | undefined {
  const objective = normalizeRequestText(q.objective)
  const keeper = open.find(other => other.id !== q.id && (other.project?.id ?? "") === (q.project?.id ?? "")
    && (other.createdAt < q.createdAt || other.createdAt === q.createdAt && other.id < q.id)
    && (!!q.requestFingerprint && other.requestFingerprint === q.requestFingerprint || objective !== "" && normalizeRequestText(other.objective) === objective))
  return keeper ? keeper.ref ?? keeper.id : undefined
}

export function linked(q: Quest, open: Quest[]): boolean {
  const rel = q.relationships
  if ((rel.dependencies?.length ?? 0) + (rel.parents?.length ?? 0) + (rel.subquests?.length ?? 0) > 0) return true
  return open.some(other => other.id !== q.id && (other.relationships?.dependencies?.includes(q.id) || other.relationships?.parents?.includes(q.id) || other.relationships?.subquests?.includes(q.id)))
}

export async function questFacts(store: Pick<QuestStore, "runtime">, q: Quest, open: Quest[], workspaces: QuestWorkspaces): Promise<Facts> {
  const [landing, dirty] = await Promise.all([landingFacts(q, workspaces), dirtyFacts(q, workspaces)])
  return {
    running: latestSessionAttempts(q.sessions).some(run => OWNED_RUN.has(run.state)),
    landing,
    dirty,
    failedStarts: failedStarts(q),
    linked: linked(q, open),
    keeper: keeperOf(q, open),
    progressAt: progressAt(q, readEvents(store.runtime, q.id)),
  }
}
