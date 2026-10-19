import {pluginStartup} from '../models/plugin-startup'
import {timed} from '../scripts/plugin-spans'
import {installHostLog} from './host/host-log'
import {leftServingRelease,presentOrServingRelease,servingReleaseRoot} from './host/serving-release'
import { hostCatalog } from "../models/host-catalog"
import {installWorkerInstructionReads} from './workers/worker-instructions'
import {installReadBudget} from './permissions/read-budget'
import {installCommandGuard} from './workers/command-guard'
import {installProcessLedger} from './workers/process-ledger'
import {registerModelRouterGenerator} from './routing/model-router'
import {cleanupSessionQuest} from "./checkouts/cleanup"
import {reloadWhenWorkersEnd, watchLandedReloads} from "./landing/delivery"
import {startDriftWatch} from "../scripts/version-drift.mjs"
import {installArtifactCards} from "./artifacts/artifact-cards"
import {connectHostObservation,disconnectHostObservation,recordHostObservation,registerHostObservation} from "./host/host-observation"
import {installWorkerCapabilities} from './workers/worker-capabilities'
import {installLiteralBackslashes} from './permissions/literal-backslashes'
import {ensureUserGiver,giverStartModel,installUserGiverContext,questWebGiverModel} from './giver/user-giver'
import {giverBinding,type GiverBinding} from './giver/giver-binding'
import {readUserGiver} from './giver-registry.mjs'
import {guidanceTool,outcomeTool,reportTool,workSupplyTool} from "./interfaces/adaptive-tools"
import {canvasTool} from "./artifacts/studio-canvas-tool"
import {variationTool} from "./artifacts/studio-variation-tool"
import {installSharedWorkspaceGuard} from "./permissions/shared-guard"
import {releaseAbandonedRunLocks} from "./checkouts/run-locks"
import {recordLocationPlugin} from '../scripts/server-plugin-lifecycle'
import { createQuestService } from "./host/service"
import { observeGiverInstruction } from './giver/giver-instruction'
import { installHistoryOrigin } from './core/history-origin'
import { questMemberships, workspaceHolderEnded } from './permissions/shared-guard'
import { openQuestListener, recordGiverBindError, serveQuestAPI } from "./api-server"
import { questRoot } from "./root.mts"
import { define } from "@opencode-ai/plugin/v2/promise"
import { firstDelivery } from "../scripts/first-delivery"
import { QuestStore } from "./store"
import { compactSettledJournals } from "./core/journal-compaction"
import { QuestTracker } from "./runs/tracker"
import { createQuestAgentAPI } from "./interfaces/agent-api"
import { validatePreparedSubagent, QUEST_SUBAGENT_DESCRIPTION, QUEST_SUBAGENT_INPUT } from "./workers/spawn"
import { recordSpawn, recordSpawnResult, registerCompletionEvidenceHandler, registerCompletionDeliveryClaimant, suppressCompletionDelivery } from "../orchestration/orchestration-ledger"
import { canonicalizeDispatch } from "../orchestration/dispatch"
import { stopSubagentWatchdog, watchSubagentCompletions } from "../orchestration/orchestration"

export async function installCanonicalDispatch(ctx: { tool?: { hook?: Function } }) {
  const hook = ctx?.tool?.hook
  if (typeof hook !== "function") return
  await safeToolHook(hook, "execute.before", (event: unknown) => {
    if (isSpawn(event)) canonicalizeDispatch(event)
  }, true)
}

export async function installLedger(ctx: { tool?: { hook?: Function } }) {
  const hook = ctx?.tool?.hook
  if (typeof hook !== "function") return
  await safeToolHook(hook, "execute.before", (event: unknown) => {
    if (isSpawn(event)) recordSpawn((event ?? {}) as Record<string, unknown>)
  }, true)
  await safeToolHook(hook, "execute.after", (event: unknown, output?: unknown) => {
    const ev = (event ?? {}) as Record<string, unknown>
    if (isSpawn(event)) recordSpawnResult(ev, output ?? ev.output)
  })
}

