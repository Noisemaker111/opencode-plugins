import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { discoveryPaths } from "../usage-service/on-computer"
import { generationKey } from "../scripts/running-generation.mjs"

export const JEV_PROVIDER = "jev"
export const JEV_BRIDGE_HOST = "127.0.0.1"
export const jevBridgePort = (env: Record<string, string | undefined> = process.env) => Number(env.JEV_BRIDGE_PORT ?? 3013)
export const JEV_CONTEXT_TOKENS = 32_000
export const JEV_REQUEST_TOKENS = 30_000
export const JEV_CHARACTERS_PER_TOKEN = 3
export const JEV_UPSTREAM_TIMEOUT_MS = 20_000
export const JEV_QUESTION_TYPES = ["choice", "noul", "score"] as const

export type JevUpstreamModel = "free" | "openrouter"
export type JevModel = JevUpstreamModel | "auto"
export const JEV_MODELS: readonly JevModel[] = ["free", "openrouter", "auto"]
export type JevUpstream = { url: string; model: string; keyed: boolean }
export const JEV_UPSTREAMS: Readonly<Record<JevUpstreamModel, JevUpstream>> = Object.freeze({
  free: Object.freeze({ url: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13-free", keyed: false }),
  openrouter: Object.freeze({ url: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13", keyed: true }),
})
export type JevPayload = { state: Record<string, unknown>; questions: Record<string, Record<string, unknown>> }
export type JevUsage = { input_tokens: number; output_tokens: number; cost: number }
export type JevReply = { answers: Record<string, unknown>; usage: JevUsage }
export type JevDependencies = { upstreams: Readonly<Record<JevUpstreamModel, JevUpstream>>; fetch: typeof fetch; openRouterKey: () => string | undefined; timeoutMs: number }
export type JevResponse = { status: number; contentType: string; body: string }

export function openRouterKey(env: Record<string, string | undefined> = process.env, dataDirectory = discoveryPaths().data): string | undefined {
  const fromEnvironment = env.OPENROUTER_API_KEY?.trim()
  if (fromEnvironment) return fromEnvironment
  try {
    const entry = JSON.parse(readFileSync(join(dataDirectory, "auth.json"), "utf8").replace(/^﻿/, "")).openrouter
    const key = entry?.type === "api" && typeof entry.key === "string" ? entry.key.trim() : ""
    return key || undefined
  } catch { return undefined }
}

const productionDependencies = (): JevDependencies => ({ upstreams: JEV_UPSTREAMS, fetch: globalThis.fetch, openRouterKey: () => openRouterKey(), timeoutMs: JEV_UPSTREAM_TIMEOUT_MS })
const JSON_TYPE = "application/json; charset=utf-8"
const SSE_TYPE = "text/event-stream; charset=utf-8"
const ERROR_TYPES: Record<number, string> = { 400: "invalid_request_error", 401: "authentication_error", 402: "payment_required", 403: "permission_error", 404: "not_found_error", 429: "rate_limit_error", 504: "timeout_error" }
export function jevError(status: number, message: string, code?: string): JevResponse {
  return { status, contentType: JSON_TYPE, body: JSON.stringify({ error: { message, type: ERROR_TYPES[status] ?? (status >= 500 ? "upstream_error" : "invalid_request_error"), ...(code ? { code } : {}) } }) }
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

export function lastUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]
    if (!isObject(row) || row.role !== "user") continue
    if (typeof row.content === "string") return row.content
    if (Array.isArray(row.content)) return row.content.flatMap(part => typeof part === "string" ? [part] : isObject(part) && typeof part.text === "string" ? [part.text] : []).join("")
    return undefined
  }
  return undefined
}

export function jevPayload(text: string | undefined): JevPayload | string {
  if (!text?.trim()) return "The last user message must be a JSON object {\"state\":{...},\"questions\":{...}}; there was none"
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return "The last user message is not JSON; Jev answers only {\"state\":{...},\"questions\":{...}}" }
  if (!isObject(parsed) || !isObject(parsed.state) || !isObject(parsed.questions)) return "The last user message must be a JSON object with a state object and a questions object"
  const names = Object.keys(parsed.questions)
  if (!names.length) return "questions must name at least one typed question"
  for (const name of names) {
    const question = parsed.questions[name]
    if (!isObject(question) || !JEV_QUESTION_TYPES.includes(question.type as typeof JEV_QUESTION_TYPES[number])) return "Question " + JSON.stringify(name) + " must be an object whose type is one of " + JEV_QUESTION_TYPES.join(", ")
  }
  return { state: parsed.state, questions: parsed.questions as JevPayload["questions"] }
}

export const jevEstimatedTokens = (payload: JevPayload) =>
  Math.ceil((JSON.stringify(payload.state).length + Math.max(...Object.values(payload.questions).map(question => JSON.stringify(question).length))) / JEV_CHARACTERS_PER_TOKEN)

export function redactKey(text: string, key?: string) {
  let out = key ? text.split(key).join("[REDACTED]") : text
  out = out.replace(/sk-or-[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]")
  return out
}

async function upstreamMessage(response: Response) {
  const text = await response.text().catch(() => "")
  try {
    const body = JSON.parse(text)
    const message = body?.error?.message ?? body?.message ?? body?.error
    if (typeof message === "string" && message.trim()) return message
  } catch {}
  return text.trim() || response.statusText || "no message"
}

export function jevCompletion(requested: JevModel, reply: JevReply, stream: boolean): JevResponse {
  const id = "chatcmpl-jev-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const created = Math.floor(Date.now() / 1000)
  const content = JSON.stringify(reply)
  const usage = { prompt_tokens: reply.usage.input_tokens, completion_tokens: reply.usage.output_tokens, total_tokens: reply.usage.input_tokens + reply.usage.output_tokens, cost: reply.usage.cost }
  if (!stream) return { status: 200, contentType: JSON_TYPE, body: JSON.stringify({ id, object: "chat.completion", created, model: requested, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage }) }
  const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
    "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model: requested, choices: [{ index: 0, delta, finish_reason: finish }], ...extra }) + "\n\n"
  return { status: 200, contentType: SSE_TYPE, body: chunk({ role: "assistant", content }, null) + chunk({}, "stop", { usage }) + "data: [DONE]\n\n" }
}

export async function handleJevChatCompletion(body: unknown, dependencies: Partial<JevDependencies> = {}): Promise<JevResponse> {
  const deps = { ...productionDependencies(), ...dependencies }
  if (!isObject(body)) return jevError(400, "The request body must be a JSON object")
  const requested = body.model
  if (!JEV_MODELS.includes(requested as JevModel)) return jevError(404, "The Jev bridge serves only the models free, openrouter and auto; " + JSON.stringify(requested ?? null) + " was refused and nothing was sent", "model_not_found")
  const payload = jevPayload(lastUserText(body.messages))
  if (typeof payload === "string") return jevError(400, payload, "invalid_jev_payload")
  const estimated = jevEstimatedTokens(payload)
  if (estimated > JEV_REQUEST_TOKENS) return jevError(400, "This Jev request is about " + estimated + " tokens (state plus its longest question at " + JEV_CHARACTERS_PER_TOKEN + " characters per token), over the " + JEV_REQUEST_TOKENS + " tokens the bridge sends into Jev's " + JEV_CONTEXT_TOKENS + "-token context; nothing was sent and nothing was shortened", "context_length_exceeded")
  if (requested === "auto") {
    const free = await askUpstream("free", payload, deps, body.stream === true)
    if (free.status === 200 || !deps.openRouterKey()) return free
    console.warn("[jev-bridge] auto: free answered HTTP " + free.status + "; asking openrouter")
    const paid = await askUpstream("openrouter", payload, deps, body.stream === true)
    return paid.status === 200 ? paid : free
  }
  return askUpstream(requested as JevUpstreamModel, payload, deps, body.stream === true)
}

async function askUpstream(requested: JevUpstreamModel, payload: JevPayload, deps: JevDependencies, stream: boolean): Promise<JevResponse> {
  const upstream = deps.upstreams[requested]
  let key: string | undefined
  if (upstream.keyed) {
    key = deps.openRouterKey()
    if (!key) return jevError(401, "No OpenRouter key is configured for jev/openrouter (set OPENROUTER_API_KEY or connect openrouter in OpenCode auth); nothing was sent", "missing_api_key")
  }
  let response: Response
  try {
    response = await deps.fetch(upstream.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(key ? { authorization: "Bearer " + key } : {}) },
      body: JSON.stringify({ model: upstream.model, state: payload.state, questions: payload.questions }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    return jevError(timedOut ? 504 : 502, redactKey("Jev upstream " + requested + (timedOut ? " did not answer in " + deps.timeoutMs / 1000 + "s" : " could not be reached: " + (error instanceof Error ? error.message : String(error))), key))
  }
  if (!response.ok) return jevError(response.status, redactKey("Jev upstream " + requested + " answered HTTP " + response.status + ": " + await upstreamMessage(response), key))
  let reply: any
  try { reply = await response.json() } catch { return jevError(502, "Jev upstream " + requested + " answered with a body that is not JSON") }
  if (!isObject(reply?.answers)) return jevError(502, "Jev upstream " + requested + " answered without an answers object")
  const number = (value: unknown) => { const parsed = typeof value === "string" ? Number(value) : value; return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined }
  const input = number(reply.usage?.input_tokens) ?? 0, output = number(reply.usage?.output_tokens) ?? 0
  const cost = upstream.keyed ? number(reply.usage?.cost) ?? number(reply.cost) ?? 0 : 0
  return jevCompletion(requested, { answers: reply.answers, usage: { input_tokens: input, output_tokens: output, cost } }, stream)
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

function send(response: ServerResponse, result: JevResponse) {
  response.writeHead(result.status, { "content-type": result.contentType })
  response.end(result.body)
}

export function jevBridgeHandler(dependencies: Partial<JevDependencies> = {}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url || "/", "http://" + JEV_BRIDGE_HOST).pathname
    if (request.method === "GET" && path === "/v1/models") {
      send(response, { status: 200, contentType: JSON_TYPE, body: JSON.stringify({ object: "list", data: JEV_MODELS.map(id => ({ id, object: "model", owned_by: JEV_PROVIDER, type: "evaluation", context_window: JEV_CONTEXT_TOKENS })) }) })
      return
    }
    if (request.method === "POST" && path === "/v1/chat/completions") {
      let body: unknown
      try { body = JSON.parse(await readBody(request)) } catch { send(response, jevError(400, "The request body is not JSON")); return }
      send(response, await handleJevChatCompletion(body, dependencies))
      return
    }
    send(response, jevError(404, "The Jev bridge serves only GET /v1/models and POST /v1/chat/completions"))
  }
}

const BRIDGE_STATE = generationKey("questgiver.jev-bridge")
type BridgeState = { server?: Server; listening?: Server; holders: number; port?: number; dependencies?: Partial<JevDependencies>; waiting?: Set<(ready: boolean) => void> }
const bridgeState = (): BridgeState => {
  const scope = globalThis as { [BRIDGE_STATE]?: BridgeState }
  return scope[BRIDGE_STATE] ??= { holders: 0 }
}
export const JEV_BRIDGE_LISTEN_MS = 10_000

function announce(state: BridgeState, ready: boolean) {
  const waiting = [...(state.waiting ?? [])]
  state.waiting?.clear()
  for (const done of waiting) done(ready)
}

export const JEV_PORT_RETRY_MS = 250

function listen(state: BridgeState, retried = false) {
  const port = state.port ?? jevBridgePort()
  const handle = jevBridgeHandler(state.dependencies)
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (!response.headersSent) send(response, jevError(500, "Jev bridge failed: " + (error instanceof Error ? error.message : String(error))))
      else response.end()
    })
  })
  server.on("listening", () => { if (state.server === server) { state.listening = server; announce(state, true) } })
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (state.server !== server) return
    state.server = undefined
    if (state.listening === server) state.listening = undefined
    if (error.code === "EADDRINUSE" && !retried) { setTimeout(() => { if (!state.server && state.holders > 0) listen(state, true) }, JEV_PORT_RETRY_MS).unref?.(); return }
    if (error.code === "EADDRINUSE") { console.warn("[jev-bridge] port " + port + " is held by another listener; the next Jev call listens again if that one has gone"); announce(state, true); return }
    console.error("[jev-bridge] bridge failed:", error)
    announce(state, false)
  })
  server.on("close", () => { if (state.listening === server) state.listening = undefined })
  server.listen(port, JEV_BRIDGE_HOST)
  state.server = server
  return server
}

