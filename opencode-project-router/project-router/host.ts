import { spawn } from 'node:child_process'
import { resolveHostExecutable } from './executable.mjs'
import {contextualError,type ErrorContext,type ErrorDetails} from '../core/error.mts'

export class RouterError extends Error {
  output?: { stdout: string; stderr: string }
  context?:ErrorDetails
  constructor(readonly code: string, message: string, context?:ErrorContext,cause?:unknown) {
    const failure=context?contextualError(cause??message,context):undefined
    super(failure?.message??message,{cause})
    this.context=failure?.context
  }
}
export function redact(text: string, limit: number | null = 1000) {
  const clean = text.replace(/(?:https?|ssh):\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, '[redacted-url]@')
    .replace(/(?:Bearer\s+|(?:token|password|api[_-]?key)[=:]\s*)[^\s"'&]+/gi, '[redacted]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  return limit === null ? clean : clean.slice(0, limit)
}
export function runArgv(executable: string, args: string[], options: { timeout?: number; maxBytes?: number; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const failure=(code:string,reason:string,next:string,cause?:unknown)=>new RouterError(code,reason,{operation:'run the '+(args[0]??'host')+' command',location:executable+(options.cwd?' in '+options.cwd:''),next},cause)
    const child = spawn(executable, args, { shell: false, windowsHide: true, cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', bytes = 0, settled = false
    const finish = (error?: RouterError, code: number | null = null) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
      if (error) { child.kill(); error.output = { stdout, stderr }; reject(error) } else resolve({ code, stdout, stderr })
    }
    const abort = () => finish(failure('CANCELLED','Operation cancelled; partial work is preserved','Inspect the saved output and partial work before starting this command again.'))
    const timer = setTimeout(() => finish(failure('TIMEOUT','Operation timed out after '+(options.timeout??30000)+' ms','Inspect the saved stdout and stderr before retrying; do not assume the command made no changes.')), options.timeout ?? 30000)
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]] as const) stream.on('data', data => {
      bytes += data.length
      if (bytes > (options.maxBytes ?? 1024 * 1024)) return finish(failure('OUTPUT_LIMIT','Host output exceeded '+(options.maxBytes??1024*1024)+' bytes','Inspect the retained output and narrow this command before retrying.'))
      if (isError) stderr += data.toString(); else stdout += data.toString()
    })
    child.once('error', cause => finish(failure('HOST_CAPABILITY_MISSING','Configured executable could not be started','Check that this executable exists and is allowed to run, or repair the installed OpenCode CLI.',cause)))
    child.once('close', code => finish(undefined, code))
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort()
  })
}
export function hostExecutable() { return resolveHostExecutable() }
export class DiscoveryHost {
  #executable: string | undefined
  constructor(executable?: string, readonly run = runArgv) { this.#executable = executable }
  get executable() { return this.#executable ??= hostExecutable() }
  async get(path: string) {
    if (path !== '/api/project') throw new RouterError('INVALID_DISCOVERY_PATH', 'Only project discovery is allowed')
    const result = await this.run(this.executable, ['api', '--standalone', 'GET', path], { timeout: 30000, maxBytes: 1024 * 1024 })
    if (result.code !== 0) throw new RouterError('DISCOVERY_UNAVAILABLE',result.stderr.trim()||'Host discovery exited '+result.code,{operation:'list projects from OpenCode',location:this.executable+' '+path,next:'Check this CLI installation and its stderr before retrying.'})
    try { return JSON.parse(result.stdout) } catch(cause) { throw new RouterError('INVALID_HOST_RESPONSE','Host returned non-JSON discovery output',{operation:'read the OpenCode project response',location:this.executable+' '+path,next:'Check the CLI version and diagnostic output; project discovery requires a JSON array.'},cause) }
  }
  async projects() {
    const result = await this.get('/api/project')
    if (!Array.isArray(result) || result.some(x => typeof x?.id !== 'string' || typeof x?.canonical !== 'string' || !Array.isArray(x?.sandboxes))) throw new RouterError('INVALID_HOST_RESPONSE', 'Expected the host project root array')
    return result.slice(0, 1000).map(x => ({ hostID: x.id, directory: x.canonical, sandboxes: x.sandboxes.filter((s: unknown) => typeof s === 'string').slice(0, 30) as string[] }))
  }
}
