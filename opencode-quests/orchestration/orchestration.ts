import { ledgerLockStatus, claimCompletionDelivery, suppressCompletionDelivery, recordCompletionDelivered, recordCompletionDeliveryFailed, recordNativeSessionLineage, recordNotification, recordTerminal, pendingCompletionEvidence, readLedger, completionDeliveryClaimed, type CompletionEvidence } from "./orchestration-ledger"
import { injectCompletion } from "./watchdog-inject"
import { detectProviderFailure, failureMessage, USAGE_REACHED, type ProviderFailure } from "../usage/usage-reached"

async function parentSessionGone(sessionApi: { get?: Function }, parentID: string): Promise<boolean> {
  if (typeof sessionApi?.get !== "function") return false
  try {
    const res = await sessionApi.get({ sessionID: parentID })
    const row = (res as { data?: unknown })?.data ?? res
    return !row
  } catch (error) {
    const failure = error as { status?: number; statusCode?: number; response?: { status?: number } }
    if ((failure?.status ?? failure?.statusCode ?? failure?.response?.status) === 404) return true
    throw error
  }
}

export async function deliverPendingCompletion(sessionApi: { synthetic?: Function; get?: Function }, completion: CompletionEvidence, file?: string): Promise<boolean> {
  const pending = pendingCompletionEvidence(completion.parentID, file).find((entry) => entry.idempotencyKey === completion.idempotencyKey)
  if (!pending) return true
  if (await parentSessionGone(sessionApi, pending.parentID)) return suppressCompletionDelivery(pending, file)
  if (completionDeliveryClaimed(pending)) return suppressCompletionDelivery(pending, file, "Quest return owner delivers this completion; native synthetic suppressed")
  if (!claimCompletionDelivery(pending, file)) return true
  if (!await injectCompletion(sessionApi, pending)) {
    recordCompletionDeliveryFailed(pending.parentID, pending.idempotencyKey, file)
    return false
  }
  return recordCompletionDelivered(pending.parentID, pending.idempotencyKey, file)
}

const CANCEL_EVENTS = new Set(["session.execution.cancelled", "session.execution.interrupted"])

const WATCHDOG_STATE_KEY = Symbol.for("opencode-config.favorite-router.watchdog")

type WatchdogState = {
  installed: boolean
  notified: Set<string>
  notifying: Set<string>
  controller: AbortController
  sessionApi: Record<string, Function> | undefined
  owner: unknown
}

export function watchdogState(): WatchdogState {
  const g = globalThis as { [WATCHDOG_STATE_KEY]?: WatchdogState }
  if (!g[WATCHDOG_STATE_KEY]) {
    g[WATCHDOG_STATE_KEY] = { installed: false, notified: new Set(), notifying: new Set(), controller: new AbortController(), sessionApi: undefined, owner: undefined }
  }
  return g[WATCHDOG_STATE_KEY]
}

function eventSessionID(event: unknown): { type?: string; sessionID?: string; idle: boolean } {
  const evt = (event ?? {}) as { type?: unknown; data?: unknown; properties?: unknown }
  const type = typeof evt.type === "string" ? evt.type : undefined
  const data = (evt.data ?? evt.properties ?? {}) as Record<string, unknown>
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  let idle = false
  if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.cancelled" || type === "session.execution.interrupted") {
    idle = true
  }
  if (type === "session.idle") idle = true
  if (type === "session.status") {
    const status = data.status as { type?: unknown } | undefined
    idle = status?.type === "idle"
  }
  if (type === "session.next.step.failed") idle = true
  return { type, sessionID, idle }
}

function messageTexts(message: unknown): string[] {
  const m = (message ?? {}) as { content?: unknown; parts?: unknown; text?: unknown }
  const texts: string[] = []
  for (const part of (Array.isArray(m.content) ? m.content : [...(Array.isArray(m.parts) ? m.parts : [])]) as Array<{
    text?: unknown
  }>) {
    if (typeof part?.text === "string") texts.push(part.text)
  }
  if (typeof m.text === "string") texts.push(m.text)
  return texts
}

function sessionMessages(res: unknown): unknown[] {
  if (Array.isArray(res)) return res
  if (res && typeof res === "object") {
    const o = res as { data?: unknown; messages?: unknown }
    if (Array.isArray(o.data)) return o.data
    if (Array.isArray(o.messages)) return o.messages
  }
  return []
}

function messageRole(message: unknown): string {
  const m = (message ?? {}) as Record<string, unknown>
  if (typeof m.type === "string") return m.type
  if (typeof m.role === "string") return m.role
  const info = m.info as Record<string, unknown> | undefined
  if (info && typeof info.role === "string") return info.role
  if (info && typeof info.type === "string") return info.type
  return ""
}

