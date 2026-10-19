import { money, page, row, seconds, stamp, type AnswerRow, type CompactAnswer } from "../quest/interfaces/answer-shape"
import { outputIncludingReasoning } from "./telemetry"

export const COMPACT_USAGE_OPERATIONS = ["usage_status", "usage_models", "usage_sessions", "usage_requests", "usage_timeline", "usage_pools", "usage_workloads", "usage_harvest", "usage_accounts", "usage_pacing", "usage_worker_time"]

type Paging = { offset?: number; limit?: number }
const percent = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 + "%" : undefined
const tail = (id: unknown) => typeof id === "string" ? "…" + id.slice(-6) : undefined
const model = (route: any) => route ? route.providerID + "/" + route.modelID + (route.reasoning && route.reasoning !== "unknown" ? "#" + route.reasoning : route.variant ? "#" + route.variant : "") : undefined
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined

function scopeText(scope: any): string {
  if (!scope) return ""
  return [scope.source, scope.sessionID ? "this session" : "all sessions", scope.includeWorkers ? "with workers" : undefined, scope.questID ? "Quest " + scope.questID : undefined, scope.accountID ? "account " + tail(scope.accountID) : undefined, scope.providerID && scope.modelID ? scope.providerID + "/" + scope.modelID : scope.providerID ?? scope.modelID].filter(Boolean).join(", ")
}

function windowRows(accounts: any[], pacing?: any[]): AnswerRow[] {
  return accounts.flatMap(account => {
    const pace = pacing?.find(each => each.accountID === account.id)
    const name = account.provider + " " + (account.plan?.name ?? account.plan?.rateLimitTier ?? "") + " " + tail(account.id)
    const windows = account.windows?.length ? account.windows : [{}]
    return windows.map((window: any) => row({ account: name.replace(/\s+/g, " ").trim(), window: window.label ?? window.id, left: percent(window.remainingPercent), resets: stamp(window.resetAt), state: window.state ?? account.state,
      pace: pace && pace.windowID === window.id && pace.paceMultiplier != null ? pace.paceMultiplier.toFixed(2) + "x" : undefined, error: account.error }))
  })
}

function statusAnswer(value: any, input: Paging): CompactAnswer {
  const s = value.session ?? {}, t = s.tokens
  const counters = s.source + ": " + s.requests + " requests" + (s.runningRequests ? " (" + s.runningRequests + " in flight)" : "") + " in " + s.sessions + " sessions" + (t ? "; in " + (t.input ?? 0).toLocaleString("en-US") + ", cached " + (t.cacheRead ?? 0).toLocaleString("en-US") + ", out " + (s.outputIncludingReasoning ?? 0).toLocaleString("en-US") : "")
  const collector = "Collector " + value.collector?.state + "; " + value.collector?.openGaps + " open gaps"
  const models = (s.models ?? []).map((each: any) => each.providerID + "/" + each.modelID + (each.reasoning ? "#" + each.reasoning : "") + " " + each.requests).join(", ")
  return page({ view: "status", scope: scopeText(value.scope), key: "windows", ...slice(windowRows(value.accounts ?? [], value.pacing?.accounts), input), limit: input.limit,
    notes: [counters, models && "models: " + models, collector, value.collector?.reason, ...(value.collector?.diagnostics ?? []), ...(value.collector?.receiptDiagnostics ?? []), ...(value.diagnostics ?? [])] })
}

function slice(rows: AnswerRow[], input: Paging) {
  const offset = input.offset ?? 0
  return { rows: rows.slice(offset, input.limit === undefined ? undefined : offset + input.limit), total: rows.length, offset }
}

function modelsAnswer(value: any, input: Paging): CompactAnswer {
  const rows = (value.models ?? []).map((m: any) => row({ model: model(m.route), requests: m.requests, sessions: m.sessions, out: count((m.tokens?.output ?? 0) + (m.tokens?.reasoning ?? 0)), tps: count(m.outputTokensPerSecond), cost: money(m.cost), last: stamp(m.lastAt) }))
  return page({ view: "models", scope: scopeText(value.scope), rows, key: "models", offset: value.offset, total: value.total, limit: input.limit, notes: [...(value.notes ?? []), ...(value.diagnostics ?? [])] })
}

