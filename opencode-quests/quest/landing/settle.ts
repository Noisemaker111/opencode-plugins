import { existsSync } from "node:fs"
import { completionMissing } from "../workers/completion"
import { deliveredResult } from "../board/result-card"
import { readAllQuests } from "../index"
import { readContinuations, v2QueueGeneration } from "../core/runtime-queues"
import { latestSessionAttempts, OWNED_RUN, TERMINAL_RUN } from "../runs/session-lineage"
import { requestQuestAttention } from "../runs/start-request"
import { heard } from "../giver/giver-handoff"
import { questWorkflow } from "../runs/workflow"
import { QuestWorkspaces, type Workspace } from "../workspaces"
import { judgeLandedSteps, reloadAndRecord, reloadInFlight, reloadRecords, remoteRef, recordLanding, sameLanding, type DeliveryPolicy, type Landing } from "./delivery"
import { isLandingStep, landingDone, workDone } from "./landing-step"
import { driveAsync, gitRun, refRun } from "./git-steps"
import { reworkedRun } from "../review/review-record"
import { landedPlaces } from "../workers/completion-return"
import { timed } from "../../scripts/plugin-spans"
import type { QuestStore } from "../store"
import type { Quest, QuestSession } from "../types"

export type Delivery = { delivered: true; where: string } | { delivered: false; reason: string }

const runGit = (cwd: string, args: string[]) => driveAsync(gitRun(cwd, args, 30_000))
const refGit = (cwd: string, args: string[]) => driveAsync(refRun(cwd, args, 30_000))
const quoted = (value: string) => `"${value}"`
const runID = (run: QuestSession) => run.runID ?? run.callID

export function readOnly(q: Quest): boolean {
  try { if (questWorkflow(q).readOnly === true) return true } catch {}
  const runs = q.sessions.filter(run => run.agentRole !== "command")
  return runs.length > 0 && runs.every(run => (run.scope as { readOnly?: unknown } | undefined)?.readOnly === true)
}

type Judged = { policy: DeliveryPolicy; ref: string; cwd: string; place: string }
type Targets = Map<string, Judged | Error>

export const landingLocation = async (workspace: Workspace, workspaces: QuestWorkspaces): Promise<Judged> => {
  const { policy } = await driveAsync(workspaces.deliveryPolicySteps(workspace))
  return { policy, ref: remoteRef(policy), cwd: policy.landed === "remote" ? workspace.root : workspace.source ?? workspace.root, place: policy.landed === "remote" ? `${policy.remote}/${policy.into}` : policy.into }
}

async function locate(workspace: Workspace, workspaces: QuestWorkspaces, targets: Targets): Promise<Judged | Error> {
  const key = workspace.root + "\u0000" + (workspace.source ?? "")
  let judged = targets.get(key)
  if (!judged) { try { judged = await landingLocation(workspace, workspaces) } catch (error) { judged = error instanceof Error ? error : new Error(String(error)) } targets.set(key, judged) }
  return judged
}

const unsaved = (workspace: Workspace): string | undefined => {
  if (workspace.mode === "shared" || workspace.changes?.commits?.[0]) return
  const kept = workspace.cleanup?.preserved?.ref
  if (kept) return `The worker kept its work only at ${kept}; nothing is committed on ${workspace.branch}.`
  const files = workspace.changes?.files.length ?? 0
  if (files) return `The worker left ${files} changed file${files === 1 ? "" : "s"} uncommitted on ${workspace.branch}.`
}

const missingWorkspace = (run: QuestSession, workspace: Workspace | undefined): string | undefined =>
  !workspace && run.state === "completed" ? `no workspace record says where ${quoted(run.sessionTitle ?? runID(run))} left its work` : undefined