function findProviderFailure(blob: string): ProviderFailure | undefined { return detectProviderFailure(blob) }
function renderFailure(failure: ProviderFailure): string { return failureMessage(failure) }

type ChildScan = { summary: string; providerError?: string; failure?: ProviderFailure }

async function parentAlreadyHasResult(sessionApi: { context?: Function }, parentID: string, childID: string) {
  try {
    const res = await sessionApi.context?.({ sessionID: parentID })
    const messages = sessionMessages(res)
    for (const message of messages) {
      if (
        messageTexts(message).some(
          (text) =>
            text.includes(`<task id="${childID}" state="completed">`) ||
            text.includes(`<task id="${childID}" state="error">`) ||
            text.includes(`<subagent sessionID="${childID}" state="completed"`) ||
            text.includes(`<subagent sessionID="${childID}" state="error"`),
        )
      ) {
        return true
      }
    }
  } catch {}
  return false
}

async function parentAlreadyHasProviderError(sessionApi: { context?: Function }, parentID: string, childID: string) {
  try {
    const res = await sessionApi.context?.({ sessionID: parentID })
    for (const message of sessionMessages(res)) {
      if (
        messageTexts(message).some(
          (text) =>
            (text.includes(USAGE_REACHED) || text.includes("Provider unavailable —")) &&
            (text.includes(`<task id="${childID}"`) || text.includes(`sessionID="${childID}"`)),
        )
      ) {
        return true
      }
    }
  } catch {}
  return false
}

async function childSummary(sessionApi: { context?: Function }, childID: string, event?: unknown): Promise<ChildScan> {
  let lastAssistant = ""
  let failure: ProviderFailure | undefined
  try {
    const res = await sessionApi.context?.({ sessionID: childID })
    const messages = sessionMessages(res)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!lastAssistant && messageRole(message) === "assistant") {
        const text = messageTexts(message).join("").trim()
        if (text) lastAssistant = text.length > 4000 ? text.slice(-4000) : text
      }
      if (failure && lastAssistant) break
    }
  } catch {}
  const error = (event as any)?.data?.error
  failure = error ? findProviderFailure(JSON.stringify(error)) : undefined
  if (failure) return { summary: renderFailure(failure), providerError: failure.detail, failure }
  return { summary: lastAssistant || "Quest session completed" }
}

async function emitSessionText(
  sessionApi: { synthetic?: Function } | undefined,
  sessionID: string | undefined,
  text: string,
  label: string,
) {
  if (typeof sessionApi?.synthetic !== "function" || !sessionID) {
    console.warn(`[orchestration] ${label}: ctx.session.synthetic unavailable`)
    return
  }
  await sessionApi.synthetic({ sessionID, text })
}

async function handleSubagentEvent(event: unknown, sessionApi: any) {
  const { type, sessionID, idle } = eventSessionID(event)
  if (!type || !sessionID || !idle) return
  const scanned = await childSummary(sessionApi, sessionID, event)
  const child = await sessionApi.get({ sessionID }).catch((err: unknown) => {
    console.error(`[orchestration] watchdog: session.get(${sessionID}) failed:`, err)
    return undefined
  })
  const info = child?.data ?? child
  const parentID = info?.parentID
  if (!parentID) return
  const key = `${parentID}:${sessionID}`
  const notified = watchdogState().notified
  const failed =
    type === "session.next.step.failed" ||
    type === "session.execution.failed" ||
    type === "session.execution.cancelled" || type === "session.execution.interrupted" ||
    Boolean(scanned.providerError)
  recordTerminal(parentID, sessionID, failed ? (CANCEL_EVENTS.has(type) ? "cancelled" : "failed") : "completed")
  if (await parentAlreadyHasProviderError(sessionApi, parentID, sessionID)) {
    notified.add(key)
    return
  }
  if (!scanned.providerError && (await parentAlreadyHasResult(sessionApi, parentID, sessionID))) {
    notified.add(key)
    return
  }
  let summary = scanned.summary
  if (failed && !scanned.providerError && summary === "Quest session completed") {
    summary = "Quest session failed"
  }
  const terminalState = failed ? (CANCEL_EVENTS.has(type) ? "cancelled" : "failed") : "completed"
  const callID = readLedger().findLast((event) => event.parentID === parentID && event.childID === sessionID)?.callID ?? sessionID
  recordNativeSessionLineage(parentID, callID, sessionID)
  if (notified.has(key) || watchdogState().notifying.has(key)) return
  watchdogState().notifying.add(key)
  try {
    recordNotification(parentID, callID, sessionID, terminalState, summary)
    const completion = pendingCompletionEvidence(parentID).find((entry) => entry.callID === callID)
    if (!completion || await deliverPendingCompletion(sessionApi, completion)) notified.add(key)
  } finally {
    watchdogState().notifying.delete(key)
  }
}

