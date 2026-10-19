export type Availability = 'up' | 'cooling' | 'probing' | 'out'
export type Health = { state: Availability; until: number | null }
export type Allowance =
  | { known: true; unit: 'percent' | 'usd'; left: number; confidence: 'measured' | 'published' | 'prior'; evidence: number }
  | { known: true; unit: 'unlimited'; left: null; confidence: 'published'; evidence: number }
  | { known: false; reason: string }
export type Plan =
  | { kind: 'payg' }
  | { kind: 'free' }
  | { kind: 'capped'; priceUSD: number; capUSD: Record<string, number | null>; reconciled: boolean }
export type RouteInput = { route: string; provider: string; model: string; plan: string | null }
export type Speed = { stepMs: number[]; firstTokenMs: number[]; tokensPerSecond: number[]; listUSDPerStep: number[]; outcomes: { ok: number; total: number } }
export type Stat = { p50: number | null; p90: number | null; n: number }
export type Row = {
  route: string
  provider: string
  model: string
  availability: { state: Availability | 'unknown'; until: number | null }
  allowance: Allowance
  iq: number | null
  step: Stat
  firstToken: Stat
  tokensPerSecond: Stat
  costPerStep: { usd: number | null; reason: string | null }
  success: { rate: number | null; n: number }
}
export type PickLabel = 'quickest' | 'best cost/performance' | 'unlimited and good and fast' | 'best quality' | 'cheapest that clears the bar'
export type Pick = { label: PickLabel; route: string | null; reason: string }
export type Leaderboard = { rows: Row[]; picks: Pick[] }
export type SortKey = 'iq' | 'usage' | 'time'

export const MIN_PICK_STEPS = 5
export const BAR_SHARE_OF_BEST = 0.9
export const NEARLY_OUT_PERCENT = 10

export function quantile(values: number[], q: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const at = (sorted.length - 1) * q
  const low = Math.floor(at)
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low)
}

const stat = (values: number[]): Stat => ({ p50: quantile(values, 0.5), p90: quantile(values, 0.9), n: values.filter(Number.isFinite).length })

function costPerStep(route: RouteInput, plans: Record<string, Plan>, listUSD: number[]): Row['costPerStep'] {
  const plan = route.plan ? plans[route.plan] : undefined
  if (!plan) return { usd: null, reason: 'no plan record' }
  if (plan.kind === 'free') return { usd: 0, reason: null }
  const list = quantile(listUSD, 0.5)
  if (list === null) return { usd: null, reason: 'no priced steps' }
  if (plan.kind === 'payg') return { usd: list, reason: null }
  if (!plan.reconciled) return { usd: null, reason: 'plan unreconciled' }
  const cap = plan.capUSD[route.model]
  if (!cap) return { usd: null, reason: 'no dollar cap for this model' }
  return { usd: list * plan.priceUSD / cap, reason: null }
}

function row(route: RouteInput, allowance: Allowance, plans: Record<string, Plan>, health: Health | undefined, aa: Record<string, number | null>, speed: Speed): Row {
  return {
    route: route.route,
    provider: route.provider,
    model: route.model,
    availability: health ? { state: health.state, until: health.until } : { state: 'unknown', until: null },
    allowance,
    iq: aa[route.model] ?? null,
    step: stat(speed.stepMs),
    firstToken: stat(speed.firstTokenMs),
    tokensPerSecond: stat(speed.tokensPerSecond),
    costPerStep: costPerStep(route, plans, speed.listUSDPerStep),
    success: { rate: speed.outcomes.total ? speed.outcomes.ok / speed.outcomes.total : null, n: speed.outcomes.total },
  }
}

const nearlyOut = (allowance: Allowance) => allowance.known && (allowance.unit === 'percent' ? allowance.left < NEARLY_OUT_PERCENT : allowance.unit === 'usd' && allowance.left <= 0)
const eligible = (row: Row) => row.availability.state === 'up' && !nearlyOut(row.allowance)
const bestBy = <T>(values: T[], score: (value: T) => number | null, better: (a: number, b: number) => boolean) => {
  let best: T | undefined
  let bestScore: number | null = null
  for (const value of values) {
    const s = score(value)
    if (s === null) continue
    if (bestScore === null || better(s, bestScore)) { best = value; bestScore = s }
  }
  return best
}
const lower = (a: number, b: number) => a < b
const higher = (a: number, b: number) => a > b

