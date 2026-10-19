import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SessionReferences, type SessionReference } from '../quest/host/session-references'
import { QuestStore } from '../quest/store'
import { questRoot } from '../quest/root.mts'
import { questReference } from '../quest/index'
import { parseQuestMarkdown } from '../quest/core/cst'
import { isQuestID } from '../quest/core/schema'
import { HOST_USAGE_DB } from './host-counters'

let codexCache: { file: string; stamp: string; titles: Map<string, string> } | undefined
function codexTitles() {
  const file = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'session_index.jsonl')
  if (!existsSync(file)) return new Map<string, string>()
  const stat = statSync(file), stamp = `${stat.mtimeMs}:${stat.size}`
  if (codexCache?.file === file && codexCache.stamp === stamp) return codexCache.titles
  const titles = new Map<string, string>()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { const row = JSON.parse(line); if (typeof row.id === 'string' && typeof row.thread_name === 'string' && row.thread_name.trim()) titles.set(row.id, row.thread_name) } catch {}
  }
  codexCache = { file, stamp, titles }
  return titles
}

export function usageReferences() {
  const store = new QuestStore(questRoot()), registry = new SessionReferences(store.runtime)
  const sessions = new Map<string, SessionReference | undefined>()
  const quests = new Map<string, { questRef: string; questTitle?: string }>()
  const session = (id?: string | null, captureSource?: string) => {
    if (!id) return undefined
    const source = captureSource === 'codex' ? 'codex' : 'opencode', key = source + ':' + id
    if (sessions.has(key)) return sessions.get(key)
    let value = registry.get(id, source)
    if (!value) {
      let title: string | undefined
      if (source === 'codex') title = codexTitles().get(id)
      else if (existsSync(HOST_USAGE_DB)) {
        let db: Database | undefined
        try {
          db = new Database(HOST_USAGE_DB, { readonly: true }); db.exec('PRAGMA busy_timeout=1000')
          const row = db.query('SELECT title FROM session_v2 WHERE id=?').get(id) as { title?: string } | null
          if (typeof row?.title === 'string' && row.title.trim()) title = row.title
        } catch {}
        finally { db?.close() }
      }
      if (title) value = registry.register({ sessionID: id, title, source })
    }
    sessions.set(key, value)
    return value
  }
  const quest = (id?: string | null) => {
    if (!id || !isQuestID(id)) return {}
    if (!quests.has(id)) {
      const file = store.find(id)
      const found = file ? parseQuestMarkdown(readFileSync(file, 'utf8')).quest : undefined
      quests.set(id, found ? { questRef: questReference(found), questTitle: found.title } : {})
    }
    return quests.get(id)!
  }
  const fields = (row: { sessionID?: string | null; source?: string; questID?: string | null }) => {
    const value = session(row.sessionID, row.source)
    return { sessionRef: value?.ref ?? null, sessionTitle: value?.title ?? null, ...quest(row.questID) }
  }
  const resolve = <T extends { sessionID?: string; source?: string }>(query: T): T => {
    const value = session(query.sessionID, query.source)
    return value ? { ...query, sessionID: value.sessionID, source: query.source ?? value.source } : query
  }
  return { session, fields, resolve }
}
