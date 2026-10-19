import { createHash } from "node:crypto"
import { reserveRunReference } from "./host/session-references"
import { questReference } from "./core/references"
import { briefReason } from "./workers/completion-return"
import { noteReason } from './review/plain-words'
import { branchOutcomes, recordBranchOutcomes, type BranchReport } from "./landing/branch-outcomes"
import { QuestStore } from "./store"
import { readAllQuests } from "./index"
import { assertFullRoute, parseWorkflow, questWorkflow, type QuestWorkflow } from "./runs/workflow"
import { questView } from "./core/contract"
import { stagesFromSteps, nextQuestStep, workerAssignment } from "./core/steps"
import { DEFERRED_NOT_STARTED, DEFERRED_UNTIL, laterItemParent, startDueDeferred } from "./landing/deferred-steps"
import { overlapRefusal } from "./core/step-overlap"
import { normalizeArtifact } from "./artifacts/artifacts"
import { acquireLock } from "./locking.mts"
import { redact } from "./privacy"
import { questRequestFingerprint, unresolvedDuplicate } from "./runs/duplicates"
import { namingProblems } from "./core/naming"
import { SIMPLE_ENGLISH, simpleEnglishProblems, wordingGroups, wordingReport } from "./review/simple-english"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { readJsonRecord } from "./core/durable-file.mjs"
import { spawnSync } from "node:child_process"
import { claimMatches } from "./core/claims"
import { QuestWorkspaces } from "./workspaces"
import { projectIdentity, type ProjectIdentity } from "./core/project"
import { explicitDirectory } from "./core/explicit-path"
import { scopeLabel, strandedDiagnostic } from "./board/board-project"
import type { NeedsJon, Quest, QuestRequest, QuestResult, QuestStageStatus, QuestStage, StepBlocker, BlockerResolution } from "./types"
import { NEEDS_JON_RENAMED } from "./types"
import { RESULT_FIELDS, questResult } from "./board/result-card"
import { TASK_CLASSES } from "../models/task-demand"
import { DEPTHS, combinedProfile, depthOf, stepProfile, workTypeOf, type Depth, type WorkProfile } from "../models/work-profile"
import { routingSettings } from "./routing/routing-settings"
import { stepRestartRefusal } from "./routing/failure-cause"
import { giverSettings, isRuntimeProject, selfFixEnabled } from "./giver/giver-settings"
import { roleWorkerModel } from "./routing/role-settings"
import type { ChosenBy } from "../models/dispatch-planner"
import { requestNamesModel } from "./routing/chosen-by"
import { continuationContext, previousAttempt } from "./runs/continuation-workspace"
import { NEEDS_JON, questOperations } from "./operations.mjs"
import { addsCycle, validCategory } from "./workers/quest-queue"
import { limitHold, workerHoldReason } from "./workers/worker-admission"
import { dependencyRunningMessage, runningDependency } from "./landing/dependency-runs"
import { DELIVERY_NONE_FINISH, LANDING_COPY_REFUSED, LANDING_STEP_ID, deliveryStepRefusal, housekeepingAction, isLandingStep, namesDeliveryStep, namesLandingStep, noWorkerRuns, withCheckStep, withLandingLast, withoutPassedLanding } from "./landing/landing-step"
import { LANDING_BRANCH_ANSWER, wrongLandingBranchBlock } from "./landing/landing-branch-answer"

const JON_SENDERS = new Set(["Quest Web", "terminal", "front"])
export const tracesToJon = (row: Pick<QuestRequest, "origin">) => row.origin === undefined || JON_SENDERS.has(row.origin.from)

const jonAsked = (context: QuestContext) => (context.request ?? []).some(row => row.text.trim() && !row.context && !row.unattributed)

const writableWorkflow = (workflow: unknown, stages?: Quest["stages"]) => {
  const flow = (workflow && typeof workflow === "object" ? workflow : {}) as QuestWorkflow
  if (flow.readOnly === true || flow.delivery === "none") return false
  if (flow.task !== undefined && flow.task !== "coding") return stages?.some(isLandingStep) ?? false
  return true
}

function profileField<T>(read: () => T, field: string): T {
  try { return read() } catch (error) { throw new QuestError("INVALID_INPUT", field + ": " + (error instanceof Error ? error.message : String(error))) }
}
export function stepDepth(value: unknown): Depth | undefined { return profileField(() => depthOf(value), "Step depth") }
export function knownWorkType(value: unknown, field = "Step workType"): string | undefined {
  const workType = profileField(() => workTypeOf(value), field)
  if (workType === undefined) return undefined
  let known: string[] | undefined
  try { known = routingSettings().workTypes.map(type => type.id) } catch { known = undefined }
  if (known && !known.includes(workType)) throw new QuestError("INVALID_INPUT", field + " must be one of the work types on the Routing page: " + known.join(", "))
  return workType
}
export function runProfile(steps: { depth?: unknown; workType?: unknown }[], fallback: WorkProfile): WorkProfile {
  return combinedProfile(steps.map(step => stepProfile(step)), fallback)
}