export async function questDelivery(q: Quest, workspaces: QuestWorkspaces, targets: Targets = new Map()): Promise<Delivery> {
  if (readOnly(q)) {
    const silent = q.stages.filter(step => !step.note?.trim())
    return silent.length ? { delivered: false, reason: `no answer is saved on ${silent.map(step => quoted(step.title)).join(", ")}` } : { delivered: true, where: "its answer is saved on the Quest" }
  }
  const places = new Set<string>()
  for (const run of latestSessionAttempts(q.sessions)) {
    if (run.agentRole === "command" || (run.scope as { readOnly?: unknown } | undefined)?.readOnly === true || reworkedRun(q, run)) continue
    const workspace = workspaces.get(runID(run))
    const missing = missingWorkspace(run, workspace)
    if (missing) return { delivered: false, reason: missing }
    if (!workspace || workspace.mode === "research") continue
    const tip = workspace.changes?.commits?.[0]
    if (!tip) {
      const why = unsaved(workspace)
      if (why) return { delivered: false, reason: why }
      continue
    }
    const [judged, branchHead] = await Promise.all([locate(workspace, workspaces, targets), workspace.branch ? refGit(workspace.root, ["rev-parse", "-q", "--verify", "refs/heads/" + workspace.branch + "^{commit}"]).then(read => read.stdout.trim()) : ""])
    if (judged instanceof Error) return { delivered: false, reason: `blocked: ${judged.message}` }
    const verdict = await driveAsync(judgeLandedSteps(judged.cwd, judged.ref, branchHead || tip))
    if (!verdict.landed) {
      const landing = (q.extensions.landings as Record<string, { state?: string; reason?: string }> | undefined)?.[runID(run)]
      return { delivered: false, reason: landing?.state === "blocked" && landing.reason ? `blocked: ${landing.reason}` : `${workspace.branch || "its worker branch"} has not landed in ${judged.place} yet` }
    }
    places.add(judged.place)
  }
  return { delivered: true, where: places.size ? `its commits landed in ${[...places].join(" and ")}` : "it left nothing to deliver" }
}

export function landedDelivery(q: Quest): Extract<Delivery, { delivered: true }> | undefined {
  if (!landingDone(q.stages)) return
  const places = landedPlaces(q)
  return { delivered: true, where: places.length ? `its commits landed in ${places.join(" and ")}` : "it left nothing to deliver" }
}

const finished = (q: Quest) => q.stages.length > 0 && q.stages.every(step => step.status === "done")
const running = (q: Quest) => latestSessionAttempts(q.sessions).some(run => OWNED_RUN.has(run.state))
const awaitingLanding = (q: Quest) => workDone(q.stages) && q.stages.find(isLandingStep)?.status === "pending"

export type LandingProof = { proven: true; note: string } | { proven: false; reason: string }

const short = (sha: string) => sha.slice(0, 12)

const currentBase = (landings: Record<string, Landing>) => Object.values(landings).filter(row => row.state === "landed").sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.into

export const landedElsewhere = (landings: Record<string, Landing>, id: string) => {
  const into = currentBase(landings), row = landings[id]
  return !!row && !!into && row.into !== into
}

export async function landingProof(store: QuestStore, q: Quest, workspaces: QuestWorkspaces): Promise<LandingProof> {
  if (readOnly(q)) return { proven: true, note: "Nothing to land: this Quest changes no files." }
  const landings = (q.extensions.landings ?? {}) as Record<string, Landing>, reloads = reloadRecords(q.extensions), lines: string[] = []
  for (const run of latestSessionAttempts(q.sessions)) {
    if (run.agentRole === "command" || (run.scope as { readOnly?: unknown } | undefined)?.readOnly === true || reworkedRun(q, run) || landedElsewhere(landings, runID(run))) continue
    const id = runID(run), workspace = workspaces.get(id)
    const missing = missingWorkspace(run, workspace)
    if (missing) return { proven: false, reason: missing }
    if (!workspace || workspace.mode === "research") continue
    if (!workspace.changes?.commits?.[0]) {
      const why = unsaved(workspace)
      if (why) return { proven: false, reason: why }
      continue
    }
    const recorded = landings[id]
    let landing = recorded?.state === "landed" && recorded.head ? { into: recorded.into, head: recorded.head } : undefined
    if (!landing) {
      const judged = await locate(workspace, workspaces, new Map())
      if (judged instanceof Error) return { proven: false, reason: `the landing place cannot be read: ${judged.message}` }
      const branchHead = workspace.branch ? (await refGit(workspace.root, ["rev-parse", "-q", "--verify", "refs/heads/" + workspace.branch + "^{commit}"])).stdout.trim() : ""
      const verdict = await driveAsync(judgeLandedSteps(judged.cwd, judged.ref, branchHead || workspace.changes.commits[0]))
      if (!verdict.landed) return { proven: false, reason: recorded?.state === "blocked" ? `the landing was refused: ${recorded.reason ?? "no reason was saved"}` : `${workspace.branch || "the worker branch"} is not merged into ${judged.place} yet` }
      landing = { into: judged.place, head: verdict.tip }
      await recordLanding(store, q.id, id, { state: "landed", into: judged.place, head: verdict.tip, branch: workspace.branch, method: "already", at: new Date().toISOString() })
    }
    const reload = reloads[id]
    if (!reload || !reload.ok) {
      if (reloadInFlight(store, q.id, id)) return { proven: false, reason: `the services are reloading after the merge into ${landing.into}` }
      if (reload && !reload.ok && q.stages.find(isLandingStep)?.status !== "pending") return { proven: false, reason: `the services did not reload: ${reload.text}` }
      if (!reloadAndRecord(store, q.id, id, workspace.root)) return { proven: false, reason: "this Quest host has no service reload installed, so the reload cannot be recorded" }
      return { proven: false, reason: `the services are reloading after the merge into ${landing.into}` }
    }
    if (!reload.revision) return { proven: false, reason: "the reload record names no revision" }
    const contained = reload.revision === landing.head || (await refGit(workspace.root, ["merge-base", "--is-ancestor", landing.head, reload.revision])).status === 0
    if (!contained) return { proven: false, reason: `the services were reloaded at ${short(reload.revision)}, which does not hold the merge ${short(landing.head)}` }
    lines.push(`Merged into ${landing.into} at ${short(landing.head)}; the services were reloaded at ${short(reload.revision)}.`)
  }
  return { proven: true, note: lines.length ? [...new Set(lines)].join(" ") : "Nothing to land: the workers left no commits." }
}

