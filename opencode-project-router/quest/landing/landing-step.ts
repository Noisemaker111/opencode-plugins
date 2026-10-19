import type { QuestStage } from "../types"
import { WORK_BRANCH, RELEASE_BRANCH, LEGACY_CHANNEL_NAMES, legacyNames } from "../channel.mjs"

export const LANDING_STEP_ID = "land-and-reload"
export const LANDING_STEP_TITLE = "Land the change on v2 and reload the services"
export const LANDING_STEP_DETAIL = "The runtime marks this step done from the landing record: the change is merged into v2 and the services are reloaded at that revision. No worker runs it."

export const RELOAD_FAILED_NOTE = "The change is merged, but the services did not reload at that revision: "
export const RELOAD_FAILED_REQUIRES = "Reload the services at the merged revision, then set this step pending with resolution evidence so the runtime checks the reload again."

export const isLandingStep = (step: Pick<QuestStage, "id"> | undefined) => step?.id === LANDING_STEP_ID

export const landingDone = (stages: Pick<QuestStage, "id" | "status">[]) => stages.some(step => isLandingStep(step) && step.status === "done")

const REBASE_STEP_PREFIX = "rebase-onto-"

export const isNonLandingBranch = (name: string) => name === RELEASE_BRANCH || Object.hasOwn(LEGACY_CHANNEL_NAMES, name)

export const landingBranchLabel = (into: string) => into === WORK_BRANCH ? WORK_BRANCH : "the landing branch"

export const rebaseStepID = (into: string) => `${REBASE_STEP_PREFIX}${landingBranchLabel(into).replace(/[^A-Za-z0-9-]+/g, "-")}`

export const isLandingWork = (stepID: string) => stepID.startsWith(REBASE_STEP_PREFIX)

export const landingWorkFirst = <T>(items: T[], stepIDs: (item: T) => string[]): T[] => {
  const landing = items.filter(item => stepIDs(item).some(isLandingWork))
  return [...landing, ...items.filter(item => !landing.includes(item))]
}

const titleWords = (title: unknown) => String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").map(word => legacyNames(WORK_BRANCH).includes(word) ? WORK_BRANCH : word).join(" ")

export const namesLandingStep = (step: { title?: unknown }) => titleWords(step.title) === titleWords(LANDING_STEP_TITLE)

const DELIVERY_STEP_WORDS = ["land", "lands", "push", "pushes", "merge", "merges", "pr", "prs"]
export const namesDeliveryStep = (step: { id?: string; title?: unknown }) => isLandingWork(step.id ?? "") || titleWords(step.id).split(" ").concat(titleWords(step.title).split(" ")).some(word => DELIVERY_STEP_WORDS.includes(word)) || /\bpull requests?\b/.test(titleWords(step.title))
export const DELIVERY_NONE_FINISH = "On a delivery none Quest nothing lands or pushes by design: finish it with its result, and do not add a landing step or change delivery unless the user asks."
export const DELIVERY_STEP_REFUSED = "Remove the step. " + DELIVERY_NONE_FINISH
export const deliveryStepRefusal = (saved: string, step: { id?: string; title?: unknown }) => saved + " Step " + JSON.stringify(step.id ?? step.title) + " names a landing, push, merge or pull request. " + DELIVERY_STEP_REFUSED

export const noWorkerRuns = (step: (Pick<QuestStage, "id"> & { title?: unknown }) | undefined) => !!step && (isLandingStep(step) || namesLandingStep(step))

export const HOUSEKEEPING_ACTIONS = ["rebase", "land", "landing", "reload", "update", "browser check", "screenshot", "capture evidence", "verify the reload"] as const
export type HousekeepingAction = typeof HOUSEKEEPING_ACTIONS[number]

const LANDING_WORDS = ["the", "a", "an", "and", "then", "onto", "on", "into", "in", "to", "at", "of", "it", "its", "this", "that", "with", "every", "all", "current", "origin", "v2", "change", "changes", "branch", "branches", "task", "worker", "workers", "merge", "merged", "revision", "head", "services", "service", "runtime", "host", "hosts", "pull", "request", "requests", "pr", "running", "reload", "reloaded", "land", "landed", "landing", "rebase", "rebased", "commit", "commits", "conflict", "conflicts", "resolve", "confirm", "verify"]
const EVIDENCE_WORDS = [...LANDING_WORDS, "page", "pages", "site", "served", "quest", "web", "browser", "check", "checks", "screenshot", "screenshots", "capture", "evidence", "scratch", "file", "files", "record", "save", "saved"]
const HOUSEKEEPING_WORDS: Record<HousekeepingAction, Set<string>> = {
  rebase: new Set(LANDING_WORDS), land: new Set(LANDING_WORDS), landing: new Set(LANDING_WORDS), reload: new Set(LANDING_WORDS), update: new Set(LANDING_WORDS), "verify the reload": new Set(LANDING_WORDS),
  "browser check": new Set(EVIDENCE_WORDS), screenshot: new Set(EVIDENCE_WORDS), "capture evidence": new Set(EVIDENCE_WORDS),
}

