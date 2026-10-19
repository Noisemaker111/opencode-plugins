import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { v2StateDirectory } from '../scripts/channel-migrate.mjs'
import { forwardLines, spanEnd, spanFiles, spanStart } from '../scripts/span-files.mjs'

async function openDatabase(file) {
  if (globalThis.Bun) { const { Database } = await import('bun:sqlite'); return new Database(file, { readonly: true }) }
  const { DatabaseSync } = await import('node:sqlite'); return new DatabaseSync(file, { readOnly: true })
}

export function defaultSources(env = process.env) {
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  const state = v2StateDirectory(join(env.OPENCODE_CONFIG_DIR ?? join(home, '.config', 'opencode'), '.channels'))
  return {
    state,
    hostLog: join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'opencode', 'log', 'opencode.log'),
    connectorLog: env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'QuestGiver', 'connector.log') : undefined,
  }
}

export function parseTime(value, now = Date.now()) {
  const relative = /^(\d+(?:\.\d+)?)([smhd])$/.exec(value)
  const at = relative ? now - Number(relative[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[relative[2]] : /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(at)) throw Error('Unreadable time: ' + value)
  return at
}

const json = text => { try { return JSON.parse(text) } catch { return undefined } }
function jsonLines(file, needle, keep = () => true) {
  if (!file || !existsSync(file)) return []
  const out = []
  for (const line of forwardLines(file)) if (line && (!needle || line.includes(needle))) { const row = json(line); if (row && keep(row)) out.push(row) }
  return out
}

function resolveSession(db, reference) {
  const columns = 'id, slug, title, agent, directory, time_updated as updated'
  if (!reference) return db.prepare(`select ${columns} from session_v2 where agent = 'quest-giver' order by time_updated desc limit 1`).get()
  return db.prepare(`select ${columns} from session_v2 where id = ? or slug = ? or title = ? order by time_updated desc limit 1`).get(reference, reference, reference)
}

export function findTurns(rows) {
  const turns = []
  let open
  for (const row of rows) {
    if (row.type === 'user' && !open) open = { start: row.time, startSeq: row.seq }
    else if (row.type === 'idle' && open) { turns.push({ ...open, end: row.time, endSeq: row.seq, closed: true }); open = undefined }
  }
  if (open) turns.push({ ...open, end: rows.at(-1)?.time ?? open.start, endSeq: rows.at(-1)?.seq ?? open.startSeq, closed: false })
  return turns
}

const PHASES = [
  [/^(user|inbox\.enqueued)>(inbox\.enqueued|inbox\.delivered|execution\.started)$/, 'admission'],
  [/^inbox\.delivered>execution\.started$/, 'admission'],
  [/^execution\.started>user$/, 'admission'],
  [/^(user|inbox\.\w+|execution\.started|step\.start)>context$/, 'prepare: session, instructions, tools'],
  [/^(user|inbox\.\w+|execution\.started)>git$/, 'prepare, then snapshot capture before its first git call'],
  [/^(user|inbox\.\w+|execution\.started)>step\.start$/, 'prepare + snapshot capture (no finer boundary recorded)'],
  [/^step\.end>context$/, 'next step: session, instructions, tools'],
  [/^(request\.end|tool\.done)>context$/, 'step close, then next step: session, instructions, tools'],
  [/^step\.end>git$/, 'next step: prepare, then snapshot capture before its first git call'],
  [/^step\.end>step\.start$/, 'next step: prepare + snapshot capture (no finer boundary recorded)'],
  [/^context>context$/, 'between context hooks'],
  [/^context>git$/, 'snapshot capture before its first git call'],
  [/^context>step\.start$/, 'snapshot capture (no git call in the host log)'],
  [/^context>request\.start$/, 'request dispatch'],
  [/^git>step\.start$/, 'snapshot capture: after last git call'],
  [/^step\.start>request\.start$/, 'request dispatch'],
  [/^request\.first>request\.end$/, 'model stream'],
  [/^request\.end>(tool\.ran|step\.streamed)$/, 'tool dispatch'],
  [/^step\.streamed>tool\.ran$/, 'tool dispatch'],
  [/^tool\.done>tool\.ran$/, 'between tool calls'],
  [/^(request\.end|tool\.done|step\.streamed)>git$/, 'step close: snapshot capture before its first git call'],
  [/^(request\.end|tool\.done|step\.streamed)>step\.end$/, 'step close: snapshot capture + file diff'],
  [/^git>step\.end$/, 'step close: after last git call'],
  [/^(step\.end|execution\.end|request\.end|compaction\.ended)>(idle|execution\.end)$/, 'settle'],
  [/^compaction\.started>(context|request\.start)$/, 'compaction: prepare the summary request'],
  [/^request\.end>compaction\.ended$/, 'compaction: save the summary'],
]
export const phaseName = (from, to) => PHASES.find(([pattern]) => pattern.test(`${from}>${to}`))?.[1]

const SNAPSHOT_GIT = new Set(['diff-files', 'ls-files', 'check-ignore', 'rm', 'add', 'write-tree', 'diff'])
export function hostGitSpawns(text, directory, from, to) {
  const out = [], want = String(directory).replaceAll('/', '\\').toLowerCase()
  for (const line of text.split('\n')) {
    if (!line.includes('spawning process')) continue
    const at = Date.parse(/^timestamp=(\S+)/.exec(line)?.[1] ?? '')
    if (!(at >= from && at <= to)) continue
    const cwd = json(/ cwd=("(?:[^"\\]|\\.)*")/.exec(line)?.[1] ?? '')
    if (typeof cwd !== 'string' || cwd.replaceAll('/', '\\').toLowerCase() !== want) continue
    const args = json(json(/ args=("(?:[^"\\]|\\.)*")/.exec(line)?.[1] ?? '') ?? '')
    if (!Array.isArray(args)) continue
    let i = 0
    while (i < args.length && (args[i] === '--git-dir' || args[i] === '--work-tree' || args[i] === '-c')) i += 2
    while (i < args.length && args[i].startsWith('--')) i++
    const command = args[i] ?? 'git', snapshot = args.some(arg => /[\\/]snapshot[\\/]/i.test(arg)) || command === 'check-ignore'
    out.push({ at, command, snapshot: snapshot && SNAPSHOT_GIT.has(command) })
  }
  return out
}

const promptTokens = t => [t?.input, t?.cacheRead, t?.cacheWrite].every(n => typeof n === 'number') ? t.input + t.cacheRead + t.cacheWrite : undefined
const union = spans => {
  const sorted = spans.filter(s => s.end > s.start).map(s => [s.start, s.end]).sort((a, b) => a[0] - b[0]), out = []
  for (const [s, e] of sorted) { const last = out.at(-1); if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]) }
  return out
}
const total = intervals => intervals.reduce((n, [s, e]) => n + e - s, 0)
const clip = (s, from, to) => ({ ...s, start: Math.max(s.start, from), end: Math.min(s.end, to) })

