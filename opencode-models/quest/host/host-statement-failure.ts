import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOST_STATEMENT_FAILURE = 'Failed to execute statement'
const TAIL_BYTES = 8 * 1024 * 1024
const HOST_LOAD_WINDOW_MS = 60_000

export type HostStatementCause = { loggedAt: string; operation: string; error: string; sqlite: string; hostProcesses?: number }

export function hostLogFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME ?? join(env.USERPROFILE ?? env.HOME ?? homedir(), '.local', 'share'), 'opencode', 'log', 'opencode.log')
}

function tail(file: string): string {
  if (!existsSync(file)) return ''
  const size = statSync(file).size, length = Math.min(size, TAIL_BYTES), buffer = Buffer.alloc(length), fd = openSync(file, 'r')
  try { readSync(fd, buffer, 0, length, size - length) } finally { closeSync(fd) }
  return buffer.toString('utf8')
}

export function parseHostStatementCause(line: string): HostStatementCause | undefined {
  if (!line.includes(HOST_STATEMENT_FAILURE) || !/\blevel=ERROR\b/.test(line)) return undefined
  const loggedAt = /timestamp=(\S+)/.exec(line)?.[1] ?? ''
  const operation = /message="([^"]+)"/.exec(line)?.[1] ?? ''
  const causes = [...line.matchAll(/\[cause\]: ([\w/]+(?:Error|Exception))(?::\s*([^\\\n]*))?/g)]
  const error = causes.find(match => match[1].startsWith('effect/sql/'))?.[1].split('/').pop() ?? ''
  const sqlite = causes.find(match => /^SQLite/.test(match[1]))?.[2]?.trim() ?? ''
  return { loggedAt, operation, error, sqlite }
}

export function hostProcessesAt(lines: string[], loggedAt: string): number | undefined {
  const at = Date.parse(loggedAt)
  if (!Number.isFinite(at)) return undefined
  const processes = new Set<string>()
  for (const line of lines) {
    const found = /^timestamp=(\S+) level=\w+ run=(\w+)/.exec(line)
    if (!found) continue
    const time = Date.parse(found[1])
    if (time <= at && at - time <= HOST_LOAD_WINDOW_MS) processes.add(found[2])
  }
  return processes.size || undefined
}

export function hostStatementCause(sessionID: string, file = hostLogFile()): HostStatementCause | undefined {
  const marker = 'sessionID=' + sessionID
  const lines = tail(file).split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line.includes(marker) || !line.includes(HOST_STATEMENT_FAILURE)) continue
    const cause = parseHostStatementCause(line)
    if (cause) return { ...cause, hostProcesses: hostProcessesAt(lines, cause.loggedAt) }
  }
  return undefined
}

export function describeHostStatementFailure(cause: HostStatementCause | undefined): string {
  if (!cause) return HOST_STATEMENT_FAILURE + ' (no host log line names its cause)'
  const detail = [cause.error, cause.sqlite].filter(Boolean).join(': ')
  const load = cause.hostProcesses ? `; ${cause.hostProcesses} host processes shared the host database` : ''
  return `${HOST_STATEMENT_FAILURE} (${detail || 'cause not logged'}; host log ${cause.loggedAt} "${cause.operation}"${load})`
}
