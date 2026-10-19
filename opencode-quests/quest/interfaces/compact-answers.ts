import { page, row, scalarRow, seconds, stamp, words, ANSWER_PAGE_CHARACTERS, type AnswerRow, type CompactAnswer } from './answer-shape'

import { COMPACT_QUEST_OPERATIONS, SYSTEM_STATE_SECTIONS } from './answer-size.mjs'
import { boardSentences } from '../board/board'

const ENDED = /complet|fail|cancel|deliver|done|land|stop|abandon|abort|return|succeed|reject|superseded|ended/i

export function questRow(quest: any): AnswerRow {
  const progress = quest.stage ?? (quest.progress ? quest.progress.done + '/' + quest.progress.total : undefined)
  return row({ id: quest.ref ?? quest.id, title: quest.title, state: quest.state, step: progress, running: quest.running || undefined, waiting: quest.nextAction ?? quest.reason, updated: stamp(quest.updatedAt) })
}

const stepRow = (step: any) => row({ id: step.id, title: step.title, state: step.state, note: step.note ?? step.blockedBy })
const runRow = (run: any) => row({ run: run.runID ?? run.callID, model: run.model, state: run.state, steps: Array.isArray(run.steps ?? run.stepIDs ?? run.deliverables) ? (run.steps ?? run.stepIDs ?? run.deliverables).join(',') : undefined, updated: stamp(run.updatedAt) })

function runningRuns(value: any): any[] {
  const all = [...(value.runs ?? []), ...(value.steps ?? []).flatMap((step: any) => step.runs ?? []), ...(value.activity?.runs ?? [])]
  const seen = new Set<string>()
  return all.filter(run => {
    const id = run?.runID ?? run?.callID
    if (!id || seen.has(id) || ENDED.test(String(run.state ?? ''))) return false
    seen.add(id)
    return true
  })
}

function questCard(view: string, value: any): CompactAnswer {
  const steps = (value.steps ?? []).map(stepRow), runs = runningRuns(value).map(runRow)
  const result = value.result && typeof value.result === 'object' ? { result: { summary: value.result.summary, howToUse: value.result.howToUse, where: value.result.where } } : {}
  const waited = value.waited ? { waited: row({ until: value.waited.until, satisfied: value.waited.satisfied, reason: value.waited.reason }) } : {}
  const base = { quest: questRow(value), ...waited, ...result, runs }
  const warned = (value.warnings ?? []).slice(0, 3).map((warning: any) => warning.text)
  const found = (value.findings ?? []).slice(-3).map((finding: any) => finding.text)
  const notes = [...warned.map((text: string) => 'Warning: ' + text), ...found.map((text: string) => 'Finding: ' + text)]
  const fitted = page({ view, scope: value.ref ?? value.id, rows: steps, key: 'steps', pageable: false, more: 'inspect section steps', extra: base, ...(notes.length ? { notes } : {}) })
  return fitted
}

function listAnswer(value: any, input: any): CompactAnswer {
  const counts = value.counts ? Object.entries(value.counts).filter(([key]) => key !== 'total').map(([key, count]) => key + ' ' + count).join(' · ') : undefined
  if (input.view === 'report' && value.report?.sections) {
    const bullets = value.report.sections.flatMap((section: any) => (section.bullets ?? []).map((bullet: any) => row({ group: section.heading ?? bullet.group, name: bullet.name, sentence: bullet.sentence, ask: bullet.ask })))
    return page({ view: 'list report', scope: value.scope, rows: bullets, key: 'bullets', pageable: false, notes: [counts, ...(value.diagnostics ?? [])] })
  }
  if (input.view === 'board') {
    const rows = (value.items ?? []).map((quest: any) => row({ id: quest.ref ?? quest.id, title: quest.title, group: quest.group, state: quest.state, step: quest.progress ? quest.progress.done + '/' + quest.progress.total : undefined, running: quest.running || undefined, waiting: quest.reason ?? quest.nextAction, updated: stamp(quest.updatedAt) }))
    return page({ view: 'list board', scope: value.scope, extra: { scope: value.scope }, rows, offset: input.offset, total: Math.max(value.total ?? 0, (input.offset ?? 0) + rows.length), limit: input.limit, notes: [...(value.runs ? boardSentences(value) : []), ...(value.workers?.text ? [value.workers.text] : []), 'Run detail for one Quest: inspect with section runs.', ...(value.diagnostics ?? [])] })
  }
  const items = (value.items ?? []).map(questRow)
  return page({ view: 'list', scope: value.scope, extra: { scope: value.scope }, rows: items, offset: input.offset, total: value.total, limit: input.limit, notes: [counts, ...(value.diagnostics ?? [])] })
}

