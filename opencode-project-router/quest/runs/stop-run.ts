import { QuestError } from '../api'
import { Duration, Effect } from 'effect'
import { QuestTracker, releaseEndedRunLocks } from './tracker'
import { activeRuns, isRun } from './wait'
import { FROZEN_RUN_STOP, OWNED_RUN, stopResult } from './session-lineage'
import { requestQuestPlan } from './start-request'
import { readContinuations, v2QueueGeneration } from '../core/runtime-queues'
import { boundedInspection } from '../worker-observation.mjs'
import { QuestWorkspaces } from '../workspaces'
import { lockHolder, workspaceLockHolder } from '../locking.mts'
import { releaseRunLocks } from '../checkouts/run-locks'
import { lastFrozenRunAction } from '../workers/stall-watch-mode'
import type { QuestHost } from './runtime'
import type { QuestStore } from '../store'
import type { Quest } from '../types'
import { killCommandTree } from '../workers/process-progress'
import { confirmWorkerIdle } from '../workers/worker-inspection'
import { timed } from '../../scripts/plugin-spans'

const shownRun = (run: { sessionRef?: string; runID?: string; callID: string }) => run.sessionRef ?? run.runID ?? run.callID
const RESUME_PENDING='same-session continuation acknowledgment pending'
const RESUME_UNKNOWN='resume acknowledgment unknown'
const sessionUnavailable=(error:unknown)=>{
 const value=error as {status?:unknown;response?:{status?:unknown}}
 return value?.status===404||value?.response?.status===404||/session (?:not found|does not exist|is unavailable)|unknown session/i.test(error instanceof Error?error.message:String(error))
}

function nothingToStop(quest: Quest, runID?: string) {
  const named = runID ? quest.sessions.find(run => isRun(run, runID)) : undefined
  const ended = named ? ' It already ended ' + named.state + ' at ' + named.updatedAt + (named.result ? ': ' + named.result : '.') : ''
  const holding = activeRuns(quest).filter(run => !named || run.deliverables.some(id => named.deliverables.includes(id)))
  const now = holding.length ? ' Active now: ' + holding.map(run => shownRun(run) + ', ' + run.state + ' since ' + (run.startedAt ?? run.updatedAt)).join('; ') + '.' : ''
  return (runID ? 'Run ' + runID + ' is not running' : 'No run of this Quest is running') + '; nothing was stopped.' + ended + now
}

const SETTLE_POLLS = 4
const SETTLE_MS = 300
const pauseFor = (ms: number) => Effect.runPromise(Effect.sleep(Duration.millis(ms)))
type StopOptions = { pause?: (ms: number) => Promise<unknown>; killTree?: (worktree: string | undefined) => Promise<number[]> }

async function untilIdle(host: QuestHost, sessionID: string, pause: (ms: number) => Promise<unknown>) {
  for (let poll = 0; poll < SETTLE_POLLS; poll++) {
    if (await confirmWorkerIdle(host, sessionID)) return true
    await pause(SETTLE_MS)
  }
  return confirmWorkerIdle(host, sessionID)
}

export async function stopQuestRuns(store: QuestStore, host: QuestHost, questID: string, input: { runID?: string; reason?: string; order?: string; sender?: string }, options: StopOptions = {}) {
  const quest = store.read(questID)
  if (!quest) throw new QuestError('NOT_FOUND', 'Quest not found: ' + questID)
  const runs = activeRuns(quest, input.runID)
  const ended = input.runID ? quest.sessions.find(run => isRun(run, input.runID)) : undefined
  if (!runs.length && ended) return { stopped: [], note: nothingToStop(quest, input.runID) }
  if (!runs.length) throw new QuestError('NO_RUNNING_WORKER', nothingToStop(quest, input.runID))
  const result = stopResult(input.reason, input.sender, input.order)
  const { pause = pauseFor, killTree = worktree => killCommandTree(worktree) } = options
  const tracker = new QuestTracker(store, host)
  const stopped = [], notes: string[] = [], workspaces = new QuestWorkspaces(store.runtime)
  for (const run of runs) {
    const runID = run.runID ?? run.callID
    const sessionID = run.openCodeSessionId ?? run.sessionID
    const abortable = sessionID?.startsWith('ses_') ? sessionID : undefined
    let aborted = false, idle = false, killed: number[] = [], error: string | undefined
    if (abortable) {
      if (typeof host.interrupt !== 'function') error = 'This host has no session abort.'
      else try { const reply: any = await boundedInspection(() => host.interrupt!({ sessionID: abortable })); aborted = (reply?.data ?? reply)?.interrupted === true } catch (cause) { error = 'The host did not confirm the abort: ' + (cause instanceof Error ? cause.message : String(cause)) }
      idle = await untilIdle(host, abortable, pause)
      if (!idle) { killed = await killTree(typeof run.scope?.worktree === 'string' ? run.scope.worktree : run.worktree); idle = await untilIdle(host, abortable, pause) }
      aborted = aborted || idle
    }
    const settled = !abortable || idle
    if (!sessionID) notes.push('No session was bound to run ' + runID + ', so nothing could be aborted; it is saved cancelled.')
    else if (!abortable) notes.push('Session ' + sessionID + ' is not a native OpenCode session, so it could not be aborted; run ' + runID + ' is saved cancelled and its session may still be running.')
    else if (!idle) notes.push('Session ' + abortable + ' did not end after the abort and a process-tree kill (' + killed.length + ' processes killed); it may still be running. Run ' + runID + ' stays active, so stop it again to retry.')
    const lockName = run.runID && 'workspace-' + workspaces.lockID(run.runID)
    if (settled) {
      await tracker.settleRun(quest.id, run, 'cancelled', result, 'quest:stop')
      if (sessionID) releaseEndedRunLocks(store, host, sessionID, run.runID && workspaces.lockID(run.runID))
      releaseRunLocks(store.runtime, { quest: quest.id, run: runID })
    }
    const lockReleased = !!sessionID && (!lockName || lockHolder(store.runtime, lockName) !== workspaceLockHolder(sessionID))
    stopped.push({ runID, sessionID, state: settled ? 'cancelled' : run.state, aborted, killed, ended: idle, lockReleased, ...(error ? { error } : {}) })
  }
  return { stopped, note: [result, ...notes].join(' ') }
}

