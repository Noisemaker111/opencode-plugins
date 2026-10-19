import { Database } from "bun:sqlite"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { priceBookFile } from "./price-book"
import { rateLimitError } from "./route-limits"

const HOUR = 3_600_000
const BURST_MS = 15 * 60_000
const WINDOWS = [
  { shape: "1h", ms: HOUR },
  { shape: "24h", ms: 24 * HOUR },
  { shape: "7d", ms: 7 * 24 * HOUR },
] as const
const DISPLAY_WINDOW = 1
const CUT_KINDS = new Set(["rate-limited", "quota"])
const CONFLICT = "conflicting bounds"

type Sources = { channelDir?: string; openCodeDb?: string }
type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
type ProviderReset = { at: number; source: string }
type Row = { provider: string | null; route: string | null; at: number; ref: string; source: string; ok: boolean; kind: string | null; tokens: Tokens; providerReset: ProviderReset | null }
type Usage = { requests: number; tokens: number }

const zeroTokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const iso = (at: number) => new Date(at).toISOString()
const tokenTotal = (tokens: Tokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
const isFree = (route: string, zero: Set<string>) => /[-:]free$/.test(route) || zero.has(route)

function totalsOf(rows: Row[]) {
  const totals = { requests: rows.length, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const row of rows) {
    totals.input += row.tokens.input
    totals.output += row.tokens.output
    totals.cacheRead += row.tokens.cacheRead
    totals.cacheWrite += row.tokens.cacheWrite
  }
  return totals
}

function usageOf(rows: Row[]): Usage {
  return { requests: rows.length, tokens: tokenTotal(totalsOf(rows)) }
}

function spread(values: number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return mean === 0 ? Infinity : (Math.max(...values) - Math.min(...values)) / mean
}

function limitKind(statusCode: number | null, message: string) {
  if (statusCode === 429 || rateLimitError(message)) return "rate-limited"
  if (statusCode === 503 || /unavailable/i.test(message)) return "unavailable"
  if (/balance|insufficient|credits?\b/i.test(message)) return "balance"
  if (/quota|exhausted|capacity|limit/i.test(message)) return "quota"
  return null
}

function providerResetOf(response: any, source: string, ref: string, after: number): ProviderReset | null {
  if (!response) return null
  const limited = Object.values(response.limits ?? {}).map((limit: any) => (limit?.resetAt ? Date.parse(limit.resetAt) : NaN)).filter(at => at > after)
  const at = limited.length ? Math.min(...limited) : typeof response.retryAfterSeconds === "number" ? (response.at ?? after) + response.retryAfterSeconds * 1000 : null
  return at === null ? null : { at, source: `${source} row ${ref}` }
}

function providerResetView(reset: ProviderReset | null | undefined) {
  return reset ? { at: iso(reset.at), source: reset.source } : null
}

function channelFiles(channelDir: string) {
  if (!existsSync(channelDir)) return []
  const seen = new Set<string>()
  const files: { file: string; source: string }[] = []
  for (const name of readdirSync(channelDir).sort()) {
    const link = join(channelDir, name, "requests.jsonl")
    if (!existsSync(link)) continue
    const file = realpathSync(link)
    if (seen.has(file)) continue
    seen.add(file)
    files.push({ file, source: "channel " + basename(dirname(file)) })
  }
  return files
}

function zeroPriced(file: string) {
  const book = priceBookFile(file)
  if (!existsSync(book)) return []
  const costs: Record<string, { input?: number; output?: number }[]> = JSON.parse(readFileSync(book, "utf8")).costs ?? {}
  return Object.entries(costs)
    .filter(([, tiers]) => Array.isArray(tiers) && tiers.length > 0 && tiers.every(tier => tier.input === 0 && tier.output === 0))
    .map(([route]) => route)
}

function channelRows(channelDir: string) {
  const latest = new Map<string, { source: string; request: any }>()
  const zero = new Set<string>()
  for (const { file, source } of channelFiles(channelDir)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue
      const request = JSON.parse(line)?.request
      if (request) latest.set(request.id, { source, request })
    }
    for (const route of zeroPriced(file)) zero.add(route)
  }
  const rows: Row[] = []
  for (const { source, request } of latest.values()) {
    const provider = request.route?.providerID || null
    const model = request.route?.modelID || null
    const route = provider && model ? provider + "/" + model : null
    if (request.state === "completed") {
      const tokens = { input: request.tokens?.input ?? 0, output: request.tokens?.output ?? 0, cacheRead: request.tokens?.cacheRead ?? 0, cacheWrite: request.tokens?.cacheWrite ?? 0 }
      rows.push({ provider, route, at: request.startedAt, ref: request.id, source, ok: true, kind: null, tokens, providerReset: null })
      continue
    }
    const kind = request.failure === "rate-limited" ? "rate-limited" : null
    rows.push({ provider, route, at: request.startedAt, ref: request.id, source, ok: false, kind, tokens: zeroTokens, providerReset: kind ? providerResetOf(request.response, source, request.id, request.startedAt) : null })
  }
  return { rows, zero }
}

