import {giverSettings,setGiverSettings} from './giver/giver-settings'
import {contextualError} from '../core/error.mts'
import {modeLine,trialOf} from './workers/trial'
import {categoriesIn,queueSettings,setCategoryEnabled,setLimits,setMode} from './workers/quest-queue'
import {trialQuests} from './workers/worker-admission'
import {readAllQuests} from './index'
import {webQuestRow} from './board/board-list'
import { readReferenceRegistry } from './core/references'
import { isQuestID } from './core/schema'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import {writeFileDurable} from './core/durable-file.mjs'
import { watchEntries } from './host/coordinator-events'
import { basename, dirname, join } from 'node:path'
import { watchRoutingDecisions, type RoutingEvent } from './routing/routing-history'
import { readRegistry, receiptName } from './interfaces/api-registry.mjs'
import { runningGeneration } from '../scripts/running-generation.mjs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { questOperations, questTools } from './operations.mjs'
import { GRANT_HEADER, MESSAGE_SCOPE, parseGrant, scopePermits } from './write-operations.mjs'
import { now as spanNow, recordSpan, timed } from '../scripts/plugin-spans'
import { readUserGiver } from './giver-registry.mjs'
import { physicalDirectory, physicalDirectoryIfPresent } from './core/project'
import { ownHostEndpoint } from './host/host-role'
import { usageWeb } from '../usage/web-api'
import { hostDatabaseFile } from '../usage/worker-time'
import { onAccountsChanged } from '../usage-service/on-computer'
import { PASSIVE_LEDGER_FILE } from '../usage/passive-ledger'
import { sweepHostDatabase } from './host/host-database-sweep'
import { refreshAnalysisInBackground } from '../models/artificial-analysis'
import { TELEMETRY_BUDGET } from '../scripts/telemetry-budget.mjs'
import { activeSessionIDs } from './core/retention'
import { questWebHTML, questWebURL } from './web'
import type { EvaluationSettings } from './routing/evaluation-settings'
import { Clock, Duration, Effect } from 'effect'
import type { Fiber } from 'effect'
import { timerClock } from './core/timer'
import { modelRouterHealth, modelRouterSettings, setModelRouterSettings } from './routing/model-router'
import { permissionJevSettings, setPermissionJevSettings, SECRET_FILES } from './permissions/permission-jev'
import { approvedCommands, removeApprovedShape } from './permissions/approved-commands'
import { recoverUserGiver, setUserGiverModel } from './giver/user-giver'
import type { GiverBinding } from './giver/giver-binding'
import type { QuestStore } from './store'
import type { createQuestService } from './host/service'
import type { QuestHost } from './runs/runtime'
import {questSettingsFile} from './config/quest-settings.mjs'
import { handOffGiver } from './giver/giver-api'
import { createReadAPI } from './board/read-api'
import { hostCapabilities } from './capabilities.mjs'
import { readOperations } from './read-operations.mjs'
import { QUEST_MCP_PATH, matchQuestRoute, readOperationFrom, mcpSessionFrom, mcpSessionPath, operationFrom, outsidePath } from './config/registry.mts'
import { onHostEvent } from './host/host-observation'
import { studioDrafts, saveStudioDraft, promoteStudioDraft, StudioError } from './artifacts/studio-drafts'
import { readCanvas, saveCanvas, canvasToDraft } from './artifacts/studio-canvas'
import { canvasAsPen, canvasFromPen } from './artifacts/studio-pen'
import { decideVariation, iterateVariations, setAskToPick, startVariations, studioVariations } from './artifacts/studio-variations'

const USAGE_EVENT_GAP_MS = 2000

export function openCodeMCPSession(metadata: Record<string, unknown> | undefined): string {
  const current = metadata?.['ai.opencode/sessionID'], legacy = metadata?.sessionID
  const valid = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  if ((current !== undefined && !valid(current)) || (legacy !== undefined && !valid(legacy)))
    throw Error('The OpenCode MCP connection supplied an invalid session identity.')
  if (current !== undefined && legacy !== undefined && current !== legacy)
    throw Error('The OpenCode MCP connection supplied conflicting session identities.')
  const sessionID = current ?? legacy
  if (!valid(sessionID)) throw Error('The OpenCode MCP connection must supply its session identity.')
  return sessionID
}

