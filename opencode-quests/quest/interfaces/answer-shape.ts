import { ANSWER_PAGE_CHARACTERS, ANSWER_ROW_CHARACTERS, FULL_INPUT } from './answer-size.mjs'
export { ANSWER_PAGE_CHARACTERS, ANSWER_ROW_CHARACTERS, FULL_INPUT }

export type AnswerValue = string | number | boolean
export type AnswerRow = Record<string, AnswerValue>
export type CompactAnswer = { view: string; head: string; nextOffset?: number | null; notes?: string[]; [list: string]: unknown }

const size = (value: unknown) => JSON.stringify(value).length

export function words(text: unknown, room: number): string {
  const first = String(text ?? '').split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? ''
  if (first.length <= room) return first
  const cut = first.slice(0, Math.max(1, room - 1)), space = cut.lastIndexOf(' ')
  return (space > room / 3 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—(]+$/, '') + '…'
}

export function stamp(at: unknown): string | undefined {
  const time = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isFinite(time) ? new Date(time).toISOString().slice(5, 16) + 'Z' : undefined
}

export const seconds = (ms: unknown) => typeof ms === 'number' && Number.isFinite(ms) ? (ms >= 100_000 ? Math.round(ms / 1000) : Math.round(ms / 100) / 10) + 's' : undefined

export function money(cost: { currency: string; actual?: number | null; estimated?: number | null; estimate?: number | null }[] | undefined): string | undefined {
  const parts = (cost ?? []).flatMap(each => {
    const actual = each.actual ?? null, estimate = each.estimated ?? each.estimate ?? null
    const value = actual !== null && actual > 0 ? actual : estimate
    if (value === null) return []
    const amount = (each.currency === 'USD' ? '$' : each.currency + ' ') + (value < 10 ? value.toFixed(2) : Math.round(value).toLocaleString('en-US'))
    return [(actual !== null && actual > 0 ? '' : '~') + amount]
  })
  return parts.length ? parts.join(' ') : undefined
}

const BARE = new Set(['id', 'title', 'name', 'model', 'route', 'label', 'what', 'account', 'session', 'lane', 'role', 'run', 'state', 'quest', 'kind', 'value'])
export const line = (value: AnswerRow) => Object.entries(value).map(([key, field]) => typeof field === 'string' && BARE.has(key) ? field : key + ' ' + (typeof field === 'number' ? field.toLocaleString('en-US') : String(field))).join(' · ')

export function row(fields: Record<string, unknown>, room = ANSWER_ROW_CHARACTERS, dropTrailing = false): AnswerRow {
  const value: AnswerRow = {}
  for (const [key, field] of Object.entries(fields)) {
    if (field === undefined || field === null || field === '') continue
    if (typeof field === 'number') { if (Number.isFinite(field)) value[key] = Math.round(field * 10) / 10; continue }
    if (typeof field === 'boolean') { value[key] = field; continue }
    value[key] = words(field, room)
  }
  for (;;) {
    const over = line(value).length - room
    if (over <= 0) return value
    const prose = Object.entries(value).filter(([key, field]) => typeof field === 'string' && !EXACT.has(key) && field.length > SHORTEST_PROSE).sort((a, b) => (b[1] as string).length - (a[1] as string).length) as [string, string][]
    if (prose.length) { const [key, field] = prose[0]; value[key] = words(field, Math.min(field.length - 1, Math.max(SHORTEST_PROSE, prose[1]?.[1].length ?? 0, field.length - over))); continue }
    const keys = Object.keys(value)
    if (!dropTrailing || keys.length <= 1) return value
    delete value[keys[keys.length - 1]]
  }
}

const SHORTEST_PROSE = 24
const EXACT = new Set(['id', 'run', 'runID', 'stepID', 'callID', 'sessionID', 'model', 'route', 'at', 'updated', 'updatedAt', 'startedAt', 'last', 'resets', 'step', 'steps', 'state', 'kind', 'left', 'pace', 'slots', 'cost', 'wall', 'tools', 'total', 'wait', 'stream', 'tool', 'session', 'account', 'window', 'depth', 'speed', 'role', 'start', 'picked', 'usd', 'pass', 'group', 'command', 'by', 'exit'])

export function scalarRow(value: unknown, first: string[] = []): AnswerRow {
  if (value === null || typeof value !== 'object') return row({ value })
  const entries = Object.entries(value as Record<string, unknown>).filter(([, field]) => ['string', 'number', 'boolean'].includes(typeof field))
  const rank = (key: string) => { const at = first.indexOf(key); return at < 0 ? first.length : at }
  return row(Object.fromEntries(entries.sort((a, b) => rank(a[0]) - rank(b[0])).map(([key, field]) => [key, /At$/.test(key) ? stamp(field) ?? field : field])), ANSWER_ROW_CHARACTERS, true)
}

export type PageInput = {
  view: string
  scope?: string
  rows: AnswerRow[]
  key?: string
  offset?: number
  total?: number
  limit?: number
  pageable?: boolean
  more?: string
  notes?: (string | undefined | null | false)[]
  extra?: Record<string, unknown>
}

export function page(input: PageInput): CompactAnswer {
  const offset = input.offset ?? 0, key = input.key ?? 'items', total = input.total ?? offset + input.rows.length
  const notes = [...new Set(input.notes?.filter((note): note is string => typeof note === 'string' && !!note.trim()).map(note => words(note, ANSWER_ROW_CHARACTERS)) ?? [])]
  const build = (shown: number): CompactAnswer => {
    const end = offset + shown, more = total - end
    const next = more > 0 && input.pageable !== false ? end : null
    const span = total === 0 ? 'none' : shown === 0 ? (offset + 1) + '+ of ' + total : (offset + 1) + '–' + end + ' of ' + total
    const tail = more > 0 ? input.pageable === false ? more + ' more' + (input.more ? ': ' + input.more : '') : 'next offset ' + end : undefined
    const head = [input.view, input.scope, span, tail].filter(Boolean).join(' · ')
    return { view: input.view, head, ...input.extra, [key]: input.rows.slice(0, shown), ...(input.pageable === false ? {} : { nextOffset: next }), ...(notes.length ? { notes } : {}) }
  }
  if (input.limit !== undefined) return build(input.rows.length)
  let shown = Math.min(1, input.rows.length)
  while (shown < input.rows.length && size(build(shown + 1)) <= ANSWER_PAGE_CHARACTERS) shown++
  return build(shown)
}

export function answerText(answer: CompactAnswer): string {
  const lines: string[] = [answer.head]
  for (const [key, value] of Object.entries(answer)) {
    if (['view', 'head', 'nextOffset', 'notes'].includes(key)) continue
    if (Array.isArray(value)) lines.push(...value.map(item => item && typeof item === 'object' ? line(item as AnswerRow) : String(item)))
    else if (value && typeof value === 'object') lines.push(key + ': ' + line(value as AnswerRow))
    else if (value !== undefined) lines.push(key + ': ' + String(value))
  }
  return [...lines, ...(answer.notes ?? [])].join('\n')
}

export const isCompact = (value: unknown): value is CompactAnswer => !!value && typeof value === 'object' && typeof (value as any).head === 'string' && typeof (value as any).view === 'string'