export async function turnWaterfall(options = {}) {
  const sources = { ...defaultSources(options.env), ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) }
  const hostDB = join(sources.state, 'host.db'), requestsFile = join(sources.state, 'requests.jsonl'), spansFile = sources.spans ?? requestsFile + '.spans.jsonl'
  if (!existsSync(hostDB)) throw Error('No host database at ' + hostDB)
  const db = await openDatabase(hostDB)
  let session, messages, turn, turns
  try {
    session = resolveSession(db, options.session)
    if (!session) throw Error(options.session ? 'No session matches ' + options.session : 'No Quest Giver session in ' + hostDB)
    const rows = db.prepare("select seq, type, time_created as time from session_message where session_id = ? and type in ('user', 'assistant', 'idle') order by seq").all(session.id)
    turns = findTurns(rows)
    if (options.since !== undefined) {
      const since = parseTime(String(options.since), options.now)
      const last = turns.at(-1)
      if (!last) throw Error('Session has no turns')
      turn = { start: since, end: last.end, startSeq: rows.find(r => r.time >= since)?.seq ?? last.startSeq, endSeq: last.endSeq, closed: last.closed, since: true }
    } else {
      const n = Number(options.turn ?? 1)
      if (!Number.isInteger(n) || n < 1) throw Error('--turn takes 1 for the latest turn, 2 for the one before, and so on')
      turn = turns.at(-n)
      if (!turn) throw Error(`Session has ${turns.length} turn(s); --turn ${n} does not exist`)
    }
    if (!turn.closed) turn.end = Math.max(turn.end, options.now ?? Date.now())
    messages = db.prepare('select seq, type, time_created as time, data from session_message where session_id = ? and seq >= ? and seq <= ? order by seq').all(session.id, turn.startSeq, turn.endSeq)
      .map(row => ({ ...row, data: json(row.data) ?? {} }))
  } finally { db.close() }
  const { start, end } = turn, wall = end - start
  const rows = [], boundaries = [], measured = []
  const boundary = (t, kind, label) => { if (Number.isFinite(t) && t >= start - 1 && t <= end + 1) boundaries.push({ t, kind, label }) }
  const add = (row, count = true) => { const clipped = clip(row, start, end); if (clipped.end < clipped.start) return; rows.push(clipped); if (count) measured.push(clipped) }

  const runIDs = new Set(), toolCallsByID = new Map()
  for (const m of messages) {
    const t = m.data.time ?? {}
    if (m.type === 'user') boundary(m.time, 'user', m.data.metadata?.questWorkerReturn ? 'Quest update' : 'user message')
    if (m.type === 'idle') boundary(m.time, 'idle', 'idle')
    if (m.type !== 'assistant') continue
    boundary(t.created, 'step.start', 'step started'); boundary(t.streamed, 'step.streamed', 'step streamed'); boundary(t.completed, 'step.end', 'step ended')
    for (const part of m.data.content ?? []) {
      if (part.type !== 'tool') continue
      const pt = part.time ?? {}, meta = part.state?.metadata ?? {}
      const text = (part.state?.content ?? []).map(c => c.text ?? '').join('')
      for (const match of text.matchAll(/"runID"\s*:\s*"([a-z0-9-]+)"/g)) runIDs.add(match[1])
      const ops = [...new Set((meta.toolCalls ?? []).map(call => call.tool))]
      const began = pt.ran ?? pt.created
      if (!Number.isFinite(began)) continue
      toolCallsByID.set(part.id, part.name)
      boundary(began, 'tool.ran', 'tool started'); boundary(pt.completed, 'tool.done', 'tool finished')
      add({ start: began, end: pt.completed ?? end, category: 'tool', label: `tool ${part.name}${ops.length ? ' ' + ops.join(', ') : ''} (${part.state?.status ?? '?'})`, tokens: text ? { resultChars: text.length, resultTokensEstimate: Math.round(text.length / 4) } : undefined })
      for (const inner of meta.innerCalls ?? []) add({ start: inner.start, end: inner.end, category: 'tool', label: `  inner ${inner.tool} (${inner.status})`, depth: 1 }, false)
    }
  }

  const requests = new Map(), earlier = new Map()
  for (const row of jsonLines(requestsFile, session.id)) { const r = row.request; if (r?.sessionID !== session.id) continue; if (r.startedAt >= start - 1000 && r.startedAt <= end) requests.set(r.id, r); else if (r.startedAt < start - 1000) earlier.set(r.id, r) }
  let lastPrompt, previous = [...earlier.values()].filter(r => r.state === 'completed').sort((a, b) => a.startedAt - b.startedAt).at(-1)
  for (const r of [...requests.values()].sort((a, b) => a.startedAt - b.startedAt)) {
    const t = r.tokens ?? {}, prompt = promptTokens(t), first = r.firstResponseAt, done = r.completedAt ?? end
    boundary(r.startedAt, 'request.start', 'request sent'); boundary(first, 'request.first', 'first response'); boundary(r.completedAt, 'request.end', 'request done')
    add({ start: r.startedAt, end: done, category: 'model', label: `model ${r.route?.providerID}/${r.route?.modelID}${r.route?.variant ? '#' + r.route.variant : ''} ${r.kind} (${r.state}${first ? `, first response ${((first - r.startedAt) / 1000).toFixed(1)}s, generation ${((done - first) / 1000).toFixed(1)}s` : ''})`,
      tokens: { input: t.input, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, output: t.output, reasoning: t.reasoning, prompt, promptDelta: prompt !== undefined && lastPrompt !== undefined ? prompt - lastPrompt : undefined, context: r.context?.tokens, messages: r.request?.messageCount, envelopeBytes: r.request?.envelopeBytes, cacheBreak: cacheBreak(previous, r) } })
    if (prompt !== undefined) lastPrompt = prompt
    if (r.state === 'completed') previous = r
  }
  const requested = union(rows.filter(r => r.category === 'model'))
  for (const m of messages) {
    const t = m.data.time ?? {}, k = m.data.tokens, stop = t.streamed ?? t.completed
    if (m.type !== 'assistant' || !Number.isFinite(t.created) || !Number.isFinite(stop)) continue
    if (requested.some(([s, e]) => s < stop && e > t.created)) continue
    const prompt = promptTokens({ input: k?.input, cacheRead: k?.cache?.read, cacheWrite: k?.cache?.write })
    add({ start: t.created, end: stop, category: 'model', label: `model ${m.data.model?.providerID}/${m.data.model?.id}${m.data.model?.variant ? '#' + m.data.model.variant : ''} (host step times; no request record)`,
      tokens: k ? { input: k.input, cacheRead: k.cache?.read, cacheWrite: k.cache?.write, output: k.output, reasoning: k.reasoning, prompt } : undefined })
  }

  const nearTurn = row => { const at = spanStart(row), to = spanEnd(row); return at !== undefined && to !== undefined && at <= end + 60_000 && to >= start - 60_000 }
  const spanRows = [spansFile, ...spanFiles(spansFile, { from: start - 86_400_000, to: end })].flatMap(file => jsonLines(file, undefined, row => row.v === 1 && (row.sessionID === session.id || nearTurn(row))))
  const pids = new Set(spanRows.filter(row => row.sessionID === session.id).map(row => row.pid))
  const background = new Map(), lags = []
  for (const row of spanRows) {
    if (row.kind === 'host') {
      if (row.sessionID !== session.id) continue
      if (Number.isFinite(row.created) && Number.isFinite(row.observed) && row.created >= start && row.created <= end) lags.push(row.observed - row.created)
      const t = row.created ?? row.observed, kind = /^session\.execution\.(succeeded|failed|interrupted)$/.test(row.type) ? 'execution.end' : row.type.replace(/^session\./, '')
      if (['inbox.enqueued', 'inbox.delivered', 'execution.started', 'execution.end', 'compaction.started', 'compaction.ended', 'retry.scheduled'].includes(kind)) boundary(t, kind, row.type.replace(/^session\./, ''))
      continue
    }
    const to = row.kind === 'agg' ? row.to : row.end, from = row.kind === 'agg' ? row.from : row.start
    if (!(to >= start && from <= end)) continue
    const blocking = row.name === 'event'
    if (row.kind === 'span' && row.sessionID === session.id) {
      const category = row.name === 'tool.execute' || row.name === 'quests.api' ? 'tool' : row.name.startsWith('dispatch.') ? 'dispatch' : 'plugin'
      if (row.name === 'session.context') boundary(row.end, 'context', 'context hook done')
      add({ start: row.start, end: blocking ? row.start + (row.sync ?? 0) : row.end, category, plugin: row.plugin, label: `${category === 'plugin' ? 'plugin ' : ''}${row.plugin} ${row.name}${row.op ? ' ' + row.op : ''}${row.sync !== undefined && row.end - row.start > row.sync + 1 ? ` (sync ${row.sync}ms)` : ''}${row.error ? ' error' : ''}`, depth: 1 }, category !== 'tool')
      continue
    }
    if (pids.size && !pids.has(row.pid)) continue
    if (row.kind === 'span' && row.name.startsWith('dispatch.')) { add({ start: row.start, end: row.end, category: 'dispatch', plugin: row.plugin, label: `dispatch ${row.name.slice(9)} ${row.op ?? ''}`, depth: 1 }); continue }
    const key = `${row.plugin} ${row.name}${row.op ? ' ' + row.op : ''}`
    const b = background.get(key) ?? background.set(key, { plugin: row.plugin, label: key, count: 0, syncMs: 0, maxSyncMs: 0, first: from }).get(key)
    const sync = row.kind === 'agg' ? row.total : row.sync ?? 0
    b.count += row.kind === 'agg' ? row.count : 1; b.syncMs += sync; b.maxSyncMs = Math.max(b.maxSyncMs, row.kind === 'agg' ? row.max : sync)
    if (row.kind === 'span' && sync >= 1) measured.push({ ...clip({ start: row.start, end: row.start + sync }, start, end), category: 'plugin', plugin: row.plugin, background: true })
  }

  let gitCount = 0
  if (sources.hostLog && existsSync(sources.hostLog)) {
    const spawns = hostGitSpawns(readFileSync(sources.hostLog, 'utf8'), session.directory, start, end).filter(s => s.snapshot)
    const busy = union(rows.filter(r => (r.category === 'model' || r.category === 'tool') && !r.depth)), rounds = []
    for (const s of spawns) { const last = rounds.at(-1); if (last && s.at - last.at < 100) last.commands.push(s.command); else rounds.push({ at: s.at, commands: [s.command] }) }
    const ours = rounds.filter(round => !busy.some(([s, e]) => round.at > s && round.at < e))
    const others = rounds.length - ours.length
    if (others) background.set('git snapshot', { plugin: 'host', label: 'host snapshot git for another session in this directory', count: rounds.filter(r => !ours.includes(r)).reduce((n, r) => n + r.commands.length, 0), syncMs: 0, maxSyncMs: 0, first: start })
    gitCount = ours.reduce((n, r) => n + r.commands.length, 0)
    for (const round of ours) boundary(round.at, 'git', 'git ' + round.commands.join(' + '))
    const marks = boundaries.filter(b => b.kind !== 'git').map(b => b.t).sort((a, b) => a - b)
    let group
    ours.forEach((round, i, rounds) => {
      const finish = Math.min(rounds[i + 1]?.at ?? Infinity, marks.find(t => t > round.at) ?? end)
      if (!group || round.at > group.end + 1) { group = { start: round.at, end: finish, category: 'host', label: '', calls: 0 }; rows.push(group) }
      group.calls += round.commands.length; group.end = Math.max(group.end, finish); group.label = `host snapshot capture (${group.calls} git call${group.calls > 1 ? 's' : ''})`
      add({ start: round.at, end: finish, category: 'git', label: '  git ' + round.commands.join(' + '), depth: 1 })
    })
  }

  boundaries.sort((a, b) => a.t - b.t)
  const covered = union(measured), gaps = []
  let cursor = start
  for (const [s, e] of [...covered, [end, end]]) { if (s > cursor) gaps.push([cursor, s]); cursor = Math.max(cursor, e) }
  for (const [s, e] of gaps) {
    const prev = boundaries.findLast(b => b.t <= s + 1), next = boundaries.find(b => b.t >= e - 1)
    const name = prev && next ? phaseName(prev.kind, next.kind) : undefined
    rows.push({ start: s, end: e, category: name ? 'host' : 'unaccounted', label: name ? `host ${name}` : `unaccounted: ${prev?.label ?? 'turn start'} → ${next?.label ?? 'turn end'}` })
  }
  rows.sort((a, b) => a.start - b.start || (a.depth ?? 0) - (b.depth ?? 0) || b.end - a.end)

  const byCategory = (predicate) => total(union(rows.filter(predicate)))
  const subtotals = {
    model: byCategory(r => r.category === 'model'),
    tool: byCategory(r => r.category === 'tool' && !r.depth),
    dispatch: byCategory(r => r.category === 'dispatch'),
    plugin: Object.fromEntries([...new Set([...rows, ...measured].filter(r => r.category === 'plugin' && r.plugin).map(r => r.plugin))].map(p => [p, total(union([...rows.filter(r => r.category === 'plugin' && r.plugin === p), ...measured.filter(r => r.background && r.plugin === p)]))])),
    hostSnapshotGit: byCategory(r => r.category === 'git'),
    host: Object.fromEntries(Object.entries(rows.filter(r => r.category === 'host' && !r.calls).reduce((m, r) => (m[r.label.replace(/^host /, '')] = (m[r.label.replace(/^host /, '')] ?? 0) + r.end - r.start, m), {})).sort((a, b) => b[1] - a[1])),
    unaccounted: rows.filter(r => r.category === 'unaccounted').reduce((n, r) => n + r.end - r.start, 0),
  }
  const modelRows = rows.filter(r => r.category === 'model'), sum = key => modelRows.reduce((n, r) => n + (r.tokens?.[key] ?? 0), 0)
  const tokens = { requests: modelRows.length, input: sum('input'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), output: sum('output'), reasoning: sum('reasoning'), toolResultTokensEstimate: rows.reduce((n, r) => n + (r.tokens?.resultTokensEstimate ?? 0), 0) }
  const dispatchUnstamped = []
  if (!rows.some(r => r.category === 'dispatch') && runIDs.size && sources.connectorLog && existsSync(sources.connectorLog))
    for (const line of readFileSync(sources.connectorLog, 'latin1').split(/\r?\n/)) { const m = /^\[quest-dispatch\] ([a-z-]+) end (\S+) (\d+)ms$/.exec(line); if (m && runIDs.has(m[2])) dispatchUnstamped.push({ run: m[2], phase: m[1], ms: Number(m[3]) }) }
  return {
    session: { id: session.id, agent: session.agent, title: session.title, directory: session.directory },
    turn: { number: options.since !== undefined ? undefined : Number(options.turn ?? 1), of: turns.length, start, end, wallMs: wall, closed: turn.closed, since: !!turn.since },
    rows: rows.map(r => ({ ...r, offsetMs: r.start - start, ms: r.end - r.start })),
    subtotals, tokens, accountedMs: total(union(measured)), dispatchUnstamped,
    hostEventLag: lags.length ? (() => { const xs = lags.sort((a, b) => a - b), at = p => xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]; return { events: xs.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: xs.at(-1) } })() : null,
    sources: { hostDB, requests: requests.size, spans: existsSync(spansFile) ? spansFile : null, spanRowsForSession: spanRows.filter(r => r.sessionID === session.id && (r.start ?? r.created) >= start && (r.start ?? r.created) <= end).length, hostLog: sources.hostLog && existsSync(sources.hostLog) ? sources.hostLog : null, snapshotGitCalls: gitCount, backgroundPids: [...pids] },
    background: [...background.values()].sort((a, b) => b.syncMs - a.syncMs),
  }
}

