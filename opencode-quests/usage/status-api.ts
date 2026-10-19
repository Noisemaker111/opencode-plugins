import "./host-hooks"
import { usageReferences } from './session-references'
import { accountEvidence, windowEvidence } from './reporting-evidence'
import { pacingView, readPacingObservations } from "./portfolio-pacing"
import { sessionBurn } from "./session-burn"
import { ledgerCoverage, ledgerLatestContext, ledgerLatestRequest, ledgerRequestPage, ledgerScopeTotals, ledgerSessionPage, readLedger, type LedgerFilter, type LedgerRow } from "./passive-ledger"
import { measuredIntervals, empiricalModels } from "./empirical-usage"
import { harvestCodexUsage } from "./codex-harvest"
import { modelUsage, MODEL_USAGE_NOTE } from "./model-usage"
import { REQUEST_METRICS_NOTE } from "./request-metrics"
import { readContextEvents } from "./context-events"
import { getAccountUsage, readAccountUsage, formatAccountUsage, ACCOUNT_USAGE_FILE } from "../usage-service/on-computer"
import { knownTokenTotal, outputIncludingReasoning, requestTiming, type RequestRecord } from "./telemetry"
import { readQuotaObservations, readCalibrations } from "./calibration-store"
import { readSessionsRequests } from "./telemetry-store"
import { resetPlan } from "./reset-planner"
import { compareWorkloads } from "./workload-planner"
import { CREDIT_RATE_CARD, validateWorkloads, type UsageWorkload } from "./credit-rates"

export const USAGE_DETAIL_VIEWS = ["requests","sessions","timeline","pools","models","workloads","harvest"] as const
const SCOPE = ["allSessions", "sessionID", "questID", "includeWorkers", "accountID", "source", "providerID", "modelID", "from", "to", "offset", "limit"]
export const USAGE_VIEW_CONTRACT: Record<(typeof USAGE_DETAIL_VIEWS)[number], { answers: string; inputs: string[]; required?: string[] }> = {
  requests: { answers: "One page of recorded requests, newest first.", inputs: SCOPE },
  sessions: { answers: "One page of per-session counters; pass allSessions for more than this conversation.", inputs: SCOPE },
  timeline: { answers: "One page of context/token points with the compactions and quota samples inside it.", inputs: SCOPE },
  pools: { answers: "Allowance calibration and chronological accuracy for one account's pools.", inputs: ["accountID", "from", "to", "offset", "limit", "reservePoints", "deadlineAt"], required: ["accountID"] },
  models: { answers: "Measured per-route request rates and costs for the selected capture source.", inputs: SCOPE },
  workloads: { answers: "Compare explicit workload alternatives against each pool.", inputs: ["workloads", "reservePoints", "deadlineAt"], required: ["workloads"] },
  harvest: { answers: "Locally readable Codex rollout counters; supplemental, never added to OpenCode totals.", inputs: ["from", "to", "offset", "limit"] },
}
export type UsageDetailView = (typeof USAGE_DETAIL_VIEWS)[number]
export type UsageStatusQuery = LedgerFilter & { refresh?: boolean; reservePoints?: number; deadlineAt?: number; allSessions?: boolean }
export type UsageDetailQuery = UsageStatusQuery & { view: UsageDetailView; offset?: number; limit?: number; workloads?: UsageWorkload[] }

const DEFAULT_LIMIT = 25, MAX_LIMIT = 100
function page(query: { offset?: number; limit?: number }) {
  const offset = query.offset ?? 0, limit = query.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error("Invalid usage pagination")
  return { offset, limit }
}
function checkRange(query: UsageStatusQuery) {
  if (query.from !== undefined && !Number.isFinite(query.from) || query.to !== undefined && !Number.isFinite(query.to) || query.from !== undefined && query.to !== undefined && query.from > query.to) throw new Error("Invalid usage time range")
}
const scopeOf = (query: UsageStatusQuery) => ({ sessionID: query.allSessions ? undefined : query.sessionID, questID: query.questID, accountID: query.accountID, providerID: query.providerID, modelID: query.modelID, source: query.source ?? 'opencode', includeWorkers: query.includeWorkers === true, from: query.from, to: query.to })
const rowTiming = (r: LedgerRow) => requestTiming({ ...r, startedAt: r.startedAt, completedAt: r.completedAt, firstVisibleAt: r.firstVisibleAt, lastOutputAt: r.lastOutputAt } as any)

