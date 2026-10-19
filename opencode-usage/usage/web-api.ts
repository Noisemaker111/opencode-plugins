import { getUsageBalances, getUsageStatus, getUsageDetail, type UsageDetailView, type UsageStatusQuery } from './status-api'
import { getUsageExperience } from './experience-api'
import { ledgerActivityPage } from './passive-ledger'
import { usageReferences } from './session-references'

export async function usageWeb(path: string) {
  const url = new URL(path, 'http://usage.local')
  const params = url.searchParams
  const offset = Number(params.get('offset') ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid usage page offset')
  const query: UsageStatusQuery = {}
  for (const key of ['accountID', 'sessionID', 'questID', 'providerID', 'modelID'] as const) {
    const value = params.get(key)
    if (value) query[key] = value
  }
  for (const key of ['allSessions', 'includeWorkers'] as const) {
    const value = params.get(key)
    if (value === null) continue
    if (!['true', 'false', '1', '0'].includes(value)) throw new Error('Invalid usage scope: ' + key)
    query[key] = value === 'true' || value === '1'
  }
  for (const key of ['from', 'to'] as const) {
    if (!params.has(key)) continue
    const value = Number(params.get(key))
    if (!Number.isFinite(value)) throw new Error('Invalid usage time range')
    query[key] = value
  }
  const source = params.get('source') ?? 'opencode'
  if (!['opencode', 'codex', 'opencode-host'].includes(source)) throw new Error('Unknown capture source')
  query.source = source as UsageStatusQuery['source']
  if (url.pathname === '/experience') {
    if (!query.accountID) throw new Error('Choose an account for quota history')
    return getUsageExperience({ accountID: query.accountID, sessionID: query.sessionID, from: query.from, to: query.to, source: query.source,
      windowID: params.get('windowID') || undefined, view: 'timeline', offset, limit: 100 })
  }
  const view = params.get('view')
  if (!view) return getUsageStatus({ ...query, refresh: params.get('refresh') === '1' }, { readOnly: true })
  if (view === 'balances') return getUsageBalances({ accountID: query.accountID, refresh: params.get('refresh') === '1' })
  if (view === 'reference') { const references = usageReferences(), resolved = references.resolve(query); return { resolvedSession: references.session(resolved.sessionID, resolved.source) } }
  if (view === 'activity') {
    const group = params.get('group') ?? 'session'
    if (group !== 'session' && group !== 'quest' && group !== 'model') throw new Error('Unknown usage grouping')
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) throw new Error('Invalid usage time range')
    const references = usageReferences()
    const resolved = references.resolve(query)
    if (query.allSessions) resolved.sessionID = undefined
    const result = ledgerActivityPage({ ...resolved, group, offset, limit: 50 })
    return { ...result, source, rows: result.rows.map(row => ({ ...row, ...references.fields({ ...row, source }) })) }
  }
  if (!['requests', 'sessions', 'timeline', 'pools', 'models'].includes(view)) throw new Error('Unknown browser usage view')
  return getUsageDetail({ ...query, view: view as UsageDetailView, offset, limit: 50 })
}