function openCodeRows(file: string) {
  if (!existsSync(file)) return []
  const db = new Database(file, { readonly: true })
  try {
    const messages = db.query(`select id, json_extract(data, '$.providerID') providerID, json_extract(data, '$.modelID') modelID, json_extract(data, '$.time.created') at, json_extract(data, '$.time.completed') completed, json_extract(data, '$.error.name') errorName, json_extract(data, '$.error.data.statusCode') statusCode, json_extract(data, '$.error.data.message') message, json_extract(data, '$.tokens.input') input, json_extract(data, '$.tokens.output') output, json_extract(data, '$.tokens.cache.read') cacheRead, json_extract(data, '$.tokens.cache.write') cacheWrite from message where json_extract(data, '$.role') = 'assistant'`).all() as any[]
    const rows: Row[] = []
    for (const m of messages) {
      const provider = m.providerID || null
      const route = provider && m.modelID ? provider + "/" + m.modelID : null
      const base = { provider, route, at: m.at, ref: m.id, source: "opencode.db", providerReset: null }
      if (m.errorName != null || m.statusCode != null || m.message != null) {
        const kind = m.errorName === "MessageAbortedError" ? null : limitKind(m.statusCode, m.message ?? "")
        rows.push({ ...base, ok: false, kind, tokens: zeroTokens })
      } else if (m.completed != null) {
        rows.push({ ...base, ok: true, kind: null, tokens: { input: m.input ?? 0, output: m.output ?? 0, cacheRead: m.cacheRead ?? 0, cacheWrite: m.cacheWrite ?? 0 } })
      }
    }
    return rows
  } finally {
    db.close()
  }
}

function windowBefore(successes: Row[], cut: Row, windowMs: number) {
  return successes.filter(row => row.at > cut.at - windowMs && row.at < cut.at)
}

function windowStats(perCut: Row[][][], index: number) {
  const usedRows = new Set<Row>()
  const requests: number[] = []
  const tokens: number[] = []
  for (const cut of perCut) {
    const rows = cut[index]
    for (const row of rows) usedRows.add(row)
    requests.push(rows.length)
    tokens.push(usageOf(rows).tokens)
  }
  return { requests, tokens, usedRows }
}

function chooseWindow(perCut: Row[][][]) {
  const scores = WINDOWS.map((_, index) => {
    const stats = windowStats(perCut, index)
    return spread(stats.requests) + spread(stats.tokens)
  })
  const best = Math.min(...scores)
  if (!Number.isFinite(best)) return { index: null, tied: [] as string[], spread: null as number | null }
  const names = WINDOWS.filter((_, index) => scores[index] === best).map(window => window.shape)
  return { index: names.length === 1 ? scores.indexOf(best) : null, tied: names.length > 1 ? names : [], spread: best }
}

