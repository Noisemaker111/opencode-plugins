const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const record = properties => ({ type: 'object', properties, additionalProperties: true })
const text = { type: 'string' }, integer = { type: 'integer' }, number = { type: 'number' }
const rows = items => ({ type: 'array', items })
const AA_BENCHMARKS = ['intelligence', 'coding', 'agentic', 'finance', 'strategy', 'legal', 'healthcare', 'engineering', 'economics']
const nullable = type => ({ type: [type, 'null'] })
const operation = (description, input, output, { positional = [], readOnly = true } = {}) => ({ description, input, output, positional, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } })

const window = record({ window: text, scope: text, model: nullable('string'), remainingPercent: nullable('number'), usedPercent: nullable('number'), resetAt: nullable('string') })
const contextTurn = record({ at: number, context: integer, fixed: integer, history: integer, route: text })
export const boardCountFields = {
  lockWaits: { ...record({ count: integer, p95Ms: nullable('number'), p99Ms: nullable('number') }), description: 'Waits for a cross-process lock in the last 24 hours: how many, and the time 95% and 99% of them stayed under. Absent when none waited.' },
  open: { ...integer, description: 'Quests that still need work: lanes attention, assigned and unassigned. Ready, done and archived Quests are not counted.' },
  ready: { ...integer, description: 'Read-only Quests whose answer is saved, waiting only for Got it. A Quest whose change is on v2 completes itself and is not counted.' },
  attention: { ...integer, description: 'Quests in the attention lane.' },
  stalled: { ...integer, description: 'Quests that need work with no live worker and no run update (or, with no runs, no creation) in the last 24 hours.' },
  runs: record({ completed: integer, failed: integer, stale: integer, missing: integer, cancelled: integer, ended: integer, causes: { ...rows(record({ code: text, text, fault: { enum: ['worker', 'environment', 'gate', 'infrastructure', 'owner'] }, count: integer, share: number, example: text })), description: 'The most common causes of runs that did not complete in the last 7 days on the same Quests, most common first, at most five. Each has a short code, a plain sentence, whose fault it was, how many runs, their share of those runs and one example run id.' }, failureShare: { ...nullable('number'), description: 'Share of ended runs on the Quests that need work that ended failed, stale, missing or cancelled, from 0 to 1; null when none ended.' } }),
}
export const workerCountFields = record({
  moving: { ...integer, description: 'Workers with tool calls in the last 10 minutes, or whose running command process tree used CPU, started processes or wrote output.' },
  waiting: { ...integer, description: 'Workers whose one running command has gone past the measured median tool time, or whose process tree is still.' },
  idle: { ...integer, description: 'Workers with no running command and no tool call in the last 10 minutes.' },
  'no live host': { ...integer, description: 'Workers whose session no live host holds.' },
  'finished unsettled': { ...integer, description: 'Workers whose change landed or whose pull request merged while the run is still recorded as running.' },
  workers: { ...integer, description: 'Runs recorded as planned, executing, waiting or blocked; the sum of the five states.' },
  waitingOn: rows(record({ command: text, ms: integer })),
  toolCallsPerMinute: { ...number, description: 'Tool calls started across all workers in the last 10 minutes, per minute.' },
  mergedPerHour: { ...integer, description: 'Runs landed in the last hour.' },
  windowMinutes: integer,
  text: { ...text, description: 'The counts as one plain sentence.' },
})
const stateReading = { ...record({ state: text, since: text, forMs: integer }), description: 'The one state of this run, process or host from the fixed set, when it entered that state and how long it has been in it.' }
const warning = record({ type: { enum: ['process-no-cpu', 'run-no-host', 'tool-past-p99', 'ask-unanswered', 'step-restarted', 'reload-storm', 'budget-rate', 'folder-missing'] }, owner: { enum: ['worker', 'host', 'Quest Giver', 'Jon'] }, at: text, forMs: integer, quest: text, run: text, text, evidence: record({}) })
const route = record({ role: { enum: ['giver'] }, automatic: { type: 'boolean' }, set: text, fallback: nullable('string'), live: text, on: { enum: ['set', 'fallback'] }, why: text, since: nullable('string'), goodAnswers: integer, probedAt: nullable('string'), moves: rows(record({ at: text, to: { enum: ['set', 'fallback'] }, why: text })) })
const freeReset = record({ at: text, basis: text, source: nullable('string'), local: text })
const freeLive = record({ used: integer, limit: integer, remaining: integer, resetAt: text, checkedAt: text, source: text })
const freeLimit = record({ lower: record({ requests: integer, tokens: integer }), upper: record({ requests: integer, tokens: integer }), basis: text, evidenceRows: integer, n: integer })
const freeLeft = record({ requests: integer, tokens: integer, upper: record({ requests: integer, tokens: integer }), basis: text, evidenceRows: integer, n: integer })
const freeBucket = record({ pool: text, label: text, provider: text, state: { enum: ['exhausted', 'usable', 'unknown'] }, estimate: text, confidence: text, n: integer, models: integer, currentModels: integer,
  used: record({ requests: integer, tokens: integer }), since: nullable('string'), limit: { anyOf: [freeLimit, { type: 'null' }] }, left: { anyOf: [freeLeft, { type: 'null' }] }, published: nullable('string'),
  live: { anyOf: [freeLive, { type: 'null' }] }, lastCutAt: nullable('string'), lastSuccessAt: nullable('string'), reset: { anyOf: [freeReset, { type: 'null' }] }, lastProbe: nullable('object') })