type GiverHost = Pick<QuestHost, 'create' | 'get'> & Partial<Pick<QuestHost, 'switchModel' | 'prompt' | 'context' | 'generate' | 'interrupt'>>
export const GIVER_SPEAKING = new Set(['message', 'succeed_giver'])
export const outsideCaller = (headers: Record<string, string | string[] | undefined>) => headers['x-quest-audience'] === 'outside' || typeof headers['x-quest-bot-key'] === 'string'
export const grantedCaller = (headers: Record<string, string | string[] | undefined>) => typeof headers['x-quest-bot-key'] === 'string' ? undefined : parseGrant(headers[GRANT_HEADER])
export const grantRefusal = (scope: string) => ({ code: 'SCOPE_REQUIRED', message: 'This grant does not allow that. The user can allow ' + scope + ' for this app in Quest Web Settings.' })
export const internalOnlyRefusal = { code: 'INTERNAL_ONLY', message: 'The Quest API and the usage API are internal: only the Quest Giver, workers and the website backend reach them. Outside callers read through /read (the quest CLI and Quest MCP do this).' }
type Registration = { id: string; owner: string; service: ReturnType<typeof createQuestService>; host?: GiverHost; binding?: GiverBinding }
type EvaluationSettingsAPI = { read: () => EvaluationSettings; write: (value: EvaluationSettings) => EvaluationSettings }
type SettingsAPIs = Record<'model-router' | 'permission-jev', EvaluationSettingsAPI>
const servers = new Map<string, { registrations: Set<Registration>; endpoint: ReturnType<typeof openQuestServer> }>()
const giverBindErrors = new Map<string, string>()
export function recordGiverBindError(runtime: string, message: string | undefined) {
  if (message) giverBindErrors.set(runtime, message); else giverBindErrors.delete(runtime)
  void servers.get(runtime)?.endpoint.then(endpoint => endpoint.publishReadiness(), () => {})
}

const defaultModelRouter: EvaluationSettingsAPI = { read: modelRouterSettings, write: setModelRouterSettings }
const defaultPermissionJev: EvaluationSettingsAPI = { read: () => permissionJevSettings(), write: value => setPermissionJevSettings(value) }
function sharedServer(store: QuestStore, modelRouter: EvaluationSettingsAPI, permissionJev: EvaluationSettingsAPI) {
  let shared = servers.get(store.runtime)
  if (!shared) {
    const registrations = new Set<Registration>()
    shared = { registrations, endpoint: openQuestServer(store, registrations, { 'model-router': modelRouter, 'permission-jev': permissionJev }) }
    servers.set(store.runtime, shared)
  }
  return shared
}
export async function openQuestListener(store: QuestStore) {
  const endpoint = await sharedServer(store, defaultModelRouter, defaultPermissionJev).endpoint
  return { url: endpoint.url }
}

export async function serveQuestAPI(store: QuestStore, service: ReturnType<typeof createQuestService>, directory: string, host?: GiverHost, modelRouter: EvaluationSettingsAPI = defaultModelRouter, permissionJev: EvaluationSettingsAPI = defaultPermissionJev, binding?: GiverBinding) {
  const registration = { id: randomUUID(), owner: physicalDirectory(directory), service, host, binding }
  const shared = sharedServer(store, modelRouter, permissionJev)
  shared.registrations.add(registration)
  const current = shared
  void current.endpoint.then(endpoint => endpoint.publishReadiness(), () => {})
  let disposed = false
  const remove = () => {
    if (disposed) return
    disposed = true
    current.registrations.delete(registration)
    void current.endpoint.then(endpoint => endpoint.publishReadiness(), () => {})
    if (!current.registrations.size && servers.get(store.runtime) === current) servers.delete(store.runtime)
  }
  try {
    const endpoint = await current.endpoint
    return { url: endpoint.url, token: endpoint.token, webURL: questWebURL(endpoint.url, endpoint.token), mcpURL: endpoint.url + mcpSessionPath(registration.id),
      dispose() { remove(); endpoint.closeRegistration(registration.id); if (!current.registrations.size) endpoint.dispose(); setImmediate(() => void reopenClosedGiverLocation(store.runtime, registration.owner)) },
    }
  } catch (error) { remove(); throw error }
}