function detailAnswer(value: any, input: Paging): CompactAnswer {
  const at = { offset: value.offset, limit: input.limit, total: value.total, scope: scopeText(value.scope) }
  if (value.view === "requests") return page({ view: "requests", ...at, key: "requests", rows: (value.requests ?? []).map((r: any) => row({ at: stamp(r.startedAt), model: model(r.route), state: r.kind + "/" + r.state, in: count(r.tokens?.input), cached: count(r.tokens?.cacheRead), out: count(outputIncludingReasoning(r)), reasoning: count(r.tokens?.reasoning), session: r.sessionRef ?? tail(r.sessionID) })) })
  if (value.view === "sessions") return page({ view: "sessions", ...at, key: "sessions", rows: (value.sessions ?? []).map((s: any) => row({ session: s.sessionRef ?? s.source + "/" + tail(s.sessionID), title: s.sessionTitle, requests: s.requests, out: count(s.outputIncludingReasoning), last: stamp(s.lastAt) })), notes: [value.crossSourceOverlap] })
  if (value.view === "timeline") return page({ view: "timeline", ...at, key: "points", rows: (value.points ?? []).map((p: any) => row({ at: stamp(p.at), model: p.model, ctx: count(p.contextTokens), req: count(p.requestKnownTokens), sum: count(p.pageCumulativeKnownTokens) })),
    extra: input.limit === undefined ? undefined : { events: [...(value.compactions ?? []).map((c: any) => row({ at: stamp(c.at), kind: "compaction " + c.type, error: c.error })), ...(value.quotaSamples ?? []).map((q: any) => row({ at: stamp(q.at), kind: "quota", account: tail(q.accountID), window: q.windowID, used: percent(q.usedPoints) }))] },
    notes: [input.limit === undefined ? (value.compactions?.length ?? 0) + " compactions and " + (value.quotaSamples?.length ?? 0) + " quota samples in this window; set limit to list them" : undefined, value.cumulativeBasis] })
  if (value.view === "pools") return page({ view: "pools", scope: tail(value.scope?.accountID), key: "pools", pageable: false, rows: (value.pools ?? []).map((p: any) => row({ pool: p.provider + " " + p.label, accuracy: p.accuracy?.state, tests: p.accuracy?.chronologicalTestedIntervals, maxError: p.accuracy?.maximumAbsoluteErrorPoints, sessions: p.sessionTotal })), notes: [...(value.limitations ?? [])] })
  if (value.view === "workloads") return page({ view: "workloads", key: "workloads", pageable: false, rows: (value.workloads ?? []).map((w: any) => row({ label: w.label, credits: w.creditEquivalent?.credits ?? "unavailable", fit: (w.windows ?? []).some((p: any) => p.estimate) ? w.windows.map((p: any) => p.windowID + " " + p.fit).join(", ") : "uncalibrated" })) })
  return page({ view: "harvest", ...at, key: "sessions", rows: (value.sessions ?? []).map((s: any) => row({ session: s.sessionRef ?? tail(s.id), source: s.source, requests: s.requests, out: count((s.totals?.output ?? 0) + (s.totals?.reasoning ?? 0)), last: stamp(s.lastObservedAt) })),
    notes: ["Codex rollouts: " + value.readFiles + " read of " + value.scannedFiles + " scanned", ...(value.diagnostics ?? [])] })
}

function accountsAnswer(value: any, input: Paging): CompactAnswer {
  return page({ view: "accounts", key: "windows", ...slice(windowRows(value.accounts ?? []), input), limit: input.limit, notes: [...(value.diagnostics ?? [])] })
}

function pacingAnswer(value: any, input: Paging): CompactAnswer {
  const rows = (value.accounts ?? []).map((a: any) => row({ account: a.provider + " " + a.plan + " " + tail(a.accountID), state: a.state, mode: a.mode, left: a.remainingPoints == null ? undefined : percent(a.remainingPoints) + " " + a.windowID, pace: a.paceMultiplier == null ? undefined : a.paceMultiplier.toFixed(2) + "x", slots: a.pacing ? a.pacing.desiredSlots + "/" + a.pacing.ceiling : a.requestedSlots, inFlight: count(value.sharedAcrossChannels?.inFlight?.[a.accountID]?.runs ?? value.sharedAcrossChannels?.inFlight?.[a.accountID]) }))
  return page({ view: "pacing", scope: value.requestedSlots + " requested slots", key: "accounts", ...slice(rows, input), limit: input.limit, notes: [...(value.limitations ?? []), ...(value.diagnostics ?? [])] })
}

function workerTimeAnswer(value: any, input: { runID?: string } & Paging): CompactAnswer {
  const line = (name: string, w: any) => row({ name, runs: w.runs, wall: seconds(w.wallMs), model: seconds(w.model?.ms), tools: seconds(w.tools?.ms), out: count((w.tokens?.output ?? 0) + (w.tokens?.reasoning ?? 0)), cost: money(w.cost) })
  const rows = input.runID ? (value.runs ?? []).map((run: any) => line(run.runID + " " + run.route, run)) : (value.byRoute ?? []).map((group: any) => line(group.name, group))
  const total = value.total ? "all " + value.total.runs + " runs: wall " + seconds(value.total.wallMs) + ", model " + seconds(value.total.model?.ms) + ", tools " + seconds(value.total.tools?.ms) + (money(value.total.cost) ? ", " + money(value.total.cost) : "") : undefined
  return page({ view: "worker_time", scope: input.runID ? "run" : "by route", key: "rows", rows, pageable: false, more: "pass runID or a from/to window", notes: [total, "Pass runID for one run.", ...(value.diagnostics ?? [])] })
}

export function compactUsage(name: string, input: any, value: any): CompactAnswer | undefined {
  if (!COMPACT_USAGE_OPERATIONS.includes(name) || !value || typeof value !== "object") return undefined
  input = input ?? {}
  if (name === "usage_accounts") return accountsAnswer(value, input)
  if (name === "usage_pacing") return pacingAnswer(value, input)
  if (name === "usage_worker_time") return workerTimeAnswer(value, input)
  if (!value.view) return statusAnswer(value, input)
  if (value.view === "models") return modelsAnswer(value, input)
  return detailAnswer(value, input)
}
