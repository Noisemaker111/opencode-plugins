import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sessionToolCalls, type SessionToolCall } from '../host/host-history'
import { projectCheck } from '../checkouts/workspace-bootstrap'
import { driveAsync, gitRun } from '../landing/git-steps'
import { readSessionRequests, TELEMETRY_FILE } from '../../usage/telemetry-store'
import { requestMetrics } from '../../usage/request-metrics'
import type { Quest, QuestResult, QuestSession, StepBlocker } from '../types'
import type { Workspace } from '../workspaces'
import { isLandingStep } from '../landing/landing-step'

export type EvidenceFile = { path: string; status: 'added' | 'modified' | 'deleted' | 'untracked'; additions: number | null; deletions: number | null; namedInMessage: boolean }
export type EvidenceCommand = { command: string; exitCode: number | null; status?: string; startedAt?: number; milliseconds?: number; source: string }
export type EvidenceIssue = { kind: 'error' | 'permission' | 'retry'; tool: string; detail: string; at?: number }
export type EvidenceCheck = { command: string; argv: string[]; cwd?: string; timeoutMilliseconds?: number; shell: boolean; matches: string[]; recorded?: EvidenceCommand; ranOnFinalTree: boolean; lastChangeAt?: number; why: string }
export type EvidenceStep = { id: string; title: string; status: string; note?: string; detail?: string; blocker?: StepBlocker; result?: QuestResult; undoneTodos: string[] }
export type OtherStep = { id: string; title: string; status: string; detail?: string }
export type ReviewEvidence = {
  questID: string; runID: string; stepIDs: string[]; request: string; collectedAt: number
  steps: EvidenceStep[]
  otherSteps?: OtherStep[]
  workspace?: { path: string; branch: string; base: string }
  diff: { available: boolean; files: EvidenceFile[]; commits: string[]; patch: string; head?: string; namedPaths: { path: string; touched: boolean }[]; error?: string }
  tests: { path: string; change: 'added' | 'changed' | 'deleted' }[]
  verification: { stepID?: string; command: string; exitCode: number | null; artifact?: string; at: string }[]
  commands: { recorded: boolean; rows: EvidenceCommand[]; diagnostics: string[] }
  issues: EvidenceIssue[]
  check?: EvidenceCheck
  usage: { wallMilliseconds: number | null; requests: number; tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }; missingTokenRequests: Record<string, number>; cost: { currency: string; actual: number | null; estimate: number | null }[] }
  undone: { stepID: string; state: string; note?: string; blocker?: StepBlocker }[]
}
export type EvidenceSources = { hostDB: string; requestsFile?: string; now?: number }

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rs)$/i
const EDIT_TOOL = /^(?:.*\.)?(edit|write|patch|apply_patch|multiedit|multi_edit|str_replace_based_edit_tool)$/i
const PERMISSION = /permission|rejected|denied|not allowed|refus/i
const runKey = (run: QuestSession) => run.runID ?? run.callID
const slash = (path: string) => path.replace(/\\/g, '/')
const normalise = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

export function requestText(quest: Quest): string {
  const words = (quest.request ?? []).filter(row => !row.context).map(row => row.text.trim()).filter(Boolean)
  return words.length ? words.join('\n\n') : (quest.description ?? quest.objective ?? quest.title)
}


