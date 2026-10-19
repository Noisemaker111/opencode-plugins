import { readAllQuests } from "../index"
import { driveAsync, refRun } from "./git-steps"
import { reloadRecords, remoteRef, type DeliveryPolicy, type Landing, type ReloadRecord } from "./delivery"
import { resolveDeliveryPolicyAsync } from "./delivery-policy.mjs"
import { housekeepingAction, isLandingStep, isLandingWork, outcomeSteps, workDone } from "./landing-step"
import { latestSessionAttempts, OWNED_RUN, TERMINAL_RUN } from "../runs/session-lineage"
import { reworkedRun, runReview } from "../review/review-record"
import { landedElsewhere, readOnly } from "./settle"
import { normalizeState } from "../core/state-machine"
import { QuestWorkspaces, type Workspace } from "../workspaces"
import type { QuestStore } from "../store"
import type { Quest, QuestSession, QuestStage } from "../types"

export type V2Place = { cwd: string; ref: string; into: string; place: string; remote?: string }
export type MergedBranch = { branch: string; tip: string; merge: string; at: string }
export type V2History = { intoHead: string; merges: MergedBranch[]; squashes: Map<string, string>; onV2: Set<string> }
export type V2Reader = {
  place(root: string, source: string): Promise<V2Place>
  history(place: V2Place): Promise<V2History | undefined>
  subjects(place: V2Place, commits: string[]): Promise<Map<string, string>>
  sameChanges(place: V2Place, commit: string, inside: string): Promise<boolean>
  contains(place: V2Place, commit: string, inside: string): Promise<boolean>
  fetch(place: V2Place): Promise<void>
}
export type MergedRunChange = { questID: string; steps: string[]; landings: string[]; landingSteps: string[]; housekeeping: string[]; from: Quest["state"]; to: Quest["state"] }

