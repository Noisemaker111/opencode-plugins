import {pluginStartup} from './plugin-startup'
import { installInstructionRevisions } from "./instruction-revisions"
import { installAccessGuard, assertConfiguredModel, assertChatModel } from "./access-policy"
import { startJevBridge, stopJevBridge } from "./jev-bridge"
import { define } from "@opencode-ai/plugin/v2/promise"
import { enforceSessionModelChange } from "./session-lifecycle"
import { installServedModels } from "./served-models"
import { installInstructionFiles } from "./instruction-files"

async function safeToolHook(hook: Function, name: string, fn: Function, rethrow = false) {
  try {
    await hook(name, async (...args: unknown[]) => {
      try { return await fn(...args) } catch (error) {
        if (rethrow) throw error
        console.error(`[models] ${name} hook error:`, error)
      }
    })
  } catch (error) {
    console.error(`[models] could not register ${name}:`, error)
  }
}

export async function installSpawnGuard(ctx: { tool?: { hook?: Function } }) {
  if(typeof ctx.tool?.hook!=="function")throw new Error("Host spawn guard is unavailable")
  await safeToolHook(ctx.tool.hook,"execute.before",(event:any)=>{
    if(!/^(task|subagent)$/i.test(String(event?.tool??event?.name??"")))return
    const input=event.input??event.args
    if(typeof input?.model!=="string")throw new Error("Use quest run to resolve an authorized route; implicit native fallback is disabled")
    const slash=input.model.indexOf("/");if(slash<1)throw new Error("Exact provider/model is required")
    assertConfiguredModel({providerID:input.model.slice(0,slash),modelID:input.model.slice(slash+1)})
    assertChatModel({providerID:input.model.slice(0,slash),modelID:input.model.slice(slash+1)})
  },true)
}

export async function installSessionModelGuard(ctx: { tool?: { hook?: Function } }) {
  const hook = ctx?.tool?.hook
  if (typeof hook !== "function") return
  await safeToolHook(hook, "execute.before", (event: unknown) => enforceSessionModelChange(event), true)
}

export default define({
  id: "models",
  async setup(ctx) {
    await pluginStartup('models','access-guard',()=>installAccessGuard(ctx),(ctx as any).location?.directory)
    for (const [name, install] of [
      ["jev-bridge", async () => { startJevBridge() }],
      ["spawn-guard", () => installSpawnGuard(ctx)],
      ["session-model-guard", () => installSessionModelGuard(ctx)],
      ["instruction-revisions", () => installInstructionRevisions(ctx)],
      ["served-models", () => installServedModels(ctx)],
      ["instruction-files", () => installInstructionFiles(ctx)],
    ] as const) {
      try { await pluginStartup('models',name,install,(ctx as any).location?.directory) } catch (error) {
        console.error(`[models] ${name} disabled:`, error)
      }
    }
    return () => stopJevBridge()
  },
})