export function installWatchdog(ctx: any) {
  queueMicrotask(() => { void watchSubagentCompletions(ctx) })
  return () => stopSubagentWatchdog(ctx?.event)
}

async function safeToolHook(hook: Function, name: string, fn: Function, essential = false) {
  try {
    await hook(name, async (...args: unknown[]) => {
      try { return await fn(...args) } catch (error) {
        if (essential) throw error
        console.error(`[quests] ${name} hook error:`, error)
      }
    })
  } catch (error) {
    console.error(`[quests] could not register ${name}:`, error)
    if (essential) throw error
  }
}

const isSpawn = (event: unknown) => {
  const ev = (event ?? {}) as Record<string, unknown>
  return /^(task|subagent)$/i.test(String(ev.tool ?? ev.name ?? ""))
}

export async function installSubagentGateway(ctx: { tool?: { transform?: Function } }) {
  const transform = ctx?.tool?.transform
  if (typeof transform !== "function") return
  await transform((draft: { get: (id: string) => any; update: (id: string, update: (tool: any) => void) => void }) => {
    for (const id of ["subagent", "task"]) {
      if (!draft.get(id)) continue
      draft.update(id, (tool: any) => {
        const original = tool.execute
        if (typeof original !== "function") return
        tool.description = QUEST_SUBAGENT_DESCRIPTION
        tool.input = QUEST_SUBAGENT_INPUT
        tool.execute = async (input: Record<string, unknown>, context: unknown) => original(validatePreparedSubagent(input ?? {}), context)
      })
    }
  })
}

export async function installQuestBinding(
  ctx: { tool?: { hook?: Function } },
  quests = new QuestTracker(new QuestStore(questRoot())),
) {
  const hook = ctx?.tool?.hook
  if (typeof hook !== "function") return
  await safeToolHook(hook, "execute.before", (event: unknown) => {
    if (isSpawn(event)) quests.onTaskBefore(event)
  }, true)
  await safeToolHook(hook, "execute.after", (event: unknown, output?: unknown) => {
    if (isSpawn(event)) quests.onTaskAfter(event, output)
  })
}

const HOST_EVENTS = Symbol.for("opencode-config.quests.host-events")

export function installQuestEvents(ctx: { event?: { subscribe?: Function }; session?: any; permission?: any; integration?:any } & import("../models/host-catalog").CatalogHost, quests: QuestTracker) {
  const state = globalThis as { [HOST_EVENTS]?: WeakMap<object, { controller: AbortController }> }
  const connections = state[HOST_EVENTS] ??= new WeakMap()
  const owner = ctx.session ?? ctx.event
  if (!owner) return
  if(ctx.session)registerHostObservation(ctx.session,ctx.permission,hostCatalog(ctx),ctx.integration)
  registerModelRouterGenerator(ctx.generate?.text)
  if (connections.has(owner)) return
  const subscribe = ctx?.event?.subscribe
  if (typeof subscribe !== "function") {
    console.warn("[quests] ctx.event.subscribe unavailable; worker models and turn ends come from the ledger only")
    return
  }
  const controller = new AbortController()
  connections.set(owner, { controller })
  startDriftWatch()
  const handle = (event: unknown) => { try { if(ctx.session)recordHostObservation(ctx.session,event);if(!firstDelivery('quests.host-events',event))return;observeGiverInstruction(quests.store.runtime,event);quests.onHostEvent(event);const ended=(event as any)?.data?.sessionID??(event as any)?.properties?.sessionID;if(ctx.session&&typeof ended==='string'&&/^session\.execution\.(succeeded|failed|interrupted)$/.test((event as any)?.type))cleanupSessionQuest(quests.store,ctx.session,ended) } catch (error) { console.error("[quests] host event error:", error) } finally { reloadWhenWorkersEnd(quests.store,/^session\.execution\.(succeeded|failed|interrupted)$/.test(String((event as any)?.type))) } }
  queueMicrotask(async () => {
    let delay=1000
    while(!controller.signal.aborted){
      try {
        const stream=await subscribe({signal:controller.signal})
        if(!stream||typeof stream[Symbol.asyncIterator]!=="function")throw new Error("Unsupported host event stream shape")
        if(ctx.session)connectHostObservation(ctx.session,ctx.permission)
        try{const released=releaseAbandonedRunLocks(quests.store.runtime,holder=>workspaceHolderEnded(quests.store,holder));if(released.length)console.error("[quests] released locks left by ended runs or dead hosts:",released.join(", "))}catch(error){console.error("[quests] lock release on connect failed:",error)}
        for await(const event of stream){if(controller.signal.aborted)break;handle(event);delay=1000}
      }catch(error){if(!controller.signal.aborted)console.error("[quests] host event connection lost; reconnecting:",error)}
      if(ctx.session)disconnectHostObservation(ctx.session)
      if(controller.signal.aborted)break
      await new Promise<void>(done=>{const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);done()};const timer=setTimeout(finish,delay);timer.unref();controller.signal.addEventListener('abort',finish,{once:true})})
      delay=Math.min(delay*2,30000)
    }
    if(connections.get(owner)?.controller===controller)connections.delete(owner)
  })
  return () => controller.abort()
}

