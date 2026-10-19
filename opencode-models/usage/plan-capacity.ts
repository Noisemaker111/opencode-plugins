import type { Observation } from "./calibration"
import type { Tokens } from "./telemetry"

export type CapacityEvent = {
  at: number
  accountID: string
  harness: string
  provider: string
  model: string
  effort?: string
  sessionID?: string
  tokens: Tokens
  units: number | null
  assumedPrice?: boolean
  kindsUnknown?: boolean
}

export const TOKEN_KINDS = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const
export type TokenKind = typeof TOKEN_KINDS[number]
export type TokenKindCounts = Record<TokenKind, number>
const emptyKinds = (): TokenKindCounts => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 })

export type CapacityInterval = {
  from: number
  to: number
  deltaPoints: number
  units: number
  rawTokens: number
  events: number
  unitsByModel: Record<string, number>
  tokensByModel: Record<string, number>
  tokensByKind?: TokenKindCounts
  unpricedEvents: number
  assumedEvents: number
  state: "clean" | "unattributed" | "too-long" | "outside-coverage" | "unpriced-traffic"
}

export type IntervalPolicy = {
  minDeltaPoints: number
  maxIntervalMs: number
  coverage?: { from: number; to: number }
  resetToleranceMs?: number
}

export const DEFAULT_INTERVAL_POLICY: IntervalPolicy = { minDeltaPoints: 1, maxIntervalMs: 3 * 3600_000 }

export const RESET_TOLERANCE_MS = 300_000
const sameReset = (a: Observation, b: Observation, tolerance: number) =>
  a.resetAt == null || b.resetAt == null ? (a.resetAt ?? null) === (b.resetAt ?? null) : Math.abs(a.resetAt - b.resetAt) <= tolerance

export function segmentObservations(observations: Observation[], resetToleranceMs = RESET_TOLERANCE_MS): Observation[][] {
  const rows = [...observations].filter(o => Number.isFinite(o.at) && Number.isFinite(o.usedPoints)).sort((a, b) => a.at - b.at)
  const segments: Observation[][] = []
  let current: Observation[] = []
  for (const row of rows) {
    const previous = current.at(-1)
    if (previous && (!sameReset(previous, row, resetToleranceMs) || row.usedPoints < previous.usedPoints)) { segments.push(current); current = [] }
    current.push(row)
  }
  if (current.length) segments.push(current)
  return segments
}

export function capacityIntervals(observations: Observation[], events: CapacityEvent[], policy: IntervalPolicy = DEFAULT_INTERVAL_POLICY): CapacityInterval[] {
  if (!Number.isFinite(policy.minDeltaPoints) || policy.minDeltaPoints <= 0 || !Number.isFinite(policy.maxIntervalMs) || policy.maxIntervalMs <= 0) throw new Error("Invalid capacity interval policy")
  const ordered = [...events].sort((a, b) => a.at - b.at)
  const intervals: CapacityInterval[] = []
  for (const segment of segmentObservations(observations, policy.resetToleranceMs)) {
    let anchor = segment[0]
    for (const row of segment.slice(1)) {
      const deltaPoints = row.usedPoints - anchor.usedPoints
      if (deltaPoints < policy.minDeltaPoints) continue
      const inside = ordered.slice(lowerBound(ordered, anchor.at), lowerBound(ordered, row.at))
      const unitsByModel: Record<string, number> = {}, tokensByModel: Record<string, number> = {}
      let units = 0, rawTokens = 0, unpricedEvents = 0, assumedEvents = 0
      let tokensByKind: TokenKindCounts | undefined = emptyKinds()
      for (const e of inside) {
        const raw = totalTokens(e.tokens)
        rawTokens += raw
        if (e.kindsUnknown) tokensByKind = undefined
        if (tokensByKind) for (const kind of TOKEN_KINDS) tokensByKind[kind] += e.tokens[kind] ?? 0
        if (e.units === null) { unpricedEvents++; continue }
        if (e.assumedPrice) assumedEvents++
        units += e.units
        const key = e.provider + "/" + e.model
        unitsByModel[key] = (unitsByModel[key] ?? 0) + e.units
        tokensByModel[key] = (tokensByModel[key] ?? 0) + raw
      }
      const covered = !policy.coverage || (anchor.at >= policy.coverage.from && row.at <= policy.coverage.to)
      const state: CapacityInterval["state"] = !covered ? "outside-coverage" : row.at - anchor.at > policy.maxIntervalMs ? "too-long"
        : unpricedEvents > 0 ? "unpriced-traffic" : units > 0 ? "clean" : "unattributed"
      intervals.push({ from: anchor.at, to: row.at, deltaPoints, units, rawTokens, events: inside.length, unitsByModel, tokensByModel, tokensByKind, unpricedEvents, assumedEvents, state })
      anchor = row
    }
  }
  return intervals
}

