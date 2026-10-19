import { nextStepAction } from "./steps"
import { completionMissing } from "../workers/completion"
import { latestSessionAttempts, RECONCILED_NOTE } from "../runs/session-lineage"
import { briefReason } from "../workers/completion-return"
import { blockerLine, ownedBlocker, ownerWait, runtimeFault, waitingOnOwner } from "../runs/blocker-owner"
import { LANDING_STEP_DETAIL, LANDING_STEP_TITLE, isLandingStep, landingDone } from "../landing/landing-step"
import type { NeedsJon, Quest, QuestStage, QuestState } from "../types"

export const GIVER_RESOLVING = "Quest Giver is resolving: "
export const WAITING_FOR_GIVER = "Not yet handed to the Quest Giver: "
const GIVER_NEXT = "The named owner resolves the prerequisite; the Quest Giver resumes after its changed evidence is saved"
const HAND_OVER = "Hand it to the Quest Giver: nobody has told it about this blocker yet"
export type Handoff = { at: string; via: string; giver?: string; wakes?: number }
export const handoffsOf = (q: Quest): Record<string, Handoff> => {
  const handoffs = { ...(q.extensions?.giverHandoffs ?? {}) } as Record<string, Handoff>
  for (const step of q.stages) {
    const legacy = handoffs[`step:${step.id}:${step.status}`]
    if (legacy) handoffs[stepBlockerKey(step)] ??= legacy
  }
  return handoffs
}
export const SAVED_BY_GIVER = "saved by the Quest Giver"
export const savedByGiver = (q: Quest, step: QuestStage) => step.status === "blocked" && !step.needsJon && handoffsOf(q)[stepBlockerKey(step)]?.via === SAVED_BY_GIVER
const fingerprint = (text: string) => { let hash = 0x811c9dc5; for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0; return hash.toString(16).padStart(8, "0") }
export const stepBlockerKey = (step: QuestStage) => `step:${step.id}:${step.status}${step.blocker ? ':' + fingerprint(JSON.stringify(step.blocker)) : ''}`
export const runKey = (run: { runID?: string; callID: string }) => `run:${run.runID ?? run.callID}`
type Derived = { state: QuestState; reason: string; nextAction: string; missing: string[]; resolving?: true; blockers?: string[]; handedAt?: string }
function handedOver(q: Quest, blockers: string[], state: QuestState, reason: string, missing: string[]): Derived {
  const handoffs = handoffsOf(q), handed = blockers.every(key => handoffs[key])
  if (!handed) return { state, reason: WAITING_FOR_GIVER + reason, nextAction: HAND_OVER, missing, blockers }
  const handedAt = blockers.map(key => handoffs[key].at).sort().at(-1)
  return { state, reason: GIVER_RESOLVING + reason, nextAction: GIVER_NEXT, missing, resolving: true, blockers, ...(handedAt ? { handedAt } : {}) }
}
export const giverBlockers = (q: Quest): string[] => deriveState(q).blockers ?? []
export const unhandedBlockers = (q: Quest): string[] => { const handoffs = handoffsOf(q); return giverBlockers(q).filter(key => !handoffs[key]) }
export const NEEDS_JON_LABEL: Record<NeedsJon, string> = { "sign-in": "a sign-in", spend: "spending money", "main-release": "a release to main", destructive: "a destructive action", choice: "a choice only the user can make" }
export const jonGates = (q: Quest): QuestStage[] => q.stages.filter(step => step.status === "blocked" && !!step.needsJon)
const jonGateLine = (step: QuestStage) => `${step.title} needs Jon for ${NEEDS_JON_LABEL[step.needsJon!]}${step.note ? ": " + step.note : ""}`

