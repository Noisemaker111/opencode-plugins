import { dispatchPlanInput } from '../../models/dispatch-planner'
import { getAccountUsage } from '../../usage-service/on-computer'
import { workflowOutcomesFile, type WorkflowRun, type WorkflowStore } from '../../usage/workflow-outcomes'
import { readPooledOutcomes } from '../../usage/pooled-evidence'
import { EVERY_KIND, runDelivered, runKind, UNCLASSIFIED_WORK, withFinishedRuns, withLearnedOutcomes, withRunTimes } from '../../models/route-outcomes'
import { ASSUMED_DEPTH, ratingOf, type RoutingSettings } from '../../models/routing-settings'
import { readPublishedSpeed, speedRowsFor } from '../../models/published-speed'
import { finishEstimates, speedSuccess } from '../../models/time-to-finish'
import { pooledCalibrations, speedKey } from '../../usage/route-speeds'
import { taggedDepth } from '../../models/work-profile'
import type { Route } from '../../models/route-vocabulary'
import { routeLimitKey, routeLimitRows, type RouteLimitRow } from '../../usage/route-limits'
import { ROUTE_HEALTH_WINDOW_MS, recentRequests, routeOutages } from '../../models/observed-route-health'
import { TELEMETRY_FILE } from '../../usage/telemetry-store'
import { aaScoreOf, analysisFor, readAnalysis, refreshAnalysisInBackground, type AnalysisCache } from '../../models/artificial-analysis'
import { benchmarkOfWorkType } from '../../models/routing-settings'

const median = (values: number[]) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null }
const outputTokens = (run: WorkflowRun) => { const t = run.observation?.tokens; return t && (t.output !== null || t.reasoning !== null) ? (t.output ?? 0) + (t.reasoning ?? 0) : NaN }
const sameRoute = (run: WorkflowRun, route: Route) => run.route.accountID === route.accountID && run.route.providerID === route.providerID && run.route.modelID === route.modelID && run.route.reasoning === route.reasoning

export function measuredFor(runs: WorkflowRun[]) {
  const settled = runs.filter(run => runDelivered(run) !== null)
  if (!settled.length) return null
  const summary = (items: WorkflowRun[]) => ({
    trials: items.length,
    replays: items.filter(run => run.replayOf).length,
    delivered: items.filter(run => runDelivered(run)).length,
    reworked: items.filter(run => run.judgment?.firstPass === false).length,
    medianMilliseconds: median(items.flatMap(run => run.observation?.state === 'completed' && run.observation.completedAt ? [run.observation.completedAt - run.startedAt] : [])),
    medianOutputTokens: median(items.map(outputTokens)),
    medianRequests: median(items.flatMap(run => run.observation?.state === 'completed' && run.observation.requests ? [run.observation.requests] : [])),
  })
  const depths = [...new Set(settled.map(run => taggedDepth(run.taskTags) ?? 'unstated'))]
  return { ...summary(settled), byDepth: Object.fromEntries(depths.map(depth => [depth, summary(settled.filter(run => (taggedDepth(run.taskTags) ?? 'unstated') === depth))])) }
}