export function cacheBreak(previous, request) {
  const t = request?.tokens ?? {}, input = t.input ?? 0
  if (!previous || request.state !== 'completed' || input < 8000 || (t.cacheRead ?? 0) >= input / 5) return undefined
  const before = previous.request?.prefix, after = request.request?.prefix, causes = []
  if (before && after) {
    const names = list => new Map(list.map(entry => [entry.split('#')[0], entry]))
    const was = names(before.tools), now = names(after.tools)
    for (const [name, entry] of now) if (!was.has(name)) causes.push('tool +' + name); else if (was.get(name) !== entry) causes.push('tool ' + name + ' changed')
    for (const name of was.keys()) if (!now.has(name)) causes.push('tool -' + name)
    if ([...was.keys()].filter(name => now.has(name)).join() !== [...now.keys()].filter(name => was.has(name)).join()) causes.push('tool order changed')
    const sections = list => { const seen = new Map(); return new Map(list.map(entry => { const at = entry.lastIndexOf('#'), label = at > 0 ? entry.slice(0, at) : 'part', n = (seen.get(label) ?? 0) + 1; seen.set(label, n); return [n > 1 ? label + ' ' + n : label, entry] })) }
    const had = sections(before.system), has = sections(after.system)
    for (const [label, entry] of has) if (!had.has(label)) causes.push('system ' + label + ' added'); else if (had.get(label) !== entry) causes.push('system ' + label + ' changed')
    for (const label of had.keys()) if (!has.has(label)) causes.push('system ' + label + ' removed')
  } else if (previous.request?.toolDefinitionCount !== request.request?.toolDefinitionCount) causes.push(`tools ${previous.request?.toolDefinitionCount}→${request.request?.toolDefinitionCount}`)
  if (!(before && after) && previous.request?.instructionRevision !== undefined && previous.request.instructionRevision !== request.request?.instructionRevision) causes.push(`instructions r${previous.request.instructionRevision}→r${request.request?.instructionRevision}`)
  const idle = request.startedAt - (previous.completedAt ?? previous.startedAt)
  if (previous.accountID && request.accountID && previous.accountID !== request.accountID) causes.push('account changed')
  const previousMissed = (previous.tokens?.input ?? 0) >= 8000 && (previous.tokens?.cacheRead ?? 0) < (previous.tokens?.input ?? 0) / 5
  if (!causes.length) causes.push(!(before && after) ? 'prefix not recorded' : previousMissed && idle < 10_000 ? `same prefix ${Math.round(idle / 1000)}s after a request that also missed: the provider had not stored it yet` : `same prefix, ${Math.round(idle / 1000)}s after the last request`)
  return 'CACHE MISS: ' + causes.slice(0, 4).join(', ') + (causes.length > 4 ? ` +${causes.length - 4} more` : '')
}