function lowerBound(rows: CapacityEvent[], at: number): number {
  let low = 0, high = rows.length
  while (low < high) { const mid = (low + high) >> 1; if (rows[mid].at < at) low = mid + 1; else high = mid }
  return low
}

export const totalTokens = (t: Tokens) => (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0)

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN
  const at = (sorted.length - 1) * q, low = Math.floor(at), high = Math.ceil(at)
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (at - low)
}

export type CapacityEstimate = {
  unitsPerPoint: number | null
  trimmedUnitsPerPoint: number | null
  tokensPerPoint: number | null
  medianUnitsPerPoint: number | null
  q1: number | null
  q3: number | null
  cleanIntervals: number
  cleanPoints: number
  cleanUnits: number
  rejected: Record<string, number>
  unattributedPoints: number
  unpricedPoints: number
  assumedPoints: number
  attributedShare: number | null
}

export function estimateCapacity(intervals: CapacityInterval[]): CapacityEstimate {
  const clean = intervals.filter(i => i.state === "clean")
  const rejected: Record<string, number> = {}
  for (const i of intervals) if (i.state !== "clean") rejected[i.state] = (rejected[i.state] ?? 0) + 1
  const unattributedPoints = intervals.filter(i => i.state === "unattributed").reduce((n, i) => n + i.deltaPoints, 0)
  const unpricedPoints = intervals.filter(i => i.state === "unpriced-traffic").reduce((n, i) => n + i.deltaPoints, 0)
  const cleanPoints = clean.reduce((n, i) => n + i.deltaPoints, 0), cleanUnits = clean.reduce((n, i) => n + i.units, 0)
  const cleanTokens = clean.reduce((n, i) => n + i.rawTokens, 0)
  const assumedPoints = clean.filter(i => i.assumedEvents > 0).reduce((n, i) => n + i.deltaPoints, 0)
  const observedPoints = intervals.reduce((n, i) => n + i.deltaPoints, 0)
  const attributedShare = observedPoints > 0 ? cleanPoints / observedPoints : null
  if (!clean.length || cleanPoints <= 0) return { unitsPerPoint: null, trimmedUnitsPerPoint: null, tokensPerPoint: null, medianUnitsPerPoint: null, q1: null, q3: null, cleanIntervals: clean.length, cleanPoints, cleanUnits, rejected, unattributedPoints, unpricedPoints, assumedPoints, attributedShare }
  const ratios = clean.map(i => i.units / i.deltaPoints).sort((a, b) => a - b)
  const q1 = quantile(ratios, 0.25), q3 = quantile(ratios, 0.75), fence = 1.5 * (q3 - q1)
  const kept = clean.filter(i => { const r = i.units / i.deltaPoints; return r >= q1 - fence && r <= q3 + fence })
  const keptPoints = kept.reduce((n, i) => n + i.deltaPoints, 0)
  return {
    unitsPerPoint: cleanUnits / cleanPoints,
    trimmedUnitsPerPoint: keptPoints > 0 ? kept.reduce((n, i) => n + i.units, 0) / keptPoints : null,
    tokensPerPoint: cleanTokens / cleanPoints,
    medianUnitsPerPoint: quantile(ratios, 0.5), q1, q3,
    cleanIntervals: clean.length, cleanPoints, cleanUnits, rejected, unattributedPoints, unpricedPoints, assumedPoints, attributedShare,
  }
}

export type MappingConfidence = "solid" | "fair" | "thin" | "none"

export type KindMapping = {
  kind: TokenKind
  tokens: number
  shareOfTokens: number
  tokensPerPercentAtMix: number | null
  fittedTokensPerPercent: number | null
  weightVersusInput: number | null
  intervalsCarrying: number
  confidence: MappingConfidence
}

export type TokenAllowanceMapping = {
  intervals: number
  percent: number
  tokens: number
  tokensPerPercent: number | null
  medianTokensPerPercent: number | null
  q1: number | null
  q3: number | null
  confidence: MappingConfidence
  fit: "per-kind" | "too-few-intervals"
  byKind: KindMapping[]
  excluded: Record<string, number>
}

const MAPPING_STATES = new Set<CapacityInterval["state"]>(["clean", "unpriced-traffic"])

function confidenceOf(intervals: number, spread: number | null): MappingConfidence {
  if (intervals === 0) return "none"
  if (intervals >= 10 && spread !== null && spread <= 0.5) return "solid"
  if (intervals >= 4 && (spread === null || spread <= 1)) return "fair"
  return "thin"
}

