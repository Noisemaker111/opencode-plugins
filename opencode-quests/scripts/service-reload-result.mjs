import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ownDirectoryEnvironment } from './own-directory.mjs'

export const SCRATCH = ['run', '.scratch']

export function reloadInvocation(row, top, timeoutMs, expectedProbe) {
  const invocation = { command: row.reload, cwd: top, timeoutMs, windowsHide: true, expected: row.expected, expectedProbe }
  return { ...invocation, key: JSON.stringify(invocation) }
}

const errorRecord = error => error ? { name: error.name, message: error.message, code: error.code, stack: error.stack } : undefined
const diagnosticLines = text => String(text ?? '').split(/\r?\n/).filter(line => line.trim() && !/^\s*(?:at\s|data:|Node\.js v|\^+$|[{}()[\],;]+$)/.test(line))
const errorLines = lines => lines.filter(line => /(?:^|\s)(?:[\w.]*Error|Exception)(?:\s*\[[^\]]+\])?:/.test(line))

export function firstErrorLine(text) {
  const lines = diagnosticLines(text)
  return (errorLines(lines)[0] ?? lines[0] ?? '').trim()
}

export function reloadFailureSummary(attempt) {
  const stderrText = readFileSync(attempt.stderr, 'utf8'), stdoutText = readFileSync(attempt.stdout, 'utf8')
  const errors = [...errorLines(diagnosticLines(stderrText)), ...errorLines(diagnosticLines(stdoutText))]
  const message = errors.length ? errors.join('\n') : firstErrorLine(stderrText) || firstErrorLine(stdoutText)
  const outcome = attempt.error?.message || (attempt.signal ? 'signal ' + attempt.signal : 'exit ' + attempt.code)
  return [message, outcome, ...(attempt.captureErrors ?? []).map(error => error.message), 'diagnostic receipt: ' + attempt.receipt].filter(Boolean).join('\n')
}

export async function runRegisteredReload(invocation) {
  const directory = join(invocation.cwd, SCRATCH.find(name => existsSync(join(invocation.cwd, name))) ?? '.scratch', 'service-reloads')
  mkdirSync(directory, { recursive: true })
  const home = mkdtempSync(join(directory, 'attempt-'))
  const stdout = join(home, 'stdout.log'), stderr = join(home, 'stderr.log'), receipt = join(home, 'result.json')
  const descriptors = [openSync(stdout, 'wx'), openSync(stderr, 'wx')]
  const startedAt = new Date().toISOString(), captureErrors = []
  const capture = (descriptor, chunk) => {
    try { appendFileSync(descriptor, chunk) } catch (error) { captureErrors.push(errorRecord(error)) }
  }
  const outcome = await new Promise(done => {
    let error
    try {
      const child = spawn(invocation.command[0], invocation.command.slice(1), {
        cwd: invocation.cwd, env: ownDirectoryEnvironment(), timeout: invocation.timeoutMs, windowsHide: invocation.windowsHide, stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', chunk => capture(descriptors[0], chunk))
      child.stderr.on('data', chunk => capture(descriptors[1], chunk))
      child.once('error', failure => { error = errorRecord(failure) })
      child.once('close', (code, signal) => done({ code, signal, error, pid: child.pid }))
    } catch (failure) { done({ code: null, signal: null, error: errorRecord(failure) }) }
  })
  for (const descriptor of descriptors) closeSync(descriptor)
  const processOk = outcome.code === 0 && !outcome.signal && !outcome.error
  const attempt = {
    ...invocation, ...outcome, startedAt, finishedAt: new Date().toISOString(),
    processOk, ok: processOk && !captureErrors.length,
    stdout, stderr, receipt, stdoutBytes: statSync(stdout).size, stderrBytes: statSync(stderr).size, captureErrors,
  }
  writeFileSync(receipt, JSON.stringify(attempt, null, 2) + '\n')
  return attempt
}

export function applyReloadResult(row, attempt, short) {
  if (!attempt) return row
  row.reloaded = attempt.ok
  row.reloadAttempts = [attempt]
  row.reloadOutcome = row.state === 'fresh' ? attempt.ok ? 'succeeded' : 'recovered' : 'failed'
  if (attempt.captureErrors.length || row.state === 'not running') {
    row.finalState = row.state
    row.finalError = row.error
    row.reloadOutcome = 'failed'
    row.state = 'reload failed'
    row.error = attempt.captureErrors.length ? 'reload diagnostic capture failed' : 'final probe reports no running revision'
    row.reloadError = reloadFailureSummary(attempt)
    row.error += '\n' + row.reloadError
    return row
  }
  if (!attempt.ok) {
    row.reloadError = reloadFailureSummary(attempt)
    if (row.state === 'fresh') row.note = 'reload command failed; final probe now runs ' + short(row.running) + '; ' + row.reloadError
    else {
      row.finalState = row.state
      row.finalError = row.error
      row.state = 'reload failed'
      row.error = [row.reloadError, row.finalError].filter(Boolean).join('\n')
    }
  } else if (row.state === 'fresh') row.note = 'reloaded; now runs ' + short(row.running)
  return row
}