export async function stopFrozenRun(store: QuestStore, host: QuestHost, questID: string, runID: string, reason: string, resumeOriginal=false, timedOut=false) {
  const quest = store.read(questID)
  const run = quest?.sessions.find(row => (row.runID ?? row.callID) === runID)
  if (!quest || !run || !OWNED_RUN.has(run.state)) return undefined
  const sessionID = run.openCodeSessionId ?? run.sessionID
  if(!timedOut&&resumeOriginal&&sessionID?.startsWith('ses_'))try{
    await timed({plugin:'quests',name:'stall.resume-frozen-run',op:runID,sessionID},()=>boundedInspection(signal=>host.prompt({sessionID,id:'msg_questfrozen'+runID,delivery:'queue',resume:true,text:'A stall check found this worker silent for at least ten minutes: '+reason+'. Continue only the assigned Quest steps '+run.deliverables.join(', ')+'. Inspect the existing command and checkout before retrying anything; do not repeat side effects blindly. Preserve every permission decision and do not retry a refused action. Record real checks and stop if blocked.',metadata:{questFrozenRun:true,questID,runID}},{signal})))
    return {runID,sessionID,aborted:false,restart:'resumed'}
  }catch(error){
    if(!sessionUnavailable(error))return {runID,sessionID,aborted:false,restart:RESUME_UNKNOWN}
  }
  if(!timedOut&&!resumeOriginal&&sessionID?.startsWith('ses_')&&[RESUME_PENDING,RESUME_UNKNOWN].includes(lastFrozenRunAction(store.runtime,questID,runID,sessionID)??''))try{
    const accepted=await timed({plugin:'quests',name:'stall.reconcile-frozen-resume',op:runID,sessionID},async()=>{
      const response=await boundedInspection(signal=>host.get({sessionID},{signal})),session=response?.data??response
      if(session?.id!==sessionID)throw Object.assign(new Error('Session not found: '+sessionID),{status:404})
      if(typeof host.context!=='function')return false
      const context=await boundedInspection(signal=>host.context!({sessionID},{signal})),messages=context?.data??context
      return Array.isArray(messages)&&messages.some((message:any)=>message?.id==='msg_questfrozen'+runID)
    })
    if(accepted)return {runID,sessionID,aborted:false,restart:'resumed'}
    return {runID,sessionID,aborted:false,restart:RESUME_UNKNOWN}
  }catch(error){
    if(!sessionUnavailable(error))return {runID,sessionID,aborted:false,restart:RESUME_UNKNOWN}
  }
  if (timedOut) await killCommandTree(typeof run.scope?.worktree === 'string' ? run.scope.worktree : undefined)
  let aborted = false, abortError: string | undefined
  if (sessionID?.startsWith('ses_') && typeof host.interrupt === 'function') try { await boundedInspection(() => host.interrupt!({ sessionID })); aborted = true } catch (cause) { abortError = cause instanceof Error ? cause.message : String(cause) }
  if (abortError) return { runID, sessionID, aborted, restart: 'not stopped: the host did not confirm the abort: ' + abortError }
  const result = FROZEN_RUN_STOP + ': ' + reason + '. The checkout is kept and the step starts again.'
  await new QuestTracker(store, host).settleRun(questID, run, 'failed', result, 'quest:frozen-run')
  if (sessionID) releaseEndedRunLocks(store, host, sessionID, run.runID && new QuestWorkspaces(store.runtime).lockID(run.runID))
  releaseRunLocks(store.runtime, { quest: questID, run: runID })
  const continuing = readContinuations(store.runtime).some(row => row.questID === questID && !['done', 'stopped'].includes(row.state))
  let restart: string = 'continuation'
  if (!continuing) try { restart = requestQuestPlan(store, questID, v2QueueGeneration()).state } catch (cause) { restart = 'not started: ' + (cause instanceof Error ? cause.message : String(cause)) }
  return { runID, sessionID, aborted, restart }
}

export async function stopRepeatingRun(store: QuestStore, host: QuestHost, questID: string, runID: string, reason: string) {
  const quest = store.read(questID)
  const run = quest?.sessions.find(row => (row.runID ?? row.callID) === runID)
  if (!quest || !run || !OWNED_RUN.has(run.state)) return undefined
  const sessionID = run.openCodeSessionId ?? run.sessionID
  await new QuestTracker(store, host).settleRun(questID, run, 'failed', 'Stopped: ' + reason + ' The checkout is kept; start the step again with a different approach.', 'quest:no-progress')
  let aborted = false
  if (sessionID?.startsWith('ses_') && typeof host.interrupt === 'function') try { await boundedInspection(() => host.interrupt!({ sessionID })); aborted = true } catch {}
  if (sessionID) releaseEndedRunLocks(store, host, sessionID, run.runID && new QuestWorkspaces(store.runtime).lockID(run.runID))
  releaseRunLocks(store.runtime, { quest: questID, run: runID })
  return { runID, sessionID, aborted }
}