export async function settleLandingStep(store: QuestStore, q: Quest, workspaces = new QuestWorkspaces(store.runtime)): Promise<Quest> {
  if (q.contractVersion !== 2 || q.archive || q.delivered || q.state === "Archived" || running(q) || !awaitingLanding(q)) return q
  const proof = await landingProof(store, q, workspaces)
  if (!proof.proven) return q
  const current = store.read(q.id)
  if (!current || current.revision !== q.revision) return current ?? q
  const stages = current.stages.map(step => isLandingStep(step) ? { ...step, status: "done" as const, note: proof.note } : step)
  return store.apply(q.id, "patched", { stages }, "quest:landing-proven", { expectedRevision: current.revision })
}

const UNLANDED_WHERE = /task branch|worker branch|not (?:yet )?on v2|not merged/i

export function turnIn(store: QuestStore, id: string, delivery: Extract<Delivery, { delivered: true }>): Quest | undefined {
  const q = store.read(id)
  if (!q || q.contractVersion !== 2 || q.archive || q.delivered || q.state === "Archived" || !finished(q) || completionMissing(q).length) return
  const where = delivery.where[0].toUpperCase() + delivery.where.slice(1) + "."
  const reward = q.reward?.trim() ? q.reward : [...q.stages.map(step => step.note?.trim() ? `${step.title}: ${step.note.trim()}` : step.title), where].join("\n\n")
  const drafted = deliveredResult(q, delivery.where)
  const result = landingDone(q.stages) && UNLANDED_WHERE.test(drafted.where) ? { ...drafted, where } : drafted
  return store.apply(id, "patched", { reward, result, delivered: { at: new Date().toISOString(), where: `Turned in automatically: every step is done and ${delivery.where}` } }, "quest:turn-in", { expectedRevision: q.revision })
}

export async function turnInDelivered(store: QuestStore, q: Quest): Promise<Quest> {
  if (q.contractVersion !== 2 || q.archive || q.delivered || q.state === "Archived" || running(q)) return q
  try {
    const workspaces = new QuestWorkspaces(store.runtime)
    if (awaitingLanding(q)) q = await settleLandingStep(store, q, workspaces)
    if (!finished(q)) return q
    const delivery = landedDelivery(q) ?? await questDelivery(q, workspaces)
    return delivery.delivered ? turnIn(store, q.id, delivery) ?? store.read(q.id) ?? q : q
  } catch (error) { console.error("[quests] turn-in", q.id, error); return store.read(q.id) ?? q }
}

const judged = new Map<string, { revision: number; delivery: Delivery }>()
const decided = new Map<string, string>()