function historyRow(item: any): AnswerRow {
  const command = item.command !== undefined
  const exit = command ? (Number.isInteger(item.exitCode) ? item.exitCode : 'unknown') : undefined
  const why = typeof item.why === 'string' && item.route && item.why.startsWith(item.route + ': ') ? item.why.slice(item.route.length + 2) : item.why
  const landing = item.kind === 'landing' ? [item.branch, item.into].filter(Boolean).join(' → ') || undefined : undefined
  const what = command ? item.command : item.kind === 'run' ? why ?? item.text : landing ?? item.text ?? why ?? item.method
  return row({ at: stamp(item.at), kind: item.kind, step: item.stepID, state: item.state, exit, model: item.model, route: item.route, by: item.kind === 'run' ? item.actor : undefined, from: item.from, what })
}

function inspectAnswer(value: any, input: any): CompactAnswer {
  const data = value.data
  const scope = (value.id ?? '') + ' ' + value.section
  if (Array.isArray(data)) return page({ view: 'inspect', scope, rows: data.map(entry => scalarRow(entry, ['id', 'runID', 'stepID', 'title', 'sessionTitle', 'name', 'state', 'kind', 'model', 'command', 'exitCode', 'note', 'updatedAt', 'at'])), offset: value.offset ?? input.offset, total: value.totalItems, limit: input.limit })
  if (data && typeof data === 'object') {
    const rows = Object.entries(data).map(([key, field]) => row({ key, value: field && typeof field === 'object' ? JSON.stringify(field) : field }))
    return page({ view: 'inspect', scope, rows, key: 'fields', pageable: false })
  }
  const text = String(data ?? '')
  return { view: 'inspect', head: ['inspect', scope, text.length + ' characters'].join(' · '), text: words(text.replace(/\s+/g, ' '), ANSWER_PAGE_CHARACTERS - 200), ...(text.length > ANSWER_PAGE_CHARACTERS - 200 ? { notes: ['The whole section with limit set to the characters wanted.'] } : {}) }
}

function routingAnswer(value: any): CompactAnswer {
  const settings = value.settings ?? {}
  const rows = Object.entries(settings.depths ?? {}).map(([depth, setting]: [string, any]) => row({ depth, excluded: setting.exclude?.length ?? 0, speed: setting.speed?.mode + (setting.speed?.points === undefined ? '' : ' ' + setting.speed.points), exploration: setting.exploration }))
  const types = (settings.workTypes ?? []).map((type: any) => type.id).join(', ')
  const ratings = settings.ratings ? Object.keys(settings.ratings).length + ' work types rated' : undefined
  const served = Array.isArray(value.served) ? 'served routes, spelled as patterns must spell them: ' + (value.served.length ? value.served.join(', ') : 'none') : value.servedError
  const nothing = (value.patterns ?? []).filter((entry: any) => !entry.matches?.length).map((entry: any) => entry.at + ' ' + entry.pattern)
  return page({ view: 'routing', rows, key: 'depths', pageable: false, notes: [types && 'work types: ' + types, ratings, served, nothing.length ? 'matches nothing served now: ' + nothing.join('; ') : undefined] })
}

function routingHistoryAnswer(value: any, input: any): CompactAnswer {
  const rows = (value.items ?? []).map((item: any) => row({ run: item.runID, at: stamp(item.at), quest: item.quest?.ref ?? item.quest?.title, steps: Array.isArray(item.steps) ? item.steps.map((step: any) => step.id).join(',') : undefined, route: [item.route?.model ?? item.route?.id, item.route?.effort].filter(Boolean).join('#'), picked: item.automatic === null || item.automatic === undefined ? undefined : item.automatic ? 'routing' : 'by name', state: item.state, total: seconds(item.timing?.totalMs), reason: item.reason }))
  return page({ view: 'routingHistory', rows, offset: input.offset, total: value.total, limit: input.limit, notes: [input.runID && value.items?.[0]?.decision ? 'The whole decision with view decision.' : undefined] })
}

