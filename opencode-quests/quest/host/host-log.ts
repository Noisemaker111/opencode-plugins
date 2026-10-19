import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
const INSTALLED = Symbol.for('questgiver.host-log')
export const HOST_LOG_MAX_BYTES = 20 * 1024 * 1024
function render(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}
export function installHostLog(runtime: string, maxBytes = HOST_LOG_MAX_BYTES): () => void {
  const globals = globalThis as any
  if (globals[INSTALLED]) return () => {}
  const file = join(runtime, 'host.log')
  try { mkdirSync(dirname(file), { recursive: true }) } catch {}
  const originals = { log: console.log, warn: console.warn, error: console.error }
  const write = (level: string, args: unknown[]) => {
    try {
      const text = args.map(render).join(' ')
      if (existsSync(file) && statSync(file).size >= maxBytes) renameSync(file, file + '.1')
      appendFileSync(file, new Date().toISOString() + ' ' + level + ' ' + text + '\n')
    } catch {}
  }
  const wrap = (level: 'log' | 'warn' | 'error', original: (...args: any[]) => void) =>
    (...args: any[]) => {
      original.apply(console, args)
      write(level, args)
    }
  console.log = wrap('log', originals.log)
  console.warn = wrap('warn', originals.warn)
  console.error = wrap('error', originals.error)
  globals[INSTALLED] = true
  return () => {
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
    delete globals[INSTALLED]
  }
}