type BalanceQuery = Pick<UsageStatusQuery, "refresh" | "accountID" | "reservePoints" | "deadlineAt">
async function balances(query: BalanceQuery) {
  const snapshot = query.refresh ? await getAccountUsage({ refresh: true }) : readAccountUsage(undefined, Date.now())
  const now = Date.now()
  const selected = query.accountID ? snapshot.accounts.filter(a => a.id === query.accountID) : snapshot.accounts
  const observations = readPacingObservations(now)
  return { now, snapshot, observations, planning: resetPlan(selected, observations, now, query.reservePoints, query.deadlineAt),
    accounts: selected.map(account => ({
      id: account.id, provider: account.provider, identity: account.identity, plan: account.plan, state: account.state,
      error: account.error, extraUsage: account.extraUsage, observedAt: account.observedAt, freshness: account.freshness, evidence: accountEvidence(account),
      windows: account.windows.map(w => ({ id: w.id, label: w.label, scope: w.scope, model: w.model, state: w.state,
        usedPercent: w.usedPercent, remainingPercent: w.remainingPercent, resetAt: w.resetAt, observedAt: w.observedAt, evidence: windowEvidence(w),
        minutesToReset: w.resetAt && Number.isFinite(Date.parse(w.resetAt)) ? Math.max(0, (Date.parse(w.resetAt) - now) / 60000) : null })),
    })) }
}

export async function getUsageBalances(query: BalanceQuery = {}) {
  const { now, snapshot, planning, accounts } = await balances(query)
  return { schema: 2, at: now, accounts, diagnostics: snapshot.diagnostics, planning }
}

export async function getUsageStatus(query: UsageStatusQuery = {}, options: { readOnly?: boolean } = {}) {
  const references = usageReferences()
  query = references.resolve(query)
  checkRange(query)
  const { now, snapshot, observations, planning, accounts } = await balances(query)
  const pacing = pacingView(snapshot.accounts, observations, now, { accountID: query.accountID, readOnly: options.readOnly ?? true })
  const filter: LedgerFilter = { sessionID: query.allSessions ? undefined : query.sessionID, questID: query.questID, accountID: query.accountID, includeWorkers: query.includeWorkers, from: query.from, to: query.to, source: query.source ?? "opencode", providerID: query.providerID, modelID: query.modelID }
  const totals = ledgerScopeTotals(filter)
  const latest = ledgerLatestRequest(filter), context = ledgerLatestContext(filter)
  const coverage = ledgerCoverage(undefined, now, filter)
  const receipt = coverage.receipt
  return {
    schema: 2, at: now, scope: scopeOf(query), resolvedSession: references.session(filter.sessionID, filter.source),
    accounts,
    diagnostics: snapshot.diagnostics,
    pacing: { ...pacing, accounts: pacing.accounts.map(({ pools, ...row }) => row) }, planning,
    session: {
      ...scopeOf(query), ...references.fields({ sessionID: filter.sessionID, source: filter.source, questID: query.questID }), source: filter.source, basis: "Recorded counters from " + filter.source + " only; capture sources can overlap and are never added together",
      requests: totals?.requests ?? 0, runningRequests: totals?.runningRequests ?? 0, sessions: totals?.sessions ?? 0,
      firstAt: totals?.firstAt ?? null, lastAt: totals?.lastAt ?? null,
      tokens: totals?.totals ?? null, knownTokens: totals?.knownTokens ?? null, missingComponents: totals?.missing ?? null,
      outputIncludingReasoning: totals && totals.requests > totals.missingOutputRequests ? totals.outputIncludingReasoning : null, missingOutputRequests: totals?.missingOutputRequests ?? 0,
      models: totals?.models ?? [], context,
      evidence: {
        state: !totals ? 'collector-unavailable' : !totals.requests ? 'no-recorded-requests' : 'recorded',
        scope: filter.sessionID ? 'Selected session' : query.allSessions ? 'All recorded sessions matching the filters' : 'All recorded sessions matching the filters; no current conversation was supplied',
        accountBinding: filter.source === 'codex' ? 'Codex rollouts do not identify the account; accountID filters exclude unbound requests.' : 'Only recorded account bindings are used.',
        context: context ? 'Recorded context snapshot' : 'No context snapshot was captured for this scope; accumulated tokens are not current context.',
        timing: latest && filter.source === 'codex' ? 'Rollout counters have an observation timestamp, not request start/end timing or speed.' : undefined,
        cost: 'Token counters are not actual charges or model quota percentages.',
      },
      latestRequest: latest ? { id: latest.id, sessionID: latest.sessionID, ...references.fields(latest), route: latest.route, kind: latest.kind, state: latest.state, startedAt: latest.startedAt, timing: rowTiming(latest) } : null,
    },
    collector: {
      source: filter.source, scope: 'Counter records match the selected source and filters. Filtered gaps require a matching captured session; unbound gaps are outside that scope. Quota observations and the receipt describe the shared collector.',
      state: !receipt ? 'unavailable' : now < receipt.at || now - receipt.at > 90000 ? 'stale' : 'current',
      reason: !receipt ? 'No collector receipt is recorded; zero captured requests does not establish zero provider usage.' : undefined,
      observedAt: receipt?.at ?? null, stale: !receipt || now < receipt.at || now - receipt.at > 90000,
      coverageFrom: coverage.coverageFrom, records: coverage.records, observations: coverage.observations,
      openGaps: coverage.openGaps, resolvedGaps: coverage.resolvedGaps, uncaptured: coverage.uncaptured,
      newRequests: receipt?.newRequests ?? null, changedRollouts: receipt?.readFiles ?? null, unchangedRollouts: receipt?.unchangedFiles ?? null,
      diagnostics: coverage.uncaptured.map(u => u.route + ": " + u.steps + " host model steps in " + u.sessions + " session(s) in the last day never reached the request log"),
      receiptDiagnostics: receipt?.diagnostics ?? [],
    },
    creditRates: { validUntil: CREDIT_RATE_CARD.validUntil, state: now < Date.parse(CREDIT_RATE_CARD.validUntil) ? "current" : "expired", note: "Published credit equivalent; not included-allowance percentage or actual charges. Rates are in the workloads view." },
  }
}
export type UsageDigest = Awaited<ReturnType<typeof getUsageStatus>>