const freeModel = record({ route: text, provider: text, model: text, bucket: text, status: { enum: ['current', 'deprecated', 'unlisted'] }, efforts: rows(text), context: nullable('integer'), published: nullable('string'),
  iq: nullable('number'), coding: nullable('number'), outputTokensPerSecond: nullable('number'), firstTokenSeconds: nullable('number'), requestsSinceReset: nullable('integer'), tokensSinceReset: nullable('integer'),
  lastAt: nullable('string'), lastOutcome: nullable('string'), lastSuccessAt: nullable('string'), lastCutAt: nullable('string'), lastProbe: nullable('object') })
const freeOpenRouter = record({ key: { enum: ['configured', 'missing'] }, checkedAt: nullable('string'), error: nullable('string'), freeModelDailyRequests: { anyOf: [freeLive, { type: 'null' }] } })


const maybe = nullable('number')
const handoffCost = record({ promptTokens: maybe, promptCharacters: maybe, giverTurns: maybe, giverFreshInputTokens: maybe, giverCacheWriteTokens: maybe, giverCacheReadTokens: maybe, giverOutputTokens: maybe, giverFreshTokens: maybe, giverModelMs: maybe, giverTurnMs: maybe, toQuestMs: maybe, toFirstWorkerMs: maybe })
const handoffSummary = record({ handoffs: integer, promptTokens: maybe, giverTurns: maybe, giverFreshTokens: maybe, giverCacheReadTokens: maybe, medianPromptTokens: maybe, medianGiverTurns: maybe, medianGiverFreshTokens: maybe, medianToQuestMs: maybe, medianToFirstWorkerMs: maybe, measuredFirstWorker: integer })