export function deriveState(q: Quest): Derived {
  const sessions=latestSessionAttempts(q.sessions),active=sessions.filter(s=>["planned","executing","waiting","blocked"].includes(s.state))
  const missing=completionMissing(q),done=q.stages.length>0&&q.stages.every(s=>s.status==="done")
  if(q.archive||q.state==="Archived")return {state:"Archived",reason:q.archive?.reason??"Archived",nextAction:"Reopen to resume",missing:[]}
  if(q.delivered&&done&&!active.length)return landingDone(q.stages)?{state:"Complete",reason:q.delivered.where,nextAction:"Nothing left to do",missing}:{state:"Ready to complete",reason:q.delivered.where,nextAction:"Read the result, then press Got it",missing}
  const ended=active.length?[]:q.stages.filter(step=>step.status!=='done'&&sessions.some(run=>['completed','cancelled'].includes(run.state)&&run.deliverables.includes(step.id)))
  const saved=ended.filter(step=>step.status==='blocked'||step.status==='pending'&&!!step.note&&!RECONCILED_NOTE.test(step.note)),unfinished=ended.length>saved.length
  const asks=active.flatMap(s=>s.state==="executing"&&s.awaiting?[s.awaiting.ask]:[])
  if(asks.length)return {state:"Needs attention",reason:"A worker is waiting for the user to allow or reject: "+asks.join("; "),nextAction:nextStepAction(q),missing}
  const gated=jonGates(q)
  if(gated.length)return {state:"Needs attention",reason:gated.map(jonGateLine).join("; "),nextAction:"The user decides: "+gated.map(step=>NEEDS_JON_LABEL[step.needsJon!]).join("; "),missing}
  const failed=done?[]:sessions.filter(s=>["failed","missing","stale"].includes(s.state))
  const executing=active.some(s=>s.state==="executing")
  const resolving=!executing&&(ended.length>0||q.stages.some(s=>s.status==="blocked")||failed.length>0)
  const state:QuestState=resolving?"Waiting":executing?"Working":done&&!active.length?"Ready to complete":"Waiting"
  const blocked=q.stages.filter(step=>step.status==="blocked"&&!saved.includes(step))
  const reason=unfinished?"Worker ended without saved completion of its assigned steps":saved.length?saved.map(step=>step.title+" saved "+step.status+(blockerLine(step)?": "+blockerLine(step):"")).join("; "):resolving&&blocked.length?blocked.map(step=>step.title+" blocked"+(blockerLine(step)?": "+blockerLine(step):"")).join("; "):resolving&&failed.length?failed.map(run=>"a worker run "+run.state+(run.result?": "+briefReason(run.result):"")).join("; "):q.stages.filter(s=>s.status==="done").length+"/"+q.stages.length+" steps done"
  if(resolving){
    const unfinishedRuns=ended.filter(step=>!saved.includes(step)).flatMap(step=>sessions.filter(run=>['completed','cancelled'].includes(run.state)&&run.deliverables.includes(step.id)).map(runKey))
    const blockers=[...new Set([...q.stages.filter(step=>(step.status==="blocked"||saved.includes(step))&&!ownedBlocker(step)).map(stepBlockerKey),...unfinishedRuns,...failed.filter(run=>!waitingOnOwner(q,run)).map(runKey)])].sort()
    if (!blockers.length && q.stages.some(ownedBlocker)) return { state, reason: ownerWait(q), nextAction: GIVER_NEXT, missing }
    const faults=q.stages.filter(step=>step.status==='blocked')
    if(faults.length&&faults.every(runtimeFault)&&!unfinished&&!failed.length)return {state,reason,nextAction:"Start the step again",missing,blockers}
    return handedOver(q,blockers,state,reason,missing)
  }
  return {state,reason,nextAction:saved.length?"Act on what the worker saved, then resume the step":nextStepAction(q),missing}
}

export function normalizeState(q: Quest): Quest {
  q.executingCount = latestSessionAttempts(q.sessions).filter((x) => x.state === "executing").length
  for (const step of q.stages) if (isLandingStep(step)) { step.title = LANDING_STEP_TITLE; step.detail = LANDING_STEP_DETAIL }
  const derived = deriveState(q)
  q.state = derived.state; q.reason = derived.reason; q.nextAction = derived.nextAction; q.missingRequirements = derived.missing
  return q
}