export async function routingMap(input: { policyFile: string; settings: RoutingSettings; now?: number; outcomesFile?: string; usage?: typeof getAccountUsage }) {
  const now = input.now ?? Date.now()
  const plan = await dispatchPlanInput({ policyFile: input.policyFile, task: 'coding', now }, input.usage ?? (options => getAccountUsage({ ...options, refresh: false })))
  let store: WorkflowStore = { version: 1, runs: [] }, diagnostics = [...plan.diagnostics]
  let analysis: AnalysisCache | null = null
  try { analysis = readAnalysis(); refreshAnalysisInBackground({ now }) } catch { diagnostics.push('Artificial Analysis cache could not be read') }
  try { store = readPooledOutcomes(input.outcomesFile ?? workflowOutcomesFile(), ...(input.outcomesFile ? [[]] : [])).store } catch (error) { diagnostics.push('Quest outcomes unreadable: ' + (error instanceof Error ? error.message : String(error))) }
  const types = [...input.settings.workTypes.map(type => type.id), UNCLASSIFIED_WORK]
  const billing = (accountID: string) => plan.accounts.find(account => account.id === accountID)?.billing ?? null
  const served = plan.routes
  const minTrials = plan.request.minTrials, maxAgeDays = plan.request.maxEvidenceAgeDays
    let published: ReturnType<typeof readPublishedSpeed> = { version: 1, rows: [] }
  try { published = readPublishedSpeed() } catch (error) { diagnostics.push(String(error instanceof Error ? error.message : error)) }
  const saved = pooledCalibrations()
  let limits = new Map<string, RouteLimitRow>(), requests: ReturnType<typeof recentRequests> = [], outages: ReturnType<typeof routeOutages> = { routes: [], providers: [] }
  try { requests = recentRequests(TELEMETRY_FILE, { sinceMs: now - ROUTE_HEALTH_WINDOW_MS }); outages = routeOutages(requests, now); limits = new Map(routeLimitRows(requests, now).map(row => [row.route, row])) } catch (error) { diagnostics.push('Route rate limits unreadable: ' + (error instanceof Error ? error.message : String(error))) }
  const perType = new Map(types.map(type => {
    const depth = plan.classification.depth ?? ASSUMED_DEPTH
    const base = withRunTimes(withFinishedRuns(served.map(({ finished: _finished, learned: _learned, learnedOther: _other, runTimes: _times, ...route }) => route), store, type, now, maxAgeDays), store, type, now, maxAgeDays)
    const routes = withLearnedOutcomes(withLearnedOutcomes(base, store, EVERY_KIND, now, maxAgeDays, undefined, 'learnedOther', depth, type), store, type, now, maxAgeDays, undefined, 'learned', depth)
    const finish = finishEstimates(routes, minTrials)
    return [type, { routes, finish }] as const
  }))
  const routes = served.map(route => {
    const b = route.benchmark, key = speedKey(route), calibration = saved[key]
    const account = plan.accounts.find(account => account.id === route.accountID)
    const mine = store.runs.filter(run => sameRoute(run, route))
    const aaRow = analysis ? analysisFor(analysis, route.modelID, route.reasoning) : null
    return {
      routeID: route.id, model: route.providerID + '/' + route.modelID, effort: route.reasoning, accountID: route.accountID, billing: billing(route.accountID),
      analysis: aaRow,
      available: route.verified && account?.authenticated === true && account.capacity !== 'exhausted', unavailableReason: route.outcomeIssue?.reason ?? (account?.capacity === 'exhausted' ? 'Account allowance exhausted' : account?.authenticated !== true ? 'Account is not authenticated' : null),
      published: b ? { category: 'coding', passAt1: b.passAt1, provenance: b.provenance, source: b.source, measuredAt: b.measuredAt, inheritedFrom: b.inheritedFrom ?? null } : null,
      speed: {
        tokensPerSecond: route.speed?.tokensPerSecond ? { value: route.speed.tokensPerSecond, basis: route.speed.basis, samples: route.speed.timedRequests, ...(route.speed.rate ? { rate: route.speed.rate } : {}), ...(route.speed.via ? { via: route.speed.via } : {}) } : null,
        firstTokenMilliseconds: route.speed && route.speed.firstTokenMilliseconds !== null ? { value: route.speed.firstTokenMilliseconds, basis: route.speed.basis, samples: route.speed.waitSamples, ...(route.speed.via ? { via: route.speed.via } : {}) } : null,
        secondsPerCall: route.speed?.basis === 'measured' && route.speed.secondsPerCall ? { value: route.speed.secondsPerCall, basis: route.speed.basis, samples: route.speed.timedRequests, ...(route.speed.via ? { via: route.speed.via } : {}) } : null,
        calibration: calibration ? { state: calibration.state, at: new Date(calibration.measuredAt ?? calibration.requestedAt).toISOString(), reason: calibration.reason ?? null, tokensPerSecond: calibration.tokensPerSecond ?? null, firstTokenMilliseconds: calibration.firstTokenMilliseconds ?? null, outputTokens: calibration.outputTokens ?? null } : null,
        published: speedRowsFor(published, route.modelID, route.reasoning).map(row => ({ suite: row.suite, outputTokensPerSecond: row.outputTokensPerSecond ?? null, firstAnswerSeconds: row.firstAnswerSeconds ?? null, suiteOutputTokens: row.suiteOutputTokens ?? null, secondsPerTask: row.secondsPerTask ?? null, costPerTaskUSD: row.costPerTaskUSD ?? null, source: row.source, measuredAt: row.measuredAt })),
        publishedTask: route.publishedTask ? { outputTokens: route.publishedTask.outputTokens, seconds: route.publishedTask.seconds, calls: route.publishedTask.calls, basis: route.publishedTask.basis, from: route.publishedTask.from ?? null, source: route.publishedTask.source, said: route.publishedTask.said } : null,
        requestMilliseconds: route.requestPerformance?.milliseconds ?? route.economics?.requestMilliseconds ?? null,
      },
      allowance: route.allowanceCost ? { points: route.allowanceCost.points, costPerTaskUSD: route.allowanceCost.costPerTaskUSD, said: route.allowanceCost.said, windows: route.allowanceCost.windows.map(w => ({ windowID: w.windowID, label: w.label, pointsPerTask: w.pointsPerTask, spare: w.spare, scarcePoints: w.scarcePoints, pace: w.pace, leftPercent: w.leftPercent, resetAt: w.resetAt, said: w.said })) } : null,
      quality: measuredFor(mine),
      rateLimit: limits.get(routeLimitKey(route.providerID, route.modelID)) ?? null,
      outage: outages.routes.find(item => item.route === routeLimitKey(route.providerID, route.modelID)) ?? null,
      cost: { perTaskUSD: b?.perTask?.costUSD ?? null, quote: route.economics ? { amount: route.economics.amount, currency: route.economics.currency, workload: route.economics.workload ?? 'comparison workload' } : null },
      byWorkType: Object.fromEntries(types.map(type => {
        const here = perType.get(type)!, typed = here.routes.find(r => r.id === route.id)!, estimate = here.finish.get(route.id)
        const success = speedSuccess(typed, plan.request)
        const benchmark = type === UNCLASSIFIED_WORK ? undefined : benchmarkOfWorkType(input.settings, type)
        const score = aaRow ? aaScoreOf(aaRow, benchmark) : null
        return [type, {
          benchmark: benchmark ?? null,
          aa: score ? { category: score.category, label: score.label, value: score.value, fellBack: score.fellBack } : null,
          rating: type === UNCLASSIFIED_WORK ? null : ratingOf(input.settings, route, type)?.rating ?? null,
          measured: measuredFor(mine.filter(run => runKind(run) === type)),
          finish: estimate ? { milliseconds: success ? estimate.attemptMilliseconds / success : estimate.attemptMilliseconds, attemptMilliseconds: estimate.attemptMilliseconds, success, basis: estimate.basis, runs: estimate.runs, said: estimate.said,
            outputTokensPerTask: estimate.outputTokensPerTask, callsPerTask: estimate.callsPerTask } : null,
        }]
      })),
    }
  }).sort((a, b) => a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort))
  return { at: new Date(now).toISOString(), analysis: analysis ? { fetchedAt: analysis.fetchedAt, nextRefreshAt: analysis.nextRefreshAt, tier: analysis.tier, indexVersion: analysis.indexVersion, models: analysis.models.length, catalog: analysis.models, error: analysis.error } : null, workTypes: input.settings.workTypes.map(type => ({ id: type.id, label: type.label, benchmark: type.benchmark })), allowanceWeight: input.settings.allowanceWeight ?? 0, routes, outageProviders: outages.providers, diagnostics }
}