const GIT_TIMEOUT = 60_000
const git = (cwd: string, args: string[]) => driveAsync(refRun(cwd, args, GIT_TIMEOUT))
const short = (sha: string) => sha.slice(0, 12)
const runID = (run: QuestSession) => run.runID ?? run.callID
const PULL_REQUEST = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/
const LOCAL_MERGE = /^Merge branch '([^']+)'/
const SQUASHED = /^(.+) \(#\d+\)$/

export const mergedBranchOf = (subject: string) => PULL_REQUEST.exec(subject)?.[1] ?? LOCAL_MERGE.exec(subject)?.[1]

export function parseV2History(intoHead: string, firstParents: string, reachable: string): V2History {
  const merges: MergedBranch[] = [], squashes = new Map<string, string>()
  for (const row of firstParents.split(/\r?\n/)) {
    const [commit, parents, at, ...words] = row.split("\t")
    if (!commit || !parents || !at) continue
    const subject = words.join("\t"), [, tip] = parents.split(" ")
    const branch = tip ? mergedBranchOf(subject) : undefined, squashed = tip ? undefined : SQUASHED.exec(subject)?.[1]
    if (branch && tip) merges.push({ branch, tip, merge: commit, at })
    if (squashed && !squashes.has(squashed)) squashes.set(squashed, commit)
  }
  return { intoHead, merges, squashes, onV2: new Set(reachable.split(/\r?\n/).filter(Boolean)) }
}

const histories = new Map<string, { intoHead: string; history: V2History }>()

export const gitV2Reader: V2Reader = {
  async place(root, source) {
    const { policy } = await resolveDeliveryPolicyAsync(root, { source }) as { policy: DeliveryPolicy }
    const remote = policy.landed === "remote" ? policy.remote : undefined
    return { cwd: remote ? root : source, ref: remoteRef(policy), into: policy.into, place: remote ? `${remote}/${policy.into}` : policy.into, ...(remote ? { remote } : {}) }
  },
  async history(place) {
    const head = await git(place.cwd, ["rev-parse", "-q", "--verify", place.ref + "^{commit}"])
    if (head.status !== 0) return
    const intoHead = head.stdout.trim(), key = place.cwd + "\u0000" + place.ref, known = histories.get(key)
    if (known?.intoHead === intoHead) return known.history
    const [firstParents, reachable] = await Promise.all([git(place.cwd, ["log", "--first-parent", "--format=%H%x09%P%x09%cI%x09%s", intoHead]), git(place.cwd, ["rev-list", intoHead])])
    if (firstParents.status !== 0 || reachable.status !== 0) return
    const history = parseV2History(intoHead, firstParents.stdout, reachable.stdout)
    histories.set(key, { intoHead, history })
    return history
  },
  async subjects(place, commits) {
    const log = await git(place.cwd, ["log", "--no-walk", "--ignore-missing", "--format=%H%x09%s", ...commits])
    return new Map(log.status === 0 ? log.stdout.split(/\r?\n/).filter(Boolean).map(row => [row.slice(0, row.indexOf("\t")), row.slice(row.indexOf("\t") + 1)] as [string, string]) : [])
  },
  async sameChanges(place, commit, inside) {
    const cherry = await git(place.cwd, ["cherry", inside, commit])
    const rows = cherry.stdout.split(/\r?\n/).filter(Boolean)
    return cherry.status === 0 && rows.length > 0 && rows.every(row => row.startsWith("-"))
  },
  async contains(place, commit, inside) {
    return commit === inside || (await git(place.cwd, ["merge-base", "--is-ancestor", commit, inside])).status === 0
  },
  async fetch(place) {
    if (place.remote) await git(place.cwd, ["fetch", "--quiet", place.remote, `+refs/heads/${place.into}:${place.ref}`])
  },
}

type Found = { how: "merged" | "contained" | "same changes"; branch: string; tip: string; merge: string; at: string; place: string; into: string; remote?: string; intoHead?: string; recorded: boolean }
type V2 = { place: V2Place; history?: V2History }
type Pass = { reader: V2Reader; workspaces: QuestWorkspaces; read: Map<string, Workspace | undefined>; fetch: boolean; places: Map<string, Promise<V2 | undefined>>; reloads: ReloadRecord[]; squashed: Map<string, string> }

function workspaceOf(pass: Pass, id: string) {
  if (!pass.read.has(id)) pass.read.set(id, pass.workspaces.get(id))
  return pass.read.get(id)
}

function v2At(pass: Pass, root: string, source: string): Promise<V2 | undefined> {
  const key = root + "\u0000" + source
  let known = pass.places.get(key)
  if (!known) {
    known = (async () => {
      try {
        const place = await pass.reader.place(root, source)
        if (pass.fetch) await pass.reader.fetch(place).catch(error => console.error("[quests] merged runs fetch", place.place, error))
        return { place, history: await pass.reader.history(place) }
      } catch (error) { console.error("[quests] merged runs place", root, error); return undefined }
    })()
    pass.places.set(key, known)
  }
  return known
}

const runReadOnly = (run: QuestSession) => (run.scope as { readOnly?: unknown } | undefined)?.readOnly === true
const considered = (q: Quest, run: QuestSession) => TERMINAL_RUN.has(run.state) && run.agentRole !== "command" && !runReadOnly(run)
const unfinished = (stages: QuestStage[], run: QuestSession) => run.deliverables.some(stepID => stages.some(step => step.id === stepID && step.status !== "done" && !isLandingStep(step)))
const after = (when: string | undefined, since: string) => !!when && Date.parse(when) > Date.parse(since)
const sentBackSince = (q: Quest, run: QuestSession, since: string) => { const review = runReview(q, runID(run)); return review?.verdict === "rework" && after(review.at, since) }
const setBackSince = (q: Quest, stepID: string, since: string) => q.setbacks.some(setback => (setback.stageID === stepID || setback.rewindTo === stepID) && after(setback.at, since))

async function findSquashed(pass: Pass, quests: Quest[]) {
  const wanted = new Map<V2, Set<string>>()
  for (const q of quests) for (const run of q.sessions) {
    if (!considered(q, run) || !unfinished(q.stages, run)) continue
    const workspace = workspaceOf(pass, runID(run)), tip = workspace?.changes?.commits?.[0]
    if (!workspace || !tip || workspace.mode === "research") continue
    const v2 = await v2At(pass, workspace.root, workspace.source ?? workspace.root)
    if (!v2?.history?.squashes.size || v2.history.onV2.has(tip)) continue
    wanted.set(v2, (wanted.get(v2) ?? new Set()).add(tip))
  }
  for (const [v2, tips] of wanted) {
    const subjects = await pass.reader.subjects(v2.place, [...tips]).catch(() => new Map<string, string>())
    for (const [tip, subject] of subjects) {
      const squash = v2.history!.squashes.get(subject)
      if (squash && await pass.reader.sameChanges(v2.place, tip, squash).catch(() => false)) pass.squashed.set(tip, squash)
    }
  }
}

async function mergeOf(q: Quest, run: QuestSession, landing: Landing | undefined, workspace: Workspace | undefined, pass: Pass): Promise<Found | undefined> {
  if (landing?.state === "landed" && landing.head) return { how: landing.workerHead && landing.workerHead !== landing.head ? "merged" : "contained", branch: landing.workerBranch ?? landing.branch, tip: landing.workerHead ?? landing.head, merge: landing.head, at: landing.at, place: landing.remote ? `${landing.remote}/${landing.into}` : landing.into, into: landing.into, recorded: true }
  if (workspace?.mode === "research") return
  const root = workspace?.root ?? q.project?.root
  if (!root) return
  const v2 = await v2At(pass, root, workspace?.source ?? root)
  if (!v2?.history) return
  const { place, history } = v2, id = runID(run)
  const own = new Set([`quest/${id}`, `land/${id}`])
  const names = [...new Set([`land/${id}`, workspace?.branch, landing?.workerBranch, landing?.branch, `quest/${id}`].filter((name): name is string => !!name))]
  const recorded = workspace?.changes?.commits?.[0], foreign = history.merges.find(row => row.merge === recorded && !names.includes(row.branch))
  const tip = foreign ? undefined : recorded
  const found = (how: Found["how"], branch: string, merged: { tip: string; merge: string; at: string }): Found => ({ how, branch, ...merged, place: place.place, into: place.into, ...(place.remote ? { remote: place.remote } : {}), intoHead: history.intoHead, recorded: false })
  for (const name of names) {
    const merged = history.merges.find(row => row.branch === name)
    if (!merged) continue
    if (name === `land/${id}`) return found("merged", name, merged)
    if (tip ? history.onV2.has(tip) : own.has(name)) return found("merged", name, merged)
  }
  if (!tip || !workspace?.branch) return
  if (history.onV2.has(tip)) return found("contained", workspace.branch, { tip, merge: tip, at: workspace.changes!.at })
  const squash = pass.squashed.get(tip)
  if (squash) return found("same changes", workspace.branch, { tip, merge: squash, at: workspace.changes!.at })
}

const settled = (step: QuestStage, note: string) => { step.status = "done"; step.note = note; delete step.blocker; delete step.resolution; delete step.needsJon }

async function reloadedAt(pass: Pass, v2: V2 | undefined, heads: string[]): Promise<ReloadRecord | undefined> {
  const history = v2?.history, reload = history && pass.reloads.find(candidate => history.onV2.has(candidate.revision!))
  if (!v2 || !reload || !heads.every(head => history.onV2.has(head))) return
  for (const head of heads) if (!await pass.reader.contains(v2.place, head, reload.revision!).catch(() => false)) return
  return reload
}

const evidence = (found: Found) => found.how === "merged" ? `On ${found.place}: ${found.branch} at ${short(found.tip)} was merged into ${found.place} by ${short(found.merge)}.`
  : found.how === "contained" ? `On ${found.place}: ${found.branch} at ${short(found.tip)} is in ${found.place}.`
  : `On ${found.place}: the changes of ${found.branch} at ${short(found.tip)} are in ${found.place} at ${short(found.merge)}, merged as one commit.`

async function mergedRunPatch(q: Quest, pass: Pass): Promise<{ stages: QuestStage[]; landings: Record<string, Landing>; reloads: Record<string, ReloadRecord>; change: Omit<MergedRunChange, "from" | "to"> } | undefined> {
  if (q.contractVersion !== 2 || q.archive || q.delivered || q.state === "Archived" || readOnly(q)) return
  const stages = structuredClone(q.stages), landings = { ...(q.extensions.landings ?? {}) } as Record<string, Landing>, reloads = { ...reloadRecords(q.extensions) }
  const busy = new Set(q.sessions.filter(run => OWNED_RUN.has(run.state)).flatMap(run => run.deliverables))
  const change = { questID: q.id, steps: [] as string[], landings: [] as string[], landingSteps: [] as string[], housekeeping: [] as string[] }
  const at = new Date().toISOString()
  for (const run of q.sessions) {
    if (!considered(q, run)) continue
    const id = runID(run), found = await mergeOf(q, run, landings[id], workspaceOf(pass, id), pass)
    if (!found || sentBackSince(q, run, found.at)) continue
    if (!found.recorded) {
      landings[id] = { state: "landed", into: found.into, branch: found.branch, method: "already", head: found.merge, workerBranch: found.branch, workerHead: found.tip, ...(found.intoHead ? { intoHead: found.intoHead } : {}), ...(found.remote ? { remote: found.remote } : {}), at }
      change.landings.push(id)
    }
    for (const stepID of run.deliverables) {
      const step = stages.find(candidate => candidate.id === stepID)
      if (!step || step.status === "done" || isLandingStep(step) || step.needsJon || busy.has(stepID) || setBackSince(q, stepID, found.at)) continue
      settled(step, evidence(found))
      change.steps.push(stepID)
    }
  }
  const carrying = latestSessionAttempts(q.sessions).filter(run => considered(q, run) && !reworkedRun(q, run) && !landedElsewhere(landings, runID(run)) && (landings[runID(run)] || workspaceOf(pass, runID(run))?.changes?.commits?.length))
  if (carrying.length && carrying.every(run => landings[runID(run)]?.state === "landed")) {
    const heads = [...new Set(carrying.map(run => landings[runID(run)].head!).filter(Boolean))]
    const into = [...new Set(carrying.map(run => landings[runID(run)].into))].join(" and ")
    for (const step of stages) if (isLandingWork(step.id) && step.status !== "done" && !busy.has(step.id)) {
      settled(step, `The work is on ${into}: every worker branch of this Quest is merged (${heads.map(short).join(", ")}).`)
      change.landingSteps.push(step.id)
    }
    const outcomes = outcomeSteps(stages)
    if (outcomes.length && outcomes.every(step => step.status === "done")) for (const step of stages) {
      const action = step.status === "done" || busy.has(step.id) || step.needsJon ? undefined : housekeepingAction(step)
      if (!action) continue
      settled(step, `Nothing left to do: every worker branch of this Quest is merged into ${into} (${heads.map(short).join(", ")}), so this ${action} step is moot.`)
      change.housekeeping.push(step.id)
    }
    const landingStep = stages.find(isLandingStep)
    if (landingStep && landingStep.status !== "done" && workDone(stages)) {
      const workspace = carrying.map(run => workspaceOf(pass, runID(run))).find(Boolean), root = workspace?.root ?? q.project?.root
      const reload = root ? await reloadedAt(pass, await v2At(pass, root, workspace?.source ?? root), heads) : undefined
      if (reload) {
        settled(landingStep, `Merged into ${into} at ${heads.map(short).join(", ")}; the services were reloaded at ${short(reload.revision!)}.`)
        change.landingSteps.push(landingStep.id)
        for (const run of carrying) if (!reloads[runID(run)]?.ok || !reloads[runID(run)].revision) reloads[runID(run)] = { ok: true, text: reload.text, revision: reload.revision, at: reload.at }
      }
    }
  }
  return change.steps.length || change.landings.length || change.landingSteps.length || change.housekeeping.length ? { stages, landings, reloads, change } : undefined
}

export async function settleMergedRuns(store: QuestStore, options: { only?: Set<string>; fetch?: boolean; reader?: V2Reader; workspaces?: QuestWorkspaces; preview?: boolean; until?: number } = {}): Promise<MergedRunChange[]> {
  const quests = readAllQuests(store.projectRoot).flatMap(entry => entry.quest ? [entry.quest] : [])
  const reloads = quests.flatMap(q => Object.values(reloadRecords(q.extensions ?? {})).filter(record => record?.ok && record.revision))
  const latestFirst = reloads.sort((a, b) => b.at.localeCompare(a.at)).filter((record, index, sorted) => sorted.findIndex(other => other.revision === record.revision) === index)
  const pass: Pass = { reader: options.reader ?? gitV2Reader, workspaces: options.workspaces ?? new QuestWorkspaces(store.runtime), read: new Map(), fetch: options.fetch === true, places: new Map(), reloads: latestFirst, squashed: new Map() }
  const open = quests.filter(q => q.contractVersion === 2 && !q.archive && !q.delivered && q.state !== "Archived" && (!options.only || options.only.has(q.id)))
  await findSquashed(pass, open)
  const changes: MergedRunChange[] = []
  for (const quest of open) {
    if (options.until !== undefined && Date.now() > options.until) { console.error("[quests] merged runs stopped at its time limit; the rest wait for the next change"); break }
    try {
      const patch = await mergedRunPatch(quest, pass)
      if (!patch) continue
      if (options.preview) {
        const preview = structuredClone(quest)
        preview.stages = patch.stages
        changes.push({ ...patch.change, from: quest.state, to: normalizeState(preview).state })
        continue
      }
      const current = store.read(quest.id)
      if (!current || current.revision !== quest.revision) continue
      const next = store.apply(quest.id, "patched", { stages: patch.stages, extensions: { ...current.extensions, landings: patch.landings, reloads: patch.reloads } }, "quest:merged-on-v2", { expectedRevision: current.revision })
      changes.push({ ...patch.change, from: current.state, to: next.state })
    } catch (error) { console.error("[quests] merged runs", quest.id, error) }
  }
  return changes
}
