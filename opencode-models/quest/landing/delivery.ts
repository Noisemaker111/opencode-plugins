import { existsSync, mkdirSync, readFileSync, watch } from "node:fs"
import { join } from "node:path"
import { commandRun, gitOut, gitOutput, gitRun, refRun, together, type GitResult, type GitSteps } from "./git-steps"
import { bootstrapStepTimeout, bootstrapWorkspacePath, landingCheck } from "../checkouts/workspace-bootstrap"
import type { QuestStore } from "../store"
import { stagesFromSteps } from "../core/steps"
import { LANDING_WORK_TYPE } from "../../models/routing-settings"
import { expandArgv } from "./delivery-policy.mjs"
import { retireCheckout } from "../checkouts/cleanup-git.mjs"
import { landedTops, reloadLanded, type ReloadOutcome } from "./landing-reload"
import { pendingUpdate, RESULT, reloadIfIdle, takeReloadResult } from "../../scripts/landing-quiet.mjs"
import { reloadDirectory } from "../../scripts/fresh-services.mjs"
import { servedRepository } from "../workers/update-drain"
import { landingTimeout } from "../../scripts/land.mjs"
import { isLandingStep, landingBranchLabel, rebaseStepID, RELOAD_FAILED_NOTE, RELOAD_FAILED_REQUIRES } from "./landing-step"
import type { QuestStage } from "../types"

export type DeliveryPolicy = { into: string; method: "pull-request" | "push" | "local-merge"; remote?: string; retire: boolean; landed: "remote" | "local"; pullRequest?: { open?: string[]; merge?: string[] } }
export type Landing = {
  state: "landed" | "blocked"; into: string; branch: string; at: string
  method?: "fast-forward" | "merge" | "already" | "push" | "pull-request" | "local-merge"
  head?: string; workerBranch?: string; workerHead?: string; intoHead?: string; remote?: string; reason?: string; output?: string
  policySource?: "settings" | "inferred"
  check?: { command: string; passed: true } | { command: null }
  conflict?: string[]
}
export type Judgement = { landed: true; how: "ancestor" | "cherry"; tip: string } | { landed: false; reason: string; tip?: string }

const GIT_TIMEOUT = 60000
const run = (cwd: string, args: string[]) => gitRun(cwd, args, GIT_TIMEOUT)
export const remoteRef = (policy: DeliveryPolicy) => policy.landed === "remote" ? `refs/remotes/${policy.remote}/${policy.into}` : `refs/heads/${policy.into}`

export function usesRepositoryLander(root: string, policy: DeliveryPolicy) {
  try {
    const config = JSON.parse(readFileSync(join(root, "land.config.json"), "utf8"))
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    return policy.method === "pull-request" && policy.landed === "remote" && !!policy.pullRequest?.merge?.length && existsSync(join(root, "scripts", "land.mjs")) && manifest.scripts?.land === "node scripts/land.mjs" &&
      config.base === policy.into && config.remote === policy.remote
  } catch { return false }
}

export function* judgeLandedSteps(cwd: string, ref: string, head: string): GitSteps<Judgement> {
  const [resolved, ancestor] = yield* together(refRun(cwd, ["rev-parse", "-q", "--verify", ref + "^{commit}"], GIT_TIMEOUT), refRun(cwd, ["merge-base", "--is-ancestor", head, ref], GIT_TIMEOUT))
  if (resolved.status !== 0) return { landed: false, reason: `${ref.replace(/^refs\/(?:remotes|heads)\//, "")} cannot be read` }
  const tip = resolved.stdout.trim()
  if (ancestor.status === 0) return { landed: true, how: "ancestor", tip }
  const cherry = yield* refRun(cwd, ["cherry", ref, head], GIT_TIMEOUT)
  if (cherry.status === 0 && !cherry.stdout.split(/\r?\n/).some(row => row.startsWith("+"))) return { landed: true, how: "cherry", tip }
  return { landed: false, reason: `${head.slice(0, 12)} is not in ${ref.replace(/^refs\/(?:remotes|heads)\//, "")}`, tip }
}

const tail = (result: GitResult) => (result.stderr + "\n" + result.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-6).join(" ")
export const conflictReason = (into: string, files: string[]) => `The branch conflicts with ${into} in ${files.length ? listed(files) : "files git did not name"}. A rebase step was added.`
const listed = (rows: string[]) => rows.slice(0, 8).join(", ") + (rows.length > 8 ? ` and ${rows.length - 8} more` : "")

export type RemoteLanding = { path: string; root: string; branch: string; policy: DeliveryPolicy; title: string; body: string; source: "settings" | "inferred"; base: string }