function rolesAnswer(value: any): CompactAnswer {
  const rows = (value.roles ?? []).map((role: any) => row({ role: role.role, model: role.selection ? role.selection.model + (role.selection.effort ? '#' + role.selection.effort : '') : '-', source: role.source }))
  return page({ view: 'roles', rows, key: 'roles', pageable: false })
}

function waterfallAnswer(value: any): CompactAnswer {
  const accounted = value.accounted?.lanes ?? {}
  const rows = (value.lanes ?? []).map((lane: any) => {
    const time = accounted[lane.id] ?? {}, by = time.byCategory ?? {}
    return row({ lane: lane.label ?? lane.id, kind: lane.kind, model: lane.model, total: seconds(time.totalMs), wait: seconds(by['model-wait']), stream: seconds(by['model-stream']), tool: seconds(by.tool) })
  })
  const window = value.window ? stamp(value.window.start) + '–' + stamp(value.window.end) : undefined
  const requests = Array.isArray(value.requests) ? value.requests.length + ' model requests' + (value.spanCount ? ', ' + value.spanCount + ' spans' : '') + '; view summary lists them' : undefined
  return page({ view: 'waterfall', scope: window, rows, key: 'lanes', pageable: false, notes: [requests] })
}

function reportAnswer(value: any) {
  const steps = (value.steps ?? []).map((step: any) => {
    const checks = Array.isArray(step.checks) ? step.checks.map((check: any) => ({ command: words(check.command, 80), exitCode: check.exitCode })) : []
    return { ...row({ id: step.id, state: step.state, note: step.note }), ...(checks.length ? { checks } : {}) }
  })
  return { id: value.id, revision: value.revision, steps }
}

const megabytes = (bytes: unknown) => typeof bytes === 'number' && Number.isFinite(bytes) ? Math.round(bytes / 1048576) + ' MB' : undefined
const lowestLeft = (account: any) => {
  const left = (account.windows ?? []).map((window: any) => window.remainingPercent).filter((value: unknown) => typeof value === 'number')
  return left.length ? Math.min(...left) + '%' : undefined
}
const systemRows: Record<string, (value: any) => AnswerRow[]> = {
  board: value => (value.board?.queued ?? []).map((quest: any) => row({ id: quest.questID, title: quest.title, waiting: quest.reason })),
  runs: value => (value.runs ?? []).map((run: any) => row({ run: run.runID, quest: run.questID, role: run.role, route: run.route ?? run.recordedRoute, state: run.state, saved: typeof run.minutesSinceLastSavedStep === 'number' ? Math.round(run.minutesSinceLastSavedStep) + ' min ago' : 'unknown', stalled: run.stall?.stalled })),
  hosts: value => (value.hosts ?? []).map((host: any) => row({ pid: host.pid, channel: host.channel ?? 'unknown', generation: host.generation ?? 'unknown', role: host.role, alive: host.alive, memory: megabytes(host.memoryBytes), sessions: host.sessions?.length })),
  serving: value => value.serving ? [row({ channel: value.serving.channel ?? 'unknown', generation: value.serving.generation ?? 'unknown', commit: value.serving.commit?.slice(0, 12) ?? 'unknown', v2: value.serving.v2?.slice(0, 12) ?? 'unknown', matchesV2: value.serving.matchesV2 ?? 'unknown' })] : [],
  reloadQueue: value => (value.reloadQueue ?? []).map((reload: any) => row({ state: reload.state, pid: reload.pid ?? undefined, start: stamp(reload.startedAt), alive: reload.alive ?? undefined, source: reload.source, repository: reload.repository })),
  accounts: value => (value.accounts?.items ?? []).map((account: any) => row({ account: account.id, provider: account.provider, state: account.state, left: lowestLeft(account), updated: stamp(account.observedAt), error: account.error ?? undefined })),
  blockedSteps: value => (value.blockedSteps ?? []).map((step: any) => row({ quest: step.questID, step: step.stepID, kind: step.kind, owner: step.owner ?? 'unknown', requires: step.requires })),
  needsYou: value => (value.needsYou ?? []).map((ask: any) => row({ quest: ask.questID, kind: ask.kind, reason: ask.reason, ask: ask.ask })),
  routes: value => (value.routes ?? []).map((route: any) => row({ route: route.providerID + '/' + route.modelPattern, matches: Array.isArray(route.matches) ? route.matches.length : 'unknown', reason: route.reason ?? undefined })),
  diagnostics: value => (value.diagnostics ?? []).map((text: string) => row({ value: text })),
}

