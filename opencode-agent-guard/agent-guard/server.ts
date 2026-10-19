import { define } from "@opencode-ai/plugin/v2/promise"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { configuredShellName, gitBashPath, isPosixShell } from "../quest/permissions/shell-guidance"
import searchOutput from "../setup/files/.config/opencode-normal/search-output/index.js"

export const guardEntry = () => join(process.env.AGENT_GUARD_HOME ?? join(homedir(), "Projects", "agent-guard"), "opencode.mjs")

export function announceConfiguredShell(environment = process.env, platform = process.platform) {
  if (platform !== "win32" || environment.SHELL || !isPosixShell(configuredShellName(environment))) return
  environment.SHELL = gitBashPath(environment)
}

export default define({
  id: "agent-guard",
  async setup(ctx: any) {
    await searchOutput.setup(ctx)
    const entry = guardEntry()
    if (!existsSync(entry)) return
    announceConfiguredShell()
    const guard = await import(pathToFileURL(entry).href)
    await guard.default.setup(ctx)
  },
})