export const fmtMs = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
export const fmtUSD = (usd: number) => usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`

function none(label: PickLabel, reason: string): Pick {
  return { label, route: null, reason }
}

function picks(rows: Row[]): Pick[] {
  const pool = rows.filter(eligible)
  const best = bestBy(pool, row => row.iq, higher)
  const bar = best && best.iq !== null ? BAR_SHARE_OF_BEST * best.iq : null
  const barText = bar === null ? '' : `the bar is ${Math.round(bar * 10) / 10} (${BAR_SHARE_OF_BEST * 100}% of the best eligible IQ, ${best?.iq})`
  const clears = (row: Row) => bar !== null && row.iq !== null && row.iq >= bar

  const quick = pool.filter(row => row.step.n >= MIN_PICK_STEPS && row.step.p50 !== null)
  const fastest = bestBy(quick, row => row.step.p50, lower)
  const quickPick: Pick = fastest
    ? { label: 'quickest', route: fastest.route, reason: `median step ${fmtMs(fastest.step.p50!)} over ${fastest.step.n} steps, the fastest of ${quick.length} eligible routes with enough steps` }
    : none('quickest', `no eligible route has ${MIN_PICK_STEPS} timed steps yet`)

  const value = pool.filter(row => row.iq !== null && row.costPerStep.usd !== null && row.step.n >= MIN_PICK_STEPS)
  const efficient = bestBy(value, row => row.costPerStep.usd === 0 ? Infinity : row.iq! / row.costPerStep.usd!, higher)
  const valuePick: Pick = efficient
    ? { label: 'best cost/performance', route: efficient.route, reason: efficient.costPerStep.usd === 0 ? `no spend per step (free route), IQ ${efficient.iq}` : `IQ ${efficient.iq} for ${fmtUSD(efficient.costPerStep.usd!)} a step, the most IQ per plan-effective dollar of ${value.length} routes` }
    : none('best cost/performance', 'no eligible route has an IQ index and a priced step yet')

  const unlimited = pool.filter(row => row.allowance.known && row.allowance.unit === 'unlimited' && clears(row) && row.step.p50 !== null)
  const unlimitedPick = bestBy(unlimited, row => row.step.p50, lower)
  const unlimitedOut: Pick = unlimitedPick
    ? { label: 'unlimited and good and fast', route: unlimitedPick.route, reason: `published unlimited allowance, IQ ${unlimitedPick.iq}, median step ${fmtMs(unlimitedPick.step.p50!)}` }
    : none('unlimited and good and fast', 'no eligible route has a published unlimited allowance and an IQ at the bar')

  const top = bestBy(pool, row => row.iq, higher)
  const qualityPick: Pick = top
    ? { label: 'best quality', route: top.route, reason: `IQ ${top.iq}, the highest of ${pool.filter(row => row.iq !== null).length} eligible routes with an index` }
    : none('best quality', 'no eligible route has an IQ index')

  const cheap = pool.filter(row => clears(row) && row.costPerStep.usd !== null)
  const cheapest = bestBy(cheap, row => row.costPerStep.usd, lower)
  const cheapPick: Pick = cheapest
    ? { label: 'cheapest that clears the bar', route: cheapest.route, reason: `IQ ${cheapest.iq}, ${fmtUSD(cheapest.costPerStep.usd!)} a step; ${barText}` }
    : none('cheapest that clears the bar', bar === null ? 'no eligible route has an IQ index' : `no eligible route clears the bar with a priced step; ${barText}`)

  return [quickPick, valuePick, unlimitedOut, qualityPick, cheapPick]
}

export function leaderboard(
  routes: RouteInput[],
  usage: Record<string, Allowance>,
  plans: Record<string, Plan>,
  health: Record<string, Health>,
  aa: Record<string, number | null>,
  speedStats: Record<string, Speed>,
): Leaderboard {
  const empty: Speed = { stepMs: [], firstTokenMs: [], tokensPerSecond: [], listUSDPerStep: [], outcomes: { ok: 0, total: 0 } }
  const rows = routes.map(route => row(route, usage[route.route] ?? { known: false, reason: 'no usage record' }, plans, health[route.route], aa, speedStats[route.route] ?? empty))
  return { rows, picks: picks(rows) }
}

const usedShare = (allowance: Allowance) => allowance.known && allowance.unit === 'percent' ? 100 - allowance.left : null

export function sortRows(rows: Row[], by: SortKey): Row[] {
  const key = (row: Row): number | null => by === 'iq' ? row.iq : by === 'usage' ? usedShare(row.allowance) : row.step.p50
  const descending = by === 'iq' || by === 'usage'
  return [...rows].sort((a, b) => {
    const x = key(a), y = key(b)
    if (x === null || y === null) return x === null && y === null ? 0 : x === null ? 1 : -1
    return descending ? y - x : x - y
  })
}