export class QuestError extends Error {
  constructor(public code: string, message: string, public retryable = false, public runID?: string) { super(message) }
}
export function refusedFor(error: QuestError, quest: Quest): QuestError { Object.defineProperty(error, "quest", { value: quest, enumerable: false }); return error }
export type QuestContext = { request?: QuestRequest[]; giverStepID?: string; laterTurn?: true; project: ProjectIdentity;  resume?: {questID:string;runID:string};  freshBase?: true;  directory?: string;  giverDirectory?: string;  missingDirectory?: string; sessionID: string; requestID: string;  turnID?: string }
export type CreateQuest = { category?: string; workflow?: QuestWorkflow; projectRoot?: string; title: string; description?: string; steps?: { title?: string; detail?:string; needs?: string[]; id?: string; commandID?: string; depth?: Depth; workType?: string; deferred?: "parent-done" | "jon"; include?: string[] }[]; reward?: string }
export type UpdateQuest = { workflow?: QuestWorkflow; projectRoot?: string; title?: string; description?: string; reward?: string; result?: QuestResult; steps?: { id: string; state: QuestStageStatus; title?: string; detail?: string; needs?: string[]; include?: string[]; note?: string; result?: QuestResult; commandID?: string | null; needsJon?: NeedsJon | null; deferred?: "parent-done" | "jon" | null; branches?: BranchReport[]; blocker?: StepBlocker; resolution?: BlockerResolution; depth?: Depth | null; workType?: string | null; verification?: { command: string; exitCode: number; artifact?: string } }[]; artifacts?: { name: string; path?: string; uri?: string; label?: string }[]; archive?: { reason?: string; accepted: boolean } | null; category?: string | null; after?: string[] }
export type RunQuest = { recoverDependencies?: boolean; readOnly?: boolean; stepIDs?: string[]; model?: string; files?: string[]; task?: string; depth?: string; workType?: string }
export type StartInput = { quest: Quest; runID: string; stepIDs: string[]; recoverDependencies?: boolean; readOnly?: boolean; model?: string; files?: string[]; task?: string; depth?: string; workType?: string; chosenBy?: ChosenBy; context: QuestContext }
export type AdmitRun = (input: Omit<StartInput, "runID" | "recoverDependencies" | "files">) => Promise<void>
export type StartRun = ((input: StartInput) => Promise<{ sessionID: string }>) & { admit?: AdmitRun }
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const retryHere = () => ' Fix what stopped it, then start this same Quest again; do not create another Quest for the same request.'
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new QuestError("INVALID_INPUT", label + " must be nonempty text")
  return value
}
function simpleEnglish(input: Parameters<typeof simpleEnglishProblems>[0], outcome: string) {
  const groups = wordingGroups(input)
  if (groups.some(group => group.blocking)) throw new QuestError("NOT_SIMPLE_ENGLISH", outcome + " Rewrite these fields, all of them in one retry of create or update. Each line gives the sentence, what is wrong and a suggested rewrite.\n" + wordingReport(groups) + "\nRule: " + SIMPLE_ENGLISH)
}
function changedText(input: UpdateQuest, q: Quest): Parameters<typeof simpleEnglishProblems>[0] {
  const fresh = (value: unknown, stored: unknown) => value === stored ? undefined : value
  const card = (value: QuestResult | undefined, stored: QuestResult | undefined) => value && typeof value === "object" ? { summary: fresh(value.summary, stored?.summary), howToUse: fresh(value.howToUse, stored?.howToUse) } : undefined
  const saved = q as Quest & { description?: string }
  return { title: fresh(input.title, q.title), description: fresh(input.description, saved.description), result: card(input.result, q.result ?? undefined), steps: Array.isArray(input.steps) ? input.steps.map(step => {
    const stage = q.stages.find(row => row.id === step?.id)
    return { title: fresh(step?.title, stage?.title), detail: fresh(step?.detail, stage?.detail), note: fresh(step?.note, stage?.note), result: card(step?.result, stage?.result), blocker: { requires: fresh(step?.blocker?.requires, stage?.blocker?.requires) } }
  }) : undefined }
}
function saveRuntimeBlocker(store: QuestStore, id: string, stepIDs: string[], reason: string, blocker: StepBlocker) {
  for (const stageID of stepIDs) store.apply(id, "stage-state", { stageID, status: "blocked", evidence: reason }, "quest:run")
  const current = store.read(id)!
  store.apply(id, "patched", { stages: current.stages.map(step => stepIDs.includes(step.id) ? (({ resolution: _cleared, ...rest }) => ({ ...rest, blocker }))(step) : step) }, "quest:run")
}
const stepFields = (operation: "create" | "update") => Object.keys((questOperations as any)[operation].input.properties.steps.items.properties) as string[]
function resultInput(value: unknown, label: string): QuestResult {
  keys(value as object, [...RESULT_FIELDS])
  const card = value as Record<string, unknown>
  for (const field of RESULT_FIELDS) if (typeof card[field] !== "string") throw new QuestError("INVALID_INPUT", label + "." + field + " must be text")
  if (!(card.summary as string).trim()) throw new QuestError("INVALID_INPUT", label + ".summary must say what the user got")
  return { summary: (card.summary as string).trim(), howToUse: (card.howToUse as string).trim(), where: (card.where as string).trim() }
}
const keys = (value: object, allowed: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new QuestError("INVALID_INPUT", "Expected an object")
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new QuestError("INVALID_INPUT", "Unsupported field: " + key)
}
export function checkoutProjectRoot(value: unknown): ProjectIdentity {
  const written = text(value, "Project root")
  const identity = projectIdentity(explicitDirectory(written) ?? written)
  if (!existsSync(join(identity.root, ".git"))) throw new QuestError("PROJECT_NOT_A_CHECKOUT", identity.root + " is not a Git checkout, so a worker would still have nothing to bind. Name the maintained source project.")
  return identity
}
function validateGraph(stages:Quest["stages"]) {
 if(stages.length>30||new Set(stages.map(s=>s.id)).size!==stages.length)throw new QuestError("INVALID_INPUT","Provide at most 30 uniquely identified steps")
 const visiting=new Set<string>(),done=new Set<string>()
 const visit=(id:string)=>{if(done.has(id))return;if(visiting.has(id))throw new QuestError("INVALID_INPUT","Step dependencies contain a cycle");const step=stages.find(s=>s.id===id);if(!step)throw new QuestError("INVALID_INPUT","Unknown step dependency: "+id);visiting.add(id);for(const dependency of step.needs)visit(dependency);visiting.delete(id);done.add(id)}
 for(const step of stages)visit(step.id)
}
const planSourceQuest = (store: QuestStore, turnID: string | undefined) => {
  const requestID = turnID?.match(/^msg_questplan([0-9a-f-]{36})$/)?.[1]
  const row = requestID === undefined ? undefined : readJsonRecord<{ kind?: string; quest?: string }>(join(store.runtime, "start-requests", requestID + ".json"))
  return row?.kind === "plan" && row.quest !== undefined ? store.read(row.quest) : undefined
}
const deliveryAnswer = (q: Quest) => {
  const delivery = questWorkflow(q).delivery
  if (delivery === undefined) return "project (from project policy)"
  const from = q.extensions.deliveryFrom
  return typeof from === "string" ? `${delivery} (inherited from ${from})` : delivery
}
const createdView = (q: Quest) => ({ ...questView(q), delivery: deliveryAnswer(q) })

function repeatedSend(store: QuestStore, duplicate: Quest) {
  const sends = Number(duplicate.extensions.sends ?? 1) + 1
  const current = store.apply(duplicate.id, "patched", { extensionsPatch: { sends } }, "quest:create")
  return { ...createdView(current), sends, note: `Quest ${questReference(current)} already holds this request (${current.state}), sent ${sends} times. No new Quest; start, stop or archive it.` }
}