async function reopenClosedGiverLocation(runtime: string, owner: string) {
  let giver: ReturnType<typeof readUserGiver>
  try { giver = readUserGiver(runtime) } catch { return }
  if (giver?.state !== 'bound' || physicalDirectoryIfPresent(giver.directory) !== owner) return
  if ([...servers.get(runtime)?.registrations ?? []].some(row => row.owner === owner)) return
  const host = ownHostEndpoint()
  if (!host) return
  const url = new URL('/api/model', host.url)
  url.searchParams.set('directory', giver.directory)
  url.searchParams.set('location[directory]', giver.directory)
  try {
    const answer = await fetch(url, { headers: { authorization: host.authorization }, signal: AbortSignal.timeout(60_000) })
    await answer.body?.cancel()
    if (!answer.ok) throw Error('the host answered ' + answer.status)
    console.error('[quests] reopened the Quest Giver folder the host closed:', giver.directory)
  } catch (error) { console.error('[quests] the host closed the Quest Giver folder and reopening it failed:', error instanceof Error ? error.message : error) }
}

const identity = (() => {
  const generation = runningGeneration()
  let commit: string | null = null
  try { commit = JSON.parse(readFileSync(join(import.meta.dirname, '..', '.deployment-source.json'), 'utf8')).commit ?? null } catch {}
  return { generation, commit }
})()

