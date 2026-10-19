import { capabilityOf, priorRuns, type FinishedRuns, type LearnedOutcomes, type Route, type RoutingRequest } from "./route-vocabulary"

export type FigureBasis = "measured" | "calibration" | "published" | "borrowed"
export type Figure = { value: number; basis: FigureBasis; runs?: number; samples?: number; source?: string; from?: string; via?: string; rate?: "stream" | "whole call" }
export type FinishBasis = "measured" | "blended" | "modeled" | "published" | "borrowed"
export type FinishEstimate = {
  attemptMilliseconds: number
  basis: FinishBasis
  runs: number
  tokensPerSecond: Figure | null
  firstTokenMilliseconds: Figure | null
  outputTokensPerTask: Figure | null
  callsPerTask: Figure | null
  secondsPerCall: Figure | null
  toolMillisecondsPerCall: number | null
  scaledBy: number | null
  said: string
}

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0
const median = (values: number[]) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : null }
const minutes = (ms: number) => ms >= 90000 ? Math.round(ms / 60000) + " min" : Math.round(ms / 1000) + "s"
const thousands = (n: number) => n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n))

const finished = (runs: FinishedRuns | undefined, minTrials: number) => runs && runs.completed >= minTrials && positive(runs.medianMilliseconds) ? runs : undefined
const counted = (runs: FinishedRuns | undefined) => runs && runs.completed > 0 ? runs : undefined

export function speedSuccess(route: Pick<Route, "benchmark" | "learned" | "learnedOther">, request: Pick<RoutingRequest, "minTrials" | "borrowedPriorRuns">) {
  const firstPass = (learned: LearnedOutcomes | undefined) => learned ? { trials: learned.trials, delivered: Math.max(0, learned.delivered - (learned.reworked ?? 0)) } : undefined
  return capabilityOf(route.benchmark && positive(route.benchmark.passAt1) ? route.benchmark.passAt1 : null, firstPass(route.learned), request.minTrials,
    { priorWeight: priorRuns(route, request), ...(route.learnedOther ? { other: firstPass(route.learnedOther) } : {}) })
}

function ratio(routes: Route[], pick: (runs: FinishedRuns, route: Route) => number | null, minTrials: number, need: (runs: FinishedRuns | undefined, minTrials: number) => FinishedRuns | undefined) {
  for (const which of ["finished", "finishedOverall"] as const) {
    const found = median(routes.flatMap(route => { const done = need(route[which], minTrials); const value = done ? pick(done, route) : null; return value !== null && positive(value) ? [value] : [] }))
    if (found !== null) return found
  }
  return null
}

function modelCall(route: Route, tokens: number | null, calls: number | null) {
  const speed = route.speed
  if (speed?.basis === "measured" && positive(speed.secondsPerCall)) return { milliseconds: speed.secondsPerCall * 1000, measuredCall: true }
  if (!speed?.tokensPerSecond || tokens === null || !positive(calls)) return null
  return { milliseconds: tokens / calls / speed.tokensPerSecond * 1000 + (speed.firstTokenMilliseconds ?? 0), measuredCall: false }
}

export function finishScales(routes: Route[], minTrials: number) {
  const published = (route: Route) => route.publishedTask?.basis === "published" ? route.publishedTask : undefined
  return {
    time: ratio(routes, (done, route) => { const task = published(route); return task ? done.medianMilliseconds / (task.seconds * 1000) : null }, minTrials, finished),
    tokens: ratio(routes, (done, route) => { const task = published(route); return task && positive(done.medianOutputTokens) ? done.medianOutputTokens / task.outputTokens : null }, minTrials, finished),
    calls: ratio(routes, (done, route) => { const task = published(route); return task && positive(task.calls) && positive(done.medianRequests) ? done.medianRequests / task.calls : null }, minTrials, finished),
    toolsPerCall: ratio(routes, (done, route) => {
      if (!positive(done.medianRequests)) return null
      const call = modelCall(route, positive(done.medianOutputTokens) ? done.medianOutputTokens : null, done.medianRequests)
      return call ? Math.max(0, done.medianMilliseconds - done.medianRequests * call.milliseconds) / done.medianRequests : null
    }, minTrials, finished),
  }
}

