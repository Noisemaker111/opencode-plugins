import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { canonicalModelID, slugModel } from './model-catalog'
import { timed } from '../scripts/plugin-spans'
import { TELEMETRY_BUDGET } from '../scripts/telemetry-budget.mjs'
import type { Route, RouteBenchmark } from './route-vocabulary'
import type { RouteSpeed } from '../usage/route-speeds'

export type AnalysisModel = { id: string; name: string; slug: string; release_date?: string | null; model_creator?: { id: number; name: string } | null; evaluations: Record<string, number | null>; pricing: Record<string, number | null>; performance: Record<string, number | null>; artificial_analysis_intelligence_index_cost?: Record<string, unknown> | null }
export type AnalysisCache = { version: 1; fetchedAt: string | null; nextRefreshAt: number; tier: string | null; indexVersion: number | null; models: AnalysisModel[]; error: string | null }
export const analysisFile = () => join(homedir(), '.local', 'state', 'questgiver', 'artificial-analysis.json')
export const analysisHistoryFile = (file = analysisFile()) => file.replace(/\.json$/, '') + '.history.jsonl'
const credentialFile = () => join(dirname(analysisFile()), 'artificial-analysis.dpapi')
const empty = (): AnalysisCache => ({ version: 1, fetchedAt: null, nextRefreshAt: 0, tier: null, indexVersion: null, models: [], error: null })
const pending = new Map<string, Promise<AnalysisCache>>()
const enforceAnalysisBudget = (text: string, budget: number) => {
  if (Buffer.byteLength(text) > budget) throw new Error('Artificial Analysis data exceeds its size budget')
  return text
}
const protectedKey = (input: string, decrypt: boolean) => execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', decrypt
  ? '$s = [Console]::ReadLine() | ConvertTo-SecureString; [System.Net.NetworkCredential]::new("", $s).Password'
  : '[Console]::ReadLine() | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString'], { input: input + '\n', encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['pipe', 'pipe', 'ignore'] }).trim()

export function connectAnalysis(key: string) {
  if (process.platform !== 'win32') throw new Error('Set ARTIFICIAL_ANALYSIS_API_KEY on this host')
  if (!/^aa_[A-Za-z0-9]+$/.test(key)) throw new Error('Invalid Artificial Analysis key format')
  const encoded = protectedKey(key, false)
  enforceAnalysisBudget(encoded, TELEMETRY_BUDGET.analysisCredentialBytes)
  mkdirSync(dirname(credentialFile()), { recursive: true })
  writeFileSync(credentialFile(), encoded, { mode: 0o600 })
}

export function readAnalysis(file = analysisFile()): AnalysisCache {
  if (!existsSync(file)) return empty()
  if (statSync(file).size > TELEMETRY_BUDGET.analysisBytes) throw new Error('Artificial Analysis cache exceeds its size budget')
  const value = JSON.parse(readFileSync(file, 'utf8')) as AnalysisCache
  if (value.version !== 1 || !Array.isArray(value.models) || !Number.isFinite(value.nextRefreshAt)) throw new Error('Invalid Artificial Analysis cache')
  return value
}

