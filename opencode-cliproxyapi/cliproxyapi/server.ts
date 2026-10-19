import { define } from "@opencode-ai/plugin/v2/promise"
import { existsSync } from "node:fs"
import { brokerConfigFile } from "../models/subscription-policy"
import { brokerKeeper } from "./broker"

export default define({
  id: "cliproxyapi",
  async setup(ctx: any) {
    if (!existsSync(brokerConfigFile())) return
    const keeper = brokerKeeper()
    const report = (error: unknown) => console.error("[cliproxyapi] broker cannot be started:", error)
    void keeper.ensure().catch(report)
    await ctx.session.hook("http.request", async (event: { request: Request }) => {
      if (new URL(event.request.url).origin === keeper.origin()) await keeper.ensure().catch(report)
    })
  },
})