const secs = ms => (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's'
const k = n => n === undefined || n === null ? '-' : n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n)
const clock = t => new Date(t).toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Math.round(t) % 1000).padStart(3, '0')
function tokenText(t) {
  if (!t) return ''
  if (t.resultChars !== undefined) return `result ${k(t.resultChars)} chars ≈${k(t.resultTokensEstimate)} tok`
  return `in ${k(t.input)} cache ${k(t.cacheRead)}${t.cacheWrite ? ' write ' + k(t.cacheWrite) : ''} out ${k(t.output)} reason ${k(t.reasoning)} | prompt ${k(t.prompt)}${t.promptDelta !== undefined ? ` (${t.promptDelta >= 0 ? '+' : ''}${k(t.promptDelta)})` : ''}${t.messages !== undefined ? ` ${k(t.messages)} msgs` : ""}${t.cacheBreak ? ' | ' + t.cacheBreak : ''}`
}

export function renderWaterfall(report, width = 40) {
  const { turn, session } = report, scale = width / Math.max(1, turn.wallMs), pct = ms => (100 * ms / Math.max(1, turn.wallMs)).toFixed(0).padStart(3) + '%'
  const bar = r => { const a = Math.min(width - 1, Math.floor(r.offsetMs * scale)), b = Math.max(a + 1, Math.min(width, Math.round((r.offsetMs + r.ms) * scale))); return ' '.repeat(a) + (r.category === 'unaccounted' ? '?' : r.category === 'host' || r.category === 'git' ? '░' : '█').repeat(b - a) + ' '.repeat(width - b) }
  const lines = [
    `${session.agent ?? 'session'} ${session.id}${session.title ? ` "${session.title}"` : ''}`,
    `${turn.since ? 'since' : `turn ${turn.number} of ${turn.of} (latest = 1)`} ${clock(turn.start)} → ${clock(turn.end)}${turn.closed ? '' : ' (still running)'}  ${secs(turn.wallMs)}`,
    '',
    `  ${'offset'.padStart(8)} ${'time'.padStart(8)}  ${'|'.padEnd(width + 1, ' ')}| span`,
  ]
  const quiet = r => (r.category === 'host' || r.category === 'unaccounted') && r.ms < 1 || / event /.test(r.label) && r.ms < 5
  const folded = report.rows.filter(quiet)
  for (const r of report.rows) if (!quiet(r)) lines.push(`  ${('+' + secs(r.offsetMs)).padStart(8)} ${secs(r.ms).padStart(8)}  |${bar(r)}| ${r.label}${r.tokens ? '  ' + tokenText(r.tokens) : ''}`)
  if (folded.some(r => / event /.test(r.label))) lines.push(`  ${folded.filter(r => / event /.test(r.label)).length} plugin event handler rows under 0.01 s not shown (--json lists them)`)
  const s = report.subtotals, t = report.tokens
  lines.push('', 'Subtotals (each is the union of its own rows; categories may overlap)')
  const row = (name, ms, extra = '') => lines.push(`  ${name.padEnd(58)} ${secs(ms).padStart(8)} ${pct(ms)}${extra}`)
  row('model', s.model, `  ${t.requests} requests, in ${k(t.input)} cached ${k(t.cacheRead)} write ${k(t.cacheWrite)} out ${k(t.output)} reasoning ${k(t.reasoning)}`)
  row('tool', s.tool, t.toolResultTokensEstimate ? `  results ≈${k(t.toolResultTokensEstimate)} tok` : '')
  if (s.dispatch) row('dispatch', s.dispatch)
  for (const [plugin, ms] of Object.entries(s.plugin)) row('plugin ' + plugin, ms)
  row('host snapshot git (from host log)', s.hostSnapshotGit)
  for (const [name, ms] of Object.entries(s.host)) row('host ' + name, ms)
  row('unaccounted', s.unaccounted)
  if (report.hostEventLag) lines.push(`  host events reached plugins ${report.hostEventLag.p50Ms.toFixed(0)} ms late (p50), ${report.hostEventLag.p95Ms.toFixed(0)} ms (p95), ${report.hostEventLag.maxMs.toFixed(0)} ms (max) over ${report.hostEventLag.events} events`)
  if (report.background.length) {
    lines.push('', 'Other work on the same host thread during this turn (sync time; not awaited by this session)')
    const listed = report.background.filter(b => b.syncMs >= 5 || b.plugin === 'host'), rest = report.background.filter(b => !listed.includes(b))
    for (const b of listed) lines.push(`  ${b.label.padEnd(58)} ${secs(b.syncMs).padStart(8)}  ×${b.count}${b.plugin === 'host' ? '' : `, max ${b.maxSyncMs.toFixed(0)}ms`}`)
    if (rest.length) lines.push(`  ${`${rest.length} more handler kinds, ${rest.reduce((n, b) => n + b.count, 0)} calls`.padEnd(58)} ${secs(rest.reduce((n, b) => n + b.syncMs, 0)).padStart(8)}`)
  }
  if (report.dispatchUnstamped.length) {
    lines.push('', 'Dispatch phases from connector.log (no clock on these lines, so not placed above)')
    for (const d of report.dispatchUnstamped) lines.push(`  ${d.run} ${d.phase.padEnd(24)} ${secs(d.ms).padStart(8)}`)
  }
  const src = report.sources
  lines.push('', `sources: ${src.requests} model requests; ${src.spans ? `${src.spanRowsForSession} span rows for this session in this turn` : 'no span file'}; ${src.hostLog ? `${src.snapshotGitCalls} snapshot git calls in host log` : 'no host log'}`)
  return lines.join('\n')
}