export function* landRemoteSteps(input: RemoteLanding): GitSteps<Landing | undefined> {
  const { path, root, branch, policy } = input, remote = policy.remote!, into = policy.into, ref = remoteRef(policy)
  const at = new Date().toISOString(), transcript: string[] = []
  const record = (label: string, result: GitResult) => { transcript.push(`$ ${label}\n${(result.stdout + result.stderr).trim()}`.trim()) }
  const stamp = function* () {
    const [current, known] = yield* together(run(path, ["rev-parse", "HEAD"]), refRun(path, ["rev-parse", "-q", "--verify", ref + "^{commit}"], GIT_TIMEOUT))
    return { head: gitOutput(current, ["rev-parse", "HEAD"]).trim(), intoHead: known.status === 0 ? known.stdout.trim() : undefined }
  }
  const blocked = function* (reason: string): GitSteps<Landing> {
    const now = yield* stamp()
    return { state: "blocked", into, branch, reason, at, remote, workerBranch: branch, workerHead: now.head, intoHead: now.intoHead, policySource: input.source, ...(transcript.length ? { output: transcript.join("\n") } : {}) }
  }
  const fetch = function* () {
    const result = yield* run(path, ["fetch", "--quiet", remote, `+refs/heads/${into}:${ref}`])
    record(`git fetch ${remote} ${into}`, result)
    return result
  }
  const exec = function* (label: string, argv: string[], body = input.body) {
    const values = { into, branch, head: (yield* gitOut(path, ["rev-parse", "HEAD"], GIT_TIMEOUT)).trim(), remote, title: input.title, body }
    const command = expandArgv(argv, values)
    const result = yield* commandRun(path, command, GIT_TIMEOUT, false)
    record(`${label}: ${command.join(" ")}`, result)
    return result
  }

  const status = (yield* gitOut(path, ["status", "--porcelain", "--untracked-files=all"], GIT_TIMEOUT)).split(/\r?\n/).filter(Boolean)
  if (status.length) return yield* blocked(`The worker left uncommitted files in ${path}; nothing was landed: ${listed(status.map(row => row.slice(3)))}`)

  if ((yield* gitOut(path, ["rev-parse", "HEAD"], GIT_TIMEOUT)).trim() === input.base) return undefined

  const fetched = yield* fetch()
  if (fetched.status !== 0) return yield* blocked(`Cannot read ${into} on ${remote}: ${tail(fetched)}`)

  let head = (yield* gitOut(path, ["rev-parse", "HEAD"], GIT_TIMEOUT)).trim()
  let checked: Landing["check"]
  const before = yield* judgeLandedSteps(path, ref, head)
  if (before.landed) return { state: "landed", into, branch, method: "already", head: before.tip, workerBranch: branch, workerHead: head, intoHead: before.tip, remote, at, policySource: input.source }
  if (usesRepositoryLander(root, policy)) {
    const pushed = yield* run(path, ["push", remote, `refs/heads/${branch}:refs/heads/${branch}`])
    record(`git push ${remote} ${branch}`, pushed)
    if (pushed.status !== 0) return yield* blocked(`Git refused to push ${branch} to ${remote}: ${tail(pushed)}`)
    const files = (yield* gitOut(path, ["diff", "--name-only", `${input.base}...HEAD`], GIT_TIMEOUT)).split(/\r?\n/).filter(Boolean)
    const body = [input.body, ...files].filter(Boolean).join("\n\n")
    if (policy.pullRequest?.open) {
      yield* exec("open", policy.pullRequest.open, body)
    }
    const deadline = Date.now() + landingTimeout(root)
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return yield* blocked(`The project lander still has ${branch} queued after its waiting deadline`)
      const landed = yield* commandRun(path, ["bun", "run", "land", branch], remaining)
      record(`bun run land ${branch}`, landed)
      const terminal = landed.stdout.trim().split(/\r?\n/).at(-1) ?? ""
      if ((landed.status === 0 || landed.status === 1) && /^waiting \(position \d+\)/.test(terminal)) continue
      if (landed.status !== 0 || !terminal.startsWith("landed "))
        return yield* blocked(`The project lander did not land ${branch}: ${tail(landed)}`)
      break
    }
    const refreshed = yield* fetch()
    if (refreshed.status !== 0) return yield* blocked(`The project lander reported a landing, but ${into} on ${remote} could not be read: ${tail(refreshed)}`)
    const after = yield* judgeLandedSteps(path, ref, head)
    if (!after.landed) return yield* blocked(`The project lander reported a landing, but ${branch} is not in ${remote}/${into}: ${after.reason}`)
    return { state: "landed", into, branch, method: "pull-request", head: after.tip, workerBranch: branch, workerHead: head, intoHead: after.tip, remote, at, policySource: input.source, output: transcript.join("\n") }
  }
  if ((yield* run(path, ["merge-base", "--is-ancestor", ref, head])).status !== 0) {
    const merged = yield* run(path, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${remote}/${into} into ${branch}`, ref])
    record(`git merge ${remote}/${into}`, merged)
    if (merged.status !== 0) {
      const files = (yield* gitOut(path, ["diff", "--name-only", "--diff-filter=U"], GIT_TIMEOUT)).split(/\r?\n/).filter(Boolean)
      yield* run(path, ["merge", "--abort"])
      return { ...(yield* blocked(conflictReason(into, files))), conflict: files }
    }
    head = (yield* gitOut(path, ["rev-parse", "HEAD"], GIT_TIMEOUT)).trim()
    const check = landingCheck(path)
    if (check) {
      const tested = yield* commandRun(bootstrapWorkspacePath(path, check), check.argv, bootstrapStepTimeout(check), check.shell)
      record(check.argv.join(" "), tested)
      if (tested.status !== 0) return yield* blocked(`${branch} merges cleanly with ${remote}/${into}, but \`${check.argv.join(" ")}\` fails on the combined tree (${tested.timedOut ? "timed out" : tested.error ? tested.error.message : tail(tested)}); the merge ${head.slice(0, 12)} stays on ${branch} and nothing was landed`)
      checked = { command: check.argv.join(" "), passed: true }
    }
  }

  if (policy.method === "push") {
    const pushed = yield* run(path, ["push", remote, `${head}:refs/heads/${into}`])
    record(`git push ${remote} ${head.slice(0, 12)}:${into}`, pushed)
    if (pushed.status !== 0) return yield* blocked(`Git refused to push ${branch} to ${remote}/${into}: ${tail(pushed)}`)
  } else {
    const pushed = yield* run(path, ["push", remote, `refs/heads/${branch}:refs/heads/${branch}`])
    record(`git push ${remote} ${branch}`, pushed)
    if (pushed.status !== 0) return yield* blocked(`Git refused to push ${branch} to ${remote}: ${tail(pushed)}`)
    const commands = policy.pullRequest
    if (commands?.open) yield* exec("open", commands.open)
    if (commands?.merge) yield* exec("merge", commands.merge)
    if (!commands?.merge) {
      const refreshed = yield* fetch()
      const after = refreshed.status === 0 ? yield* judgeLandedSteps(path, ref, head) : undefined
      if (!after?.landed) return yield* blocked(`${branch} is pushed to ${remote} and waits to be merged into ${into}; set a delivery policy with pullRequest commands for this project (quest delivery) to have it merged`)
    }
  }

  yield* fetch()
  const after = yield* judgeLandedSteps(path, ref, head)
  if (!after.landed) return yield* blocked(`${branch} is not in ${remote}/${into} after ${policy.method}: ${after.reason}`)
  return { state: "landed", into, branch, method: policy.method, head: after.tip, workerBranch: branch, workerHead: head, intoHead: after.tip, remote, at, policySource: input.source, ...(checked ? { check: checked } : {}), ...(transcript.length ? { output: transcript.join("\n") } : {}) }
}

