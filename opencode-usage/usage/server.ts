import "./host-hooks"
import { define } from "@opencode-ai/plugin/v2/promise"
import { telemetryQueue } from "./telemetry-queue"
import { isProductionRequest } from "./telemetry"
import { startPassiveUsage } from "./passive-ledger"
import { startAccountUsageRefresh, type AccountUsageRefresher } from "../usage-service/on-computer"
import { installContextEvents } from "./context-events"
import { installRequestTelemetry } from "./request-collector"
import { usageTools } from "./tools"
import { pluginStartup } from "../models/plugin-startup"
export { getUsageExperience } from "./experience-api"

type Collectors = { accounts: AccountUsageRefresher; stopPassive: () => void; holders: number }
let collectors: Collectors | undefined

async function acquire(location: string | undefined) {
  if (collectors) { collectors.holders++; return collectors }
  const accounts = await pluginStartup("usage", "account-refresh", async () => startAccountUsageRefresh(), location)
  const stopPassive = await pluginStartup("usage", "passive-usage", async () => startPassiveUsage(), location)
  if (collectors) { collectors.holders++; accounts.stop(); stopPassive(); return collectors }
  return collectors = { accounts, stopPassive, holders: 1 }
}

function release(held: Collectors) {
  if (--held.holders > 0) return
  held.accounts.stop()
  held.stopPassive()
  if (collectors === held) collectors = undefined
}

export default define({
  id: "usage",
  async setup(ctx) {
    const location = (ctx as { location?: { directory?: string } }).location?.directory
    const held = await acquire(location)
    await pluginStartup("usage", "request-telemetry", () => installRequestTelemetry(ctx, record => {
      if (isProductionRequest(record)) telemetryQueue().submit(record)
      if (record.state !== "running" && record.accountID) held.accounts.requestCompleted(record.accountID)
    }), location)
    await pluginStartup("usage", "context-events", () => installContextEvents(ctx), location)
    const tool = (ctx as { tool?: { transform?: Function } }).tool
    if (tool?.transform) await tool.transform((draft: { add: (tool: unknown) => void }) => {
      for (const operation of usageTools) draft.add(operation)
    })
    return () => release(held)
  },
})