function systemStateAnswer(value: any, input: any): CompactAnswer {
  const scope = value.questID
  if (input.section) {
    const all = systemRows[input.section](value), offset = input.offset ?? 0
    const rows = input.limit === undefined ? all.slice(offset) : all.slice(offset, offset + input.limit)
    return page({ view: 'system_state section', scope: [scope, input.section].filter(Boolean).join(' '), rows, offset, total: all.length, limit: input.limit, notes: input.section === 'diagnostics' ? [] : [value.diagnostics?.length ? value.diagnostics.length + ' sources unavailable: section diagnostics' : undefined] })
  }
  const counts = value.board?.counts ?? {}
  const countRow = row({ you: counts.you, result: counts.result, working: counts.working, queued: counts.queued, done: counts.done, open: counts.open, total: counts.total, runs: value.runs?.length, blocked: value.blockedSteps?.length, needsYou: value.needsYou?.length, reloads: value.reloadQueue?.length, hostsAlive: (value.hosts ?? []).filter((host: any) => host.alive).length, unavailable: value.diagnostics?.length }, 400)
  const serving = systemRows.serving(value)[0]
  const revision = serving ? (serving.matchesV2 === true ? 'serving matches v2' : serving.matchesV2 === false ? 'serving differs from v2' : 'serving against v2 unknown') : undefined
  return page({ view: 'system_state', scope: [scope, revision, stamp(value.at)].filter(Boolean).join(' · '), rows: systemRows.hosts(value), key: 'hosts', pageable: false, more: 'section hosts', extra: { counts: countRow, ...(serving ? { serving } : {}) }, notes: ['One part: section ' + SYSTEM_STATE_SECTIONS.filter(name => name !== 'hosts' && name !== 'serving').join(', ') + '.', 'One Quest: questID.', value.diagnostics?.length ? value.diagnostics.length + ' sources unavailable: section diagnostics' : undefined] })
}

export const shapedQuestOperation = (method: string) => COMPACT_QUEST_OPERATIONS.includes(method)

const PIECE_OPERATIONS = ['get', 'routing', 'roles', 'routingHistory']

export function pieceInput(method: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!PIECE_OPERATIONS.includes(method) || input.view === undefined) return input
  const { view, ...rest } = input
  return rest
}

function piece(method: string, input: any, value: any, drawn: boolean): unknown {
  if (method === 'list' && input.view === 'board' && drawn) return value
  if (method === 'get' && input.view === 'page') { const { workflow, continuation, recordedState, recordedExecuting, ...page } = value; return page }
  if ((method === 'routing' || method === 'roles') && input.view === 'settings') return value
  if (method === 'routingHistory' && input.view === 'rows') return { ...value, items: (value.items ?? []).map(({ decision, ...item }: any) => item) }
  if (method === 'routingHistory' && input.view === 'decision') return { runID: input.runID ?? null, decision: value.items?.[0]?.decision ?? null }
  if (method === 'waterfall' && (input.view !== undefined || input.request !== undefined)) return value
  if (method === 'inspect' && input.limit !== undefined) return value
  return undefined
}

export function compactQuestAnswer(method: string, input: any, value: any, drawn = true): unknown {
  if (!shapedQuestOperation(method) || !value || typeof value !== 'object') return value
  input = input ?? {}
  const asked = piece(method, input, value, drawn)
  if (asked !== undefined) return asked
  if (method === 'list') return listAnswer(value, input)
  if (method === 'get' || method === 'status') return questCard(method, value)
  if (method === 'inspect') return inspectAnswer(value, input)
  if (method === 'history') return page({ view: 'history', scope: value.id, ...(value.earlierCount ? { extra: { earlierCount: value.earlierCount } } : {}), rows: (value.items ?? []).map(historyRow), offset: input.offset, total: value.total ?? (input.offset ?? 0) + (value.items?.length ?? 0), limit: input.limit })
  if (method === 'routing') return routingAnswer(value)
  if (method === 'routingHistory') return routingHistoryAnswer(value, input)
  if (method === 'roles') return rolesAnswer(value)
  if (method === 'waterfall') return waterfallAnswer(value)
  if (method === 'system_state') return systemStateAnswer(value, input)
  return reportAnswer(value)
}