export const sameLanding = (a: Landing, b: Landing) => a.state === b.state && a.reason === b.reason && a.workerHead === b.workerHead && a.intoHead === b.intoHead && a.head === b.head

export function recordLanding(store: QuestStore, questID: string, runID: string, landing: Landing, root?: string): Promise<ReloadOutcome> | undefined {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = store.read(questID)
    if (!current) return
    try { store.apply(questID, "patched", { extensions: { ...current.extensions, landings: { ...(current.extensions.landings as Record<string, unknown> ?? {}), [runID]: landing } } }, "quest:land", { expectedRevision: current.revision }); break }
    catch (error) { if (attempt === 2) throw error }
  }
  if (landing.state === "blocked" && landing.conflict) addRebaseStep(store, questID, runID, landing)
  return landing.state === "landed" && root ? reloadAndRecord(store, questID, runID, root) : undefined
}

export type ReloadRecord = { ok: boolean; text: string; revision?: string; at: string }

export const reloadRecords = (extensions: Record<string, unknown>) => (extensions.reloads ?? {}) as Record<string, ReloadRecord>

const reloading = new Set<string>()
const waiterKey = (store: QuestStore, questID: string, runID: string) => store.runtime + "\u0000" + questID + "\u0000" + runID

export function reloadAndRecord(store: QuestStore, questID: string, runID: string, root: string): Promise<ReloadOutcome> {
  const key = waiterKey(store, questID, runID)
  if (reloading.has(key)) return Promise.resolve({ ok: true, text: "the services are reloading" })
  reloading.add(key)
  return reloadLanded(root, { questID, runID }).then(outcome => { if (!outcome.ok) reloading.delete(key); return outcome })
}

export const reloadInFlight = (store: QuestStore, questID: string, runID: string) => reloading.has(waiterKey(store, questID, runID))