function windowMaxima(successes: Row[], windowMs: number): Usage {
  const max: Usage = { requests: 0, tokens: 0 }
  let requests = 0
  let tokens = 0
  let start = 0
  for (let end = 0; end < successes.length; end++) {
    requests++
    tokens += tokenTotal(successes[end].tokens)
    while (successes[start].at <= successes[end].at - windowMs) {
      requests--
      tokens -= tokenTotal(successes[start].tokens)
      start++
    }
    max.requests = Math.max(max.requests, requests)
    max.tokens = Math.max(max.tokens, tokens)
  }
  return max
}

function boundsOf(successes: Row[], perCut: Row[][][], index: number) {
  const before = perCut.map(cut => cut[index])
  return {
    lower: windowMaxima(successes, WINDOWS[index].ms),
    upper: {
      requests: Math.min(...before.map(rows => rows.length)),
      tokens: Math.min(...before.map(rows => usageOf(rows).tokens)),
    },
  }
}

function reasonOf(n: number, bounds: ReturnType<typeof boundsOf> | null) {
  if (n < 2) return "fewer than 2 cut-offs"
  if (bounds === null) return "no single window fits the cut-offs"
  if (bounds.lower.requests > bounds.upper.requests || bounds.lower.tokens > bounds.upper.tokens) return CONFLICT
  return null
}

function clearsAt(items: Row[], value: (row: Row) => number, limit: number, windowMs: number, now: number) {
  const total = items.reduce((sum, row) => sum + value(row), 0)
  if (total < limit) return now
  let removed = 0
  for (const row of items) {
    removed += value(row)
    if (removed > total - limit) return row.at + windowMs
  }
  return null
}

function rollingResetOf(items: Row[], windowMs: number, lower: Usage, now: number, n: number) {
  const requestsAt = clearsAt(items, () => 1, lower.requests, windowMs, now)
  const tokensAt = clearsAt(items, row => tokenTotal(row.tokens), lower.tokens, windowMs, now)
  if (requestsAt === null || tokensAt === null) return null
  return { at: iso(Math.max(requestsAt, tokensAt)), basis: "estimate", evidenceRows: items.length, n }
}

function balanceOf(balanceErrors: Row[], successes: Row[]) {
  const last = balanceErrors.at(-1)
  const exhausted = last !== undefined && !successes.some(row => row.at > last.at)
  return {
    state: exhausted ? "balance exhausted" : "balance ok, no fit",
    lastBalanceError: last ? iso(last.at) : null,
    action: exhausted ? "needs top-up" : null,
  }
}