const startsWith = (words: string[], action: HousekeepingAction) => {
  const phrase = action.split(" ")
  return phrase.every((word, index) => words[index] === word || index === phrase.length - 1 && words[index] === word + "s") ? phrase.length : 0
}

const judgedAction = (text: string): HousekeepingAction | undefined => {
  const words = titleWords(text).split(" ").filter(word => word && !/^[0-9]+$/.test(word))
  const action = [...HOUSEKEEPING_ACTIONS].sort((a, b) => b.length - a.length).find(candidate => startsWith(words, candidate))
  return action && words.slice(startsWith(words, action)).every(word => HOUSEKEEPING_WORDS[action].has(word)) ? action : undefined
}

export const housekeepingAction = (step: Pick<QuestStage, "id"> & { title?: unknown; housekeeping?: HousekeepingAction }): HousekeepingAction | undefined => {
  if (isLandingStep(step)) return
  if (step.housekeeping && (HOUSEKEEPING_ACTIONS as readonly string[]).includes(step.housekeeping)) return step.housekeeping
  if (isLandingWork(step.id)) return "rebase"
  const title = String(step.title ?? "").trim()
  return title ? judgedAction(title) : judgedAction(step.id.replace(/-/g, " "))
}

export const isHousekeeping = (step: Pick<QuestStage, "id"> & { title?: unknown; housekeeping?: HousekeepingAction }) => !!housekeepingAction(step)

export const outcomeSteps = <T extends Pick<QuestStage, "id"> & { title?: unknown; housekeeping?: HousekeepingAction }>(stages: T[]): T[] => stages.filter(step => !isLandingStep(step) && !isHousekeeping(step))

export const LANDING_COPY_REFUSED = "No worker runs a copy of the landing step. The runtime lands the change from its own landing step, so leave this copy closed."

export function withoutPassedLanding<T extends { id?: string; title?: unknown; needs?: string[] }>(steps: T[]): T[] {
  const passed = steps.filter(namesLandingStep), dropped = new Set(passed.flatMap(step => step.id ? [step.id] : []))
  if (!passed.length || passed.length === steps.length) return steps
  return steps.filter(step => !namesLandingStep(step)).map(step => step.needs?.some(id => dropped.has(id)) ? { ...step, needs: step.needs.filter(id => !dropped.has(id)) } : step)
}

export const workSteps = <T extends Pick<QuestStage, "id">>(stages: T[]): T[] => stages.filter(step => !isLandingStep(step))

const currentWork = <T extends Pick<QuestStage, "id" | "deferred">>(stages: T[]): T[] => workSteps(stages).filter(step => !step.deferred)

export const workDone = (stages: Pick<QuestStage, "id" | "status" | "deferred">[]) => {
  const work = currentWork(stages)
  return work.length > 0 && work.every(step => step.status === "done")
}

export const CHECK_STEP_ID = "check-it-works"
export const CHECK_STEP_TITLE = "Check it works"
export const CHECK_STEP_DETAIL = "Open or run the changed thing the way a user would. In the note, say what you opened or ran and what you saw. Use a computer-use tool when one is available; otherwise run the app, request its health or run a test. If you cannot check it, say what could not be checked."

function runtimeStep(id: string, title: string, detail: string, needs: string[]): QuestStage {
  return { id, title, detail, status: "pending", needs, todos: [], claim: { repos: [], include: [], exclude: [] }, proofs: [], attempt: 1 }
}

export function landingStep(needs: string[]): QuestStage {
  return runtimeStep(LANDING_STEP_ID, LANDING_STEP_TITLE, LANDING_STEP_DETAIL, needs)
}

export function withCheckStep(stages: QuestStage[], on: boolean): QuestStage[] {
  return on ? [...stages, runtimeStep(CHECK_STEP_ID, CHECK_STEP_TITLE, CHECK_STEP_DETAIL, stages.map(step => step.id))] : stages
}

export const NOTHING_RAN = "Nothing to land: no worker ran for this Quest, so no change sits on a task branch."

export function withLandingLast(stages: QuestStage[], writable: boolean, workersRan = true): QuestStage[] {
  const work = currentWork(stages), existing = stages.find(isLandingStep), deferred = workSteps(stages).filter(step => step.deferred)
  if (!writable || !work.length) return existing && existing.status !== "done" ? [...work, ...deferred] : stages
  const landing = existing ? { ...existing, needs: work.map(step => step.id) } : landingStep(work.map(step => step.id))
  if (landing.status === "done" && work.some(step => step.status !== "done")) { landing.status = "pending"; delete landing.note }
  if (landing.status === "pending" && !workersRan && work.every(step => step.status === "done")) { landing.status = "done"; landing.note = NOTHING_RAN }
  return [...work, landing, ...deferred]
}
