import type { QuestSession } from '../types'

export const INFRASTRUCTURE: { pattern: RegExp; reason: string }[] = [
  { pattern: /command timed out|Command exceeded timeout|\[quest\] stopped after/i, reason: 'a command ran past its limit and was stopped' },
  { pattern: /no progress:/i, reason: 'the run repeated itself without progress and was stopped' },
  { pattern: /dispatch owner .{0,80}exited|Exited dispatch owner/i, reason: 'the dispatching host exited before the run could finish' },
  { pattern: /The host never started this run/, reason: 'the host restarted before the run started' },
  { pattern: /Owning host reports this session idle with a persisted/, reason: 'execution was interrupted' },
  { pattern: /External .{0,40} run stopped renewing its lease/, reason: 'the host connection was lost' },
  { pattern: /Owning host no longer holds this session/, reason: 'the host process it was running in ended' },
  { pattern: /Worker interrupted; no automatic restart is authorized/, reason: 'execution was interrupted' },
  { pattern: /socket connection was closed/i, reason: 'the tool transport closed mid-run' },
  { pattern: /operation timed out/i, reason: 'the tool transport timed out' },
  { pattern: /usage limit (has been )?reached/i, reason: 'the account allowance was exhausted' },
  { pattern: /monthly usage limit/i, reason: 'the account allowance was exhausted' },
  { pattern: /connection lost/i, reason: 'the host connection was lost' },
  { pattern: /execution interrupted/i, reason: 'execution was interrupted' },
  { pattern: /no healthy failover/i, reason: 'no healthy route was available' },
  { pattern: /working directory does not exist/i, reason: 'the assigned workspace was missing' },
  { pattern: /execution ended with the host process/i, reason: 'the host process it was running in ended' },
  { pattern: /planned before this host started/i, reason: 'the host restarted before the run started' },
  { pattern: /the worker did not start/i, reason: 'the worker did not start' },
  { pattern: /lock timeout/i, reason: 'a lock timed out' },
  { pattern: /Workspace preparation failed at install dependencies|Dependency changes conflict/i, reason: "installing the checkout's packages failed" },
  { pattern: /WORKSPACE_PREPARATION_FAILED|CONTINUATION_WORKSPACE_UNAVAILABLE|Continuation access mode differs from its original workspace|Cannot resume original worktree|Invalid Git directory binding|workspace (preparation|checkout) failed|checkout failed|Cannot establish selected Git checkout|Dependency workspace .{0,80} was created under .{0,400} and this Quest now runs in/i, reason: 'the workspace failed (checkout or Git binding)' },
  { pattern: /Git repository binding changed during discovery/i, reason: 'the workspace failed (checkout or Git binding)' },
  { pattern: /Workspace ownership or path mismatch|Original worktree still has an active owner|retained checkout does not contain newly required dependency changes|Resolve dependency conflicts before starting/i, reason: 'the workspace failed (checkout or Git binding)' },
  { pattern: /Recovery requires a retained writable serial Quest PR attempt/i, reason: 'the run could not resume its old attempt' },
  { pattern: /is not saved done, and its last run .{0,120} ended/i, reason: 'a step it depends on was not done yet' },
  { pattern: /HOST_DRAINING/, reason: 'the host was being replaced and took no new work' },
  { pattern: /An update to the Quest host waits for the running Quest work/i, reason: 'the host was being replaced and took no new work' },
  { pattern: /The user giver changed/i, reason: 'the Quest Giver changed before the run started' },
  { pattern: /checkout is missing|Recorded workspace is gone/i, reason: 'the workspace failed (checkout or Git binding)' },
  { pattern: /AUTHORIZED_ROUTE_UNAVAILABLE|No evidenced, funded route|no allowed (model|route)|No route can|Cannot verify reasoning in the outgoing request/i, reason: 'routing refused the run' },
  { pattern: /was retired at \d{4}-\d{2}-\d{2}/i, reason: 'routing sent the run to a retired model' },
  { pattern: /Rate limit exceeded|free tier can only be used from within OpenCode/i, reason: 'the provider refused the account' },
  { pattern: /(powershell|tool call)[^.]{0,80}(never returned|did not return|no result|hung)/i, reason: 'a tool call never returned' },
  { pattern: /stopped by (jon|the quest giver)/i, reason: 'the run was stopped for a harness reason' },
  { pattern: /Permission ask went unanswered/, reason: 'the permission role did not answer the worker in time' },
  { pattern: /unknown provider for model/i, reason: 'the CLIProxyAPI broker had not loaded its accounts' },
  { pattern: /has no Quest tools:|Quest tools did not load|Worker cannot save assigned Quest results/i, reason: 'the worker’s Quest tools did not load' },
  { pattern: /Frozen run stopped by the stall watch/i, reason: 'the run froze with a tool call stuck in running' },
  { pattern: /Failed to execute statement.{0,40}database is locked|could not save to its database: another host process held the database lock/i, reason: 'the host database was locked by another host process' },
  { pattern: /ENOSPC|no space left on device|not enough space on the disk|disk (is )?full/i, reason: 'the disk was full' },
  { pattern: /Failed to execute statement/i, reason: 'the host could not save to its database' },
  { pattern: /Use PowerShell or rg instead of Unix binaries|Use PowerShell ';' instead of &&|shell guard (sent|sends) .{0,60}PowerShell/i, reason: 'the old shell guard sent the command to PowerShell' },
]

export function hostEnding(run: Pick<QuestSession, 'state' | 'result' | 'evidence'>): string | undefined {
  if (run.state === 'completed') return undefined
  for (const line of [...[...(run.evidence ?? [])].reverse(), run.result ?? '']) {
    const infrastructure = INFRASTRUCTURE.find(entry => entry.pattern.test(line))
    if (infrastructure) return infrastructure.reason
  }
  if (run.state === 'cancelled') return 'the run was stopped or reloaded before a verdict'
  return undefined
}
