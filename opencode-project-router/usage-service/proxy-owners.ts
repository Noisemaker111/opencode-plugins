import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { writeFileDurable } from "./durable"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import JSON5 from "json5"

export const PROXY_OWNER_ACCOUNT: Record<string, string> = { anthropic: "claude", openai: "openai", xai: "grok" }
export const proxyOwnersFile = () => process.env.OPENCODE_PROXY_OWNERS_FILE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "proxy-model-owners.json")
type Owners = { at: string; providerID: string; owners: Record<string, string> }

let cached: { file: string; mtime: number; owners: Record<string, string> } | undefined
export function proxyOwners(file = proxyOwnersFile()): Record<string, string> {
  try {
    const mtime = statSync(file).mtimeMs
    if (cached?.file === file && cached.mtime === mtime) return cached.owners
    const value = JSON.parse(readFileSync(file, "utf8")) as Owners
    cached = { file, mtime, owners: value?.owners && typeof value.owners === "object" ? value.owners : {} }
    return cached.owners
  } catch { return {} }
}

export function proxyAccountProvider(modelID: string, owners = proxyOwners()) {
  const owner = owners[modelID]
  return owner ? PROXY_OWNER_ACCOUNT[owner] ?? owner : undefined
}

export async function refreshProxyOwners(configFile: string, providerID = "cliproxyapi", file = proxyOwnersFile()) {
  if (!existsSync(configFile)) return proxyOwners(file)
  const settings = (JSON5.parse(readFileSync(configFile, "utf8")) as any)?.providers?.[providerID]?.settings
  if (typeof settings?.baseURL !== "string" || typeof settings?.apiKey !== "string") return proxyOwners(file)
  const response = await fetch(settings.baseURL.replace(/\/$/, "") + "/models", { headers: { authorization: "Bearer " + settings.apiKey }, signal: AbortSignal.timeout(5000) })
  if (!response.ok) return proxyOwners(file)
  const listed = (await response.json() as { data?: { id?: unknown; owned_by?: unknown }[] }).data ?? []
  const owners = Object.fromEntries(listed.flatMap(model => typeof model.id === "string" && typeof model.owned_by === "string" ? [[model.id, model.owned_by]] : []))
  mkdirSync(dirname(file), { recursive: true })
  writeFileDurable(file, JSON.stringify({ at: new Date().toISOString(), providerID, owners } satisfies Owners))
  return owners
}