export function tokenAllowanceMapping(intervals: CapacityInterval[]): TokenAllowanceMapping {
  const excluded: Record<string, number> = {}
  const usable = intervals.filter(i => {
    const reason = !MAPPING_STATES.has(i.state) ? i.state : !i.tokensByKind ? "kinds-not-recorded" : i.rawTokens <= 0 ? "no-logged-tokens" : null
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1
    return reason === null
  })
  const percent = usable.reduce((n, i) => n + i.deltaPoints, 0)
  const totals = emptyKinds()
  for (const i of usable) for (const kind of TOKEN_KINDS) totals[kind] += i.tokensByKind![kind]
  const tokens = TOKEN_KINDS.reduce((n, k) => n + totals[k], 0)
  const ratios = usable.map(i => i.rawTokens / i.deltaPoints).sort((a, b) => a - b)
  const median = ratios.length ? quantile(ratios, 0.5) : null
  const q1 = ratios.length ? quantile(ratios, 0.25) : null, q3 = ratios.length ? quantile(ratios, 0.75) : null
  const spread = median && q1 !== null && q3 !== null ? (q3 - q1) / median : null
  const tokensPerPercent = percent > 0 && tokens > 0 ? tokens / percent : null
  const present = TOKEN_KINDS.filter(k => totals[k] > 0)
  const canFit = present.length > 0 && usable.length >= present.length * 3
  const beta = canFit ? nonNegativeLeastSquares(usable.map(i => present.map(k => i.tokensByKind![k])), usable.map(i => i.deltaPoints)) : null
  const fitted = (kind: TokenKind) => { const j = present.indexOf(kind); return beta && j >= 0 && beta[j] > 0 ? 1 / beta[j] : null }
  const inputWeight = beta && present.includes("input") ? beta[present.indexOf("input")] : null
  const byKind = TOKEN_KINDS.map(kind => {
    const carrying = usable.filter(i => i.rawTokens > 0 && i.tokensByKind![kind] / i.rawTokens >= 0.1).length
    const share = tokens > 0 ? totals[kind] / tokens : 0
    const j = present.indexOf(kind)
    return { kind, tokens: totals[kind], shareOfTokens: share,
      tokensPerPercentAtMix: tokensPerPercent !== null && share > 0 ? tokensPerPercent * share : null,
      fittedTokensPerPercent: fitted(kind),
      weightVersusInput: beta && j >= 0 && inputWeight && inputWeight > 0 ? beta[j] / inputWeight : null,
      intervalsCarrying: carrying,
      confidence: totals[kind] > 0 ? confidenceOf(canFit ? carrying : Math.min(carrying, 3), spread) : "none" as MappingConfidence }
  })
  return { intervals: usable.length, percent, tokens, tokensPerPercent, medianTokensPerPercent: median, q1, q3,
    confidence: confidenceOf(usable.length, spread), fit: canFit ? "per-kind" : "too-few-intervals", byKind, excluded }
}

export type PriceRatioTest = {
  overallUnitsPerPoint: number | null
  byModel: { model: string; intervals: number; points: number; units: number; unitsPerPoint: number; tokensPerPoint: number; ratioToOverall: number }[]
  regression: { model: string; pointsPerUnit: number; impliedUnitsPerPoint: number }[] | null
  verdict: string
}

export function priceRatioTest(intervals: CapacityInterval[], options: { dominantShare?: number; minIntervals?: number } = {}): PriceRatioTest {
  const dominantShare = options.dominantShare ?? 0.8, minIntervals = options.minIntervals ?? 3
  const clean = intervals.filter(i => i.state === "clean")
  const overall = estimateCapacity(intervals).unitsPerPoint
  const buckets = new Map<string, CapacityInterval[]>()
  for (const i of clean) {
    const entries = Object.entries(i.unitsByModel)
    const top = entries.sort((a, b) => b[1] - a[1])[0]
    if (!top || top[1] / i.units < dominantShare) continue
    buckets.set(top[0], [...(buckets.get(top[0]) ?? []), i])
  }
  const byModel = [...buckets.entries()].filter(([, rows]) => rows.length >= minIntervals).map(([model, rows]) => {
    const points = rows.reduce((n, i) => n + i.deltaPoints, 0)
    const units = rows.reduce((n, i) => n + i.units, 0)
    const tokens = rows.reduce((n, i) => n + i.rawTokens, 0)
    return { model, intervals: rows.length, points, units, unitsPerPoint: units / points, tokensPerPoint: tokens / points, ratioToOverall: overall ? units / points / overall : NaN }
  }).sort((a, b) => b.points - a.points)
  const models = [...new Set(clean.flatMap(i => Object.keys(i.unitsByModel)))].filter(m => clean.reduce((n, i) => n + (i.unitsByModel[m] ?? 0), 0) > 0)
  const regression = models.length >= 2 && clean.length >= models.length * 3 ? nonNegativeLeastSquares(clean.map(i => models.map(m => i.unitsByModel[m] ?? 0)), clean.map(i => i.deltaPoints)).map((beta, k) => ({ model: models[k], pointsPerUnit: beta, impliedUnitsPerPoint: beta > 0 ? 1 / beta : Infinity })) : null
  const spread = byModel.length >= 2 ? Math.max(...byModel.map(b => b.ratioToOverall)) / Math.min(...byModel.map(b => b.ratioToOverall)) : null
  const verdict = byModel.length < 2 ? "Too few single-model intervals to test the price ratio on this window; API price remains an assumption."
    : spread! <= 1.5 ? "Consistent with metering in proportion to API price (dominant-model buckets within " + spread!.toFixed(2) + "x of each other)."
    : "Not proportional to API price: dominant-model buckets differ by " + spread!.toFixed(2) + "x. Prefer the measured per-model figure."
  return { overallUnitsPerPoint: overall, byModel, regression, verdict }
}