const said = (figure: Figure) => figure.basis === "calibration" ? "one calibration request" : figure.basis === "measured" ? (figure.runs !== undefined ? "over " + figure.runs + " run" + (figure.runs === 1 ? "" : "s") : "measured over " + figure.samples + " requests") + (figure.via ? " via " + figure.via : "") : figure.basis === "borrowed" ? "borrowed from " + figure.from : "published"

export function finishEstimates(routes: Route[], minTrials: number): Map<string, FinishEstimate> {
  const { time, tokens, calls, toolsPerCall } = finishScales(routes, minTrials)
  const pooled = routes.flatMap(route => { const done = counted(route.finished); return done && positive(done.medianRequests) ? [done.medianRequests] : [] })
  const pooledCalls = median(pooled)
  const estimates = new Map<string, FinishEstimate>()
  for (const route of routes) {
    const speed = route.speed, task = route.publishedTask
    const same = counted(route.finished), via = same?.via
    const withVia = <T extends object>(figure: T) => speed?.via ? { ...figure, via: speed.via } : figure
    const tokensPerSecond: Figure | null = speed?.tokensPerSecond ? withVia({ value: speed.tokensPerSecond, basis: speed.basis, samples: speed.timedRequests, ...(speed.rate ? { rate: speed.rate } : {}) }) : null
    const firstTokenMilliseconds: Figure | null = speed && speed.firstTokenMilliseconds !== null ? withVia({ value: speed.firstTokenMilliseconds, basis: speed.basis, samples: speed.waitSamples }) : null
    const secondsPerCall: Figure | null = speed?.basis === "measured" && positive(speed.secondsPerCall) ? withVia({ value: speed.secondsPerCall, basis: "measured" as const, samples: speed.timedRequests }) : null
    const publishedTokens: Figure | null = task ? { value: task.outputTokens * (tokens ?? 1), basis: task.basis, source: task.source, ...(task.from ? { from: task.from } : {}) } : null
    const publishedCalls: Figure | null = task && positive(task.calls) ? { value: task.calls * (calls ?? 1), basis: task.basis, source: task.source, ...(task.from ? { from: task.from } : {}) } : null
    const outputTokensPerTask: Figure | null = same && positive(same.medianOutputTokens) ? { value: same.medianOutputTokens, basis: "measured", runs: same.completed, ...(via ? { via } : {}) } : publishedTokens
    const callsPerTask: Figure | null = same && positive(same.medianRequests) ? { value: same.medianRequests, basis: "measured", runs: same.completed, ...(via ? { via } : {}) } : publishedCalls
    const parts = { tokensPerSecond, firstTokenMilliseconds, secondsPerCall, outputTokensPerTask, callsPerTask, toolMillisecondsPerCall: null as number | null }
    const prior = ((): { milliseconds: number; basis: FinishBasis; said: string; tools: number | null; scaledBy: number | null } | null => {
      const call = modelCall(route, publishedTokens?.value ?? null, publishedCalls?.value ?? null)
      if (call && publishedCalls) {
        const attempt = publishedCalls.value * (call.milliseconds + (toolsPerCall ?? 0))
        const perCall = call.measuredCall ? (call.milliseconds / 1000).toFixed(1) + "s a model call (" + said(secondsPerCall!) + ")"
          : (call.milliseconds / 1000).toFixed(1) + "s a model call (" + thousands(publishedTokens!.value / publishedCalls.value) + " output tokens at " + Math.round(tokensPerSecond!.value) + " tok/s, " + said(tokensPerSecond!) + ", plus first-token wait)"
        return { milliseconds: attempt, basis: "modeled", tools: toolsPerCall, scaledBy: null,
          said: Math.round(publishedCalls.value) + " model calls a task (" + said(publishedCalls) + (calls !== null ? ", scaled to the size of the work here" : "") + ") × (" + perCall +
            (toolsPerCall !== null ? " + " + (toolsPerCall / 1000).toFixed(1) + "s tools and host time, measured on routes with finished runs" : "") + "): about " + minutes(attempt) }
      }
      if (call?.measuredCall && !publishedCalls && pooledCalls !== null) {
        const attempt = pooledCalls * (call.milliseconds + (toolsPerCall ?? 0))
        return { milliseconds: attempt, basis: "borrowed", tools: toolsPerCall, scaledBy: null,
          said: Math.round(pooledCalls) + " model calls a task (the median over " + pooled.length + " route" + (pooled.length === 1 ? "" : "s") + " with finished runs of this work here, since this route has no published task figures) × (" + (call.milliseconds / 1000).toFixed(1) + "s a model call (" + said(secondsPerCall!) + ")" +
            (toolsPerCall !== null ? " + " + (toolsPerCall / 1000).toFixed(1) + "s tools and host time, measured on routes with finished runs" : "") + "): about " + minutes(attempt) }
      }
      if (tokensPerSecond && publishedTokens) {
        const attempt = publishedTokens.value / tokensPerSecond.value * 1000
        return { milliseconds: attempt, basis: "modeled", tools: null, scaledBy: null,
          said: thousands(publishedTokens.value) + " output tokens a task (" + said(publishedTokens) + ") at " + Math.round(tokensPerSecond.value) + " tok/s (" + said(tokensPerSecond) + "); model calls unknown: about " + minutes(attempt) }
      }
      if (task) {
        const attempt = task.seconds * 1000 * (time ?? 1)
        return { milliseconds: attempt, basis: task.basis, tools: null, scaledBy: time,
          said: task.said + ", " + minutes(task.seconds * 1000) + " a task" + (time !== null ? ", scaled × " + time.toFixed(2) + " to the size of the work here: about " + minutes(attempt) : "") }
      }
      return null
    })()
    const here = same ? "median " + minutes(same.medianMilliseconds) + " over " + same.completed + " finished run" + (same.completed === 1 ? "" : "s") + " of this work type here" + (via ? " via " + via : "") : ""
    const weight = same ? Math.min(1, same.completed / minTrials) : 0
    if (same && (weight === 1 || !prior)) {
      estimates.set(route.id, { ...parts, attemptMilliseconds: same.medianMilliseconds, basis: "measured", runs: same.completed, scaledBy: null, said: here })
      continue
    }
    if (same && prior) {
      const attempt = weight * same.medianMilliseconds + (1 - weight) * prior.milliseconds
      estimates.set(route.id, { ...parts, toolMillisecondsPerCall: prior.tools, attemptMilliseconds: attempt, basis: "blended", runs: same.completed, scaledBy: prior.scaledBy,
        said: "about " + minutes(attempt) + ": " + same.completed + " of the " + minTrials + " runs routing trusts on their own (" + here + ") blended with " + prior.basis + " " + prior.said })
      continue
    }
    if (prior) estimates.set(route.id, { ...parts, toolMillisecondsPerCall: prior.tools, attemptMilliseconds: prior.milliseconds, basis: prior.basis, runs: 0, scaledBy: prior.scaledBy, said: prior.said })
  }
  for (const route of routes) {
    const floor = runTimeFloor(route, minTrials), estimate = estimates.get(route.id)
    if (!floor || estimate && estimate.attemptMilliseconds >= floor.medianMilliseconds) continue
    const measured = "median " + minutes(floor.medianMilliseconds) + " over " + floor.completed + " ended run" + (floor.completed === 1 ? "" : "s") + (floor.kind === "*" ? " of any work type" : " of this work type") + " at " + floor.reasoning + (floor.sameModel ? " on this model" : " on any model") + " here"
    if (!estimate) {
      estimates.set(route.id, { tokensPerSecond: null, firstTokenMilliseconds: null, outputTokensPerTask: null, callsPerTask: null, secondsPerCall: null, toolMillisecondsPerCall: null, attemptMilliseconds: floor.medianMilliseconds, basis: "measured", runs: floor.completed, scaledBy: null, said: measured })
      continue
    }
    const weight = Math.min(1, floor.completed / minTrials), attempt = weight * floor.medianMilliseconds + (1 - weight) * estimate.attemptMilliseconds
    estimates.set(route.id, weight === 1
      ? { ...estimate, attemptMilliseconds: attempt, basis: "measured", runs: floor.completed, said: measured + ", longer than " + estimate.basis + " " + estimate.said }
      : { ...estimate, attemptMilliseconds: attempt, basis: "blended", runs: floor.completed, said: "about " + minutes(attempt) + ": " + floor.completed + " of the " + minTrials + " runs routing trusts on their own (" + measured + ") blended with " + estimate.basis + " " + estimate.said })
  }
  return estimates
}

function runTimeFloor(route: Route, minTrials: number) {
  const rows = (route.runTimes ?? []).filter(row => row.reasoning === route.reasoning && positive(row.medianMilliseconds))
  return rows.find(row => row.completed >= minTrials) ?? rows[0]
}