export function applyLandedReloads(store: QuestStore, tops: Iterable<string>): void {
  for (const top of tops) {
    const result = takeReloadResult(top)
    if (!result) continue
    for (const waiter of result.waiting ?? []) {
      recordReload(store, waiter.questID, waiter.runID, result)
      reloading.delete(waiterKey(store, waiter.questID, waiter.runID))
    }
  }
}

export function reloadWhenWorkersEnd(store: QuestStore, ended = true): void {
  const served = servedRepository()
  const tops = new Set(landedTops)
  if(served&&pendingUpdate(served))tops.add(served)
  if(!tops.size)return
  try{
    applyLandedReloads(store,tops)
    if(ended)for(const repository of tops)reloadIfIdle(repository)
  }catch(error){console.error("[quests] landing reload",error)}
}

export function watchLandedReloads(store: QuestStore, onResult: () => void = () => reloadWhenWorkersEnd(store, false), top = servedRepository()): () => void {
  if (!top) return () => {}
  const dir = reloadDirectory(top)
  mkdirSync(dir, { recursive: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const watcher = watch(dir, (_, file) => {
    if (String(file ?? "") !== RESULT) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(onResult, 200)
    timer.unref?.()
  })
  watcher.on("error", () => {})
  watcher.unref?.()
  onResult()
  return () => { if (timer) clearTimeout(timer); watcher.close() }
}

export function recordReload(store: QuestStore, questID: string, runID: string, outcome: ReloadOutcome) {
  const record: ReloadRecord = { ok: outcome.ok, text: outcome.text, ...(outcome.revision ? { revision: outcome.revision } : {}), at: new Date().toISOString() }
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = store.read(questID)
    if (!current) return
    const stages = blockLandingOnFailedReload(current.stages, record)
    try { store.apply(questID, "patched", { ...(stages ? { stages } : {}), extensions: { ...current.extensions, reloads: { ...reloadRecords(current.extensions), [runID]: record } } }, "quest:reload", { expectedRevision: current.revision }); return }
    catch (error) { if (attempt === 2) throw error }
  }
}

function blockLandingOnFailedReload(stages: QuestStage[], record: ReloadRecord): QuestStage[] | undefined {
  const step = stages.find(isLandingStep)
  if (record.ok || !step || step.status === "done") return
  const next = structuredClone(stages), landing = next.find(isLandingStep)!
  landing.status = "blocked"
  landing.note = RELOAD_FAILED_NOTE + record.text
  landing.blocker = { kind: "environment", owner: "Quest Giver", requires: RELOAD_FAILED_REQUIRES }
  delete landing.resolution
  return next
}

export { rebaseStepID }

function addRebaseStep(store: QuestStore, questID: string, runID: string, landing: Landing) {
  const branch = landing.workerBranch ?? landing.branch, files = landing.conflict ?? [], id = rebaseStepID(landing.into)
  const named = files.length ? files.join(", ") : "the files git reports"
  const detail = `Rebase ${branch} onto ${landing.into}, resolve the conflicts in ${named}, run the project checks and land it.`
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = store.read(questID)
    if (!current) return
    const stages = structuredClone(current.stages), existing = stages.find(stage => stage.id === id)
    const ownRun = current.sessions.find(run => (run.runID ?? run.callID) === runID)
    if (existing && !ownRun?.deliverables.includes(id)) return
    if (!existing) stages.push({ ...stagesFromSteps([{ id, title: `Rebase onto ${landingBranchLabel(landing.into)} and land`, detail, workType: LANDING_WORK_TYPE }])[0], status: "pending", housekeeping: "rebase" })
    else {
      const landings = (current.extensions.landings ?? {}) as Record<string, Landing>
      const failures = current.sessions.filter(run => run.deliverables.includes(id) && landings[run.runID ?? run.callID]?.conflict).length
      existing.detail = detail
      existing.workType ??= LANDING_WORK_TYPE
      if (failures >= 2) {
        existing.status = "blocked"
        existing.note = `The rebase step failed twice: ${branch} still conflicts with ${landing.into} in ${named}.`
        existing.blocker = { kind: "work", owner: "Quest Giver", requires: `Decide how to land ${branch}: rebasing it onto ${landing.into} failed twice.` }
      } else if (existing.status !== "working") { existing.status = "pending"; delete existing.blocker }
    }
    try { store.apply(questID, "patched", { stages }, "quest:land", { expectedRevision: current.revision }); return }
    catch (error) { if (attempt === 2) throw error }
  }
}

export const retire = retireCheckout as (input: { root: string; path?: string; branch?: string; head?: string; tagName?: string; landedRef?: string; remote?: string; deleteRemoteBranch?: boolean; holds?: string[]; requireOwnCommit?: boolean }) => { retired: boolean; reason?: string; tip?: string; remoteDeleted?: boolean }
