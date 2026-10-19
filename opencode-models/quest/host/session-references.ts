import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock } from '../locking.mts'
import {writeFileDurable,readJsonRecord,runFileStem} from '../core/durable-file.mjs'
import { generateReadableReference, isReadableReference } from '../core/readable-reference'

export type SessionReference = { sessionID: string; ref: string; title: string; source: string }
type Registry = { version: 1; sessions: SessionReference[] }
const sourceName = (source = 'opencode') => source === 'opencode-host' ? 'opencode' : source
type Parsed = { stamp: string; registry: Registry; index: Map<string, SessionReference> }
const parsedRegistries = new Map<string, Parsed>()
export class SessionReferences {
  private file: string
  constructor(readonly runtime: string) { this.file = join(runtime, 'session-references', 'index.json') }
  private read(own = false): Parsed {
    const stat = statSync(this.file, { throwIfNoEntry: false })
    if (!stat) return { stamp: '', registry: { version: 1, sessions: [] }, index: new Map() }
    const stamp = stat.ino + ':' + stat.mtimeMs + ':' + stat.size, held = parsedRegistries.get(this.file)
    if (!own && held?.stamp === stamp) return held
    const value = readJsonRecord<Registry>(this.file)
    if (!value) return { stamp, registry: { version: 1, sessions: [] }, index: new Map() }
    if (value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.some(s => !s.sessionID || !s.title || !s.source || !isReadableReference(s.ref))) throw Error('Invalid session reference registry')
    if (new Set(value.sessions.map(s => s.ref)).size !== value.sessions.length || new Set(value.sessions.map(s => s.source + '\0' + s.sessionID)).size !== value.sessions.length) throw Error('Conflicting session references')
    const index = new Map<string, SessionReference>()
    for (const row of value.sessions) for (const key of [row.source + '\0' + row.sessionID, row.source + '\0' + row.ref]) if (!index.has(key)) index.set(key, row)
    const parsed = { stamp, registry: value, index }
    if (!own) parsedRegistries.set(this.file, parsed)
    return parsed
  }
  get(value: string, source = 'opencode'): SessionReference | undefined {
    return this.read().index.get(sourceName(source) + '\0' + value)
  }
  register(input: { sessionID: string; title: string; ref?: string; source?: string; runID?: string }): SessionReference {
    if (!input.sessionID || !input.title?.trim()) throw Error('A session reference requires its recorded identity and title')
    if (input.ref && !isReadableReference(input.ref)) throw Error('Invalid readable session reference')
    const source = sourceName(input.source), existing = this.get(input.sessionID, source)
    if (existing && existing.title === input.title) return existing
    const lock = acquireLock(this.runtime, 'session-references')
    try {
      const registry = this.read(true).registry, prior = registry.sessions.find(s => s.source === source && s.sessionID === input.sessionID)
      const pending = input.runID ? registry.sessions.find(s => s.source === 'quest-run' && s.sessionID === input.runID) : undefined
      if (!prior && pending) {
        pending.sessionID = input.sessionID; pending.source = source; pending.title = input.title
        writeFileDurable(join(this.runtime, 'session-references', pending.ref + '.json'), JSON.stringify(pending, null, 2) + '\n')
        writeFileDurable(this.file, JSON.stringify(registry, null, 2) + '\n')
        return pending
      }
      if (prior) {
        if (prior.title !== input.title) {
          prior.title = input.title
          writeFileDurable(join(this.runtime, 'session-references', prior.ref + '.json'), JSON.stringify(prior, null, 2) + '\n')
          writeFileDurable(this.file, JSON.stringify(registry, null, 2) + '\n')
        }
        return prior
      }
      const directory = join(this.runtime, 'session-references')
      const recovered = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json') && isReadableReference(name.slice(0, -5))).flatMap(name => { const row = readJsonRecord<SessionReference>(join(directory, name)); return row ? [row] : [] }).find(row => row.source === source && row.sessionID === input.sessionID) : undefined
      let ref = recovered?.ref ?? input.ref ?? (isReadableReference(input.title) ? input.title : undefined)
      if (ref && (registry.sessions.some(s => s.ref === ref) || (!recovered && existsSync(join(directory, ref + '.json'))))) throw Error('Session reference already belongs to another session: ' + ref)
      if (!ref) do { ref = generateReadableReference(input.title) } while (registry.sessions.some(s => s.ref === ref) || existsSync(join(directory, ref + '.json')))
      const row: SessionReference = { sessionID: input.sessionID, ref, title: input.title, source }
      writeFileDurable(join(directory, ref + '.json'), JSON.stringify(row, null, 2) + '\n')
      registry.sessions.push(row)
      writeFileDurable(this.file, JSON.stringify(registry, null, 2) + '\n')
      return row
    } finally { lock.release() }
  }
}

export function reserveRunReference(runtime: string, title: string, requestKey: string): string {
  const directory = join(runtime, 'run-references')
  mkdirSync(directory, { recursive: true })
  for (;;) {
    const ref = generateReadableReference(title, 'session')
    if (existsSync(join(runtime, 'workspaces', runFileStem(ref) + '.json')) || existsSync(join(runtime, 'session-references', ref + '.json'))) continue
    try { writeFileSync(join(directory, ref + '.json'), JSON.stringify({ref, title, requestKey}) + '\n', {flag:'wx'}); return ref }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
}