export async function getUsageDetail(query: UsageDetailQuery) {
  const references = usageReferences()
  query = references.resolve(query)
  checkRange(query)
  const { offset, limit } = page(query)
  const now = Date.now(), view = query.view
  if (!USAGE_DETAIL_VIEWS.includes(view)) throw new Error("Unknown usage view")
  const filter: LedgerFilter = { sessionID: query.allSessions ? undefined : query.sessionID, questID: query.questID, accountID: query.accountID, includeWorkers: query.includeWorkers, from: query.from, to: query.to, source: query.source ?? "opencode", providerID: query.providerID, modelID: query.modelID }
  const head = { schema: 2, at: now, view, scope: scopeOf(query), resolvedSession: references.session(filter.sessionID, filter.source), offset, limit }
  if (view === "requests") {
    const result = ledgerRequestPage({ ...filter, offset, limit })
    return { ...head, total: result.total, nextOffset: result.nextOffset,
      requests: result.rows.map(r => ({ id: r.id, source: r.source, sessionID: r.sessionID, ...references.fields(r), questID: r.questID ?? null, accountID: r.accountID ?? null, route: r.route, kind: r.kind, state: r.state, startedAt: r.startedAt, completedAt: r.completedAt ?? null, tokens: r.tokens, outputTotal: r.outputTotal ?? null, context: r.context ?? null, request: r.request ?? null, timing: rowTiming(r) })) }
  }
  if (view === "sessions") {
    const result = ledgerSessionPage({ ...filter, offset, limit })
    return { ...head, total: result.total, nextOffset: result.nextOffset, sessions: result.sessions.map(s => ({ ...s, ...references.fields(s) })),
      crossSourceOverlap: "Native host, HTTP and Codex captures may overlap; source counters are not verified unique billable tokens." }
  }
  if (view === "timeline") {
    const result = ledgerRequestPage({ ...filter, offset, limit })
    const rows = [...result.rows].sort((a, b) => a.at - b.at)
    const from = rows[0]?.at ?? query.from ?? now, to = rows.at(-1)?.at ?? query.to ?? now
    const events = readContextEvents()
    const sessions = new Set(rows.map(r => r.sessionID)); if (query.sessionID) sessions.add(query.sessionID)
    const observations = readQuotaObservations(ACCOUNT_USAGE_FILE + ".observations", { from }).observations.filter(o => o.at <= to && (!query.accountID || o.accountID === query.accountID))
    let cumulative = 0
    return { ...head, total: result.total, nextOffset: result.nextOffset, from, to,
      points: rows.map(r => { const known = knownTokenTotal(r); cumulative += known
        return { at: r.startedAt, requestID: r.id, sessionID: r.sessionID, ...references.fields(r), contextTokens: r.context?.tokens ?? null, requestKnownTokens: known, pageCumulativeKnownTokens: cumulative, partial: Object.values(r.tokens).some(v => v === null), model: r.route.providerID + "/" + r.route.modelID, kind: r.kind } }),
      compactions: events.events.filter(e => sessions.has(e.sessionID) && e.at >= from && e.at <= to).slice(-limit).map(e => ({ id: e.id, sessionID: e.sessionID, ...references.fields({ sessionID: e.sessionID, source: query.source }), at: e.at, type: e.type, reason: e.reason ?? null, error: e.error ?? null })),
      quotaSamples: observations.slice(-limit).map(o => ({ at: o.at, accountID: o.accountID, windowID: o.windowID, usedPoints: o.usedPoints, resetAt: o.resetAt, provenance: "observed-all-account-activity" })),
      cumulativeBasis: "Cumulative tokens accumulate within this page only; ask for the next page to continue the series." }
  }
  if (view === "pools") {
    if (!query.accountID) throw new Error("A pools view needs an exact accountID from a previous digest")
    const accounts = readAccountUsage(undefined, now)
    const account = accounts.accounts.filter(a => a.id === query.accountID)
    if (!account.length) throw new Error("Account not found in current connections")
    const from = query.from ?? now - 7 * 86400000, to = query.to ?? now
    const ledger = readLedger({ from, to, accountID: query.accountID })
    const coverage = { from: ledger.coverageFrom, gaps: ledger.gaps, diagnostics: ledger.receipt?.calibrationDiagnostics ?? ledger.receipt?.diagnostics, observedAt: ledger.receipt?.at }
    const burn = sessionBurn(account, ledger.observations, ledger.rows, now, coverage)
    const intervals = measuredIntervals(account, ledger.observations, ledger.rows, coverage)
    return { ...head, from, to, planning: resetPlan(account, readPacingObservations(now), now, query.reservePoints, query.deadlineAt),
      empiricalModels: empiricalModels(intervals),
      pools: burn.pools.map(pool => ({ scope: pool.scope, provider: pool.provider, plan: pool.plan, label: pool.label, evidence: pool.evidence, accuracy: pool.accuracy,
        sessionTotal: pool.sessions.length, sessions: pool.sessions.slice(offset, offset + limit).map(s => ({ ...s, ...references.fields(s), recentRequests: s.recentRequests.slice(0, limit) })),
        seriesTotal: pool.series.length, series: pool.series.slice(-limit) })),
      unassignedRequests: burn.unassignedRequests, limitations: burn.limitations }
  }
  if (view === "models") {
    const from = query.from ?? now - 28 * 86400000, to = query.to ?? now
    const ledger = readLedger({ ...filter, from, to })
    const stored = filter.source === 'opencode' ? readSessionsRequests(ledger.rows.map(row => row.sessionID)) : { records: [] as RequestRecord[], diagnostics: [] as string[] }
    const originals = new Map(stored.records.map(record => ['opencode:' + record.id, record]))
    const records = ledger.rows.map(row => originals.get(row.id) ?? row as RequestRecord)
    const models = modelUsage(records, to, from)
    const notes = ['Recorded ' + filter.source + ' requests only; missing timing, account bindings and actual charges are not inferred. Other capture sources may overlap.', MODEL_USAGE_NOTE, REQUEST_METRICS_NOTE]
    return { ...head, from, to, source: filter.source, total: models.length, nextOffset: offset + limit < models.length ? offset + limit : null, models: models.slice(offset, offset + limit), notes, diagnostics: [...stored.diagnostics, ...ledger.diagnostics] }
  }
  if (view === "workloads") {
    const workloads = query.workloads ?? []
    validateWorkloads(workloads)
    if (!workloads.length) throw new Error("A workloads view needs at least one explicit workload alternative")
    const accounts = readAccountUsage(undefined, now)
    const planning = resetPlan(accounts.accounts, readPacingObservations(now), now, query.reservePoints, query.deadlineAt)
    return { ...head, creditRates: { ...CREDIT_RATE_CARD, state: now < Date.parse(CREDIT_RATE_CARD.validUntil) ? "current" : "expired" },
      workloads: compareWorkloads(accounts.accounts, planning, readCalibrations().calibrations, workloads, now) }
  }
  const to = query.to ?? now, from = query.from ?? to - 4 * 3600000
  const harvest = await harvestCodexUsage({ from, to, now })
  return { ...head, from: harvest.from, to: harvest.to, scannedFiles: harvest.scannedFiles, readFiles: harvest.readFiles,
    total: harvest.sessions.length, nextOffset: offset + limit < harvest.sessions.length ? offset + limit : null,
    sessions: harvest.sessions.slice(offset, offset + limit).map(s => ({ id: s.id, ...references.fields({ sessionID: s.id, source: 'codex' }), parentID: s.parentID, source: s.source, startedAt: s.startedAt, requests: s.requests, totals: s.totals, lastObservedAt: s.lastObservedAt, quotaSamples: s.quota.length, gaps: s.gaps.length })),
    coverage: harvest.coverage, diagnostics: harvest.diagnostics.slice(0, 10) }
}