async function openQuestServer(store: QuestStore, registrations: Set<Registration>, settings: SettingsAPIs) {
  const token = randomBytes(32).toString('hex'), instance = randomUUID(), startedAt = new Date().toISOString()
  const registry = process.env.QUEST_API_REGISTRY ?? join(store.runtime, 'quest-api')
  const record = join(registry, receiptName(process.pid, store.runtime, instance))
  const mcpSessions = new Map<string, { route: string; registrationID?: string; transport: StreamableHTTPServerTransport; pending: Map<string | number, AbortController> }>()
  const closeRegistration = (id: string) => { for (const row of mcpSessions.values()) if (row.registrationID === id) void row.transport.close() }
  const servingRegistration = (directory: unknown) => typeof directory === 'string' && ([...registrations].find(row => row.owner === directory) ?? (physicalDirectoryIfPresent(directory) ? undefined : [...registrations].find(row => physicalDirectoryIfPresent(row.owner))))
  const giver = () => {
    const current = readUserGiver(store.runtime)
    const registration = current?.state === 'bound' && servingRegistration(current.directory)
    return registration ? { sessionID: current.sessionID, service: registration.service, host: registration.host, owner: registration.owner } : undefined
  }
  const recoverableGiver = () => {
    const current = readUserGiver(store.runtime)
    const registration = current?.directory && servingRegistration(current.directory)
    return registration ? { current, host: registration.host, owner: registration.owner } : undefined
  }
  let binding: ReturnType<typeof readUserGiver>, bound: string | undefined, giverSession: string | undefined
  const refreshBinding = () => { try { const row = readUserGiver(store.runtime); binding = row; bound = row?.state === 'bound' ? row.directory : undefined; giverSession = row?.state === 'bound' ? row.sessionID : undefined } catch { binding = undefined; bound = undefined; giverSession = undefined } setImmediate(publishReadiness) }
  let receipt: Record<string, unknown> | undefined, published: boolean | undefined, publishedError: string | undefined, readyAt: number | undefined
  function publishReadiness() {
    if (!receipt) return
    const now = !!bound && [...registrations].some(row => row.owner === bound)
    const bindError = now ? undefined : giverBindErrors.get(store.runtime)
    if (now === published && bindError === publishedError) return
    if (now && now !== published) readyAt = Date.now()
    published = now
    publishedError = bindError
    try { writeFileDurable(record, JSON.stringify({ ...receipt, ready: now, ...(now ? { readyAt } : {}), ...(bindError ? { bindError } : {}) }), { mode: 0o600 }) }
    catch (error) { console.error('[quests] Quest API receipt not updated:', error instanceof Error ? error.message : error) }
  }
  refreshBinding()
  let watched = false, bindingWatcher: ReturnType<typeof watchEntries> | undefined
  try {
    mkdirSync(store.runtime, { recursive: true })
    const watcher = watchEntries(store.runtime, { names: ['user-giver.json'] }, () => refreshBinding())
    bindingWatcher = watcher
    watcher.on('error', () => { watched = false }); watcher.on('close', () => { watched = false }); watched = true
    refreshBinding()
  } catch {}
  const ready = () => { if (!watched) refreshBinding(); return !!bound && [...registrations].some(row => row.owner === bound) }
  const giverBinding = () => [...registrations].find(row => row.binding)?.binding
  const bindGiver = async () => { const pending = giverBinding(); if (!pending) return false; const done = await pending.bind(); refreshBinding(); return done }
  const runModeView = () => {
    const settings = queueSettings(), quests = trialQuests(store.projectRoot, settings)
    const text = modeLine(quests, settings), trial = settings.mode === 'trial' ? trialOf(quests, settings) : undefined
    return { mode: settings.mode, ...(text ? { text } : {}), ...(trial ? { allowed: trial.allowed, clean: trial.clean, cap: trial.cap } : {}) }
  }
  const call = (method: string, input: unknown, sessionID: string | undefined, requestID: string, service = giver()?.service, external = false, audience = external ? 'web' : 'agent', waiting: {signal?:AbortSignal;progress?:(value:any)=>Promise<void>;historyFrom?:string} = {}) => {
    if (!service) void bindGiver()
    if (!sessionID || !service) throw Error('The Quest Giver service is not connected yet.')
    const view = method === 'list' && input && typeof input === 'object' && typeof (input as { view?: unknown }).view === 'string' ? ' ' + (input as { view: string }).view : ''
    return timed({ plugin: 'quests', name: 'quests.api', op: method + view, sessionID }, () => service.call(method, input, { sessionID, id: requestID, external, native: !external, audience, ...waiting }))
  }
  const readAPI = createReadAPI(store)
  const listeners = new Set<(id: string) => void>()
  let journals: ReturnType<typeof watchEntries> | undefined
  const listen = (listener: (id: string) => void) => {
    listeners.add(listener)
    if (!journals) {
      const directory = join(store.runtime, 'journals')
      mkdirSync(directory, { recursive: true })
      journals = watchEntries(directory, { matches: name => name.endsWith('.jsonl') && isQuestID(name.slice(0, -6)) }, name => { if (name) for (const each of listeners) each(name.slice(0, -6)) })
      journals.on('error', () => { journals = undefined })
    }
    return () => { listeners.delete(listener); if (!listeners.size) { journals?.close(); journals = undefined } }
  }
  const routingListeners = new Set<(event: RoutingEvent) => void>()
  let routingWatch: ReturnType<typeof watchRoutingDecisions> | undefined
  const listenRouting = (listener: (event: RoutingEvent) => void) => {
    routingListeners.add(listener)
    if (!routingWatch) {
      try {
        routingWatch = watchRoutingDecisions(store.runtime, event => { for (const each of routingListeners) each(event) })
        routingWatch.on('error', () => { routingWatch = undefined })
      } catch {}
    }
    return () => { routingListeners.delete(listener); if (!routingListeners.size) { routingWatch?.close(); routingWatch = undefined } }
  }
  const usageListeners = new Set<() => void>()
  let usageWatches: { close(): void }[] = []
  const listenUsage = (listener: () => void) => {
    usageListeners.add(listener)
    if (!usageWatches.length) {
      const changed = () => { for (const each of usageListeners) each() }
      const ledger = basename(PASSIVE_LEDGER_FILE)
      try {
        const watch = watchEntries(dirname(PASSIVE_LEDGER_FILE), { names: [ledger, ledger + '-wal'] }, changed)
        watch.on('error', () => { usageWatches = usageWatches.filter(held => held !== watch) })
        usageWatches.push(watch)
      } catch {}
      try { usageWatches.push({ close: onAccountsChanged(changed) }) } catch {}
    }
    return () => { usageListeners.delete(listener); if (!usageListeners.size) { for (const watch of usageWatches) watch.close(); usageWatches = [] } }
  }
  const eventsRegion = (response: ServerResponse) => Effect.scoped(Effect.gen(function* () {
    const send = (value: unknown) => { response.write('data: ' + JSON.stringify(value) + '\n\n') }
    const pending = new Map<string, Fiber.Fiber<void, never>>()
    let usage: Fiber.Fiber<void, never> | undefined
    const questChanged = (id: string) => Effect.gen(function* () {
      yield* Effect.sleep('50 millis')
      yield* Effect.sync(() => {
        pending.delete(id)
        send({ type: 'quest.changed', id: readReferenceRegistry(store.projectRoot).entries.find(entry => entry.id === id)?.ref ?? id })
      })
    })
    const usageChanged = Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(USAGE_EVENT_GAP_MS))
      yield* Effect.sync(() => { usage = undefined; send({ type: 'usage.changed' }) })
    })
    const lane = (effect: Effect.Effect<void>) => Effect.runFork(effect.pipe(Effect.provideService(Clock.Clock, timerClock)))
    yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
      yield* Effect.sleep('25 seconds')
      yield* Effect.sync(() => { response.write(': heartbeat\n\n') })
    })))
    yield* Effect.acquireRelease(
      Effect.sync(() => listen(id => { if (!pending.has(id)) pending.set(id, lane(questChanged(id))) })),
      unlisten => Effect.sync(unlisten))
    yield* Effect.acquireRelease(
      Effect.sync(() => listenRouting(send)),
      unlisten => Effect.sync(unlisten))
    yield* Effect.acquireRelease(
      Effect.sync(() => listenUsage(() => { if (!usage) usage = lane(usageChanged) })),
      unlisten => Effect.sync(unlisten))
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      for (const fiber of pending.values()) fiber.interruptUnsafe()
      pending.clear()
      usage?.interruptUnsafe()
      usage = undefined
    }))
    yield* Effect.never
  }))
  let nextHostSweep = 0
  const startHostSweep = () => {
    if (Date.now() < nextHostSweep) return
    nextHostSweep = Date.now() + 60 * 60_000
    refreshAnalysisInBackground()
    sweepHostDatabase({ file: hostDatabaseFile(), budget: TELEMETRY_BUDGET.hostDatabaseBytes, protectedSessionIDs: activeSessionIDs(store.root) })
      .catch(error => console.error('[quests] host database budget not enforced', error instanceof Error ? error.message : error))
  }
  const http = createServer(async (request, response) => {
    startHostSweep()
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(value)) }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = matchQuestRoute(request.method ?? '', pathname)
    const requestStart = spanNow()
    const requestDone = () => recordSpan({ plugin: 'quests', name: 'request', op: request.method + ' ' + pathname, route: pathname, start: requestStart, end: spanNow(), outcome: response.writableFinished ? String(response.statusCode) : 'interrupted' })
    response.once('close', requestDone)
    if (route === 'web') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      })
      response.end(questWebHTML()); return
    }
    const authorization = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from('Bearer ' + token)
    const origin = request.headers.origin
    const sameOrigin = !origin || origin === 'http://' + request.headers.host
    if (!sameOrigin || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      json(403, { code: 'FORBIDDEN', message: 'Quest API credentials and the local Quest Web origin are required.' }); return
    }
    const grant = grantedCaller(request.headers)
    const outside = outsideCaller(request.headers) || typeof request.headers[GRANT_HEADER] === 'string'
    const granted = grant && scopePermits(grant.scopes, operationFrom(pathname) ?? '')
    if (outside && !outsidePath(pathname) && !granted) { json(403, internalOnlyRefusal); return }
    try {
      const readMethod = readOperationFrom(pathname)
      if (readMethod) {
        if (request.method !== 'POST') { json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Read operations are POST.' }); return }
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
        json(200, await timed({ plugin: 'quests', name: 'read.api', op: readMethod }, () => readAPI.call(readMethod, input))); return
      }
      if (route === 'health') {
        const healthy = ready(), current = binding
        const pending = healthy ? undefined : giverBinding()
        if (pending) void bindGiver()
        const recovery = current && current.state !== 'bound' || pending ? { required: current?.state !== 'bound', state: current?.state ?? 'unbound', recoverable: !!current?.candidateSessionID, replacement: current?.replacement === true, ...pending?.status() } : undefined
        json(200, { instance, ready: healthy, giverSessionID: healthy ? giverSession : undefined, previousGiverSessionIDs: healthy && Array.isArray(current?.previousSessionIDs) ? current.previousSessionIDs : [], recovery, pid: process.pid, startedAt, ...identity }); return
      }
      if (route === 'capabilities') { json(200, hostCapabilities(identity, Object.keys(readOperations), Object.keys(questOperations))); return }
      if (route === 'contract') { json(200, questOperations); return }
      if (route === 'giverSettings') { json(200, giverSettings()); return }
      if (route === 'saveGiverSettings') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        json(200, setGiverSettings(JSON.parse(Buffer.concat(chunks).toString('utf8')))); return
      }
      if (route === 'questCategories') { json(200, { categories: categoriesIn(readAllQuests(store.projectRoot).flatMap(row => row.quest ? [row.quest] : []), queueSettings()) }); return }
      if (route === 'saveQuestCategory') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        setCategoryEnabled(input?.name, input?.enabled)
        json(200, { categories: categoriesIn(readAllQuests(store.projectRoot).flatMap(row => row.quest ? [row.quest] : []), queueSettings()) }); return
      }
      if (route === 'questLimits') { json(200, queueSettings().limits); return }
      if (route === 'saveQuestLimits') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        json(200, setLimits({ ...('workers' in input ? { workers: input.workers } : {}), ...('quests' in input ? { quests: input.quests } : {}) }).limits); return
      }
      if (route === 'questMode') { json(200, runModeView()); return }
      if (route === 'saveQuestMode') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        setMode(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.mode)
        json(200, runModeView()); return
      }
      if (route === 'permissionSecretFiles') { json(200, { files: SECRET_FILES }); return }
      if (route === 'approvedCommands') { json(200, approvedCommands()); return }
      if (route === 'removeApprovedCommand') {
        const shape = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('shape')
        if (!shape) { json(400, { code: 'SHAPE_REQUIRED', message: 'Name the command shape to remove.' }); return }
        json(200, removeApprovedShape(shape)); return
      }
      if (route === 'modelRouterHealth') { json(200, modelRouterHealth()); return }
      const settingRead = route === 'modelRouter' ? 'model-router' : route === 'permissionJev' ? 'permission-jev' : undefined
      if (settingRead) { json(200, settings[settingRead].read()); return }
      const settingWrite = route === 'saveModelRouter' ? 'model-router' : route === 'savePermissionJev' ? 'permission-jev' : undefined
      if (settingWrite) {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        json(200, settings[settingWrite].write(JSON.parse(Buffer.concat(chunks).toString('utf8')))); return
      }
      if (route === 'newGiver') {
        const current = giver()
        if (!current?.host) throw Error('The connected Quest Giver cannot create a new conversation yet.')
        const result = await handOffGiver(store, current.host, current.owner, 'a new Quest Giver was asked for')
        refreshBinding()
        json(200, result); return
      }
      if (route === 'recoverGiver') {
        const current = recoverableGiver()
        if (!current?.host) throw Error('The uncertain Quest Giver is not connected to an authenticated host.')
        const result = await recoverUserGiver(store, current.host)
        refreshBinding()
        json(200, result); return
      }
      if (route === 'giverModel') {
        const current = giver()
        if (!current?.host) throw Error('The connected Quest Giver cannot switch models yet.')
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        json(200, await setUserGiverModel(store, current.host, input.sessionID, input.model)); return
      }
      if (route === 'webQuests') {
        const items: unknown[] = []
        let offset = 0, page: any
        for (;;) {
          page = await call('list', { allProjects: true, archived: false, view: 'board', offset, limit: 100 }, giver()?.sessionID, instance + ':' + randomUUID(), giver()?.service, true)
          if (Array.isArray(page.items)) items.push(...page.items)
          if (page.nextOffset === null || page.nextOffset === undefined) break
          if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw Error('Quest pagination did not advance')
          offset = page.nextOffset
        }
        json(200, { items: items.map(webQuestRow), total: page?.total ?? items.length }); return
      }
      if (route === 'webUsage') {
        const query = new URL(request.url!, 'http://127.0.0.1').searchParams
        if (!query.has('allSessions')) query.set('allSessions', 'true')
        json(200, await usageWeb('/status?' + query)); return
      }
      if (route === 'studioDrafts') {
        const id = new URL(request.url!, 'http://127.0.0.1').searchParams.get('id')
        if (!id || !isQuestID(id)) throw new StudioError('INVALID_QUEST', 'Choose a Quest before opening its drafts.')
        json(200, studioDrafts(store, id)); return
      }
      if (route === 'saveStudioDraft' || route === 'promoteStudioDraft') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!input || typeof input.id !== 'string' || !isQuestID(input.id)) throw new StudioError('INVALID_QUEST', 'Choose a Quest before saving its draft.')
        json(200, route === 'promoteStudioDraft' ? await promoteStudioDraft(store, input) : saveStudioDraft(store, input)); return
      }
      if (route === 'studioVariations') {
        const id = new URL(request.url!, 'http://127.0.0.1').searchParams.get('id')
        if (!id || !isQuestID(id)) throw new StudioError('INVALID_QUEST', 'Choose a Quest before opening its variations.')
        json(200, timed({ plugin: 'quests', name: 'studio.api', op: 'variations' }, () => studioVariations(store, id))); return
      }
      if (route === 'askStudioVariations') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!input || typeof input.id !== 'string' || !isQuestID(input.id)) throw new StudioError('INVALID_QUEST', 'Choose a Quest before asking to pick.')
        json(200, timed({ plugin: 'quests', name: 'studio.api', op: 'ask to pick' }, () => setAskToPick(store, input))); return
      }
      const variationAction = route === 'startStudioVariations' ? 'start' : route === 'decideStudioVariation' ? 'decide' : route === 'iterateStudioVariations' ? 'iterate' : undefined
      if (variationAction) {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!input || typeof input.id !== 'string' || !isQuestID(input.id)) throw new StudioError('INVALID_QUEST', 'Choose a Quest before changing its variations.')
        json(200, timed({ plugin: 'quests', name: 'studio.api', op: 'variations ' + variationAction }, () => variationAction === 'start' ? startVariations(store, input) : variationAction === 'iterate' ? iterateVariations(store, input) : decideVariation(store, input))); return
      }
      if (route === 'studioCanvas') {
        const id = new URL(request.url!, 'http://127.0.0.1').searchParams.get('id')
        if (!id || !isQuestID(id)) throw new StudioError('INVALID_QUEST', 'Choose a Quest before opening its canvas.')
        json(200, readCanvas(store, id)); return
      }
      if (route === 'saveStudioCanvas' || route === 'studioCanvasCode') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!input || typeof input.id !== 'string' || !isQuestID(input.id)) throw new StudioError('INVALID_QUEST', 'Choose a Quest before saving its canvas.')
        json(200, route === 'saveStudioCanvas' ? saveCanvas(store, input, 'Jon') : canvasToDraft(store, input)); return
      }
      if (route === 'studioCanvasPen') {
        const id = new URL(request.url!, 'http://127.0.0.1').searchParams.get('id')
        if (!id || !isQuestID(id)) throw new StudioError('INVALID_QUEST', 'Choose a Quest before exporting its canvas.')
        json(200, canvasAsPen(store, id)); return
      }
      if (route === 'importStudioCanvasPen') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!input || typeof input.id !== 'string' || !isQuestID(input.id)) throw new StudioError('INVALID_QUEST', 'Choose a Quest before importing a .pen file.')
        json(200, canvasFromPen(store, input, 'Jon')); return
      }
      if (route === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.write('data: ' + JSON.stringify({ type: 'connected', instance }) + '\n\n')
        const region = Effect.runFork(eventsRegion(response).pipe(Effect.provideService(Clock.Clock, timerClock)))
        response.once('close', () => region.interruptUnsafe())
        return
      }
      const sessionRoute = mcpSessionFrom(pathname)
      if (pathname === QUEST_MCP_PATH || sessionRoute) {
        const registration = sessionRoute && [...registrations].find(row => row.id === sessionRoute)
        if (sessionRoute && !registration) { json(410, { code: 'LOCATION_CLOSED', message: 'The owning OpenCode location disconnected.' }); return }
        const transportID = request.headers['mcp-session-id']
        let body: any
        if (request.method === 'POST') {
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        }
        if (transportID !== undefined) {
          const row = typeof transportID === 'string' ? mcpSessions.get(transportID) : undefined
          if (!row || row.route !== pathname) { json(404, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP session not found. Initialize a new session.' } }); return }
          if (body?.method === 'tools/call' && (typeof body.id === 'string' || typeof body.id === 'number')) {
            if (row.pending.has(body.id)) { json(400, { jsonrpc: '2.0', id: body.id, error: { code: -32600, message: 'Request ID is already active in this MCP session.' } }); return }
            const controller = new AbortController()
            row.pending.set(body.id, controller)
            response.once('close', () => {
              controller.abort(new Error('Quest MCP request closed'))
              if (row.pending.get(body.id) === controller) row.pending.delete(body.id)
            })
          }
          await row.transport.handleRequest(request, response, body)
          return
        }
        if (!isInitializeRequest(body)) { json(400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Initialize an MCP session before calling tools.' } }); return }
        const mcp = new Server({ name: 'quests', version: '1.0.0' }, { capabilities: { tools: {} } })
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: questTools() }))
        const pending = new Map<string | number, AbortController>()
        mcp.setRequestHandler(CallToolRequestSchema, async (message, extra) => {
          try {
            const metadata = message.params._meta
            const sessionID = openCodeMCPSession(metadata)
            const result = await timed({ plugin: 'quests', name: 'tool.execute', op: message.params.name, sessionID, route: pathname }, () => call(message.params.name, message.params.arguments ?? {}, sessionID, instance + ':' + transport.sessionId + ':' + extra.requestId, registration ? registration.service : giver()?.service, !registration, 'agent', {
              historyFrom: registration ? 'runtime' : 'terminal',
              signal: AbortSignal.any([extra.signal, ...(pending.get(extra.requestId) ? [pending.get(extra.requestId)!.signal] : [])]),
              progress: async value => {
                const progressToken=message.params._meta?.progressToken
                if(progressToken!==undefined)await extra.sendNotification({method:'notifications/progress',params:{progressToken,progress:value.waitingSeconds,message:'Waiting for saved Quest progress'}})
              },
            }))
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }
          } catch (error) {
            return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: (error as any).code ?? 'REQUEST_FAILED', message: (error as Error).message }) }] }
          }
        })
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: false,
          onsessioninitialized: id => { mcpSessions.set(id, { route: pathname, registrationID: registration ? registration.id : [...registrations].find(row => row.owner === giver()?.owner)?.id, transport, pending }) },
        })
        transport.onclose = () => {
          if (transport.sessionId) mcpSessions.delete(transport.sessionId)
          for (const controller of pending.values()) controller.abort(new Error('Quest MCP session closed'))
          pending.clear()
        }
        await mcp.connect(transport)
        try { await transport.handleRequest(request, response, body) }
        finally { if (!transport.sessionId) await mcp.close() }
        return
      }
      const method = operationFrom(pathname)
      if (!method || request.method !== 'POST') { json(404, { code: 'NOT_FOUND', message: 'Unknown Quest API endpoint' }); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const requestID = request.headers['idempotency-key']
      if (typeof requestID !== 'string' || !requestID.trim()) { json(400, { code: 'INVALID_INPUT', message: 'An idempotency-key header is required.' }); return }
      if (GIVER_SPEAKING.has(method) && !(grant && method === 'message' && grant.scopes.includes(MESSAGE_SCOPE))) { json(403, { code: 'GIVER_UNREACHABLE', message: 'Nobody outside talks to the Quest Giver. Talk to it in the Quest Web conversation.' }); return }
      const caller = new AbortController()
      response.once('close', () => { if (!response.writableFinished) caller.abort(new Error('The Quest API caller closed the request')) })
      const bot=request.headers['x-quest-bot-key'], botName=typeof bot==='string'?/name=([^;]+)/.exec(bot)?.[1]:undefined
      const historyFrom=grant?grant.name+' (app Jon allowed)':botName?decodeURIComponent(botName):request.headers['x-quest-audience']==='agent'?'terminal':'Quest Web'
      if (grant && method === 'message' && input && typeof input === 'object' && typeof input.text === 'string') input.text = 'From ' + grant.name + ', an outside app the user allowed to message you. This is not the user speaking; decide for yourself what to do with it. ' + input.text
      const answering = performance.now()
      const answer = await call(method, input, giver()?.sessionID, requestID, giver()?.service, true, request.headers['x-quest-audience'] === 'agent' ? 'agent' : 'web', { signal: caller.signal, historyFrom, outside: grant !== undefined || outsideCaller(request.headers) })
      json(200, answer, { 'server-timing': 'quest;dur=' + (performance.now() - answering).toFixed(1) })
    } catch (error) {
      if (!response.headersSent) {
        const failure=contextualError(error,{operation:(request.method??'GET')+' '+pathname,location:'Quest API; records at '+store.projectRoot,next:'Check the saved Quest or settings and the linked computer log before repeating this action.'})
        json(error instanceof StudioError ? error.status : 400, { code: failure.code ?? 'REQUEST_FAILED', message: failure.message, context:failure.context })
      }
    }
  })
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  http.unref()
  startHostSweep()
  const url = 'http://127.0.0.1:' + (http.address() as { port: number }).port
  mkdirSync(registry, { recursive: true })
  readRegistry(registry)
  const hostPassword = process.env.OPENCODE_PASSWORD || undefined
  receipt = { version: 2, instance, url, token, pid: process.pid, startedAt: Date.parse(startedAt), generation: identity.generation, commit: identity.commit, hostPassword }
  recordSpan({ plugin: 'quests', name: 'startup', op: 'api ready', start: performance.timeOrigin, end: spanNow() })
  publishReadiness()
  return {
    url, token, closeRegistration, publishReadiness,
    dispose() { receipt = undefined; bindingWatcher?.close(); journals?.close(); routingWatch?.close(); for (const row of mcpSessions.values()) void row.transport.close(); http.close(); try { unlinkSync(record) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } },
  }
}