export function analysisFor(cache: AnalysisCache, modelID: string, effort: string) {
  const slug = slugModel(canonicalModelID(modelID)).replace(/-(contributor-)?free$/, '')
  const candidates = cache.models.filter(model => {
    const variant = model.name.match(/\((none|non-reasoning|minimal|low|medium|high|xhigh|max|reasoning)\b/i)?.[1]?.toLowerCase()
    const identity = slugModel(model.name.split(' (')[0])
    const same = slugModel(model.slug) === slug || identity === slug
    if (variant) return same && (variant === effort.toLowerCase() || variant === 'non-reasoning' && effort === 'none') || slugModel(model.slug) === slug + '-' + slugModel(effort)
    return same
  })
  return candidates.length === 1 ? candidates[0] : null
}

export const AA_INDEX_KEYS: Record<string, string> = {
  intelligence: 'artificial_analysis_intelligence_index',
  coding: 'artificial_analysis_coding_index',
  agentic: 'artificial_analysis_agentic_index',
  finance: 'artificial_analysis_finance_and_accounting_index',
  strategy: 'artificial_analysis_strategy_and_ops_index',
  legal: 'artificial_analysis_legal_index',
  healthcare: 'artificial_analysis_healthcare_and_medical_index',
  engineering: 'artificial_analysis_engineering_index',
  economics: 'artificial_analysis_economics_index',
}
export const AA_INDEX_LABELS: Record<string, string> = { intelligence: 'intelligence index', coding: 'coding index', agentic: 'agentic index', finance: 'finance and accounting index', strategy: 'strategy and ops index', legal: 'legal index', healthcare: 'healthcare and medical index', engineering: 'engineering index', economics: 'economics index' }
export type AAScore = { category: string; label: string; value: number; fellBack: boolean }
const finiteValue = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
export function aaScoreOf(row: AnalysisModel, category?: string): AAScore | null {
  const wanted = category && AA_INDEX_KEYS[category] ? category : 'intelligence'
  const own = finiteValue(row.evaluations?.[AA_INDEX_KEYS[wanted]])
  if (own !== null) return { category: wanted, label: AA_INDEX_LABELS[wanted], value: own, fellBack: false }
  const general = finiteValue(row.evaluations?.[AA_INDEX_KEYS.intelligence])
  return general === null ? null : { category: 'intelligence', label: AA_INDEX_LABELS.intelligence, value: general, fellBack: wanted !== 'intelligence' }
}

export async function analysisData(input: { file?: string; now?: number; key?: string; fetch?: typeof fetch; force?: boolean } = {}): Promise<AnalysisCache> {
  const file = input.file ?? analysisFile(), now = input.now ?? Date.now(), saved = readAnalysis(file)
  if (!input.force && saved.nextRefreshAt > now) return saved
  if (pending.has(file)) return pending.get(file)!
  const refresh = timed({ plugin: 'routing', name: 'artificial-analysis', op: 'refresh' }, async () => {
    let result = saved
    try {
      const key = input.key ?? process.env.ARTIFICIAL_ANALYSIS_API_KEY ?? (process.platform === 'win32' && existsSync(credentialFile()) ? protectedKey(enforceAnalysisBudget(readFileSync(credentialFile(), 'utf8'), TELEMETRY_BUDGET.analysisCredentialBytes), true) : '')
      if (!key) return saved
      const models: AnalysisModel[] = []
      let tier: string | null = null, indexVersion: number | null = null
      for (let page = 1; page <= 20; page++) {
        const response = await (input.fetch ?? fetch)('https://artificialanalysis.ai/api/v2/language/models/free?page=' + page, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(15_000) })
        if (!response.ok) {
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
          result = { ...saved, nextRefreshAt: response.status === 429 && reset > now ? reset : now + 3_600_000, error: 'Artificial Analysis HTTP ' + response.status }
          break
        }
        const body = await response.json() as { tier: string; intelligence_index_version: number; pagination: { total_pages: number; has_more: boolean }; data: AnalysisModel[] }
        if (!Array.isArray(body.data) || !Number.isInteger(body.pagination?.total_pages) || body.pagination.total_pages > 20) throw new Error('Invalid Artificial Analysis response')
        tier = body.tier; indexVersion = body.intelligence_index_version
        models.push(...body.data.map(({ id, name, slug, release_date, model_creator, evaluations, pricing, performance, artificial_analysis_intelligence_index_cost }) => ({ id, name, slug, release_date: release_date ?? null, model_creator: model_creator ? { id: model_creator.id, name: model_creator.name } : null, evaluations, pricing, performance, artificial_analysis_intelligence_index_cost: artificial_analysis_intelligence_index_cost ?? null })))
        if (!body.pagination.has_more) { result = { version: 1, fetchedAt: new Date(now).toISOString(), nextRefreshAt: now + TELEMETRY_BUDGET.analysisRefreshDays * 86_400_000, tier, indexVersion, models, error: null }; break }
        if (page === 20) throw new Error('Artificial Analysis pagination exceeds its budget')
      }
    } catch { result = { ...saved, nextRefreshAt: now + 3_600_000, error: 'Artificial Analysis refresh failed; saved data retained' } }
    const text = enforceAnalysisBudget(JSON.stringify(result), TELEMETRY_BUDGET.analysisBytes)
    mkdirSync(dirname(file), { recursive: true })
    const temporary = file + '.' + process.pid + '.tmp'
    writeFileSync(temporary, text, { mode: 0o600 }); renameSync(temporary, file)
    appendAnalysisHistory(analysisHistoryFile(file), saved, result, now)
    return result
  })
  pending.set(file, refresh)
  try { return await refresh } finally { pending.delete(file) }
}