export function nonNegativeLeastSquares(x: number[][], y: number[], iterations = 400): number[] {
  const columns = x[0]?.length ?? 0
  if (!columns) return []
  const scale = Array.from({ length: columns }, (_, j) => Math.max(1e-9, ...x.map(row => row[j])))
  const a = x.map(row => row.map((v, j) => v / scale[j]))
  const seed = y.reduce((n, v) => n + v, 0) / Math.max(1e-9, a.reduce((n, row) => n + row.reduce((m, v) => m + v, 0), 0))
  let w = Array.from({ length: columns }, () => Math.max(1e-6, seed))
  for (let step = 0; step < iterations; step++) {
    const fit = a.map(row => row.reduce((n, v, j) => n + v * w[j], 0))
    w = w.map((value, j) => {
      const numerator = a.reduce((n, row, i) => n + row[j] * y[i], 0)
      const denominator = a.reduce((n, row, i) => n + row[j] * fit[i], 0)
      return denominator > 1e-12 ? value * (numerator / denominator) : value
    })
  }
  return w.map((value, j) => value / scale[j])
}

export type BurnRate = {
  windowMs: number
  pointsPerHour: number | null
  unitsPerHour: number | null
  observedPoints: number | null
  observedUnits: number
  hoursToExhaustion: number | null
  hoursToReset: number | null
  resetsBeforeExhausted: boolean | null
}

export function burnRate(observations: Observation[], events: CapacityEvent[], options: { now: number; windowMs: number; usedPoints: number | null; resetAt: number | null }): BurnRate {
  const { now, windowMs } = options
  const from = now - windowMs
  const recent = [...observations].filter(o => o.at >= from && o.at <= now).sort((a, b) => a.at - b.at)
  let observedPoints: number | null = null
  if (recent.length >= 2) {
    observedPoints = 0
    for (const segment of segmentObservations(recent)) if (segment.length >= 2) observedPoints += Math.max(0, segment.at(-1)!.usedPoints - segment[0].usedPoints)
  }
  const span = recent.length >= 2 ? recent.at(-1)!.at - recent[0].at : 0
  const observedUnits = events.filter(e => e.at >= from && e.at <= now).reduce((n, e) => n + (e.units ?? 0), 0)
  const pointsPerHour = observedPoints !== null && span > 0 ? observedPoints / (span / 3600_000) : null
  const unitsPerHour = observedUnits / (windowMs / 3600_000)
  const hoursToExhaustion = pointsPerHour !== null && pointsPerHour > 0 && options.usedPoints !== null ? (100 - options.usedPoints) / pointsPerHour : null
  const hoursToReset = options.resetAt !== null && options.resetAt > now ? (options.resetAt - now) / 3600_000 : null
  return { windowMs, pointsPerHour, unitsPerHour, observedPoints, observedUnits, hoursToExhaustion, hoursToReset, resetsBeforeExhausted: hoursToExhaustion !== null && hoursToReset !== null ? hoursToReset < hoursToExhaustion : null }
}

export function valueTokensAt(tokens: Tokens, perMillion: Partial<Record<keyof Tokens, number>>): number | null {
  let value = 0
  for (const key of ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as (keyof Tokens)[]) {
    const count = tokens[key] ?? 0
    if (!count) continue
    const rate = perMillion[key] ?? (key === "reasoning" ? perMillion.output : undefined)
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return null
    value += count * rate / 1e6
  }
  return value
}

export function tasksRemaining(remainingPoints: number, unitsPerPoint: number, unitsPerTask: number): number | null {
  if (!(unitsPerTask > 0) || !(unitsPerPoint > 0) || !(remainingPoints >= 0)) return null
  return remainingPoints * unitsPerPoint / unitsPerTask
}