function fitOf(poolId: string, free: boolean, members: string[], rows: Row[], now: number) {
  const successes: Row[] = []
  const cutOffs: Row[] = []
  const availability: Row[] = []
  const balanceErrors: Row[] = []
  let armed = false
  let open = false
  let lastReset: number | null = null
  for (const row of rows) {
    if (row.kind === "unavailable") {
      availability.push(row)
    } else if (row.kind === "balance") {
      balanceErrors.push(row)
    } else if (row.ok) {
      if (open) {
        open = false
        lastReset = row.at
      }
      successes.push(row)
      armed = true
    } else if (row.kind && CUT_KINDS.has(row.kind) && armed) {
      cutOffs.push(row)
      armed = false
      open = true
    }
  }
  const since = lastReset ?? successes[0]?.at ?? null
  const sinceRows = since === null ? [] : successes.filter(row => row.at >= since)
  const sinceUsage = usageOf(sinceRows)
  const sinceTotals = totalsOf(sinceRows)
  const n = cutOffs.length
  const perCut = cutOffs.map(cut => WINDOWS.map(w => windowBefore(successes, cut, w.ms)))
  const choice = n >= 2 ? chooseWindow(perCut) : { index: null, tied: [] as string[], spread: null as number | null }
  const best = choice.index
  const shown = windowStats(perCut, best ?? DISPLAY_WINDOW)
  const bounds = best === null ? null : boundsOf(successes, perCut, best)
  const reason = reasonOf(n, bounds)
  const estimate = reason === null && bounds !== null && best !== null
  const windowMs = best === null ? null : WINDOWS[best].ms
  const trailing = windowMs === null ? [] : successes.filter(row => row.at > now - windowMs)
  const latest = cutOffs.at(-1)
  const fixedReset = open && latest?.providerReset && latest.providerReset.at > now ? latest.providerReset : null
  const usedNow = estimate ? usageOf(fixedReset ? sinceRows : trailing) : null
  const evidenceRows = successes.length + n
  const limitEstimate = estimate && bounds ? { lower: bounds.lower, upper: bounds.upper, basis: "estimate", evidenceRows, n } : null
  const leftEstimate = limitEstimate && usedNow ? {
    requests: Math.max(0, limitEstimate.lower.requests - usedNow.requests),
    tokens: Math.max(0, limitEstimate.lower.tokens - usedNow.tokens),
    upper: {
      requests: Math.max(0, limitEstimate.upper.requests - usedNow.requests),
      tokens: Math.max(0, limitEstimate.upper.tokens - usedNow.tokens),
    },
    basis: "estimate",
    evidenceRows,
    n,
  } : null
  const spent = limitEstimate && usedNow ? open && (usedNow.requests >= limitEstimate.upper.requests || usedNow.tokens >= limitEstimate.upper.tokens) : null
  const blocked = leftEstimate !== null && (leftEstimate.requests === 0 || leftEstimate.tokens === 0)
  const nextReset = fixedReset
    ? { at: iso(fixedReset.at), basis: "provider", source: fixedReset.source }
    : limitEstimate && blocked && windowMs !== null
      ? rollingResetOf(trailing, windowMs, limitEstimate.lower, now, n)
      : null
  const burstRequests = successes.filter(row => row.at > now - BURST_MS).length
  return {
    poolId,
    free,
    members,
    split: null as string[] | null,
    estimate: estimate ? "estimated" : "no estimate",
    reason: estimate ? null : reason,
    evidence: { cutOffs: n, successes: successes.length },
    cutOffs: cutOffs.map(cut => ({ at: iso(cut.at), kind: cut.kind, source: cut.source, route: cut.route })),
    availability: availability.map(row => ({ at: iso(row.at), kind: row.kind, source: row.source, route: row.route })),
    balanceErrors: balanceErrors.map(row => ({ at: iso(row.at), source: row.source, route: row.route })),
    balance: free ? null : balanceOf(balanceErrors, successes),
    sinceLastReset: { ...sinceTotals, tokens: sinceUsage.tokens, since: since === null ? null : iso(since) },
    perRoute: members.map(route => {
      const list = sinceRows.filter(row => row.route === route)
      return { route, requests: list.length, tokens: usageOf(list).tokens }
    }),
    window: n === 0 ? null : {
      shape: best === null ? "no shape" : WINDOWS[best].shape,
      rangeRequests: [Math.min(...shown.requests), Math.max(...shown.requests)],
      rangeTokens: [Math.min(...shown.tokens), Math.max(...shown.tokens)],
      tied: choice.tied,
      spread: choice.spread,
      bounds,
      basis: estimate ? "estimate" : "observation",
      evidenceRows: shown.usedRows.size,
      n,
    },
    windowNow: usedNow,
    limitEstimate,
    confidence: n < 2 ? "none" : n < 4 ? "low" : "medium",
    n,
    leftEstimate,
    spent,
    burst: { requests: burstRequests, cap: estimate && bounds ? Math.max(1, Math.floor(bounds.lower.requests / 2)) : null },
    nextReset,
    providerReset: providerResetView(latest?.providerReset),
  }
}

type Fit = ReturnType<typeof fitOf>