export async function settleQuests(store: QuestStore, options: { only?: Set<string>; refs?: boolean } = {}): Promise<{ turnedIn: string[]; noticed: string[] }> {
  const workspaces = new QuestWorkspaces(store.runtime), targets: Targets = new Map()
  const out = { turnedIn: [] as string[], noticed: [] as string[] }
  let open: Set<string> | undefined
  const continuing = (id: string) => (open ??= new Set(readContinuations(store.runtime).filter(row => !["done", "stopped"].includes(row.state)).map(row => row.questID))).has(id)
  const candidates = readAllQuests(store.projectRoot).flatMap(({ quest }) => quest && quest.contractVersion === 2 && !quest.archive && !quest.delivered && quest.state !== "Archived" && (!options.only || options.only.has(quest.id)) && quest.sessions.length && !running(quest) ? [quest] : [])
  await Promise.all(candidates.map(async candidate => {
    let quest = candidate
    const key = store.runtime + "\0" + quest.id
    let delivery: Delivery | undefined
    if (awaitingLanding(quest)) {
      try { quest = await settleLandingStep(store, quest, workspaces) } catch (error) { console.error("[quests] landing step", quest.id, error) }
      if (awaitingLanding(quest)) return
    }
    if (finished(quest)) {
      const prior = judged.get(key)
      const landed = landedDelivery(quest)
      if (landed) delivery = landed
      else if (!options.refs && prior?.revision === quest.revision) delivery = prior.delivery
      else {
        try { delivery = await questDelivery(quest, workspaces, targets) } catch (error) { delivery = { delivered: false, reason: error instanceof Error ? error.message : String(error) } }
        judged.set(key, { revision: quest.revision, delivery })
      }
      if (delivery.delivered) {
        try { if (turnIn(store, quest.id, delivery)) out.turnedIn.push(quest.id) } catch (error) { console.error("[quests] turn-in", quest.id, error) }
        return
      }
    }
    const last = latestSessionAttempts(quest.sessions).filter(run => TERMINAL_RUN.has(run.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1)
    if (!last) return
    const reason = delivery && !delivery.delivered ? delivery.reason : undefined
    const situation = [quest.revision, runID(last), reason ?? ""].join("\0")
    if (decided.get(key) === situation) return
    const told = heard(store.runtime, last)
    if (told === "pending" || told === "silent" && continuing(quest.id)) return
    decided.set(key, situation)
    if (told === "heard") return
    try { if (requestQuestAttention(store, quest.id, runID(last), reason, v2QueueGeneration())) out.noticed.push(quest.id) } catch (error) { console.error("[quests] attention", quest.id, error) }
  }))
  return out
}

const retrying = new Set<string>()

export async function retryLandings(store: QuestStore, options: { only?: Set<string> } = {}): Promise<string[]> {
  const workspaces = new QuestWorkspaces(store.runtime), started: string[] = [], targets: Targets = new Map()
  const quests = readAllQuests(store.projectRoot).flatMap(({ quest }) => quest && quest.contractVersion === 2 && !quest.archive && !quest.delivered && quest.state !== "Archived" && !readOnly(quest) && (!options.only || options.only.has(quest.id)) && quest.sessions.length && !running(quest) && workDone(quest.stages) ? [quest] : [])
  await Promise.all(quests.flatMap(quest => latestSessionAttempts(quest.sessions).map(async run => {
    const id = runID(run), key = store.runtime + "\u0000" + id
    if (run.agentRole === "command" || run.state !== "completed" || (run.scope as { readOnly?: unknown } | undefined)?.readOnly === true || reworkedRun(quest, run) || retrying.has(key)) return
    const workspace = workspaces.get(id)
    if (!workspace || workspace.mode === "research" || workspace.mode === "shared" || workspace.removed || !existsSync(workspace.path)) return
    const prior = (quest.extensions.landings as Record<string, Landing> | undefined)?.[id]
    if (prior?.state === "landed") return
    const location = await locate(workspace, workspaces, targets)
    if (location instanceof Error) return
    const [head, intoHead] = await Promise.all([runGit(workspace.path, ["rev-parse", "HEAD"]).then(read => read.stdout.trim()), refGit(location.cwd, ["rev-parse", "-q", "--verify", location.ref + "^{commit}"]).then(read => read.stdout.trim() || undefined)])
    if (prior && prior.workerHead === head && prior.intoHead === intoHead || retrying.has(key)) return
    retrying.add(key)
    started.push(quest.id)
    void timed({ plugin: "quests", name: "step", op: "landing" }, () => workspaces.land(id, { title: quest.title, body: quest.description, delivery: questWorkflow(quest).delivery }))
      .then(landing => {
        if (!landing || landing.reason?.startsWith("Its workspace is busy") || prior && sameLanding(prior, landing)) return
        recordLanding(store, quest.id, id, landing, workspace.root)
      })
      .catch(error => console.error("[quests] landing retry", quest.id, error))
      .finally(() => { retrying.delete(key) })
  })))
  return started
}