export function namedPaths(text: string): string[] {
  const source = /\.(?:[cm]?[jt]sx?|json|md|py|go|rs|java|cs|css|scss|html|ya?ml|toml|sh|ps1|sql|txt)$/i
  return [...new Set((text.match(/[\w.@-]*[\\/][\w.@\\/-]+|[\w@-]{2,}\.[a-z][a-z0-9]{0,5}\b/gi) ?? []).map(path => slash(path).replace(/^\.\//, '').replace(/[.,;:]+$/, '')).filter(path => path.length > 2 && !/^https?:|\/\//i.test(path) && (path.includes('/') || source.test(path))))]
}

function issuesOf(calls: SessionToolCall[]): EvidenceIssue[] {
  const issues: EvidenceIssue[] = [], failed = new Set<string>()
  for (const call of calls) {
    const key = call.tool + '\0' + JSON.stringify(call.input ?? null)
    if (failed.has(key)) issues.push({ kind: 'retry', tool: call.tool, detail: (call.command ?? JSON.stringify(call.input ?? null)) + ' was run again after it failed', at: call.startedAt })
    if (call.error || call.status === 'error') {
      failed.add(key)
      issues.push({ kind: PERMISSION.test(call.error ?? '') ? 'permission' : 'error', tool: call.tool, detail: (call.command ? call.command + ': ' : '') + (call.error ?? 'error'), at: call.startedAt })
    }
  }
  return issues
}

function checkEvidence(path: string, commands: EvidenceCommand[], editedAt: number[], files: EvidenceFile[]): EvidenceCheck | undefined {
  const check = projectCheck(path)
  if (!check) return
  const command = check.argv.join(' '), matches = [command]
  if (check.description === 'the package test script') try { const script = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).scripts?.test; if (typeof script === 'string' && script.trim()) matches.push(script.trim()) } catch {}
  const recorded = commands.filter(row => matches.some(match => normalise(row.command).includes(normalise(match)))).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).at(-1)
  const changed = [...editedAt, ...files.filter(file => file.status !== 'deleted').flatMap(file => { try { return [statSync(join(path, file.path)).mtimeMs] } catch { return [] } })]
  const lastChangeAt = changed.length ? Math.max(...changed) : undefined
  const base = { command, argv: check.argv, ...(check.cwd ? { cwd: check.cwd } : {}), ...(check.timeoutMilliseconds ? { timeoutMilliseconds: check.timeoutMilliseconds } : {}), shell: check.shell, matches, ...(lastChangeAt !== undefined ? { lastChangeAt } : {}) }
  if (!recorded) return { ...base, ranOnFinalTree: false, why: 'no host record shows `' + command + '` ran in this run' }
  if (recorded.exitCode === null) return { ...base, recorded, ranOnFinalTree: false, why: 'the host recorded `' + recorded.command + '` but not its exit code' }
  if (recorded.startedAt === undefined) return { ...base, recorded, ranOnFinalTree: false, why: 'the host recorded `' + recorded.command + '` without a time' }
  if (lastChangeAt !== undefined && lastChangeAt > recorded.startedAt) return { ...base, recorded, ranOnFinalTree: false, why: 'files changed after `' + recorded.command + '` last ran' }
  return { ...base, recorded, ranOnFinalTree: true, why: '`' + recorded.command + '` ran after the last change and exited ' + recorded.exitCode }
}

async function diffEvidence(workspace: Workspace | undefined, request: string) {
  const empty = { available: false, files: [] as EvidenceFile[], commits: [] as string[], patch: '' }
  if (!workspace || workspace.mode === 'research' || workspace.removed || !existsSync(workspace.path)) return { ...empty, error: !workspace ? 'No workspace record says where this run left its work.' : workspace.mode === 'research' ? 'The run was read-only research.' : 'The checkout is gone; only its recorded file list is available.' }
  const base = workspace.comparisonTree ?? workspace.base, path = workspace.path
  const read = (args: string[]) => driveAsync(gitRun(path, args, 60_000))
  const [statuses, patch, log, head] = await Promise.all([read(['diff', '--no-renames', '--name-status', '-z', base, '--']), read(['diff', '--no-renames', base, '--']), workspace.mode === 'shared' ? Promise.resolve(undefined) : read(['log', '--format=%s', workspace.base + '..HEAD']), read(['rev-parse', 'HEAD'])])
  if (statuses.status !== 0 || patch.status !== 0) return { ...empty, error: 'git diff failed: ' + (statuses.stderr || patch.stderr).trim() }
  const status = new Map<string, EvidenceFile['status']>(), fields = statuses.stdout.split('\0').filter(Boolean)
  for (let index = 0; index + 1 < fields.length; index += 2) status.set(slash(fields[index + 1]), fields[index].startsWith('A') ? 'added' : fields[index].startsWith('D') ? 'deleted' : 'modified')
  const lower = request.toLowerCase()
  const named = (path: string) => { const name = path.split('/').at(-1)!.toLowerCase(), stem = name.replace(/\.[^.]+$/, ''); return lower.includes(path.toLowerCase()) || lower.includes(name) || stem.length >= 4 && lower.includes(stem) }
  const files: EvidenceFile[] = (workspace.changes?.files ?? []).map(file => { const at = slash(file.path); return { path: at, status: file.untracked ? 'untracked' : status.get(at) ?? 'modified', additions: file.additions, deletions: file.deletions, namedInMessage: named(at) } })
  for (const [at, kind] of status) if (!files.some(file => file.path === at)) files.push({ path: at, status: kind, additions: null, deletions: null, namedInMessage: named(at) })
  return { available: true, files, commits: log?.status === 0 ? log.stdout.split(/\r?\n/).filter(Boolean) : [], patch: patch.stdout, ...(head.status === 0 ? { head: head.stdout.trim() } : {}) }
}

export async function collectReviewEvidence(quest: Quest, run: QuestSession, workspace: Workspace | undefined, sources: EvidenceSources): Promise<ReviewEvidence> {
  const now = sources.now ?? Date.now(), runID = runKey(run), request = requestText(quest)
  const stages = quest.stages
  const steps: EvidenceStep[] = stages.filter(step => run.deliverables.includes(step.id)).map(step => ({ id: step.id, title: step.title, status: step.status, ...(step.note ? { note: step.note } : {}), ...(step.detail ? { detail: step.detail } : {}), ...(step.blocker ? { blocker: step.blocker } : {}), ...(step.result ? { result: step.result } : {}), undoneTodos: step.todos.filter(todo => todo.status !== 'done').map(todo => todo.title) }))
  const otherSteps: OtherStep[] = stages.filter(step => !run.deliverables.includes(step.id) && !isLandingStep(step)).map(step => ({ id: step.id, title: step.title, status: step.status, ...(step.detail ? { detail: step.detail } : {}) }))
  const diff = await diffEvidence(workspace, request)
  const pathsNamed = namedPaths(request).map(path => ({ path, touched: diff.files.some(file => file.path === path || file.path.endsWith('/' + path)) })).filter(named => named.touched || !!workspace && existsSync(join(workspace.path, named.path)))
  const sessionID = run.openCodeSessionId ?? run.sessionID
  const host = sessionID ? sessionToolCalls(sources.hostDB, sessionID) : { calls: [], diagnostics: ['The run has no host session, so no tool calls or commands could be read.'] }
  const since = run.startedAt ? Date.parse(run.startedAt) : undefined
  const calls = host.calls.filter(call => since === undefined || call.startedAt === undefined || call.startedAt >= since - 1000).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  const commands: EvidenceCommand[] = calls.flatMap(call => call.command === undefined ? [] : [{ command: call.command, exitCode: call.exitCode, ...(call.status ? { status: call.status } : {}), ...(call.startedAt !== undefined ? { startedAt: call.startedAt } : {}), ...(call.startedAt !== undefined && call.completedAt !== undefined ? { milliseconds: call.completedAt - call.startedAt } : {}), source: call.source }])
  const editedAt = calls.filter(call => EDIT_TOOL.test(call.tool)).flatMap(call => { const at = call.completedAt ?? call.startedAt; return at === undefined ? [] : [at] })
  const check = workspace && existsSync(workspace.path) && !workspace.removed ? checkEvidence(workspace.path, commands, editedAt, diff.files) : undefined
  const records = sessionID ? readSessionRequests(sessionID, sources.requestsFile ?? TELEMETRY_FILE).records.filter(record => since === undefined || record.startedAt >= since - 1000) : []
  const metrics = requestMetrics(records)
  const ledger = sources.requestsFile ?? TELEMETRY_FILE
  const started = since ?? (records.length ? Math.min(...records.map(record => record.startedAt)) : calls[0]?.startedAt)
  const reports = (quest.extensions.runReports as Record<string, Record<string, { state: string; note?: string; blocker?: StepBlocker }>> | undefined)?.[runID] ?? {}
  const undone = [
    ...steps.filter(step => step.status !== 'done').map(step => ({ stepID: step.id, state: step.status, ...(step.note ? { note: step.note } : {}), ...(step.blocker ? { blocker: step.blocker } : {}) })),
    ...Object.entries(reports).filter(([id, report]) => report.state !== 'done' && !steps.some(step => step.id === id && step.status !== 'done')).map(([stepID, report]) => ({ stepID, state: report.state, ...(report.note ? { note: report.note } : {}), ...(report.blocker ? { blocker: report.blocker } : {}) })),
    ...steps.filter(step => step.undoneTodos.length).map(step => ({ stepID: step.id, state: 'todos open', note: step.undoneTodos.join('; ') })),
  ]
  const added = diff.patch.split(/\r?\n/).filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n')
  return {
    questID: quest.id, runID, stepIDs: run.deliverables, request, collectedAt: now, steps, otherSteps,
    ...(workspace ? { workspace: { path: workspace.path, branch: workspace.branch, base: workspace.base } } : {}),
    diff: { ...diff, namedPaths: pathsNamed },
    tests: diff.files.filter(file => TEST_PATH.test(file.path)).map(file => ({ path: file.path, change: file.status === 'added' || file.status === 'untracked' ? 'added' as const : file.status === 'deleted' ? 'deleted' as const : 'changed' as const })),
    verification: quest.evidence.tests.filter(test => test.stepID && run.deliverables.includes(test.stepID) && (!test.runID || test.runID === runID) && (since === undefined || Date.parse(test.at) >= since - 1000)).map(test => ({ ...(test.stepID ? { stepID: test.stepID } : {}), command: test.command, exitCode: Number.isInteger(test.exitCode) ? test.exitCode! : test.result === 'passed' ? 0 : null, ...(test.artifact ? { artifact: test.artifact } : {}), at: test.at })),
    commands: { recorded: host.calls.length > 0, rows: commands, diagnostics: host.diagnostics },
    issues: issuesOf(calls),
    ...(check ? { check } : {}),
    usage: { wallMilliseconds: started === undefined ? null : now - started, requests: metrics.requests, tokens: metrics.tokens.knownTotals as ReviewEvidence['usage']['tokens'], missingTokenRequests: metrics.tokens.missingRequests, cost: metrics.cost.map(row => ({ currency: row.currency, actual: row.actualCharge, estimate: row.estimatedCost ?? null })) },
    undone,
  }
}