function poolIdOf(provider: string, free: boolean) {
  if (!free) return "paid:" + provider
  if (provider === "opencode-go") return "opencode-go/free"
  if (provider === "opencode") return "opencode/free"
  return "free:" + provider
}

function buildPools(now: number, sources: Sources) {
  const channelDir = sources.channelDir ?? join(homedir(), ".local", "state", "questgiver", "channels")
  const openCodeDb = sources.openCodeDb ?? join(homedir(), ".local", "share", "opencode", "opencode.db")
  const channel = channelRows(channelDir)
  const rows = [...channel.rows, ...openCodeRows(openCodeDb)].filter(row => row.at <= now)
  const unplaced = rows.filter(row => !row.route || !row.provider).map(row => ({ ref: row.ref, source: row.source, reason: "no provider or model id" }))
  const groups = new Map<string, { free: boolean; routes: Set<string>; rows: Row[] }>()
  for (const row of rows) {
    if (!row.route || !row.provider) continue
    const free = isFree(row.route, channel.zero)
    const poolId = poolIdOf(row.provider, free)
    const group = groups.get(poolId) ?? { free, routes: new Set<string>(), rows: [] }
    group.routes.add(row.route)
    group.rows.push(row)
    groups.set(poolId, group)
  }
  const pools: Fit[] = []
  for (const [poolId, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const members = [...group.routes].sort()
    const sorted = group.rows.sort((a, b) => a.at - b.at)
    const whole = fitOf(poolId, group.free, members, sorted, now)
    if (group.free && whole.reason === CONFLICT) {
      const children = members.map(route => fitOf(`${poolId}:${route}`, true, [route], sorted.filter(row => row.route === route), now))
      pools.push({ ...whole, split: children.map(child => child.poolId) }, ...children)
    } else {
      pools.push(whole)
    }
  }
  return { pools, unplaced: { count: unplaced.length, rows: unplaced }, zero: channel.zero }
}

function rowsByRoute(pools: Fit[]) {
  const byRoute = new Map<string, Fit>()
  for (const pool of pools) {
    if (!pool.free || pool.split) continue
    for (const route of pool.members) byRoute.set(route, pool)
  }
  return byRoute
}

function budgetOf(row: Fit) {
  const capReached = row.burst.cap !== null && row.burst.requests >= row.burst.cap
  const fitSpent = row.confidence === "medium" && row.n >= 3 && row.spent === true
  return {
    poolId: row.poolId,
    leftRequests: row.leftEstimate?.requests ?? null,
    leftTokens: row.leftEstimate?.tokens ?? null,
    confidence: row.confidence,
    n: row.n,
    nextReset: row.nextReset,
    spent: fitSpent || capReached,
    burst: row.burst,
  }
}

export function freePools(now: number, sources: Sources = {}) {
  const { pools, unplaced } = buildPools(now, sources)
  return { pools, unplaced }
}

export function freeBudgets(now: number, sources: Sources = {}) {
  const { pools } = buildPools(now, sources)
  const budgets = new Map<string, ReturnType<typeof budgetOf>>()
  for (const [route, row] of rowsByRoute(pools)) budgets.set(route, budgetOf(row))
  return budgets
}

export function freePoolBudget(route: { providerID: string; modelID: string }, now: number, sources: Sources = {}) {
  const key = route.providerID + "/" + route.modelID
  const { pools, zero } = buildPools(now, sources)
  if (!isFree(key, zero)) return null
  const row = rowsByRoute(pools).get(key) ?? pools.find(item => item.poolId === poolIdOf(route.providerID, true))
  if (!row || row.estimate !== "estimated" || !row.leftEstimate) return null
  const spent = row.confidence === "medium" && row.n >= 3 && row.spent === true
  return { poolId: row.poolId, leftEstimate: row.leftEstimate, confidence: row.confidence, n: row.n, nextReset: row.nextReset, spent }
}