export function installQuestCompletionEvidence(quests: QuestTracker, api = createQuestAgentAPI(questRoot())) {
  const unclaim = registerCompletionDeliveryClaimant((completion) => quests.deliversCompletion(completion))
  const unregister = registerCompletionEvidenceHandler((completion) => {
    const disposition = quests.onCompletion(completion)
    if (disposition === "parked" && suppressCompletionDelivery(completion)) quests.onCompletion(completion, true)
    const blockerSessionID = completion.openCodeSessionId ?? completion.runtimeSessionId
    if (blockerSessionID && (disposition === "recorded" || disposition === "duplicate")) void api.handoff({ sessionID: blockerSessionID, reason: "Blocking worker reached terminal handoff" }).catch((error) => console.error("[quests] automatic dependency handoff failed:", error))
  })
  return () => { unregister(); unclaim() }
}

function recordedGiverDirectory(store:QuestStore){
  try{return readUserGiver(store.runtime)?.directory as string|undefined}catch{return undefined}
}

function giverBound(store:QuestStore){
  try{return readUserGiver(store.runtime)?.state==='bound'}catch{return false}
}

export async function installQuestTools(ctx: { tool?: { transform?: Function }; mcp?: {transform:Function}; session?: any;permission?:any;location?:{directory:string} }, api = createQuestAgentAPI(questRoot())) {
  const transform = ctx?.tool?.transform
  if (typeof transform !== "function") return
  let dispose: (()=>void)|undefined
  if(!ctx.session||!ctx.location||!ctx.mcp)throw Error('Quest API requires the installed OpenCode session and MCP plugin interfaces')
  let serviceDirectory=ctx.location.directory,binding:GiverBinding|undefined
  if(process.env.OPENCODE_QUEST_WEB==='1'){
    const bindGiver=async()=>ensureUserGiver(api.store,ctx.session,undefined,serviceDirectory,{model:await giverStartModel()??questWebGiverModel()})
    let giver:any
    try{giver=await pluginStartup('quests','giver-binding',bindGiver,ctx.location.directory);recordGiverBindError(api.store.runtime,undefined)}
    catch(error){const reason=error instanceof Error?error.message||error.name:String(error);recordGiverBindError(api.store.runtime,reason);console.error('[quests] Quest Giver not bound at startup; the Quest tools and Quest API stay up and binding is tried again when this host becomes active or a Quest API request needs the Quest Giver:',reason)}
    const at=giver?.location?.directory??recordedGiverDirectory(api.store)
    serviceDirectory=(leftServingRelease(at)?servingReleaseRoot():presentOrServingRelease(at))??ctx.location.directory
    const location=ctx.location.directory
    binding=giverBinding(()=>timed({plugin:'quests',name:'giver',op:'bind again',location},bindGiver),()=>giverBound(api.store))
  }
  const service=createQuestService(api.store,ctx.session,{directory:serviceDirectory,location:ctx.location.directory,onDispose:fn=>{dispose=fn}})
  setImmediate(() => { try { compactSettledJournals(api.store) } catch (error) { console.error('[quests] settled journals not compacted', error) } })
  const tools=[guidanceTool(api.store,ctx.session),outcomeTool(api.store,ctx.session),workSupplyTool(api.store,ctx.session),reportTool(service.call),canvasTool(api.store),variationTool(api.store)]
  try{await transform((draft: { add: (tool: unknown) => void }) => {for(const tool of tools)draft.add(tool)})}
  catch(error){binding?.dispose();dispose?.();throw error}
  let endpoint: Awaited<ReturnType<typeof serveQuestAPI>>|undefined
  try{
    endpoint=await pluginStartup('quests','api-listener',()=>serveQuestAPI(api.store,service,serviceDirectory,ctx.session,undefined,undefined,binding),ctx.location.directory)
    await ctx.mcp.transform((draft:any)=>draft.set('quests',{type:'remote',url:endpoint!.mcpURL,headers:{authorization:'Bearer '+endpoint!.token},oauth:false,codemode:true}))
  }catch(error){
    endpoint?.dispose();endpoint=undefined
    console.error('[quests] quests MCP namespace unavailable; direct Quest tools remain registered',String(error))
  }
  return ()=>{binding?.dispose();endpoint?.dispose();dispose?.()}
}

