import { createHash } from "node:crypto"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import {writeFileDurable,readJsonRecord} from "../core/durable-file.mjs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { acquireLock } from "../locking.mts"
import { projectIdentity, projectIdentityAsync, type ProjectIdentity } from "../core/project"
import { driveAsync, gitRun } from "../landing/git-steps"
import { QuestStore } from "../store"
import { QuestError } from "../api"

export type Participant = {
  id: string; host: string; sessionID: string; title: string; questID?: string
  checkout: string; branch: string | null; head: string | null
  scopes: string[]; activity: string; updatedAt: number; releasedAt?: number
}
export type CoordinationContext = { directory: string; sessionID: string; host: string }
const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
function git(directory: string, args: string[]) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true })
  return result.status === 0 ? result.stdout.trim() : null
}
type Tree = { path: string; branch: string | null; head: string | null }
function checkout(directory: string): Tree {
  const path = realpathSync(git(directory, ["rev-parse", "--show-toplevel"]) ?? directory)
  return { path, branch: git(path, ["symbolic-ref", "--short", "HEAD"]), head: git(path, ["rev-parse", "HEAD"]) }
}
async function gitAsync(directory: string, args: string[]) {
  const result = await driveAsync(gitRun(directory, args))
  return result.status === 0 ? result.stdout.trim() : null
}
async function checkoutAsync(directory: string): Promise<Tree> {
  const path = realpathSync(await gitAsync(directory, ["rev-parse", "--show-toplevel"]) ?? directory)
  const [branch, head] = await Promise.all([gitAsync(path, ["symbolic-ref", "--short", "HEAD"]), gitAsync(path, ["rev-parse", "HEAD"])])
  return { path, branch, head }
}
function scopesFor(root: string, scopes: unknown): string[] {
  if (!Array.isArray(scopes) || scopes.length > 100) throw new QuestError("INVALID_INPUT", "scopes must contain at most 100 relative files or directories")
  return [...new Set(scopes.map(scope => {
    if (typeof scope !== "string" || !scope.trim() || /[\0*?\[\]]/.test(scope) || isAbsolute(scope)) throw new QuestError("INVALID_INPUT", "Use literal relative paths; use . for the entire checkout")
    const path = resolve(root, scope), rel = relative(root, path)
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new QuestError("INVALID_INPUT", "Reservation escapes the checkout")
    let ancestor = path
    while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor)
    const actual = resolve(realpathSync(ancestor), relative(ancestor, path))
    const actualRel = relative(realpathSync(root), actual)
    if (actualRel === ".." || actualRel.startsWith("../") || actualRel.startsWith("..\\") || isAbsolute(actualRel)) throw new QuestError("INVALID_INPUT", "Reservation resolves outside the checkout")
    return actualRel.replaceAll("\\", "/") || "."
  }))].sort()
}
const overlaps = (a: string, b: string) => a === "." || b === "." || key(a) === key(b) || key(a).startsWith(key(b) + "/") || key(b).startsWith(key(a) + "/")