export function refreshAnalysisInBackground(input: Parameters<typeof analysisData>[0] = {}) {
  analysisData(input).catch(() => undefined)
}

export type AnalysisChange = { id: string; name: string; field: string; from: number | string | null; to: number | string | null }
export type AnalysisHistoryLine = { at: string; ok: boolean; error: string | null; fetchedAt: string | null; tier: string | null; indexVersion: number | null; models: number; baseline: boolean; added: string[]; removed: string[]; changes: AnalysisChange[]; changesTruncated?: number }
const HISTORY_CHANGES_PER_FETCH = 2000
const flatValues = (row: AnalysisModel): Record<string, number | string | null> => ({
  release_date: row.release_date ?? null,
  ...Object.fromEntries(Object.entries(row.evaluations ?? {}).map(([k, v]) => ['evaluations.' + k, v])),
  ...Object.fromEntries(Object.entries(row.pricing ?? {}).map(([k, v]) => ['pricing.' + k, v])),
  ...Object.fromEntries(Object.entries(row.performance ?? {}).map(([k, v]) => ['performance.' + k, v])),
})

export function appendAnalysisHistory(file: string, before: AnalysisCache, after: AnalysisCache, at: number) {
  const ok = after.error === null && after.fetchedAt !== null && after.fetchedAt !== before.fetchedAt
  const baseline = before.models.length === 0
  const previous = new Map(before.models.map(model => [model.id, model]))
  const next = new Map(after.models.map(model => [model.id, model]))
  const changes: AnalysisChange[] = []
  if (ok && !baseline) for (const [id, model] of next) {
    const old = previous.get(id)
    if (!old) continue
    const a = flatValues(old), b = flatValues(model)
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[field] !== b[field]) changes.push({ id, name: model.name, field, from: a[field] ?? null, to: b[field] ?? null })
  }
  const line: AnalysisHistoryLine = { at: new Date(at).toISOString(), ok, error: after.error, fetchedAt: after.fetchedAt, tier: after.tier, indexVersion: after.indexVersion, models: after.models.length, baseline: ok && baseline,
    added: ok && !baseline ? [...next.keys()].filter(id => !previous.has(id)) : [], removed: ok && !baseline ? [...previous.keys()].filter(id => !next.has(id)) : [], changes: changes.slice(0, HISTORY_CHANGES_PER_FETCH) }
  if (changes.length > HISTORY_CHANGES_PER_FETCH) line.changesTruncated = changes.length - HISTORY_CHANGES_PER_FETCH
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 })
  if (statSync(file).size > TELEMETRY_BUDGET.analysisHistoryBytes) {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const kept = lines.slice(Math.floor(lines.length * (1 - TELEMETRY_BUDGET.keepRatio)))
    const temporary = file + '.' + process.pid + '.tmp'
    writeFileSync(temporary, kept.join('\n') + '\n', { mode: 0o600 }); renameSync(temporary, file)
  }
}

export function readAnalysisHistory(file = analysisHistoryFile()): AnalysisHistoryLine[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as AnalysisHistoryLine)
}