const number = (n: number | null | undefined) => n === null || n === undefined ? "unknown" : n.toLocaleString("en-US")
export function formatUsageStatus(value: UsageDigest): string {
  const t = value.session.tokens
  const lines = [
    formatAccountUsage({ schema: 1, updatedAt: "", accounts: value.accounts as any, diagnostics: [] }, value.at),
    "",
    ...value.pacing.accounts.map(a => a.provider + "/" + a.accountID.slice(-6) + " " + a.plan + ": " + a.state + "; " + a.mode +
      (a.remainingPoints === null ? "" : "; " + a.remainingPoints.toFixed(1) + "% left in " + a.windowID) +
      (a.paceMultiplier == null ? "" : "; " + a.paceMultiplier.toFixed(2) + "x current pace required") +
      (a.pacing ? "; desired " + a.pacing.desiredSlots + "/" + a.pacing.ceiling : "")),
    value.session.source + ": " + (value.scope.sessionID ? "Selected conversation" : "All recorded sessions") + (value.scope.includeWorkers ? " including workers" : "") + ": " +
      value.session.requests + " requests" + (value.session.runningRequests ? " (" + value.session.runningRequests + " in flight)" : "") +
      " across " + value.session.sessions + " session(s)",
    t ? "Input " + number(t.input) + " · cache read " + number(t.cacheRead) + " · cache write " + number(t.cacheWrite) + " · output incl. reasoning " + number(value.session.outputIncludingReasoning) : "No recorded counters for this scope",
    value.session.missingComponents && Object.values(value.session.missingComponents).some(count => count > 0) ? 'Token totals sum captured components only; missing components are counted in missingComponents.' : undefined,
    ...value.session.models.map(model => model.providerID + '/' + model.modelID + ' (' + (model.reasoning ?? 'reasoning unknown') + ', ' + (model.harness ?? 'harness unknown') + '): ' + model.requests + ' requests across ' + model.sessions + ' session(s)'),
    value.session.evidence.scope,
    value.session.evidence.accountBinding,
    value.session.evidence.cost,
    "Current context: " + (value.session.context ? number(value.session.context.tokens) + " (" + value.session.context.source + ")" : value.session.evidence.context),
    value.session.evidence.timing,
    "Collector: " + value.collector.state + "; " + number(value.collector.records) + ' ' + value.collector.source + " counter records; " + value.collector.openGaps + " open gap(s)",
    value.collector.reason,
    ...value.accounts.flatMap(account => [account.evidence.reason ? account.provider + ': ' + account.evidence.missingFields.join(', ') + '. ' + account.evidence.reason : undefined, account.evidence.freshness, ...account.windows.flatMap(window => window.evidence.reason ? [account.provider + '/' + window.id + ': ' + window.evidence.missingFields.join(', ') + '. ' + window.evidence.reason] : [])]),
    ...value.collector.diagnostics,
    ...value.collector.receiptDiagnostics.map(diagnostic => 'Shared collector: ' + diagnostic),
    ...value.diagnostics,
    "Detail views: " + USAGE_DETAIL_VIEWS.join(", ") + " — each returns one page you size.",
  ]
  return lines.filter(line => line !== undefined).join("\n")
}
export function formatUsageDetail(value: Awaited<ReturnType<typeof getUsageDetail>>): string {
  const rows = value as any
  const head = value.view + " " + (rows.total ?? 0) + " total, showing " + value.offset + "–" + (value.offset + value.limit) +
    (rows.nextOffset ? " · next offset " + rows.nextOffset : " · end of results")
  if (value.view === "requests") return [head, ...rows.requests.map((r: any) => new Date(r.startedAt).toISOString().slice(11, 19) + "  " + r.route.providerID + "/" + r.route.modelID + "  " + r.kind + "/" + r.state + "  in " + number(r.tokens.input) + " · cached " + number(r.tokens.cacheRead) + " · out incl. reasoning " + number(outputIncludingReasoning(r)) + " (reasoning " + number(r.tokens.reasoning) + ")")].join("\n")
  if (value.view === "sessions") return [head, ...rows.sessions.map((s: any) => s.source + "/" + s.sessionID.slice(-8) + "  " + s.requests + " requests  out " + number(s.outputIncludingReasoning) + "  last " + new Date(s.lastAt).toISOString().slice(11, 19))].join("\n")
  if (value.view === "timeline") return [head, ...rows.points.map((p: any) => new Date(p.at).toISOString().slice(11, 19) + "  ctx " + number(p.contextTokens) + "  req " + number(p.requestKnownTokens) + "  page sum " + number(p.pageCumulativeKnownTokens) + "  " + p.model),
    ...rows.compactions.map((c: any) => new Date(c.at).toISOString().slice(11, 19) + "  compaction " + c.type + (c.error ? " · " + c.error : "")),
    ...rows.quotaSamples.map((q: any) => new Date(q.at).toISOString().slice(11, 19) + "  account " + q.accountID.slice(-6) + " " + q.windowID + " " + q.usedPoints + "% used (all activity)")].join("\n")
  if (value.view === "pools") return [head, ...rows.pools.map((p: any) => p.provider + " " + p.label + ": allowance attribution " + p.accuracy.state + "; " + p.accuracy.chronologicalTestedIntervals + " chronological tests; max error " + (p.accuracy.maximumAbsoluteErrorPoints === null ? "unknown" : p.accuracy.maximumAbsoluteErrorPoints.toFixed(4)) + " points (target 0.01); " + p.sessionTotal + " session(s)")].join("\n")
  if (value.view === "models") return [head, ...rows.models.map((m: any) => rows.source + ' ' + m.route.providerID + '/' + m.route.modelID + " (" + (m.route.reasoning ?? m.route.variant ?? "reasoning unknown") + ', ' + (m.route.harness ?? 'harness unknown') + "): " + m.requests + " requests / " + m.sessions + " recorded sessions; " + (m.visibleOutputTokensPerSecond == null ? 'visible output speed was not captured' : number(m.visibleOutputTokensPerSecond) + " visible tokens/s")), ...rows.notes].join("\n")
  if (value.view === "workloads") return [head, ...rows.workloads.map((w: any) => w.label + ": " + (w.creditEquivalent.credits === null ? "credit comparison unavailable" : w.creditEquivalent.credits.toFixed(3) + " published credit equivalent") + "; allowance " + (w.windows.some((p: any) => p.estimate) ? w.windows.map((p: any) => p.windowID + " " + p.fit).join(", ") : "uncalibrated"))].join("\n")
  return [head, "Codex rollouts: " + rows.readFiles + " read of " + rows.scannedFiles + " scanned; " + rows.coverage.reconciledRequests + " reconciled requests, " + rows.coverage.rejectedCounters + " counter gaps",
    ...rows.sessions.map((s: any) => s.id.slice(-8) + " " + s.source + ": " + s.requests + " requests; out incl. reasoning " + number(s.totals.output + s.totals.reasoning))].join("\n")
}
