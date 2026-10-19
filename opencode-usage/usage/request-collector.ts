import { questSessionContext } from "../quest/session-context"
import { createHash, randomUUID } from "node:crypto"
import { normalizeTokens, valueRequest, type RequestRecord, type RequestRole, type Tokens } from "./telemetry"
import { planAllowanceOf } from "../models/allowance-cost"
import { accountRegime } from "./calibration-store"
import { recordRequest, TELEMETRY_FILE } from "./telemetry-store"
import { demotedRoute, limitWindowOf, observeHealthRow, rateLimitError, resetFromText, routeLimitKey, stopRouteRetries } from "./route-limits"
import { freeBudgetOf } from "../models/free-budget-cache"
import { responseOf } from "./plan-allowance"
import { rebuildRouteHealth } from "../models/observed-route-health"
import { accountsForRoute, readAccountUsage } from "../usage-service/on-computer"
import { instructionRevision } from "./request-context"
import { unavailableModelError } from "../models/model-availability"
import { hostCatalog } from "../models/host-catalog"
import { catalogPrice, listPriceOf, priceBookFile, saveHostPriceBook } from "./price-book"
import { bodyParts, composeRequest, countParts, o200k, systemSections, type CountedPart } from "./request-composition"
const empty = (): Tokens => ({ input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null })
const digest=(value:unknown)=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)??"").digest("hex").slice(0,8)
export function systemSegments(part:unknown):string[]{
  return systemSections(part).map(section=>section.label+"#"+digest(section.text))
}
type PrefixTexts={tools:string[];system:string[]}
function prefixTexts(body:any,messages:any[],input:any[]):PrefixTexts{
  const tools=(Array.isArray(body?.tools)?body.tools:[]).map((tool:any)=>JSON.stringify(tool)??"")
  const system=[...(body?.system===undefined?[]:Array.isArray(body.system)?body.system:[body.system]),...(body?.instructions===undefined?[]:[body.instructions]),...[...messages,...input].filter((item:any)=>item?.role==="system"||item?.role==="developer").map((item:any)=>item.content)].flatMap(part=>systemSections(part).map(section=>section.text))
  return {tools,system}
}
export function promptPrefix(body:any,messages:any[]=Array.isArray(body?.messages)?body.messages:[],input:any[]=Array.isArray(body?.input)?body.input:[]):{prefix?:{tools:string[];system:string[]}}{
  const tools=(Array.isArray(body?.tools)?body.tools:[]).map((tool:any)=>String(tool?.name??tool?.function?.name??tool?.type??"?")+"#"+digest(tool))
  const system=[...(body?.system===undefined?[]:Array.isArray(body.system)?body.system:[body.system]),...(body?.instructions===undefined?[]:[body.instructions]),...[...messages,...input].filter((item:any)=>item?.role==="system"||item?.role==="developer").map((item:any)=>item.content)].flatMap(systemSegments)
  return tools.length||system.length?{prefix:{tools,system}}:{}
}
export function prefixSizes(body:any,count:(text:string)=>number):{tools:number[];system:number[]}{
  const texts=prefixTexts(body,Array.isArray(body?.messages)?body.messages:[],Array.isArray(body?.input)?body.input:[])
  const sized=(list:string[])=>countParts(list.map(text=>({kind:"system" as const,text})),count).map(part=>part.tokens)
  return {tools:sized(texts.tools),system:sized(texts.system)}
}
const AFFINITY_HEADERS=["x-session-affinity","x-session-id"]
export function requestPayloadMetadata(envelopeBytes:number,body:any,observedAt:number,revision?:ReturnType<typeof instructionRevision>,headers?:Headers):NonNullable<RequestRecord["request"]>{
  const messages=Array.isArray(body?.messages)?body.messages:[]
  const input=Array.isArray(body?.input)?body.input:[]
  const systemInstructionCount=[...messages,...input].filter((item:any)=>item?.role==="system"||item?.role==="developer").length+(body?.system===undefined?0:Array.isArray(body.system)?body.system.length:1)+(body?.instructions===undefined?0:1)
  const linked=revision&&revision.observedAt<=observedAt?revision:undefined
  return {observedAt,envelopeBytes,messageCount:messages.length,inputItemCount:input.length,toolDefinitionCount:Array.isArray(body?.tools)?body.tools.length:0,systemInstructionCount,...promptPrefix(body,messages,input),...(typeof (body?.prompt_cache_key??body?.promptCacheKey)==="string"?{cacheKeyed:true}:{}),...(AFFINITY_HEADERS.some(name=>headers?.get(name))?{sessionAffinity:true as const}:{}),...(linked?{instructionRevision:linked.revision,instructionRevisionObservedAt:linked.observedAt,...(linked.eventCreatedAt===undefined?{}:{instructionEventCreatedAt:linked.eventCreatedAt}),correlation:"session-revision-snapshot" as const}:{})}
}
function recordRefusal(record: RequestRecord, status: number, headers: Headers, now = Date.now()) {
  record.failure = "rate-limited"
  const observed = responseOf(status, headers, now)
  record.response = observed.limits || !record.response?.limits ? observed : { ...observed, limits: record.response.limits }
}
const observedOutcomes = new WeakSet<RequestRecord>()
function observeOutcome(record: RequestRecord) {
  if (observedOutcomes.has(record)) return
  observedOutcomes.add(record)
  try { observeHealthRow(record) } catch {}
}
export function observePayload(payload: any, record: RequestRecord, now: number) {
  if (payload?.error || payload?.type === "error" || payload?.type === "response.failed") {
    record.state = "failed"
    const error = payload?.error ?? payload?.response?.error ?? payload
    if (unavailableModelError(error)) record.failure = "model-unavailable"
    else if (record.failure !== "rate-limited" && rateLimitError(error)) {
      recordRefusal(record, 429, new Headers(), now)
      record.limitWindow = limitWindowOf(error)
      const stated = resetFromText(JSON.stringify(error), now)
      if (stated !== null) record.limitResetAt = new Date(stated).toISOString()
      const learned = record.limitWindow === "allowance" ? freeBudgetOf(routeLimitKey(record.route.providerID, record.route.modelID), now)?.nextReset?.at : undefined
      if (learned) record.windowResetAt = learned
    }
  }
  const usage = payload?.usage ?? payload?.response?.usage ?? payload?.message?.usage
  if (usage && typeof usage === "object") {
    if (typeof usage.prompt_tokens === "number" || typeof usage.input_tokens === "number" && (payload?.response || payload?.object === "response")) {
      record.tokens = normalizeTokens({ input: usage.prompt_tokens ?? usage.input_tokens, output: usage.completion_tokens ?? usage.output_tokens,
        cacheRead: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0,
        cacheWrite: usage.prompt_tokens_details?.cache_write_tokens ?? usage.input_tokens_details?.cache_write_tokens ?? 0,
        reasoning: usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0 }, { inputIncludesCache: true, outputIncludesReasoning: true })
    } else if (typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number") {
      record.tokens = { ...record.tokens, ...(typeof usage.input_tokens === "number" ? { input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 } : {}), ...(typeof usage.output_tokens === "number" ? { output: null, reasoning: null } : {}) }
      if (typeof usage.output_tokens === "number") record.outputTotal = usage.output_tokens
    }
  }
  const t = record.tokens
  if (t.input !== null && t.cacheRead !== null && t.cacheWrite !== null) record.context = { tokens: t.input + t.cacheRead + t.cacheWrite, source: "provider", at: record.startedAt }
  const visible = payload?.choices?.some((c: any) => typeof c.delta?.content === "string" && c.delta.content.length > 0)
    || payload?.type === "response.output_text.delta" && typeof payload.delta === "string" && payload.delta.length > 0
    || payload?.type === "content_block_delta" && payload.delta?.type === "text_delta" && typeof payload.delta.text === "string" && payload.delta.text.length > 0
  if (visible) { record.firstVisibleAt ??= now; record.lastOutputAt = now }
}
export function observedResponse(response: Response, record: RequestRecord, save: (r: RequestRecord) => void, clock = Date.now): Response {
  record.firstResponseAt = clock()
  const media=(response.headers.get("content-type")??"").split(";")[0].trim().toLowerCase()
  const capture=record.capture={mediaType:/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(media)&&media.length<=80?media:"unknown",framing:media==="text/event-stream"?"sse" as const:"json-or-unknown" as "sse"|"json-or-unknown",parsedPayloads:0,usagePayloads:0,parseFailures:0,truncatedBuffers:0}
  if (!response.body) { record.completedAt = clock(); record.state = response.ok ? "completed" : "failed"; save(record); return response }
  let streaming = media==="text/event-stream"
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = "", finished = false, terminalSeen = false, dataLines: string[] = []
  const parse = (text: string) => { try { const payload = JSON.parse(text);capture.parsedPayloads++;if(payload?.usage||payload?.response?.usage||payload?.message?.usage)capture.usagePayloads++;if (["message_stop", "response.completed","response.incomplete"].includes(payload?.type)) terminalSeen = true; observePayload(payload, record, clock()) } catch { capture.parseFailures++ } }
  const flushEvent = () => { if (!dataLines.length) return; const data=dataLines.join("\n"); dataLines=[]; if(data.trim()==="[DONE]")terminalSeen=true;else parse(data) }
  const line = (value:string) => {const text=value.replace(/\r$/,"");if(!text)flushEvent();else if(text.startsWith("data:"))dataLines.push(text.slice(5).replace(/^ /,""))}
  const lines=(final=false)=>{let newline:number;while((newline=buffer.search(/[\r\n]/))>=0){if(!final&&buffer[newline]==="\r"&&newline===buffer.length-1)break;const width=buffer[newline]==="\r"&&buffer[newline+1]==="\n"?2:1,next=buffer.slice(0,newline);buffer=buffer.slice(newline+width);line(next)}}
  const flush=()=>{buffer+=decoder.decode();if(streaming){lines(true);if(buffer)line(buffer);buffer="";flushEvent()}else if(buffer){parse(buffer);buffer=""}}
  const finish = (state: RequestRecord["state"]) => { if (finished) return; finished = true; record.completedAt = clock(); record.state = record.state === "failed" ? "failed" : state; save(record) }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {flush();finish(response.ok ? "completed" : "failed");controller.close();return}
        buffer += decoder.decode(chunk.value, { stream: true })
        if(!streaming&&/^\s*(?:data:|event:|:)/.test(buffer)){streaming=true;capture.framing="sse"}
        if(streaming)lines()
        if(buffer.length+dataLines.reduce((n,v)=>n+v.length,0)>8*1024*1024){buffer="";dataLines=[];capture.truncatedBuffers++}
        controller.enqueue(chunk.value)
      } catch (error) { finish("failed"); controller.error(error) }
    },
    async cancel(reason) {flush();finish(terminalSeen && response.ok ? "completed" : "interrupted");await reader.cancel(reason)},
  })
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
}
const attemptKey = (sessionID: string, providerID: string, modelID: string) => sessionID + "|" + providerID + "/" + modelID
export const requestSource = (session: { agent?: unknown } | undefined) => session?.agent === "bench" || session?.agent === "replay" ? "bench" as const : undefined
export function requestRole(route: { providerID: string; modelID: string }, session: { agent?: unknown } | undefined, worker: { runID?: string } | undefined): RequestRole | null {
  if (route.providerID === "jev") return route.modelID === "auto" ? "router" : "jev"
  if (session?.agent === "quest-giver") return "giver"
  if (worker?.runID) return "worker"
  return session || worker ? "other" : null
}
export function requestCost(request: RequestRecord, file = priceBookFile(), owners?: Record<string, string>): NonNullable<RequestRecord["cost"]> {
  const listed = listPriceOf(request, file, owners)
  const value = listed ? valueRequest({ ...request, price: listed.price }) : undefined
  const listUSD = value?.currency === "USD" ? value.value : null
  const allowance = listUSD === null ? null : planAllowanceOf(request.route.providerID, request.route.modelID, request.accountID)
  return { listUSD, planUSD: listUSD !== null && allowance ? listUSD / allowance.multiplier : null, priceSource: listed?.source ?? null }
}
const errorNameOf = (error: unknown) => { const name = (error as { name?: unknown } | undefined)?.name; return typeof name === "string" && name.length ? name : null }
const elapsed = (from: number) => Math.round((performance.now() - from) * 1000) / 1000
export async function installRequestTelemetry(ctx: any, save = recordRequest, priceBook = priceBookFile(), questWorker: (sessionID: string) => unknown = questSessionContext) {
  if (typeof ctx.session?.hook !== "function") return false
  try { rebuildRouteHealth(TELEMETRY_FILE) } catch {}
  const requests = new WeakMap<Request, RequestRecord>()
  const pendingRetries = new Map<string, number>()
  const outcomes = new Map<string, string>()
  const counting = new WeakMap<RequestRecord, Promise<CountedPart[] | undefined>>()
  const unanswered = new Map<string, RequestRecord[]>()
  const safeSave = (r: RequestRecord) => {
    if (r.completedAt !== undefined && r.state !== "error") observeOutcome(r)
    if (r.state === "completed" && r.cost === undefined) try { r.cost = requestCost(r, priceBook) } catch {}
    const parts = r.completedAt !== undefined ? counting.get(r) : undefined
    if (parts) { counting.delete(r); void parts.then(counted => { if (counted) r.composition = composeRequest(counted, r.tokens, r.outputTotal) }, () => {}).finally(() => safeSave(r)); return }
    try {
      r.recordedAt=Date.now();save(r)
      if (r.state !== "completed" && r.state !== "failed") return
      const identity = `${r.route.providerID}/${r.route.modelID}`, outcome = `${r.state}:${r.failure ?? ""}`
      if (outcomes.get(identity) === outcome) return
      outcomes.set(identity, outcome)
      void Promise.resolve(ctx.catalog?.reload?.()).catch(() => console.warn("[usage] model availability refresh failed"))
    } catch (error) { console.error("[usage] telemetry persistence failed:", error instanceof Error ? error.message : "unknown error") }
  }
  const forgetUnanswered = (record: RequestRecord) => {
    const key = attemptKey(record.sessionID, record.route.providerID, record.route.modelID)
    const rest = (unanswered.get(key) ?? []).filter(item => item !== record)
    if (rest.length) unanswered.set(key, rest); else unanswered.delete(key)
  }
  const failUnanswered = (record: RequestRecord, error: unknown) => {
    if (record.completedAt !== undefined || record.firstResponseAt !== undefined) return
    forgetUnanswered(record)
    counting.delete(record)
    const now = Date.now()
    record.state = "error"; record.errorName = errorNameOf(error); record.elapsedMs = now - record.startedAt; record.completedAt = now
    safeSave(record)
  }
  await ctx.session.hook("http.request", async (event: any) => {
    const hookStart = performance.now()
    const providerID = event.model?.providerID, modelID = event.model?.id ?? event.model?.modelID
    if (!event.request || !event.sessionID || !providerID || !modelID) return
    const accounts = accountsForRoute(readAccountUsage(), providerID, modelID)
    const record: RequestRecord = { id: randomUUID(), sessionID: event.sessionID, accountID: accounts.length === 1 ? accounts[0].id : undefined, accountRegime: accounts.length === 1 ? accountRegime(accounts[0]) : undefined,
      route: { providerID, modelID, variant: event.model?.variant }, kind: event.kind ?? "unknown", startedAt: Date.now(), state: "running", tokens: empty() }
    const attempt = attemptKey(event.sessionID, providerID, modelID)
    record.retries = pendingRetries.get(attempt) ?? 0
    pendingRetries.delete(attempt)
    unanswered.set(attempt, [...(unanswered.get(attempt) ?? []), record])
    const signal: AbortSignal | undefined = event.request.signal
    if (signal) signal.addEventListener("abort", () => failUnanswered(record, signal.reason), { once: true })
    if (signal?.aborted) failUnanswered(record, signal.reason)
    const requestObservedAt=Date.now(),revision=instructionRevision(event.sessionID)
    try {
      const bytes=await event.request.clone().arrayBuffer(),body=JSON.parse(new TextDecoder().decode(bytes))
      record.request=requestPayloadMetadata(bytes.byteLength,body,requestObservedAt,revision,event.request.headers)
      const effort=body?.reasoning?.effort??body?.reasoning_effort
      if(typeof effort==="string")record.route.reasoning=effort
      record.route.serviceTier=typeof body?.service_tier==="string"?body.service_tier:"default"
      const parts=bodyParts(body)
      counting.set(record,new Promise(resolve=>setTimeout(()=>o200k().then(count=>{const prefix=record.request?.prefix;if(prefix)prefix.tokens=prefixSizes(body,count);resolve(countParts(parts,count))},()=>resolve(undefined)))))
    } catch {}
    let session: any, worker: ReturnType<typeof questSessionContext> | undefined
    try { const result = await ctx.session.get({ sessionID: event.sessionID }); session = result?.data ?? result; record.parentID = session?.parentID; record.questID = session?.metadata?.questID; record.source = requestSource(session) } catch {}
    try { worker = questWorker(event.sessionID) as ReturnType<typeof questSessionContext>; if (worker) {record.questID ??= worker.questID; record.parentID ??= worker.parentID; record.route.reasoning ??= worker.reasoning; record.route.harness ??= worker.harness} } catch {}
    record.role = requestRole(record.route, session, worker)
    record.runID = worker?.runID ?? null
    record.stepID = worker?.stepID ?? null
    try {
      const result = await hostCatalog(ctx)?.model.list()
      const models: any = (result as any)?.data ?? result
      const model = Array.isArray(models) ? models.find((m: any) => m.providerID === providerID && (m.id ?? m.modelID) === modelID) : undefined
      const price = catalogPrice(model?.cost, providerID, modelID, record.startedAt)
      if (price) record.price = price
      saveHostPriceBook(models, priceBook)
    } catch {}
    record.overheadMs = { beforeSend: elapsed(hookStart), afterResponse: null }
    requests.set(event.request, record)
  })
  await ctx.session.hook("http.response", (event: any) => {
    const record = requests.get(event.request)
    if (record && event.response instanceof Response) {
      const started = performance.now()
      forgetUnanswered(record)
      if (event.response.status === 429) recordRefusal(record, 429, event.response.headers)
      else record.response = responseOf(event.response.status, event.response.headers, Date.now())
      if (record.overheadMs) record.overheadMs.afterResponse = elapsed(started)
      event.response = observedResponse(event.response, record, safeSave)
    }
  })
  await ctx.session.hook("retry", (event: any) => {
    const providerID = event.model?.providerID, modelID = event.model?.id ?? event.model?.modelID
    const unansweredCalls = providerID && modelID && event.sessionID ? unanswered.get(attemptKey(event.sessionID, providerID, modelID)) : undefined
    if (unansweredCalls?.length === 1) failUnanswered(unansweredCalls[0], event.error)
    if (event.decision?.retry && providerID && modelID && event.sessionID) {
      const attempt = attemptKey(event.sessionID, providerID, modelID)
      pendingRetries.set(attempt, (pendingRetries.get(attempt) ?? 0) + 1)
    }
    if (!event.decision?.retry || !providerID || !modelID || !questWorker(event.sessionID)) return
    try {
      const route = { providerID, modelID }
      if (!demotedRoute(route)) return
      stopRouteRetries(route, event.sessionID)
      event.decision = { retry: false }
    } catch {}
  })
  await keepModelRequestsOnHttp(ctx)
  return true
}

type ProviderSettings = { id: string; settings?: Record<string, unknown> }
type ProviderDraft = { list(): readonly { provider: ProviderSettings }[]; update(providerID: string, update: (provider: ProviderSettings) => void): void }
export async function keepModelRequestsOnHttp(ctx: { provider?: { transform?: (callback: (draft: ProviderDraft) => void) => Promise<unknown> } }) {
  await ctx.provider?.transform?.(draft => {
    for (const { provider } of draft.list())
      if (provider.settings?.transport !== undefined && provider.settings.transport !== "http")
        draft.update(provider.id, next => { next.settings = { ...next.settings, transport: "http" } })
  })
}