export type AAFacts = { name: string; intelligence: number | null; score: AAScore | null; outputTokensPerSecond: number | null; firstTokenSeconds: number | null; inputPrice: number | null; outputPrice: number | null; fetchedAt: string }
export const AA_SUITE = "Artificial Analysis intelligence index"
export const AA_MAX_AGE_DAYS = 7
export const priorWord = (benchmark: RouteBenchmark) => benchmark.inheritedFrom === "Artificial Analysis" ? "estimated" : "published"
export const AA_PASS_FIT = { intercept: 0.1489, slope: 0.0119 }
export const aaPassPrior = (intelligence: number) => Math.min(0.99, Math.max(0.01, AA_PASS_FIT.intercept + AA_PASS_FIT.slope * intelligence))
const finiteOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null

export function readAnalysisSafely(file = analysisFile()): AnalysisCache {
  try { return readAnalysis(file) } catch { return empty() }
}

export function aaFactsFor(cache: AnalysisCache, modelID: string, effort: string, now: number, maxAgeDays = AA_MAX_AGE_DAYS, category?: string): AAFacts | null {
  const age = now - Date.parse(cache.fetchedAt ?? "")
  if (!Number.isFinite(age) || age < 0 || age > maxAgeDays * 86_400_000) return null
  const row = analysisFor(cache, modelID, effort)
  if (!row) return null
  return { name: row.name, intelligence: finiteOrNull(row.evaluations?.artificial_analysis_intelligence_index), score: aaScoreOf(row, category), outputTokensPerSecond: finiteOrNull(row.performance?.median_output_tokens_per_second),
    firstTokenSeconds: finiteOrNull(row.performance?.median_time_to_first_token_seconds), inputPrice: finiteOrNull(row.pricing?.price_1m_input_tokens), outputPrice: finiteOrNull(row.pricing?.price_1m_output_tokens), fetchedAt: cache.fetchedAt as string }
}

export function withAnalysis(routes: Route[], cache: AnalysisCache, billing: Record<string, string>, now: number, workload?: { input: number; output: number }, category?: string): Route[] {
  return routes.map(route => {
    const facts = aaFactsFor(cache, route.modelID, route.reasoning, now, AA_MAX_AGE_DAYS, category)
    if (!facts) return route
    const free = billing[route.accountID] === "free"
    const score = facts.score
    const estimated = score !== null && (!route.benchmark || free)
    const benchmark: RouteBenchmark | undefined = estimated
      ? { suite: score.category === "intelligence" ? AA_SUITE : "Artificial Analysis " + score.label, passAt1: aaPassPrior(score.value), effort: route.reasoning, provenance: "independent", source: "artificialanalysis.ai", measuredAt: facts.fetchedAt, intelligence: score.value, inheritedFrom: "Artificial Analysis",
        attribution: "estimated from the Artificial Analysis " + score.label + " " + score.value + " for " + facts.name + (score.fellBack ? " (no " + AA_INDEX_LABELS[category ?? ""] + " for this model, so the intelligence index)" : "") + " (a fitted estimate, not a published score)" }
      : route.benchmark && facts.intelligence !== null ? { ...route.benchmark, intelligence: facts.intelligence } : route.benchmark
    const speed: RouteSpeed | undefined = !route.speed?.tokensPerSecond && facts.outputTokensPerSecond !== null
      ? { tokensPerSecond: facts.outputTokensPerSecond, rate: null, firstTokenMilliseconds: facts.firstTokenSeconds === null ? null : facts.firstTokenSeconds * 1000, secondsPerCall: null, timedRequests: 0, waitSamples: 0, basis: "published", measuredAt: facts.fetchedAt }
      : undefined
    const economics = !route.economics && !free && workload && facts.inputPrice !== null && facts.outputPrice !== null
      ? { amount: (workload.input * facts.inputPrice + workload.output * facts.outputPrice) / 1_000_000, currency: "USD", basis: "artificial-analysis" as const, source: "Artificial Analysis list price for " + facts.name, observedAt: facts.fetchedAt, workload: "comparison workload" }
      : undefined
    return { ...route, analysis: facts, ...(benchmark ? { benchmark } : {}), ...(speed ? { speed } : {}), ...(economics ? { economics } : {}) }
  })
}