function changedFiles(checkout: string, base: string): string[] {
  const tracked = spawnSync("git", ["-C", checkout, "diff", "--name-only", "-z", "--no-renames", base, "--"], { encoding: "utf8", windowsHide: true })
  const untracked = spawnSync("git", ["-C", checkout, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8", windowsHide: true })
  if (tracked.status !== 0 || untracked.status !== 0) return []
  return [...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean)
}

function doneRefusal(q: Quest, step: QuestStage, sessionID: string, latest: Quest["evidence"]["tests"][number] | undefined, runtime: string): string | undefined {
  if (typeof latest?.exitCode === "number" && latest.exitCode !== 0) return `Step ${step.id} cannot be done: its latest check, ${latest.command}, exited ${latest.exitCode}. Run it again until it exits 0.`
  const include = step.claim?.include ?? []
  const run = q.sessions.findLast(s => s.deliverables.includes(step.id) && (s.openCodeSessionId ?? s.sessionID) === sessionID) ?? q.sessions.findLast(s => s.deliverables.includes(step.id))
  if (!include.length || !run || questWorkflow(q).readOnly || run.scope?.readOnly === true) return undefined
  const workspace = new QuestWorkspaces(runtime).get(run.runID ?? run.callID)
  if (workspace?.mode === "research") return undefined
  const files = workspace ? changedFiles(workspace.path, workspace.comparisonTree ?? workspace.base) : []
  if (workspace && files.some(file => claimMatches({ repo: workspace.path, include, exclude: [], state: "active" }, resolve(workspace.path, file)))) return undefined
  return `Step ${step.id} cannot be done: none of its claimed files (${include.join(", ")}) changed in the run's worktree. Write the file the step names, then report it done.`
}

export function questsAPI(store: QuestStore, context: QuestContext, startRun: StartRun) {
  if (!context.project?.id || !context.project.root || !context.sessionID || !context.requestID) throw new QuestError("PROJECT_CONTEXT_REQUIRED", "A trusted project, session and request identity are required")
  const readRecord = (id: string) => {
    const q = store.read(text(id, "Quest id"))
    if (!q) throw new QuestError("NOT_FOUND", "Quest not found")
    return q
  }
  const getOwned = (id: string) => {
    const q = readRecord(id)
    if (q.project?.id !== context.project.id) throw new QuestError("PROJECT_MISMATCH", "Quest does not belong to this session project; select its owning project")
    return q
  }
  return {
    list(query: { text?: string; state?: string; projectID?: string; allProjects?: boolean; archived?: boolean; offset?: number; limit?: number } = {}) {
      keys(query, ["text", "state", "projectID", "allProjects", "archived", "offset", "limit"])
      const offset = query.offset ?? 0, limit = query.limit ?? 25
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new QuestError("INVALID_INPUT", "Invalid pagination")
      const entries = readAllQuests(store.projectRoot, { includeArchived: true })
      const terms = (query.text === undefined ? '' : text(query.text, 'Search text')).toLocaleLowerCase().split(/\s+/).filter(Boolean)
      const diagnostics = entries.filter(x=>!x.quest).map(x=>"Unreadable Quest record: "+x.errors.join("; "))
      const all = entries.flatMap(x => x.quest ? [x.quest] : [])
      const stranded = [...new Set(all.filter(q => q.project?.root && !existsSync(q.project.root)).map(q => q.project!.root))]
      const gone = strandedDiagnostic(stranded)
      if (gone) diagnostics.push(gone)
      const rows = all
        .filter(q => (query.allProjects === true || q.project?.id === context.project.id)
          && (!query.projectID || q.project?.id === query.projectID)
          && (query.state ? q.state === query.state : query.archived === true ? q.state === "Archived" : q.state !== "Archived")
          && terms.every(term => [q.title, q.description ?? q.objective, ...q.stages.map(step => step.title)].join('\n').toLocaleLowerCase().includes(term)))
        .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      const page = rows.slice(offset, offset + limit)
      return { diagnostics, items: page.map(questView), records: rows, allRecords: all, page,
        scope: scopeLabel(query.allProjects === true, context.project.root),
        total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null }
    },
    get(id: string) { return questView(readRecord(id)) },
    create(input: CreateQuest) {
      keys(input, ["title", "description", "steps", "reward", "workflow", "projectRoot", "category"])
      if (input.category !== undefined && !validCategory(input.category)) throw new QuestError("INVALID_INPUT", "No Quest was created. category must be up to 40 letters, digits, spaces, dashes or underscores")
      const project = input.projectRoot === undefined ? context.project : checkoutProjectRoot(input.projectRoot)
      text(input.title, "Title")
      const said = context.request?.filter(row => row.text.trim()) ?? [], asked = said.filter(row => !row.context), unattributed = asked.some(row => row.unattributed)
      const words = asked.length === 1 && !unattributed ? asked[0].text : undefined
      if (isRuntimeProject(project.root) && !selfFixEnabled()) {
        if (!asked.length) throw new QuestError("SELF_FIX_OFF", "No Quest was created. Self-fix is off, so the Quest Giver opens no Quest about the runtime without the user's request. Record the finding on the Quest it concerns; the user can turn self-fix on in Settings, Agents.")
        if (!asked.some(tracesToJon)) throw new QuestError("SELF_FIX_OFF", "No Quest was created. Self-fix is off, and this request did not come from the user: it came from " + [...new Set(asked.map(row => row.origin?.from ?? "an unknown sender"))].join(", ") + ". Only the user's own message, a terminal session relaying the user's words or the front relaying the user's words can open a Quest. Record the finding on the Quest it concerns; the user can turn self-fix on in Settings, Agents.")
      }
      if (input.description !== undefined || !asked.length) text(input.description, asked.length ? "Description" : said.length ? "Description (the user message this turn holds was already acted on, so it is kept only as context; describe this Quest's own task, or pass fromMessage when this Quest is what that message asks for)" : "Description (no user message is recorded for this create, so describe the request)")
      const description = input.description ?? words ?? input.title
      if (input.steps !== undefined && (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 30)) throw new QuestError("INVALID_INPUT", "Provide 1–30 steps, or omit steps for a request one worker does")
      const listed = input.steps ? withoutPassedLanding(input.steps) : [{}], oneStep = asked.length > 0 && listed.length === 1
      const steps = oneStep || input.steps === undefined ? [{ ...listed[0], title: input.title }] : listed
      if (oneStep && steps[0]?.detail !== undefined) throw new QuestError("INVALID_INPUT", "No Quest was created. A one-step Quest's step is the user's message, so its worker gets those words as the task: leave steps[0].detail out. Facts the message does not hold go in description; paths go in steps[0].include.")
      for (const step of steps) { keys(step, stepFields("create")); text(step.title, "Step title"); stepDepth(step.depth); knownWorkType(step.workType); if(step.detail!==undefined&&typeof step.detail!=="string")throw new QuestError("INVALID_INPUT","Step detail must be text"); if (step.deferred !== undefined && !DEFERRED_UNTIL.includes(step.deferred)) throw new QuestError("INVALID_INPUT", "Step deferred must be " + DEFERRED_UNTIL.join(" or ")); if (step.commandID !== undefined) text(step.commandID, "Configured command id"); if (step.include !== undefined && (!Array.isArray(step.include) || step.include.some(path => typeof path !== "string" || !path.trim()))) throw new QuestError("INVALID_INPUT", "Step include must list repository paths or globs") }
      const explicitIDs=steps.flatMap(s=>s.id?[s.id]:[]);if(new Set(explicitIDs).size!==explicitIDs.length)throw new QuestError("INVALID_INPUT","Duplicate step IDs")
      if (steps.some(step => step.id === LANDING_STEP_ID)) throw new QuestError("INVALID_INPUT", "The runtime adds the landing step itself; leave " + LANDING_STEP_ID + " out of the steps")
      const planned = input.workflow === undefined ? {} : parseWorkflow(input.workflow)
      const origin = planned.delivery === undefined ? planSourceQuest(store, context.turnID) : undefined
      const inherited = origin && questWorkflow(origin).delivery
      const workflow = inherited ? { ...planned, delivery: inherited } : planned
      if (workflow.readOnly === true && workflow.task === "coding") throw new QuestError("INVALID_INPUT", "No Quest was created. A read-only Quest cannot change code, yet its task says coding. Leave readOnly out to change code, or leave task out to read and report.")
      assertFullRoute(workflow.model, "workflow.model")
      if (workflow.delivery === "none") { const named = listed.find(namesDeliveryStep); if (named) throw new QuestError("INVALID_INPUT", deliveryStepRefusal("No Quest was created.", named)) }
      const writable = writableWorkflow(workflow)
      const stages = withLandingLast(withCheckStep(stagesFromSteps(steps), writable && giverSettings().checkItWorks === true), writable)
      validateGraph(stages)
      if (input.reward !== undefined && typeof input.reward !== "string") throw new QuestError("INVALID_INPUT", "Reward must be text")
      const ids = new Set(stages.map(s => s.id))
      if (stages.some(s => s.needs.some(id => !ids.has(id) || id === s.id))) throw new QuestError("INVALID_INPUT", "Step dependency does not identify another step")
      const id = hash(context.project.id + ":" + context.sessionID + ":" + context.requestID + ":create").slice(0, 26)
      const admitted = store.read(id) ?? store.readRequest(id)
      if (admitted) return createdView(admitted)
      simpleEnglish(input, "No Quest was created.")
      const unreadable = namingProblems({ title: input.title, objective: input.description, steps: input.steps })
      if (unreadable.length) throw new QuestError("UNREADABLE_QUEST", "No Quest was created. " + unreadable.join(" ") + " Retry create with the corrected wording; the request itself does not change.")
      const quests = readAllQuests(store.projectRoot).flatMap(x => x.quest ? [x.quest] : [])
      const fingerprint = questRequestFingerprint({ projectID: project.id, title: input.title, objective: description })
      const duplicate = unresolvedDuplicate(quests,{ projectID: project.id, title: input.title, objective: description, fingerprint, messageID: words === undefined ? undefined : asked[0].messageID, turnID: context.turnID, ownerSessionID: context.sessionID })
      if (duplicate) return repeatedSend(store, duplicate)
      const parent = context.laterTurn ? laterItemParent(quests, asked) : undefined
      if (parent) throw refusedFor(new QuestError("LATER_ITEM_ON_PARENT", `No Quest was created. Quest ${questReference(parent)} already holds the user message this create answers, so this is a later item of that Quest. Add it to ${questReference(parent)} with update as a new step with deferred: "parent-done" (it starts when the current steps are done) or deferred: "jon" (it waits until the user asks). The user sees it there as a deferred step.`), parent)
      const q = store.createNamed({ title: input.title, objective: description, description, reward: input.reward ?? "", ...(said.length ? { request: said } : {}), extensions: { workflow, ...(origin && inherited ? { deliveryFrom: questReference(origin) } : {}), category: input.category ?? (asked.length ? "added by Jon" : "system"), ...(context.turnID ? { giverTurnID: context.turnID } : {}), ...(context.giverStepID ? { giverStepID: context.giverStepID } : {}) }, stages, contractVersion: 2, project, integrationOwner: context.sessionID, requestFingerprint: fingerprint }, id)
      return createdView(q)
    },
    update(id: string, input: UpdateQuest) {
      keys(input, ["title", "description", "reward", "result", "steps", "artifacts", "archive", "workflow", "projectRoot", "category", "after"])
      const q = readRecord(id)
      simpleEnglish(changedText(input, q), "Nothing was saved.")
      const rewritten = namingProblems({ title: input.title, objective: input.description, steps: input.steps })
      if (rewritten.length) throw new QuestError("UNREADABLE_QUEST", "Nothing was saved. " + rewritten.join(" ") + " Retry the update with wording the Quest can be read by.")
      const patch: Record<string, unknown> = {}
      if (input.workflow !== undefined) { const changed = parseWorkflow(input.workflow); assertFullRoute(changed.model, "workflow.model"); if (questWorkflow(q).delivery === "none" && changed.delivery !== undefined && changed.delivery !== "none" && !jonAsked(context)) throw new QuestError("INVALID_INPUT", "Nothing was saved. This Quest has delivery none, and the Quest Giver raises that only when the user asks in their message this turn. " + DELIVERY_NONE_FINISH); patch.extensions = { ...q.extensions, workflow: { ...questWorkflow(q), ...changed } } }
      if (input.projectRoot !== undefined) {
        patch.project = checkoutProjectRoot(input.projectRoot)
        const {giverSourceDirectory:_moved,...extensions}=(patch.extensions??q.extensions) as Record<string,unknown>
        patch.extensions=extensions
      }
      if (input.result !== undefined) patch.result = resultInput(input.result, "result")
      if (input.category !== undefined) {
        if (input.category !== null && !validCategory(input.category)) throw new QuestError("INVALID_INPUT", "category must be up to 40 letters, digits, spaces, dashes or underscores, or null to clear it")
        const { category: _previous, ...extensions } = (patch.extensions ?? q.extensions) as Record<string, unknown>
        patch.extensions = input.category === null ? extensions : { ...extensions, category: input.category }
      }
      if (input.after !== undefined) {
        const found = Array.isArray(input.after) ? input.after.map(other => { try { return typeof other === "string" ? store.read(other) : undefined } catch { return undefined } }) : undefined
        if (!found || found.some(other => !other)) throw new QuestError("INVALID_INPUT", "after must list the IDs of existing Quests that must finish first")
        const after = [...new Set(found.map(other => other!.id))]
        if (addsCycle(q.id, after, other => store.read(other))) throw new QuestError("INVALID_INPUT", "after would make this Quest wait on itself, directly or through other Quests")
        patch.relationships = { ...q.relationships, dependencies: after }
      }
      for (const key of ["title", "description", "reward"] as const) if (input[key] !== undefined) {
        if (typeof input[key] !== "string" || (key !== "reward" && !input[key]!.trim())) throw new QuestError("INVALID_INPUT", key + " must be text")
        patch[key] = input[key]
      }
      if (input.steps !== undefined) {
        if (!Array.isArray(input.steps)) throw new QuestError("INVALID_INPUT", "steps must be an array")
        const stages = structuredClone(q.stages), seen = new Set<string>(), checks: Quest["evidence"]["tests"] = []
        const runReports=structuredClone((q.extensions.runReports??{}) as Record<string,Record<string,{state:string;note?:string;blocker?:StepBlocker}>>)
        const stepResults=structuredClone((q.extensions.stepResults??{}) as Record<string,{runIDs:string[];state:string;recordedAt:string;blocker?:StepBlocker;verification?:{command:string;exitCode:number;artifact?:string}}>)
        let outcomes = branchOutcomes(q)
        const runStepSavedAt=structuredClone((q.extensions.runStepSavedAt??{}) as Record<string,Record<string,string>>)
        const reporter = q.sessions.findLast(run => (run.openCodeSessionId ?? run.sessionID) === context.sessionID)
        const checkOf = (update: NonNullable<UpdateQuest["steps"]>[number], stepID: string): Quest["evidence"]["tests"][number] => {
          const check = update.verification as { command?: unknown; exitCode?: unknown; artifact?: unknown }
          if (!check || typeof check !== "object" || Array.isArray(check)) throw new QuestError("INVALID_INPUT", "Step verification must be an object with command and exitCode")
          if (!Number.isSafeInteger(check.exitCode)) throw new QuestError("INVALID_INPUT", "Verification exitCode must be the integer the command actually returned")
          if (check.artifact !== undefined && typeof check.artifact !== "string") throw new QuestError("INVALID_INPUT", "Verification artifact must be a path or URI")
          return { command: text(check.command, "Verification command"), exitCode: check.exitCode as number, reportedState: update.state, result: check.exitCode === 0 ? "passed" : "failed", at: new Date().toISOString(), stepID, ...(check.artifact ? { artifact: check.artifact as string } : {}) }
        }
        const delivery = (patch.extensions as { workflow?: QuestWorkflow } | undefined)?.workflow?.delivery ?? questWorkflow(q).delivery
        for (const given of input.steps) {
          keys(given, stepFields("update"))
          const update = given.state === "blocked" && (given.blocker?.kind === "permission" || given.needsJon === "choice") && wrongLandingBranchBlock([given.note, given.blocker?.requires]) ? { ...given, state: "pending" as const, note: LANDING_BRANCH_ANSWER, resolution: { evidence: LANDING_BRANCH_ANSWER }, blocker: undefined, needsJon: undefined } : given
          if (!["pending", "working", "blocked", "done"].includes(update.state)) throw new QuestError("INVALID_INPUT", "Step state is required: pending, working, blocked or done")
          let step = stages.find(s => s.id === update.id)
          text(update.id, "Step id")
          if (update.id === LANDING_STEP_ID && update.state === "done") throw new QuestError("LANDING_NOT_PROVEN", "Nothing was saved. The landing step is done only from the landing record: the change merged into v2 and the services reloaded at that revision. The runtime marks it done when both are recorded. A change that sits only on the task branch is not done.")
          if (seen.has(update.id)) throw new QuestError("INVALID_INPUT", "Duplicate step id")
          if (!step && namesLandingStep({ title: update.title })) throw new QuestError("INVALID_INPUT", "Nothing was saved. The runtime adds the landing step itself; leave a copy of it out of the steps.")
          if (delivery === "none" && (!step || update.title !== undefined) && namesDeliveryStep({ id: update.id, title: update.title ?? step?.title })) throw new QuestError("INVALID_INPUT", deliveryStepRefusal("Nothing was saved.", { id: update.id }))
          if (step && step.status === "done" && update.state !== "done" && !isLandingStep(step) && namesLandingStep(step)) throw new QuestError("STEP_NOT_ELIGIBLE", "Nothing was saved. " + LANDING_COPY_REFUSED)
          if (!step) { text(update.title, "New step title"); step = stagesFromSteps([{ id: update.id, title: update.title! }])[0]; const action = housekeepingAction(step); if (action) step.housekeeping = action; stages.push(step) }
          if (update.commandID !== undefined) {
            const commandID = update.commandID === null ? undefined : text(update.commandID, "Configured command id")
            if (commandID !== step.commandID && q.sessions.some(run => ["planned", "executing", "waiting", "blocked"].includes(run.state) && run.deliverables.includes(step.id))) throw new QuestError("STEP_RUNNING", "The step has an active or unconfirmed run. Reconcile it before changing its configured command.")
            if (commandID === undefined) delete step.commandID
            else step.commandID = commandID
          }
          if (update.depth !== undefined || update.workType !== undefined) {
            const legacy = step as typeof step & { size?: unknown }
            if (legacy.size !== undefined) { if (update.depth === undefined && step.depth === undefined) step.depth = stepDepth(legacy.size); delete legacy.size }
            if (update.depth === null) delete step.depth; else if (update.depth !== undefined) step.depth = stepDepth(update.depth)
            if (update.workType === null) delete step.workType; else if (update.workType !== undefined) step.workType = knownWorkType(update.workType)
          }
          if (update.title !== undefined && update.title !== step.title) { step.title = text(update.title, "Step title"); if (step.housekeeping) { delete step.housekeeping; const action = housekeepingAction(step); if (action) step.housekeeping = action } }
          if (update.detail !== undefined) { if (typeof update.detail !== "string") throw new QuestError("INVALID_INPUT", "Step detail must be text"); step.detail = update.detail }
          if (update.deferred !== undefined) {
            if (update.deferred !== null && !DEFERRED_UNTIL.includes(update.deferred)) throw new QuestError("INVALID_INPUT", "Step deferred must be " + DEFERRED_UNTIL.join(" or ") + ", or null to make it current work")
            if (update.deferred === null) delete step.deferred
            else if (update.state !== "pending") throw new QuestError("INVALID_INPUT", "Only a pending step can be deferred")
            else step.deferred = { at: step.deferred?.at ?? new Date().toISOString(), until: update.deferred }
          }
          if (update.needs !== undefined) { if (!Array.isArray(update.needs) || update.needs.some(n => typeof n !== "string")) throw new QuestError("INVALID_INPUT", "Dependencies must be step IDs"); step.needs = update.needs }
          if (update.include !== undefined) { if (!Array.isArray(update.include) || update.include.some(path => typeof path !== "string" || !path.trim())) throw new QuestError("INVALID_INPUT", "Step include must list repository paths or globs"); step.claim = { ...step.claim, include: update.include.map(String).slice(0, 20) } }
          if (update.blocker !== undefined) {
            keys(update.blocker, ["kind", "owner", "requires"])
            if (update.state !== "blocked" || !["environment", "dependency", "permission", "work", "unknown"].includes(update.blocker.kind)) throw new QuestError("INVALID_INPUT", "blocker needs a blocked step and a valid kind")
            text(update.blocker.owner, "Blocker owner"); text(update.blocker.requires, "Blocker prerequisite")
          }
          if (update.resolution !== undefined) { keys(update.resolution, ["evidence"]); text(update.resolution.evidence, "Resolution evidence") }
          if(reporter?.deliverables.includes(step.id)){
            const runID=reporter.runID??reporter.callID
            runStepSavedAt[runID]={...runStepSavedAt[runID],[step.id]:new Date().toISOString()}
          }
          if (update.branches !== undefined) {
            const recorded = recordBranchOutcomes(outcomes, update.branches, step.id)
            if ("problem" in recorded) throw new QuestError("INVALID_INPUT", recorded.problem)
            outcomes = recorded.saved
          }
          if (step.status === "blocked" && update.state !== "blocked" && !update.resolution) throw new QuestError("BLOCKER_UNCHANGED", "Save resolution.evidence naming the changed prerequisite or verified superseding work before resuming this step. Rewording its note or starting another worker does not resolve it.")
          if (update.state === "blocked") {
            step.blocker = update.blocker ?? step.blocker ?? { kind: "unknown", owner: "Quest Giver", requires: update.note?.trim() || step.note || "Identify and resolve the prerequisite before retrying" }
            delete step.resolution
          } else if (update.resolution) { step.resolution = update.resolution; delete step.blocker }
          if (update.verification !== undefined) checks.push(checkOf(update, step.id))
          if (update.state === "done" && step.status !== "done") {
            const refusal = doneRefusal(q, step, context.sessionID, [...q.evidence.tests, ...checks].findLast(test => test.stepID === step.id), store.runtime)
            if (refusal) throw new QuestError("STEP_NOT_ELIGIBLE", "Nothing was saved. " + refusal)
          }
          seen.add(update.id); step.status = update.state
          if (update.needsJon && NEEDS_JON_RENAMED[update.needsJon]) update.needsJon = NEEDS_JON_RENAMED[update.needsJon]
          if (update.needsJon !== undefined && update.needsJon !== null && !NEEDS_JON.includes(update.needsJon)) throw new QuestError("INVALID_INPUT", "needsJon must be one of " + NEEDS_JON.join(", ") + ", or null")
          if (update.needsJon && update.state !== "blocked") throw new QuestError("INVALID_INPUT", "needsJon marks a blocked step; save the step blocked with the blocker in its note")
          if (update.state !== "blocked" || update.needsJon === null) delete step.needsJon
          else if (update.needsJon) step.needsJon = update.needsJon
          if (update.note !== undefined) { if (typeof update.note !== "string") throw new QuestError("INVALID_INPUT", "Step note must be text"); if (update.note !== step.note) step.noteAt = new Date().toISOString(); step.note = update.note }
          if (update.result !== undefined) step.result = resultInput(update.result, "result")
          if((update.state==='blocked'||update.state==='done')&&update.note?.trim()){
            const completed=q.sessions.filter(s=>s.deliverables.includes(step.id)&&(['completed','failed','cancelled'].includes(s.state)||(s.openCodeSessionId??s.sessionID)===context.sessionID)).map(s=>s.runID??s.callID)
            const owned = q.sessions.filter(run => run.deliverables.includes(step.id) && (run.openCodeSessionId ?? run.sessionID) === context.sessionID).map(run => run.runID ?? run.callID)
            for (const runID of owned.length ? owned.slice(-1) : completed.slice(-1)) runReports[runID] = { ...runReports[runID], [step.id]: { state: update.state, note: step.note, ...(step.blocker ? { blocker: step.blocker } : {}) } }
            if(completed.length)stepResults[step.id]={runIDs:[...new Set([...(stepResults[step.id]?.runIDs??[]),...completed])],state:update.state,recordedAt:new Date().toISOString(),...(step.blocker?{blocker:step.blocker}:{}),...(update.verification?{verification:update.verification}:{})}
          } else if(update.state==='pending'&&update.resolution){
            const finished=q.sessions.filter(s=>s.deliverables.includes(step.id)&&['completed','failed','cancelled'].includes(s.state)).map(s=>s.runID??s.callID)
            if(finished.length)stepResults[step.id]={...stepResults[step.id],runIDs:[...new Set([...(stepResults[step.id]?.runIDs??[]),...finished])],state:update.state,recordedAt:new Date().toISOString()}
          }
        }
        for (const update of input.steps) if (update.state === "done") {
          const run = q.sessions.findLast(s => ["planned", "executing", "waiting"].includes(s.state) && s.deliverables.includes(update.id))
          const next = run?.deliverables.map(id => stages.find(s => s.id === id)).find(s => s?.status === "pending" && !seen.has(s.id))
          if (next) next.status = "working"
        }
        if (stages.some(s => s.needs.some(id => id === s.id || !stages.some(other => other.id === id)))) throw new QuestError("INVALID_INPUT", "Unknown or self-dependent step")
        for (const started of startDueDeferred(stages)) { const step = stages.find(s => s.id === started)!; step.note = "Started: the current steps of this Quest are done, and the user has not said otherwise."; step.noteAt = new Date().toISOString() }
        const landed = withLandingLast(stages, writableWorkflow(patch.extensions ? (patch.extensions as Record<string, unknown>).workflow : q.extensions.workflow, stages), q.sessions.some(run => run.agentRole !== "command" && run.deliverables.length > 0))
        validateGraph(landed)
        patch.stages = landed
        if (q.delivered && landed.some(s => s.status !== "done")) { patch.delivered = null; if (input.result === undefined) patch.result = null }
        patch.extensions={...(patch.extensions??q.extensions) as Record<string,unknown>,stepResults,runReports,runStepSavedAt,...(Object.keys(outcomes).length?{branchOutcomes:outcomes}:{})}
        const handoffs = { ...(patch.extensions.giverHandoffs ?? {}) as Record<string, unknown> }
        for (const step of landed) {
          const previous = q.stages.find(old => old.id === step.id)
          if (previous && (previous.status !== step.status || JSON.stringify(previous.blocker) !== JSON.stringify(step.blocker))) delete handoffs[`step:${step.id}:${previous.status}`]
        }
        if (patch.extensions.giverHandoffs) patch.extensions.giverHandoffs = handoffs
        if (checks.length) patch.evidence = { ...q.evidence, tests: [...q.evidence.tests, ...checks] }
      }
      if (input.artifacts !== undefined) {
        if (!Array.isArray(input.artifacts)) throw new QuestError("INVALID_INPUT", "Artifacts must be an array")
        const artifacts = [...q.evidence.artifacts]
        for(const a of input.artifacts){keys(a,["name","path","uri","label"]);text(a.name,"Artifact name");const value=normalizeArtifact({...a,verified:false}),index=artifacts.findIndex(old=>old.name===value.name&&old.path===value.path&&old.uri===value.uri);if(index<0)artifacts.push(value);else artifacts[index]={...artifacts[index],...value,verified:artifacts[index].verified,at:artifacts[index].at}}
        patch.evidence = { ...(patch.evidence ?? q.evidence) as Quest["evidence"], artifacts }
      }
      if (input.archive !== undefined) {
        if (input.archive === null) patch.archive = undefined
        else {
          keys(input.archive, ["reason", "accepted"])
          if (typeof input.archive.accepted !== "boolean") throw new QuestError("INVALID_INPUT", "Archive accepted must be explicit")
          const steps = (patch.stages ?? q.stages) as Quest["stages"]
          if (q.sessions.some(s => ["planned", "executing", "waiting", "blocked"].includes(s.state))) throw new QuestError("ACTIVE_RUNS", "Wait for or cancel active runs before archiving")
          if (input.archive.accepted && (!steps.length || steps.some(s => s.status !== "done"))) throw new QuestError("UNFINISHED_STEPS", "Finish the requested steps before accepting the reward")
          if (!input.archive.accepted) text(input.archive.reason, "Reason for archiving unfinished work")
          patch.archive = { ...input.archive, at: new Date().toISOString() }
        }
      }
      return questView(store.apply(id, "patched", patch, "quest:update", { expectedRevision: q.revision }))
    },
    async run(id: string, input: RunQuest = {}) {
      keys(input, ["stepIDs", "model", "files", "readOnly", "task", "depth", "workType", "recoverDependencies"])
      if(input.recoverDependencies!==undefined&&typeof input.recoverDependencies!=="boolean")throw new QuestError("INVALID_INPUT","recoverDependencies must be a boolean")
      if(input.readOnly!==undefined&&typeof input.readOnly!=="boolean")throw new QuestError("INVALID_INPUT","readOnly must be a boolean")
      if(input.task!==undefined&&!TASK_CLASSES.includes(String(input.task).trim().toLowerCase() as any))throw new QuestError("INVALID_INPUT","task must be one of "+TASK_CLASSES.join(", "))
      if(input.depth!==undefined&&!DEPTHS.includes(String(input.depth).trim().toLowerCase() as Depth))throw new QuestError("INVALID_INPUT","depth must be one of "+DEPTHS.join(", "))
      knownWorkType(input.workType, "workType")
      if(input.files!==undefined&&(!Array.isArray(input.files)||!input.files.length||input.files.length>100||input.files.some(x=>typeof x!=="string"||!x.trim())))throw new QuestError("INVALID_INPUT","files must be 1–100 literal relative file/directory scopes")
      if (input.model !== undefined) text(input.model, "Model")
      id = getOwned(id).id
      const requestKey = hash(context.project.id + ":" + context.sessionID + ":" + context.requestID + ":run:" + id).slice(0, 26)
      let runID!: string
      let chooser: (model: string | undefined) => ChosenBy | undefined = () => undefined
      let q: Quest, stepIDs: string[], planned: ((key: string, attemptID: string, model: string | undefined) => Quest) | undefined, savedWorkflowModel: string | undefined
      const requested = input
      let admitted = !startRun.admit, admission: Parameters<AdmitRun>[0] | undefined
      for (;;) {
      input = requested
      admission = undefined
      const lock = acquireLock(store.runtime, "run-" + id)
      try {
        q = getOwned(id)
        if (q.project?.root && !existsSync(q.project.root)) throw new QuestError("PROJECT_ROOT_MISSING", "The recorded project folder " + q.project.root + " no longer exists, so no worker can be bound there. Move the Quest with update projectRoot to the maintained source project, then start it again.")
        const workflow = questWorkflow(q)
        savedWorkflowModel = input.model === undefined ? workflow.model : undefined
        const fromRoles = input.model === undefined && workflow.model === undefined ? roleWorkerModel() : undefined
        chooser = (model: string | undefined): ChosenBy | undefined => !model ? undefined : model === fromRoles || requestNamesModel(q, model) ? "jon" : context.resume ? "resume" : "giver"
        input = { ...input, model: input.model ?? workflow.model ?? fromRoles, task: input.task ?? workflow.task, depth: input.depth ?? workflow.depth, workType: input.workType ?? workflow.workType, readOnly: input.readOnly ?? workflow.readOnly }
        if (q.state === "Archived") throw new QuestError("ARCHIVED", "Reopen the Quest before starting work")
        const prior = q.sessions.find(s => s.requestKey === requestKey || s.runID === requestKey)
        if (prior) {
          runID = prior.runID ?? prior.callID
          if(!!input.readOnly!==!!(prior.scope as any)?.readOnly)throw new QuestError("REQUEST_CONFLICT","This request already selected another access mode")
          if (JSON.stringify(input.files??["."])!==JSON.stringify((prior.scope as any)?.requestedFiles??(prior.scope as any)?.files??["."]))throw new QuestError("REQUEST_CONFLICT","This request already reserved different file scopes")
          if (input.model !== undefined && prior.model !== input.model) throw new QuestError("REQUEST_CONFLICT", "This request already selected another model; use a new request identity")
          if (prior.state === "failed" || prior.state === "planned" && prior.result) throw new QuestError(prior.state === "failed" ? "DISPATCH_FAILED" : "DISPATCH_OUTCOME_UNKNOWN", (prior.result ?? "Previous launch failed") + retryHere(), false, runID)
          return { runID, state: prior.state, sessionID: prior.openCodeSessionId ?? prior.sessionID ?? null, result: prior.result ?? null }
        }
        { const held = workerHoldReason(store, q); if (held) throw new QuestError("WORKER_HOLD", held + ".", false, runID) }
        const next = nextQuestStep(q)
        const agentStep = (id: string) => !q.stages.find(step => step.id === id)?.commandID
        stepIDs = input.stepIDs ?? (next?.status === "pending" ? (agentStep(next.id) ? workerAssignment(q.stages, next.id, agentStep,(questWorkflow(q).maxConcurrent??1)===1) : [next.id]) : [])
        if (!Array.isArray(stepIDs) || !stepIDs.length || new Set(stepIDs).size !== stepIDs.length) throw new QuestError("NO_ELIGIBLE_STEPS", "No eligible steps; inspect pending work and dependencies")
        for (const id of stepIDs) {
          const step = q.stages.find(s => s.id === id)
          const earlier = stepIDs.slice(0, stepIDs.indexOf(id))
          if (isLandingStep(step)) throw new QuestError("STEP_NOT_ELIGIBLE", "No worker runs the landing step. The runtime marks it done from the landing record once the change is on v2 and the services reloaded.")
          if (noWorkerRuns(step)) throw new QuestError("STEP_NOT_ELIGIBLE", LANDING_COPY_REFUSED)
          if (!step || step.status !== "pending" || step.needs.some(dep => !earlier.includes(dep) && !q.stages.some(s => s.id === dep && s.status === "done"))) throw new QuestError("STEP_NOT_ELIGIBLE", "The selected step is not ready")
          if (step.deferred) throw new QuestError("STEP_DEFERRED", DEFERRED_NOT_STARTED)
          if (step.blocker) throw new QuestError("BLOCKER_UNCHANGED", "Resolve the saved prerequisite and report resolution.evidence before dispatch: " + step.blocker.requires)
          const restart = stepRestartRefusal(q, id); if (restart) throw new QuestError("STEP_RESTART_LIMIT", restart)
          const holding = q.sessions.find(s => ["planned", "executing", "waiting", "blocked"].includes(s.state) && s.deliverables.includes(id))
          if (holding) { const shown = holding.sessionRef ?? holding.runID ?? holding.callID; throw new QuestError("STEP_RUNNING", "The step already has an active run on this Quest: " + shown + ", " + holding.state + " since " + (holding.startedAt ?? holding.updatedAt) + ". Read it with inspect section=runs, or end it with stop runID " + shown + ". Another Quest for the same request is not a retry.") }
          const reconciled=(q.extensions.stepResults as Record<string,{runIDs:string[]}>|undefined)?.[id]?.runIDs??[]
          if (q.sessions.some(s => s.state === "completed" && s.deliverables.includes(id)&&!reconciled.includes(s.runID??s.callID))) throw new QuestError("STEP_UNRECONCILED", "A worker already completed this step without a reconciled result; inspect that session and save the step done or blocked with its result note, or pending with resolution.evidence, before retrying")
        }
        const owned = runningDependency(q, stepIDs)
        if (owned) throw new QuestError("DEPENDENCY_RUNNING", dependencyRunningMessage(q, owned.stepID, owned.run))
        const overlap = overlapRefusal(q, stepIDs)
        if (overlap) throw new QuestError("STEP_OVERLAPS", overlap)
        { const full = limitHold(store.projectRoot, store.runtime, q, requestKey); if (full) throw new QuestError("WORKER_LIMIT", full + ". No worker was started for this Quest.", false, runID) }
        const combined = runProfile(q.stages.filter(step => stepIDs.includes(step.id)), { depth: stepDepth(input.depth), workType: input.workType })
        input = { ...input, depth: combined.depth, workType: combined.workType }
        if (!admitted && !q.stages.some(step => stepIDs.includes(step.id) && step.commandID)) {
          admission = { quest: q, stepIDs, model: input.model, ...(chooser(input.model) ? { chosenBy: chooser(input.model) } : {}), readOnly: input.readOnly, task: input.task, depth: input.depth, workType: input.workType, context }
        } else {
        const sessionTitle = q.stages.filter(step => stepIDs.includes(step.id)).map(step => step.title).join(" and ")
        runID = reserveRunReference(store.runtime, sessionTitle, requestKey)
        const previous = previousAttempt(q,stepIDs)
        planned = (key: string, attemptID: string, model: string | undefined) => store.apply(q.id, "session-planned", { callID: attemptID, runID: attemptID, requestKey: key, sessionRef: attemptID, sessionTitle, parentID: context.sessionID, role: "worker", model, scope:{readOnly:input.readOnly===true,files:input.files??["."],requestedFiles:input.files??["."]}, deliverables: stepIDs, attempt: previous ? previous.attempt + 1 : 1, resumedFrom: previous?.callID, resumeRoot: previous?.resumeRoot ?? previous?.callID }, "quest:run")
        planned(requestKey, runID, input.model)
        }
      } finally { lock.release() }
      if (!admission) break
      await startRun.admit!(admission)
      admitted = true
      }
      const launch = async (attemptID: string, model: string | undefined) => {
        try {
          const started = await startRun({ quest: q!, runID: attemptID, stepIDs: stepIDs!, recoverDependencies:input.recoverDependencies, model, ...(chooser(model) ? { chosenBy: chooser(model) } : {}), files: input.files, readOnly:input.readOnly, task: input.task, depth: input.depth, workType: input.workType, context:continuationContext(q!,stepIDs!,context) })
          if (!started?.sessionID) throw new QuestError("DISPATCH_OUTCOME_UNKNOWN", "Host did not confirm a worker session; reconcile this run before retrying", false, attemptID)
          store.apply(id, "session-bound", { callID: attemptID, sessionID: started.sessionID }, "quest:run")
          return { runID: attemptID, state: store.read(id)?.sessions.find(s=>s.runID===attemptID)?.state ?? "executing", sessionID: started.sessionID }
        } catch (error) {
          const unknown = !(error instanceof QuestError) || error.code === "DISPATCH_OUTCOME_UNKNOWN"
          const evidence = redact(error instanceof Error ? error.message : "Dispatch failed", 2000), message = briefReason(evidence, "Dispatch failed")
          store.apply(id, "session-state", { callID: attemptID, state: unknown ? "planned" : "failed", result: noteReason(message), evidence, preserveTerminal:true }, "quest:run")
          if (savedWorkflowModel && chooser(savedWorkflowModel) === "giver" && error instanceof QuestError && error.code === "ROUTE_UNAVAILABLE") {
            const current = store.read(id), workflow = current && questWorkflow(current)
            if (current && workflow?.model === savedWorkflowModel) {
              const { model: _model, ...automatic } = workflow
              store.apply(id, "patched", { extensions: { ...current.extensions, workflow: automatic } }, "quest:route-recovery")
            }
          }
          const actual=store.read(id)?.sessions.find(s=>s.runID===attemptID)
          if(actual && ["completed","failed","cancelled"].includes(actual.state) && (unknown||actual.result!==redact(noteReason(message))))throw new QuestError("DISPATCH_RESPONSE_FAILED", "Worker outcome: "+actual.state+". Dispatch response error: "+message+retryHere(),false,attemptID)
          const prerequisite = error instanceof QuestError ? ({WORKSPACE_PREPARATION_FAILED:'environment',WORKER_TOOLS_UNAVAILABLE:'environment',CONTINUATION_DEPENDENCIES_MISSING:'dependency'} as Record<string,StepBlocker['kind']>)[error.code] : undefined
          if(prerequisite&&actual?.state==='failed'&&error instanceof QuestError){
            const current=store.read(id)!
            const steps=current.stages.filter(step=>stepIDs!.includes(step.id)&&['pending','working'].includes(step.status))
            const reason=noteReason(message),blocker:StepBlocker={kind:prerequisite,owner:'Quest Giver',requires:reason}
            if(steps.length)try{questsAPI(store,context,startRun).update(id,{steps:steps.map(step=>({id:step.id,state:'blocked',note:reason,blocker}))})}
            catch(refused){if(!(refused instanceof QuestError))throw refused;saveRuntimeBlocker(store,id,steps.map(step=>step.id),reason,blocker)}
            throw new QuestError(error.code,message+' The step is blocked. Repair the prerequisite and save resolution.evidence before another run.',false,attemptID)
          }
          throw new QuestError(unknown ? "DISPATCH_OUTCOME_UNKNOWN" : (error as QuestError).code, message + retryHere(), false, attemptID)
        }
      }
      return launch(runID, input.model)
    },
  }
}