export function coordination(store: QuestStore, context: CoordinationContext, now = Date.now()) {
  return ledger(store, context, projectIdentity(context.directory), checkout(context.directory), now)
}
export async function coordinationAsync(store: QuestStore, context: CoordinationContext, now = Date.now()) {
  const [project, tree] = await Promise.all([projectIdentityAsync(context.directory), checkoutAsync(context.directory)])
  return ledger(store, context, project, tree, now)
}
function ledger(store: QuestStore, context: CoordinationContext, project: ProjectIdentity, tree: Tree, now: number) {
  if (!context.sessionID || !context.host) throw new QuestError("HOST_CONTEXT_REQUIRED", "A host and session identity are required")
  const id = hash(context.host + ":" + context.sessionID)
  const file = join(store.runtime, "coordination", project.id + ".json")
  const read = (): Participant[] => {
    const state = readJsonRecord(file)
    if (state === undefined) return []
    if (state.version !== 1 || !Array.isArray(state.participants)) throw new Error("Unreadable coordination ledger; preserving it")
    return state.participants
  }
  const view = (rows: Participant[]) => ({
    participantID: id, project, checkout: tree.path, branch: tree.branch, head: tree.head,
    participants: rows.filter(row => !row.releasedAt).map(row => ({ ...row, stale: now - row.updatedAt > 5 * 60_000, sameCheckout: key(row.checkout) === key(tree.path) })),
    coordination: "cooperative" as const,
  })
  return (input: { action: string; title?: string; questID?: string; scopes?: string[]; activity?: string; participantID?: string; reason?: string }) => {
    if (input.action === "status") return view(read())
    const lock = acquireLock(store.runtime, "coordination-" + project.id)
    try {
      const rows = read(), prior = rows.find(row => row.id === id && !row.releasedAt)
      if (input.action === "release") {
        if (prior) { prior.releasedAt = now; prior.activity = input.activity ?? prior.activity }
      } else if (input.action === "recover") {
        const target = rows.find(row => row.id === input.participantID && !row.releasedAt)
        if (!target || now - target.updatedAt <= 5 * 60_000 || !input.reason?.trim()) throw new QuestError("RECOVERY_REQUIRED", "Recovery needs a stale participant ID and a reason confirming its editor has stopped")
        target.releasedAt = now; target.activity = "Recovered: " + input.reason
      } else if (input.action === "join" || input.action === "update") {
        if (input.action === "update" && !prior) throw new QuestError("NOT_JOINED", "Join this checkout before updating activity")
        const title = input.title ?? prior?.title
        if (!title?.trim() || title.length > 300 || (input.activity?.length ?? 0) > 2000) throw new QuestError("INVALID_INPUT", "Supply a short work title and activity")
        if (prior && key(prior.checkout) !== key(tree.path)) throw new QuestError("CHECKOUT_CHANGED", "Release your previous checkout before joining another")
        if (prior && prior.branch !== tree.branch && !prior.scopes.includes(".")) throw new QuestError("BRANCH_CHANGED", "The checkout branch changed during your work; inspect changes and release before joining again")
        const scopes = scopesFor(tree.path, input.scopes ?? prior?.scopes ?? [])
        const questID = input.questID ?? prior?.questID
        if (questID && store.read(questID)?.project?.id !== project.id) throw new QuestError("PROJECT_MISMATCH", "The Quest must belong to this project")
        const conflicts = rows.filter(row => !row.releasedAt && row.id !== id && key(row.checkout) === key(tree.path) && (scopes.includes(".") || row.scopes.includes(".") || row.scopes.some(a => scopes.some(b => overlaps(a, b)))))
        if (conflicts.length) return { ...view(rows), acquired: false, conflicts }
        const participant: Participant = { id, host: context.host, sessionID: context.sessionID, title, questID, checkout: tree.path, branch: tree.branch, head: tree.head, scopes, activity: input.activity ?? prior?.activity ?? "Working", updatedAt: now }
        const index = rows.findIndex(row => row.id === id)
        if (index < 0) rows.push(participant); else rows[index] = participant
      } else throw new QuestError("INVALID_OPERATION", "Use status, join, update, release or recover")
      mkdirSync(dirname(file), { recursive: true })
      writeFileDurable(file, JSON.stringify({ version: 1, participants: rows }, null, 2))
      return { ...view(rows), acquired: input.action === "join" || input.action === "update" }
    } finally { lock.release() }
  }
}

export const COORDINATION_INPUT = {
  type: "object", additionalProperties: false, required: ["action"], properties: {
    action: { type: "string", enum: ["status", "join", "update", "release", "recover"] },
    title: { type: "string", maxLength: 300 }, questID: { type: "string" },
    scopes: { type: "array", maxItems: 100, items: { type: "string" }, description: "Literal checkout-relative file/directory paths. . reserves the whole checkout; [] announces presence only." },
    activity: { type: "string", maxLength: 2000 }, participantID: { type: "string" },
    reason: { type: "string", description: "For recover: explain how you confirmed the stale editor has stopped. Age alone is insufficient." },
  },
}
export const COORDINATION_DESCRIPTION = "Coordinate editors in a shared checkout. status shows OpenCode/Codex participants, activity, branches and reservations. join/update atomically reserve literal files/directories; acquired=false means stop before editing conflicting paths. Refresh activity during work and release when finished. Reserve . exclusively before Git checkout/switch, merge, rebase, reset or staging/committing. Stale reservations remain held until the editor stops and explicit recovery records why. Cooperative awareness does not intercept shell commands or editors."
