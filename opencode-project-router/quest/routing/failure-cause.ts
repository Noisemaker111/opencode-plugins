import { hostEnding } from './run-judgment'
import type { QuestSession } from '../types'
import { TERMINAL_RUN } from '../runs/session-lineage'

export type Fault = 'worker' | 'environment' | 'gate' | 'infrastructure' | 'owner'
export type FailureCause = { code: string; text: string; fault: Fault }

export const KNOWN: Record<string, { code: string; fault: Fault }> = {
  'the dispatching host exited before the run could finish': { code: 'host-lost', fault: 'infrastructure' },
  'the host process it was running in ended': { code: 'host-lost', fault: 'infrastructure' },
  'the host restarted before the run started': { code: 'host-lost', fault: 'infrastructure' },
  'the host connection was lost': { code: 'host-lost', fault: 'infrastructure' },
  'execution was interrupted': { code: 'host-lost', fault: 'infrastructure' },
  'the host was being replaced and took no new work': { code: 'host-lost', fault: 'infrastructure' },
  'the tool transport closed mid-run': { code: 'tool-lost', fault: 'infrastructure' },
  'the tool transport timed out': { code: 'tool-lost', fault: 'infrastructure' },
  'a tool call never returned': { code: 'command-stuck', fault: 'infrastructure' },
  'the run froze with a tool call stuck in running': { code: 'command-stuck', fault: 'infrastructure' },
  'a command ran past its limit and was stopped': { code: 'command-limit', fault: 'worker' },
  'the run repeated itself without progress and was stopped': { code: 'no-progress', fault: 'worker' },
  'the account allowance was exhausted': { code: 'route-refused', fault: 'environment' },
  'the provider refused the account': { code: 'route-refused', fault: 'environment' },
  'no healthy route was available': { code: 'route-refused', fault: 'environment' },
  'routing refused the run': { code: 'route-refused', fault: 'environment' },
  'routing sent the run to a retired model': { code: 'route-refused', fault: 'infrastructure' },
  'the CLIProxyAPI broker had not loaded its accounts': { code: 'route-refused', fault: 'infrastructure' },
  'the assigned workspace was missing': { code: 'workspace', fault: 'environment' },
  'the workspace failed (checkout or Git binding)': { code: 'workspace', fault: 'environment' },
  'the disk was full': { code: 'workspace', fault: 'environment' },
  'the worker did not start': { code: 'start-failed', fault: 'infrastructure' },
  'the run could not resume its old attempt': { code: 'start-failed', fault: 'infrastructure' },
  "installing the checkout's packages failed": { code: 'dependencies', fault: 'environment' },
  'a step it depends on was not done yet': { code: 'dependency-unfinished', fault: 'gate' },
  'the Quest Giver changed before the run started': { code: 'start-failed', fault: 'infrastructure' },
  'the worker’s Quest tools did not load': { code: 'tools-not-loaded', fault: 'infrastructure' },
  'a lock timed out': { code: 'database', fault: 'infrastructure' },
  'the host database was locked by another host process': { code: 'database', fault: 'infrastructure' },
  'the host could not save to its database': { code: 'database', fault: 'infrastructure' },
  'the permission role did not answer the worker in time': { code: 'permission-silent', fault: 'infrastructure' },
  'the run was stopped for a harness reason': { code: 'stopped-on-purpose', fault: 'owner' },
  'the run was stopped or reloaded before a verdict': { code: 'stopped-on-purpose', fault: 'owner' },
  'the old shell guard sent the command to PowerShell': { code: 'gate', fault: 'gate' },
}

export const FAILURE_CAUSE_TEXT: Record<string, string> = {
  'host-lost': 'the Quest host stopped or restarted under the run',
  'tool-lost': 'the tool connection dropped',
  'command-stuck': 'a command never finished',
  'command-limit': 'a command ran past its limit and was stopped',
  'no-progress': 'the run repeated itself without progress',
  'route-refused': 'the model route or account refused the run',
  workspace: 'the checkout or disk was not usable',
  dependencies: 'installing packages in the checkout failed',
  'dependency-unfinished': 'it was started before a step it depends on was done',
  'start-failed': 'the worker never started',
  'tools-not-loaded': 'the Quest tools did not load in the worker’s checkout',
  database: 'the host database was locked or failed',
  'permission-silent': 'the permission role did not answer',
  'stopped-on-purpose': 'the run was stopped or reloaded on purpose',
  gate: 'a gate refused the command',
  other: 'no cause was recorded',
}

export function failureCause(run: Pick<QuestSession, 'state' | 'result' | 'evidence'>): FailureCause | undefined {
  if (run.state === 'completed') return undefined
  const reason = hostEnding(run)
  const known = reason ? KNOWN[reason] : undefined
  if (known) return { ...known, text: FAILURE_CAUSE_TEXT[known.code] }
  const saved = reason || run.result?.trim() || run.evidence.at(-1)?.trim()
  return { code: 'other', text: saved ? saved.replace(/\s+/g, ' ').slice(0, 160) : FAILURE_CAUSE_TEXT.other, fault: 'infrastructure' }
}

export const RESTART_LIMIT = 3

export function stepRestartRefusal(q: { sessions: QuestSession[]; stages: { id: string; resolution?: { evidence: string } }[] }, stepID: string): string | undefined {
  const runs = q.sessions.filter(run => run.deliverables.includes(stepID) && TERMINAL_RUN.has(run.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  const last = runs.slice(-RESTART_LIMIT)
  if (last.length < RESTART_LIMIT || !last.every(run => ['worker', 'gate'].includes(failureCause(run)?.fault ?? ''))) return
  if (q.stages.find(step => step.id === stepID)?.resolution?.evidence?.trim()) return
  return "Step " + stepID + " has restarted " + (q.sessions.filter(run => run.deliverables.includes(stepID)).length - 1) + " times and its last " + RESTART_LIMIT + " runs failed on the worker or a gate. The Quest Giver must save resolution evidence naming what changed before starting it again."
}
