import { SPANS_FILE } from '../../scripts/span-store'
import { foldSpans, recentRows, statsOf, windowOf } from './span-aggregate'

const DATA_SHARE_MILLISECONDS = 30_000
const shared = new Map<string, { at: number; value: Promise<DataSet> }>()

export function dataView(input: { from?: number; to?: number; limit?: number } = {}): Promise<DataSet> {
  const key = JSON.stringify([input.from, input.to, input.limit])
  const held = shared.get(key)
  if (held && Date.now() - held.at < DATA_SHARE_MILLISECONDS) return held.value
  const value = buildDataView(input)
  shared.set(key, { at: Date.now(), value })
  return value
}

type DataSet = Awaited<ReturnType<typeof buildDataView>>

async function buildDataView(input: { from?: number; to?: number; limit?: number }) {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 500)), 5000)
  const now = Date.now(), to = input.to ?? now, from = new Date(input.from ?? to).setHours(0, 0, 0, 0)
  const file = process.env.OPENCODE_SPANS_FILE ?? SPANS_FILE
  const window = windowOf(foldSpans(file), from, to)
  const distributions = [...window.names].map(([name, series]) => ({ name, ...statsOf(series) })).sort((a, b) => (b.p99 ?? 0) - (a.p99 ?? 0))
  const trends = [...window.trends].map(([key, series]) => {
    const split = key.lastIndexOf('\0')
    return { name: key.slice(0, split), start: Number(key.slice(split + 1)), ...statsOf(series) }
  }).sort((a, b) => a.start - b.start)
  const models = [...window.models].map(([key, value]) => {
    const split = key.lastIndexOf('\0')
    return { model: key.slice(0, split), harness: key.slice(split + 1), calls: value.calls, tokenCalls: value.tokenCalls, tokens: value.tokens, tokensPerSecond: value.milliseconds ? Math.round(value.tokens / value.milliseconds * 10_000) / 10 : null }
  }).sort((a, b) => b.calls - a.calls)
  return { from, to, now, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, total: window.count, rows: recentRows(file, from, to, limit), distributions, trends, models }
}
