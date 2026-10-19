import { mkdirSync, existsSync, realpathSync, readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFileDurable } from '../quest/core/durable-file.mjs'
import { runArgv, RouterError } from './host'
import { verifyTarget, type Target } from './resolution'

import {repositoryURL} from './remote'
export {repositoryURL} from './remote'
export type CloneAttempt = { id: string; remote: string; destination: string; state: 'cloning' | 'verified' | 'cancelled' | 'auth-required' | 'partial' | 'failed' | 'unknown'; target?: Target }
export class Onboarding {
  constructor(readonly parent = 'C:/Users/Jk101/Projects', readonly run = runArgv) {}
  private git(args: string[], signal?: AbortSignal, clone = false) {
    const env={...process.env};for(const key of Object.keys(env))if(/^GIT_(?:CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS)|DIR$|WORK_TREE$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$)/.test(key))delete env[key]
    return this.run('git', ['-c', 'core.hooksPath='+(process.platform==='win32'?'NUL':'/dev/null'), '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', ...args], {
      timeout: clone ? 120000 : 5000, maxBytes: 256000, signal,
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...(clone ? {} : { GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }), GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oPermitLocalCommand=no' },
    })
  }
  async clone(input: { url: string; authorized: boolean; requestID: string; known: Target[]; signal?: AbortSignal; retry?: boolean }) {
    if (!input.authorized) throw new RouterError('CLONE_AUTHORIZATION_REQUIRED', 'Explicit user clone/work authorization is required')
    const remote = repositoryURL(input.url)
    if (!isAbsolute(this.parent)) throw new RouterError('INVALID_PARENT', 'Configure an absolute project parent')
    const basenamePath = join(this.parent, remote.name)
    const candidates = [...input.known]
    if (existsSync(join(basenamePath, '.git'))) candidates.unshift(verifyTarget(basenamePath))
    const probeUntil = Date.now() + 15000
    for (const candidate of candidates.slice(0, 20)) {
      if (Date.now() >= probeUntil) break
      try {
        const target = verifyTarget(candidate.directory)
        const result = await this.git(['-C', target.root, 'remote', 'get-url', 'origin'])
        if (result.code === 0 && repositoryURL(result.stdout.trim()).identity === remote.identity) {
          const head = await this.git(['-C', target.directory, 'rev-parse', '--verify', 'HEAD'])
          const index = await this.git(['-C', target.directory, 'ls-files'])
          if (head.code === 0 && index.code === 0 && index.stdout.trim()) return { state: 'verified', reused: true, target: { ...target, remote: remote.identity } }
        }
      } catch {}
    }
    if (!isAbsolute(this.parent)) throw new RouterError('INVALID_PARENT', 'Configure an absolute project parent')
    mkdirSync(this.parent, { recursive: true })
    const destination = join(realpathSync(this.parent), remote.name)
    const id = createHash('sha256').update(input.requestID + ':' + remote.identity).digest('hex')
    const marker = join(destination, '.project-router-attempt.json')
    let prior: CloneAttempt | undefined
    if (existsSync(destination)) {
      try { prior = JSON.parse(readFileSync(marker, 'utf8')) } catch { if (existsSync(marker)) prior = { id, remote: remote.identity, destination, state: 'partial' } }
      if (!prior || prior.id !== id || prior.remote !== remote.identity) throw new RouterError('DESTINATION_COLLISION', 'Destination already exists; choose a different configured parent or register the matching clone')
      if (prior.state === 'verified' && prior.target) {
        const target = verifyTarget(prior.target.directory)
        const index = await this.git(['-C', target.directory, 'ls-files'])
        if (index.code === 0 && index.stdout.trim()) return { ...prior, target: { ...target, remote: remote.identity }, reused: true }
      }
      if (input.retry && existsSync(join(destination, 'repo', '.git'))) {
        const result = await this.git(['-C', join(destination, 'repo'), 'rev-parse', '--verify', 'HEAD'])
        const origin = await this.git(['-C', join(destination, 'repo'), 'remote', 'get-url', 'origin'])
        const index = await this.git(['-C', join(destination, 'repo'), 'ls-files'])
        if (result.code === 0 && origin.code === 0 && index.code === 0 && index.stdout.trim() && repositoryURL(origin.stdout.trim()).identity === remote.identity) {
          const target = { ...verifyTarget(join(destination, 'repo')), remote: remote.identity }
          const done: CloneAttempt = { ...prior, state: 'verified', target }; writeFileDurable(marker, JSON.stringify(done)); return done
        }
      }
      return { ...prior, recovery: 'Partial work preserved. Inspect this attempt; use another parent for an explicitly authorized fresh attempt.' }
    }
    try { mkdirSync(destination) } catch { throw new RouterError('DESTINATION_COLLISION', 'Another operation reserved the destination; nothing was overwritten') }
    const attempt: CloneAttempt = { id, remote: remote.identity, destination, state: 'cloning' }
    const save = () => writeFileDurable(marker, JSON.stringify(attempt))
    save()
    try {
      const template = join(destination, 'empty-template'); mkdirSync(template)
      const result = await this.git(['clone', '--template=' + template, '--no-checkout', '--no-recurse-submodules', '--', remote.url, join(destination, 'repo')], input.signal, true)
      if (result.code !== 0) { attempt.state = /auth|permission denied|could not read username/i.test(result.stderr) ? 'auth-required' : existsSync(join(destination, 'repo')) ? 'partial' : 'failed'; save(); return attempt }
      const checkout = await this.git(['-C', join(destination, 'repo'), 'reset', '--hard', 'HEAD'], input.signal)
      const head = await this.git(['-C', join(destination, 'repo'), 'rev-parse', '--verify', 'HEAD'])
      if (checkout.code !== 0 || head.code !== 0) { attempt.state = 'partial'; save(); return attempt }
      attempt.target = { ...verifyTarget(join(destination, 'repo')), remote: remote.identity }; attempt.state = 'verified'; save(); return attempt
    } catch (error) { attempt.state = error instanceof RouterError && error.code === 'CANCELLED' ? 'cancelled' : 'unknown'; save(); return attempt }
  }
}