export async function runWaterfall(args, env = process.env) {
  if (args.includes('--help') || args.includes('-h')) return [
    'quest waterfall [session] [--turn <n> | --since <time>] [--json]',
    'Time and token waterfall for one turn of a session (default: the latest Quest Giver session).',
    '  session      ses_ id, slug or title; worker sessions work too',
    '  --turn n     1 = latest turn (default), 2 = the one before, ...',
    '  --since t    everything since t (10m, 2h, ISO time or epoch ms)',
    '  --json       the full report as JSON',
    '  --state d    channel state directory (default: the v2 channel)',
    '  --host-log f / --connector-log f / --spans f   override source files',
  ].join('\n')
  const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const valued = new Set(['--turn', '--since', '--state', '--host-log', '--connector-log', '--spans', '--width'])
  const positional = args.filter((arg, i) => !arg.startsWith('--') && !valued.has(args[i - 1]))
  const report = await turnWaterfall({
    session: positional[0], turn: option('--turn'), since: option('--since'),
    state: option('--state') && resolve(option('--state')), hostLog: option('--host-log'), connectorLog: option('--connector-log'), spans: option('--spans'),
    env,
  })
  return args.includes('--json') ? JSON.stringify(report) : renderWaterfall(report, Number(option('--width') ?? 40))
}
