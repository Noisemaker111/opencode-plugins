import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { deliveryRefusal, type DeliveryMode } from "../landing/delivery-permission"
import { driveAsync, gitRun } from "../landing/git-steps"
import { git, gitStatus } from "./worktree-plumbing"

export const REFUSED_PUSH_URL = "delivery-none-push-refused"
const HOOKS_DIRECTORY = "quest-delivery-none-hooks"

export async function blockPushesForNoneDelivery(path: string, questID: string, delivery: DeliveryMode | undefined): Promise<void> {
  const gitDir = (await git(path, ["rev-parse", "--absolute-git-dir"])).trim()
  const hooks = join(gitDir, HOOKS_DIRECTORY)
  if (delivery !== "none") {
    if (!existsSync(join(gitDir, "config.worktree"))) return
    for (const remote of await remoteNames(path)) await gitStatus(path, ["config", "--worktree", "--unset-all", `remote.${remote}.pushurl`])
    await gitStatus(path, ["config", "--worktree", "--unset-all", "core.hooksPath"])
    rmSync(hooks, { recursive: true, force: true })
    return
  }
  if (await localConfig(path, "extensions.worktreeConfig") !== "true") await git(path, ["config", "extensions.worktreeConfig", "true"])
  rmSync(hooks, { recursive: true, force: true })
  mkdirSync(hooks, { recursive: true })
  const sharedHooks = await localConfig(path, "core.hooksPath")
  const source = sharedHooks ? resolve(path, sharedHooks) : join((await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(), "hooks")
  if (existsSync(source)) for (const name of readdirSync(source)) {
    if (!name.endsWith(".sample") && name !== "pre-push" && statSync(join(source, name)).isFile()) copyFileSync(join(source, name), join(hooks, name))
  }
  const refusal = deliveryRefusal({ questID, delivery, gate: "push" }) ?? ""
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\necho ${shellQuote(refusal)} >&2\nexit 1\n`)
  await git(path, ["config", "--worktree", "core.hooksPath", hooks])
  for (const remote of await remoteNames(path)) await git(path, ["config", "--worktree", "--replace-all", `remote.${remote}.pushurl`, REFUSED_PUSH_URL])
}

async function remoteNames(path: string): Promise<string[]> {
  return (await git(path, ["remote"])).split("\n").map(name => name.trim()).filter(Boolean)
}

async function localConfig(path: string, key: string): Promise<string | undefined> {
  const result = await driveAsync(gitRun(path, ["config", "--local", "--get", key]))
  return result.status === 0 ? result.stdout.trim() || undefined : undefined
}

function shellQuote(text: string): string {
  return "'" + text.replaceAll("'", "'\\''") + "'"
}