export const READ_CONTRACT_VERSION = 1
export const READ_MCP_INSTRUCTIONS = 'Every tool reads Quest records, usage, workers, board, bench, routes, context, owners, handoffs and sessions without a model turn. Answers are short: ask for more with limit, include or detail. Nobody outside talks to the Quest Giver.'
export const readOperations = {
  usage: operation("Each account's remaining windows and resets, and the worker slots.", object({}),
    record({ at: number, updatedAt: nullable('string'), accounts: rows(record({ account: text, provider: text, state: text, stale: nullable('boolean'), windows: rows(window) })), diagnostics: rows(text), admission: record({ slots: nullable('integer'), basis: { enum: ['measured', 'unmeasured'] }, cores: integer, near: number, text, running: integer, landingWaiting: integer, waiting: integer, landedLastHour: integer, gateFiles: integer, affectedFiles: integer, gateUnloadedSeconds: nullable('number'), gateSecondsAtSlots: nullable('number'), gateSecondsAtNext: nullable('number'), affectedUnloadedSeconds: nullable('number'), affectedSecondsAtSlots: nullable('number'), measuredAt: text, checkRuns: integer, runsRecorded: integer, moving: nullable('integer'), waitingOnCommand: nullable('integer'), toolCallsPerMinute: nullable('number'), mergedPerHour: nullable('integer') }) })),
  workers: operation("Workers running now: the counts, then each one's Quest, run, route, minutes and status line. Run records: telemetry (docs/telemetry.md).", object({}),
    record({ at: number, running: { ...integer, description: 'Runs recorded as running. This is not work happening; read counts.' }, counts: workerCountFields, items: rows(record({ quest: text, title: text, run: text, state: text, route: nullable('string'), steps: rows(text), startedAt: nullable('string'), minutes: nullable('integer'), waiting: nullable('string'), session: nullable('string'), status: nullable('string'), statusKind: nullable('string'), observed: { anyOf: [stateReading, { type: 'null' }] } })), hosts: rows(record({ host: text, pid: integer, generation: nullable('string'), state: { enum: ['serving', 'draining', 'standby', 'down'] }, since: text, forMs: integer })) })),
  board: operation("Each open Quest's title and status, with the counts of what needs attention.", object({}),
    record({ at: number, ...boardCountFields, text, workers: workerCountFields, lanes: { type: 'object', additionalProperties: integer }, hold: record({ allowedQuests: rows(text), reason: text, until: text, setAt: text, text }), warnings: { ...rows(warning), description: 'Every anomaly raised and not yet cleared, newest first, each with its type, owner, time, how long ago and the evidence.' }, findings: { ...rows(record({ quest: text, title: text, at: text, kind: text, text })), description: 'Findings recorded on open Quests (a check-in, stall, stop, blocked or host finding, or a refused Quest creation), newest first. They stay on their Quest; nothing hands them to the Quest Giver.' }, items: rows(record({ quest: text, title: text, lane: text, state: text, done: integer, steps: integer, running: integer, updatedAt: nullable('string') })) })),
  routes: operation('The route the Quest Giver runs on now, the set route, its fallback or automatic routing, and why it moved.', object({}),
    record({ at: number, roles: rows(route), outages: record({}) })),
  context: operation('Context tokens per turn of the Quest Giver: the fixed part against old chat re-sent each turn.', object({}),
    record({ at: number, sessions: rows(record({ role: { enum: ['giver'] }, sessionID: text, turns: integer, first: nullable('integer'), last: nullable('integer'), peak: nullable('integer'), fixed: nullable('integer'), history: nullable('integer'), growthPerTurn: nullable('integer'), recent: rows(contextTurn) })) })),
  owners: operation('Who owns each open Quest: its Quest Giver, its open workers and the host holding each; what is away from the active host.', object({}),
    record({ at: number, activeHost: { anyOf: [record({ host: text, generation: nullable('string') }), { type: 'null' }] }, currentGiver: { anyOf: [record({ session: text, host: nullable('string') }), { type: 'null' }] }, owned: integer,
      items: rows(record({ quest: text, title: text, giver: nullable('string'), currentGiver: { type: 'boolean' }, host: nullable('string'), generation: nullable('string'), hostState: nullable('string'), workers: rows(record({ run: text, session: text, state: text, host: nullable('string'), generation: nullable('string'), hostState: nullable('string') })) })),
      away: rows(record({ role: { enum: ['giver', 'worker'] }, session: text, quest: text, host: nullable('string') })) })),
  telemetry: operation('The run record of one Quest: phase times and gaps of each run, speed, worker tokens and cost, route, routing decision with excluded routes, failures per route and outcome. No Quest: speed by route and work type. Where each number lives: docs/telemetry.md.', object({ quest: text, trace: { type: 'boolean', description: 'Add each run\'s time budget (every second in one named bucket, with unaccounted time), token budget, turns, tool calls, largest tool results and the raw trace file.' } }, []),
    record({ at: number, quest: text, head: text, runs: rows(record({})) }), { positional: ['quest'] }),
  handoffs: operation('Hand-offs to the Quest Giver, newest first, and where each ended: created, folded, refused or not placed. Run records: telemetry (docs/telemetry.md).', object({}),
    record({ at: number, lastDay: handoffSummary, items: rows(record({ messageID: text, sender: { enum: ['front', 'outside'] }, text, sentAt: text, state: text, reportedAt: nullable('string'), outcomes: rows(record({ kind: { enum: ['created', 'folded', 'refused', 'not placed'] }, quest: text, title: text, reason: text })), cost: { anyOf: [handoffCost, { type: 'null' }] } })) })),
  budget: operation("Each account's share of its weekly and 5-hour allowance by role and session, and the measured tokens per percent.", object({}),
    record({ at: number, basis: text, answer: rows(text), accounts: rows(record({ account: text, provider: text, plan: nullable('string'), week: record({}), fiveHour: {}, mapping: record({}), roles: rows(record({ role: text, sessions: integer, sharePercent: number, fiveHourPercent: nullable('number'), tokens: record({}) })), sessions: rows(record({ session: text, role: text, quest: nullable('string'), title: nullable('string'), sharePercent: number, fiveHourPercent: nullable('number'), tokens: record({}) })), sessionCount: integer })), diagnostics: rows(text) })),
  hygiene: operation('What the Quest hygiene pass closed, collapsed and flagged, and why. It changes nothing: a dry run of the saved rules on the open Quests.', object({}),
    record({ at: number, head: text, closed: rows(record({})), collapsed: rows(record({})), flagged: rows(record({})), wouldAct: rows(record({})), kept: integer, settings: record({}) })),
  sessions: operation('Each open worker and the current Quest Giver: state, status line, tool calls, cost, share of allowance, route and release.', object({}),
    record({ at: number, count: integer, items: rows(record({ role: { enum: ['worker', 'giver'] }, session: nullable('string'), quest: nullable('string'), title: text, run: nullable('string'), state: text, status: nullable('string'), route: nullable('string'), release: nullable('string'), startedAt: nullable('string'), toolCalls: nullable('integer'), toolCallsPerMinute: nullable('number'), costUSD: nullable('number'), weekSharePercent: nullable('number'), fiveHourSharePercent: nullable('number'), starterPrompt: nullable('string') })) })),
  hourly: operation('Per Eastern clock hour for the last 24 hours: PRs landed, spend at catalog rates, worker share of that spend and cost per landed PR, with today and this week beside them. Each row names its hour.', object({}),
    record({ at: number, zone: text, zoneName: text, text, hours: rows(record({ start: text, label: text, current: { type: 'boolean' }, prs: integer, spendUSD: number, workerUSD: number, workerSharePercent: nullable('number'), costPerPrUSD: nullable('number'), requests: integer, unpricedRequests: integer })), day: record({ since: text, label: text, prs: integer, spendUSD: number, workerUSD: number, workerSharePercent: nullable('number'), costPerPrUSD: nullable('number') }), week: record({ since: text, label: text, prs: integer, spendUSD: number, workerUSD: number, workerSharePercent: nullable('number'), costPerPrUSD: nullable('number') }), basis: text, diagnostics: rows(text) })),
  latency: operation('Model call median, p90 and max per model, and span means and worst cases by group (front is the read API, connection, dispatch, checks, host), with overTime buckets for charts. The quest CLI prints a table; --json gives JSON.',
    object({ window: { type: 'string', pattern: '^-?[0-9]+([.][0-9]+)?(s|m|h|d)$', description: 'How far back to read, such as 15m, 30m, 2h or 1d. Defaults to 30m.' } }),
    record({ at: number, from: number, window: text, bucketMilliseconds: integer, text,
      models: rows(record({ model: text, kind: text, count: integer, median: number, p90: number, max: number, outputTokensPerSecond: nullable('number') })),
      spans: rows(record({ group: { enum: ['front', 'connection', 'dispatch', 'checks', 'host'] }, span: text, count: integer, mean: number, max: number, total: number, errors: integer })),
      overTime: record({ models: rows(record({ start: number, model: text, count: integer, median: number, p90: number })), spans: rows(record({ start: number, group: text, span: text, count: integer, mean: number, max: number })) }),
      diagnostics: rows(text) }),
    { positional: ['window'] }),
  processes: operation('The leaderboard of every shell process workers started: running ones first, then by how long each ran, with its worker, run, Quest, command, state and how long in that state, CPU, output and exit code. The quest CLI prints a table; --json gives JSON.',
    object({ window: { type: 'string', pattern: '^-?[0-9]+([.][0-9]+)?(s|m|h|d)$', description: 'How far back to read, such as 30m, 2h or 1d. Defaults to 24h.' } }),
    record({ at: number, window: text, total: integer, running: integer, stuck: integer, states: { type: 'object', additionalProperties: integer }, text,
      rows: rows(record({ rank: integer, id: text, state: { enum: ['moving', 'quiet', 'stuck', 'ended', 'failed', 'lost'] }, since: text, inStateMs: integer, ranMs: integer, running: { type: 'boolean' }, worker: nullable('string'), run: nullable('string'), quest: nullable('string'), command: text, kind: text, startedAt: text, endedAt: nullable('string'), exitCode: nullable('integer'), cpuMs: integer, cpuShare: nullable('number'), peakCpuPercent: number, outputBytes: integer })),
      diagnostics: rows(text) }),
    { positional: ['window'] }),
  prefix: operation('The fixed starting context per role from the usage ledger: prompt, instructions and tool sizes each session sends before any chat, how many versions each has, which are identical across roles, and cache write and read.',
    object({ window: { type: 'string', pattern: '^-?[0-9]+([.][0-9]+)?(s|m|h|d)$', description: 'How far back to read, such as 6h, 1d or 7d. Defaults to 1d.' } }),
    record({ at: number, from: number, to: number, window: text, text,
      roles: rows(record({ role: text, sessions: integer, requests: integer, fixedTokens: nullable('number'), fixedTokensMeasuredSessions: integer, firstPromptTokens: nullable('number'), prefixVersions: integer,
        firstRequest: record({ cacheWrite: number, cacheRead: number, uncached: number }), allRequests: record({ cacheWrite: number, cacheRead: number, uncached: number }),
        changingSections: rows(text), sections: rows(record({ name: text, kind: { enum: ['system', 'tool'] }, versions: integer, tokens: nullable('number'), sharedWith: rows(text) })) })),
      shared: rows(record({ name: text, roles: rows(text), tokens: nullable('number') })),
      basis: text, diagnostics: rows(text) }),
    { positional: ['window'] }),
  history: operation('What one worker session did, in time order: its messages, each tool call with what it returned, and errors marked. Give a session id, a run id or part of a title. The window is -5m by default, or -all for the whole session. The quest CLI prints the text; --json gives JSON.',
    object({ session: { type: 'string', description: 'A session id (ses_...), a run id or part of a Quest, step or session title.' }, window: { type: 'string', pattern: '^-?([0-9]+([.][0-9]+)?(s|m|h|d)|all)$', description: 'How far back to read, such as -5m, -1h or -all. Defaults to -5m.' } }, ['session']),
    record({ at: number, session: text, window: text, messages: integer, lines: rows(text), text }),
    { positional: ['session', 'window'] }),
  rates: operation('Tool calls per tool in a window: calls, calls a minute, calls still running and mean seconds, across every worker session. The quest CLI prints a table; --json gives JSON.',
    object({ window: { type: 'string', pattern: '^-?[0-9]+([.][0-9]+)?(s|m|h|d)$', description: 'How far back to read, such as -15m or -1h. Defaults to -1h.' } }),
    record({ at: number, window: text, minutes: integer, sessions: integer, calls: integer, perMinute: number, text, tools: rows(record({ tool: text, calls: integer, perMinute: number, running: integer, meanMs: nullable('integer') })) }),
    { positional: ['window'] }),
  summary: operation('One picture of the workers: the counts, each worker with its progress verdict, running agents per minute over the last hour, tool rates for the last 15 minutes and completed runs per model. The quest CLI prints the text and tables; --json gives JSON.',
    object({}),
    record({ at: number, text, counts: workerCountFields, verdicts: { type: 'object', additionalProperties: integer },
      workers: rows(record({ quest: text, run: text, state: text, route: nullable('string'), minutes: nullable('integer'), status: nullable('string'), statusKind: nullable('string'), session: nullable('string') })),
      running: record({ minutes: integer, points: rows(integer), peak: integer, now: integer, mean: number }),
      rates: { anyOf: [record({}), { type: 'null' }] },
      finished: rows(record({ model: text, runs: integer, medianMinutes: integer, meanMinutes: integer })), diagnostics: rows(text) })),
  benchmarks: operation("Artificial Analysis models with every index, speed, latency and list price, matched to our routes (never-run ones too) or marked no route yet, plus the top unmatched by coding index and where our measurements disagree. Pass benchmark to order by one index. No network.", object({ benchmark: { type: 'string', enum: AA_BENCHMARKS, description: 'Index to order by and to show as the score. Default intelligence.' }, status: { type: 'string', enum: ['all', 'matched', 'no route yet'], description: 'Which models to list. Counts always cover every model. Default all.' } }), record({ at: text, benchmark: record({ category: text, label: text }), source: record({ fetchedAt: nullable('string'), ageHours: nullable('number'), stale: { type: 'boolean' }, tier: nullable('string'), indexVersion: nullable('number'), error: nullable('string'), lastChangeAt: nullable('string'), lastErrorAt: nullable('string'), refreshAttempts: integer }), counts: record({ aaModels: integer, matched: integer, noRouteYet: integer, routes: integer, routesWithAA: integer, disagreements: integer }), models: rows(record({ aaID: text, name: text, status: text, routes: { type: 'array', items: text }, score: record({ category: text, label: text, value: number, fellBack: { type: 'boolean' } }) })), routes: rows(record({ route: text, model: text, effort: nullable('string'), aaID: nullable('string'), aaName: nullable('string') })), diagnostics: { type: 'array', items: text } })),
  free: operation('Free models from OpenCode Zen, OpenCode Go and OpenRouter in one place: each provider bucket, what it has used and when it resets, OpenRouter\'s live daily counter, and each current model\'s quality, speed, context and published limit.', object({ all: { type: 'boolean', description: 'Include deprecated models as well as current ones.' } }),
    record({ at: integer, text, current: integer, deprecated: integer, unlisted: integer, reset: { anyOf: [freeReset, { type: 'null' }] }, pools: rows(freeBucket), models: rows(freeModel), openRouter: { anyOf: [freeOpenRouter, { type: 'null' }] }, diagnostics: rows(text) })),
  leaderboard: operation("Routes ranked for choosing a model: availability, allowance left, IQ index, median step time, plan-effective cost per step, success, and five labelled picks with reasons. Reads this computer's stores; no network. Pass benchmark to rank by one AA index.", object({ benchmark: { type: 'string', enum: AA_BENCHMARKS, description: 'Which Artificial Analysis index the IQ column shows. Default intelligence.' } }),
    record({ at: number, text, rows: rows(record({})), picks: rows(record({ label: text, route: nullable('string'), reason: text })), counts: record({}), missing: rows(text), accountUsage: record({}), diagnostics: rows(text), paths: record({}) })),
}


export function readTools(operations = readOperations) {
  return Object.entries(operations).map(([name, op]) => ({ name, description: op.description, inputSchema: op.input, outputSchema: op.output, annotations: op.annotations }))
}