export default define({
  id: "quests",
  async setup(ctx) {
    const quests = new QuestTracker(new QuestStore(questRoot()), ctx.session)
    const api = createQuestAgentAPI(questRoot(), ctx.session)
    const disposers: Array<() => unknown> = []
    for (const [name, install] of [
      ["host-log", () => installHostLog(api.store.runtime)],
      ...(typeof (ctx as any).tool?.transform === "function" && (ctx as any).session && (ctx as any).location && (ctx as any).mcp ? [["listener", async () => { await openQuestListener(api.store) }] as const] : []),
      ["canonical-dispatch", () => installCanonicalDispatch(ctx)],
      ["literal-backslashes", () => installLiteralBackslashes(ctx)],
      ["ledger", () => installLedger(ctx)],
      ["artifact-cards", () => installArtifactCards(ctx)],
      ["subagent-gateway", () => installSubagentGateway(ctx)],
      ["binding", () => installQuestBinding(ctx, quests)],
      ["watchdog", () => installWatchdog(ctx)],
      ["host-events", () => installQuestEvents(ctx, quests)],
      ["history-source", () => installHistoryOrigin(ctx.session, id => questMemberships(api.store, id).length > 0)],
      ["completion-evidence", () => installQuestCompletionEvidence(quests, api)],
      ["worker-capabilities", () => installWorkerCapabilities(ctx,api.store)],
      ["user-giver", () => installUserGiverContext(api.store,ctx.session)],
      ["tools", () => installQuestTools(ctx, api)],
      ["shared-workspace-guard", () => installSharedWorkspaceGuard(ctx,api.store)],
      ["worker-instruction-reads", () => installWorkerInstructionReads(ctx,api.store)],
      ["read-budget", () => installReadBudget(ctx,api.store)],
      ["command-guard", async () => { await installCommandGuard(ctx as any).ready }],
      ["process-ledger", () => installProcessLedger(ctx as any, sessionID => { const member = questMemberships(api.store, sessionID).find(row => (row.run.sessionID ?? row.run.openCodeSessionId) === sessionID); return member ? { worker: sessionID, run: member.run.runID ?? member.run.callID, quest: member.quest.id } : { worker: sessionID } })],
      ["shell-guidance", async () => (await import('./permissions/shell-guidance')).installShellGuidance(ctx)],
      ["landed-reload-watch", () => watchLandedReloads(api.store)],
    ] as const) {
      try {
        const dispose = await pluginStartup('quests',name,install as () => unknown,ctx.location?.directory)
        if (typeof dispose === 'function') disposers.push(dispose as () => unknown)
      } catch (error) {
        console.error(`[quests] ${name} disabled:`, error)
        if (ctx.location?.directory) recordLocationPlugin(ctx.location.directory, 'quests#'+name, error)
      }
    }
    return async () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try { await dispose() } catch (error) { console.error('[quests] cleanup failed:', error) }
      }
    }
  },
})