export function startJevBridge(options: { port?: number; dependencies?: Partial<JevDependencies> } = {}) {
  const state = bridgeState()
  state.holders++
  if (state.server) return state.server
  state.port = options.port ?? jevBridgePort()
  state.dependencies = options.dependencies
  return listen(state)
}

export function jevBridgeReady(timeoutMs = JEV_BRIDGE_LISTEN_MS): Promise<boolean> {
  const state = bridgeState()
  if (state.server && (state.listening === state.server || state.server.listening)) return Promise.resolve(true)
  if (state.holders < 1) return Promise.resolve(false)
  if (!state.server) listen(state)
  return new Promise(resolve => {
    const done = (ready: boolean) => { clearTimeout(timer); resolve(ready) }
    const timer = setTimeout(() => { state.waiting?.delete(done); resolve(false) }, timeoutMs)
    ;(state.waiting ??= new Set()).add(done)
  })
}

export function stopJevBridge() {
  const state = bridgeState()
  state.holders = Math.max(0, state.holders - 1)
  if (state.holders > 0 || !state.server) return
  const server = state.server
  state.server = undefined
  state.listening = undefined
  announce(state, false)
  server.close()
}

if (import.meta.main) {
  const server = startJevBridge()
  server.on("listening", () => console.log("[jev-bridge] listening on http://" + JEV_BRIDGE_HOST + ":" + jevBridgePort() + "/v1"))
}