export function stopSubagentWatchdog(owner: unknown) {
  const state = watchdogState()
  if (!state.installed || state.owner !== owner) return
  state.controller.abort()
  state.controller = new AbortController()
  state.installed = false
  state.sessionApi = undefined
  state.owner = undefined
}

export async function watchSubagentCompletions(ctx: any) {
  const state = watchdogState()
  if (state.installed) return
  state.installed = true
  const eventApi = ctx?.event
  const sessionApi = ctx?.session
  if (!eventApi || typeof eventApi.subscribe !== "function") {
    console.error("[orchestration] watchdog: ctx.event.subscribe unavailable")
    return
  }
  if (!sessionApi || typeof sessionApi.get !== "function") {
    console.error("[orchestration] watchdog: ctx.session.get unavailable")
    return
  }
  state.sessionApi = sessionApi
  state.owner = eventApi
  if (typeof sessionApi.synthetic === "function") void (async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
    const lock = ledgerLockStatus()
    if (lock.state !== 'available') {
      console.error(`[orchestration] completion replay deferred: ${lock.state}; preserve the lock and verify its owner before explicit recovery`)
      return
    }
    const latest = new Map<string, ReturnType<typeof readLedger>[number]>()
    for (const event of readLedger()) {
      if (event.kind === "terminal" && event.childID) latest.set(`${event.parentID}:${event.childID}`, event)
    }
    for (const event of latest.values()) {
      await new Promise(resolve => setTimeout(resolve, 0))
      if (ledgerLockStatus().state !== 'available') break
      if (!event.childID) continue
      const summary = event.state === "missing-result" ? 'The worker result is missing. Reopen its saved session before continuing.' : event.state === 'completed' ? 'The worker finished its turn.' : 'The worker stopped before finishing. Read its saved result before continuing.'
      try {
        const state = event.state === "completed" ? "completed" : event.state === "failed" ? "failed" : event.state === "cancelled" ? "cancelled" : "missing-result"
        recordNotification(event.parentID, event.callID, event.childID, state, summary)
      } catch {}
    }
    for (const completion of pendingCompletionEvidence()) {
      try { await deliverPendingCompletion(sessionApi, completion) } catch {}
    }
  })()
  try {
    const stream = await eventApi.subscribe({ signal: state.controller.signal })
    if (stream && typeof stream[Symbol.asyncIterator] === "function") {
      for await (const event of stream) {
        await handleSubagentEvent(event, sessionApi)
      }
    } else if (stream && typeof stream.next === "function") {
      for (;;) {
        const res = await stream.next()
        if (res.done) break
        await handleSubagentEvent(res.value, sessionApi)
      }
    } else {
      console.error("[orchestration] watchdog: unsupported event stream shape")
    }
  } catch (err) {
    console.error("[orchestration] watchdog: event subscription failed:", err)
  }
}

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  build: "Build",
  explore: "Explore",
  orchestrator: "Orchestrator",
  reviewer: "Reviewer",
  "model-openai-gpt-5-6-luna-fast": "OpenAI/GPT-5.6 Luna Fast",
  "model-grok-sub-grok-4-6": "Grok 4.6",
  "model-opencode-go-muse-spark-1-2-contributor": "Muse Spark 1.2",
  "model-x-preview-f-free": "Preview",
}

export function formatAgentLabel(agent: unknown, _description?: unknown): string {
  const id = String(agent ?? "").trim()
  if (AGENT_DISPLAY_NAMES[id]) return AGENT_DISPLAY_NAMES[id]
  if (!id) return "Unknown agent"
  if (id.startsWith("model-")) {
    return id.slice("model-".length).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return id
}

export function formatTaskDescription(description: unknown, prompt?: unknown): string {
  const raw = String(description ?? "").trim()
  const explicit = typeof prompt === "object" && prompt !== null
    ? String((prompt as Record<string, unknown>).humanLabel ?? "").trim()
    : ""
  if (explicit) return explicit
  if (/^integrate-lean-/i.test(raw)) return "Updating orchestrator scaling (3 → N)"
  if (/^commit-review-skill/i.test(raw)) return "Reviewing integrated changes"
  if (/^verify-shell/i.test(raw)) return "Verifying shell guards"
  if (/^verify-/i.test(raw)) return "Verifying changes"
  if (/^check-/i.test(raw)) return "Checking implementation"
  return raw || "Working on assigned task"
}

export function normalizeTaskDisplay(input: unknown): void {
  if (!input || typeof input !== "object") return
  const args = input as Record<string, unknown>
  const description = args.description ?? args.title
  const label = formatTaskDescription(description, args)
  if ("description" in args) args.description = label
  if ("title" in args) args.title = label
}
