import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import type { AccountPlan, PublicConnection, UsageProvider } from "./types"
import { keyIdentity, readStore } from "./store"

export type Connection = PublicConnection & {
  provider: UsageProvider
  accountID: string
  identity: "account" | "connection"
  plan: AccountPlan
  token: () => string | undefined
  upstreamAccountID?: string
}
const str = (x: unknown): string | undefined => typeof x === "string" && x.trim() ? x : undefined
const hash = (x: string) => createHash("sha256").update(x).digest("hex").slice(0, 20)
export const opaqueAccountID = (provider: string, identity: string) => provider + "-" + hash(provider + ":" + identity)
const unknownPlan = (): AccountPlan => ({ name: null, rateLimitTier: null, multiplier: null, provenance: "unknown", observedAt: null })
function json(path: string): any { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) }
function jsonc(path: string): any {
  const source = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
  let out = "", quote = false, escaped = false, line = false, block = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i], n = source[i + 1]
    if (line) { if (c === "\n") { line = false; out += c }; continue }
    if (block) { if (c === "*" && n === "/") { block = false; i++ }; continue }
    if (quote) { out += c; if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quote = false; continue }
    if (c === '"') { quote = true; out += c; continue }
    if (c === "/" && n === "/") { line = true; i++; continue }
    if (c === "/" && n === "*") { block = true; i++; continue }
    out += c
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, "$1"))
}
function configuredSecret(value: unknown, home: string): string | undefined {
  const raw = str(value)
  const file = raw?.match(/^\{file:(.+)\}$/)?.[1]?.replace(/^~(?=[\\/]|$)/, home)
  if (file) { try { return str(readFileSync(file, "utf8").trim()) } catch { return undefined } }
  return raw && !/^\{(?:env|file):/.test(raw) ? raw : undefined
}
function jwt(token: unknown): any {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString()) } catch { return {} }
}
export type DiscoveryPaths = { home: string; config: string; codex: string; claude: string; data: string; usage: string }
export function discoveryPaths(): DiscoveryPaths {
  const isolated = process.env.OPENCODE_ACCOUNT_DISCOVERY_ROOT
  if (isolated) return { home: isolated, config: join(isolated, ".config/opencode"), codex: join(isolated, ".codex"), claude: join(isolated, ".claude"), data: join(isolated, ".local/share/opencode"), usage: join(isolated, ".config/usage/connections.json") }
  const home = homedir()
  return {
    home, config: process.env.OPENCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode"),
    codex: process.env.CODEX_HOME ?? join(home, ".codex"),
    claude: process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
    data: join(process.env.XDG_DATA_HOME ?? join(home, ".local/share"), "opencode"),
    usage: process.env.USAGE_CONNECTIONS_FILE ?? join(home, ".config/usage/connections.json"),
  }
}
export function discoverConnections(paths = discoveryPaths()): { connections: Connection[]; diagnostics: string[] } {
  const connections: Connection[] = [], diagnostics: string[] = []
  const read = (path: string, owner: string): any => {
    if (!existsSync(path)) return undefined
    try { return json(path) } catch { diagnostics.push(owner + ": credential metadata unreadable"); return undefined }
  }
  const add = (owner: PublicConnection["owner"], path: string, provider: UsageProvider, auth: any, readAuth: () => any, extra: any = {}) => {
    if (!auth || auth.disabled === true) return
    const tokenKey = ["access_token", "accessToken", "access", ...(provider === "opencode-go" ? ["key", "apiKey"] : []), ...(provider === "ollama-cloud" ? ["apiKey"] : [])].find(key => str(auth[key]))
    if (!tokenKey) return
    const claims = jwt(auth.id_token ?? auth[tokenKey]), accessClaims = jwt(auth[tokenKey])
    const claim = claims["https://api.openai.com/auth"] ?? accessClaims["https://api.openai.com/auth"] ?? {}
    const upstreamAccountID = str(auth.account_id ?? auth.accountId ?? claim.chatgpt_account_id)
    const claudeAccount = str(auth.account_uuid ?? extra.accountUuid)
    const organization = str(auth.organization_uuid ?? extra.organizationUuid)
    const identityKey = str(extra.identityKey) ?? (provider === "openai" ? upstreamAccountID : provider === "claude" && claudeAccount && organization ? claudeAccount + ":" + organization : str(auth.account_id ?? auth.user_id))
    const identity = identityKey ? "account" : "connection"
    const fallback = owner + ":" + path + ":" + provider
    const plan = unknownPlan()
    const name = str(auth.subscriptionType ?? claim.chatgpt_plan_type)
    const tier = str(auth.rateLimitTier ?? extra.organizationRateLimitTier)
    if (name || tier) Object.assign(plan, {
      name: name ?? null, rateLimitTier: tier ?? null,
      multiplier: /(?:^|_)(5|20)x(?:_|$)/.test(tier ?? "") ? Number((tier ?? "").match(/(?:^|_)(5|20)x(?:_|$)/)![1]) : null,
      provenance: "credential-metadata",
    })
    connections.push({
      id: "connection-" + hash(fallback), accountID: opaqueAccountID(provider, identityKey ?? fallback), identity,
      owner, provider, plan, upstreamAccountID,
      modelPrefix: str(auth.prefix) ?? null,
      routeProviders: owner === "broker" ? ["cliproxyapi"] : owner === "codex" ? ["codex"] :
        owner === "claude-code" ? ["claude-code"] : provider === "openai" ? ["openai"] : [provider],
      token: () => { try { return str(readAuth()?.[tokenKey]) } catch { return undefined } },
    })
  }
  const brokerConfig = join(paths.config, "cliproxyapi/config.localhost.yaml")
  if (existsSync(brokerConfig)) {
    try {
      const cfg = Bun.YAML.parse(readFileSync(brokerConfig, "utf8")) as any
      const dir = str(cfg?.["auth-dir"])?.replace(/^~(?=[\\/]|$)/, paths.home)
      if (dir) for (const file of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
        const path = join(dir, file), c = read(path, "broker")
        const provider = c?.type === "codex" ? "openai" : c?.type === "claude" ? "claude" : c?.type === "xai" ? "grok" : undefined
        if (provider) add("broker", path, provider, c, () => json(path))
      }
    } catch { diagnostics.push("broker: account store unavailable") }
  }
  const openCodeFile = join(paths.data, "auth.json"), openCode = read(openCodeFile, "opencode")
  if (openCode?.openai?.type === "oauth") add("opencode", openCodeFile, "openai", openCode.openai, () => json(openCodeFile).openai)
  if (openCode?.["opencode-go"]) add("opencode", openCodeFile, "opencode-go", openCode["opencode-go"], () => json(openCodeFile)["opencode-go"])
  if (openCode?.anthropic?.type === "oauth") add("opencode", openCodeFile, "claude", openCode.anthropic, () => json(openCodeFile).anthropic)
  const configRoots = [paths.config, join(paths.home, ".config/opencode")]
  const channels = join(paths.home, ".config/opencode/.channels")
  if (existsSync(channels)) for (const file of readdirSync(channels).filter(name => name.endsWith(".json")).sort()) try {
    const root = str(json(join(channels, file))?.root)
    if (root) configRoots.push(root)
  } catch { diagnostics.push("opencode: channel configuration unreadable") }
  const seenRoots = new Set<string>()
  for (const root of configRoots) {
    const key = process.platform === "win32" ? root.toLowerCase() : root
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    const configFile = [join(root, "opencode.jsonc"), join(root, "opencode.json")].find(existsSync)
    if (!configFile) continue
    try {
      const config = jsonc(configFile), provider = config?.providers?.["ollama-cloud"]
      const source = provider?.settings?.apiKey ?? provider?.options?.apiKey
      const configured = configuredSecret(source, paths.home) ?? str(process.env.OLLAMA_API_KEY)
      if (configured) add("opencode", configFile, "ollama-cloud", { apiKey: configured }, () => ({ apiKey: configured }), { identityKey: "configured:" + hash(String(source ?? configured)) })
    } catch { diagnostics.push("ollama-cloud: provider configuration unreadable") }
  }
  const codexFile = join(paths.codex, "auth.json"), codex = read(codexFile, "codex")
  if (codex?.tokens && !codex.OPENAI_API_KEY) add("codex", codexFile, "openai", codex.tokens, () => json(codexFile).tokens)
  const claudeFile = join(paths.claude, ".credentials.json"), claude = read(claudeFile, "claude-code")
  const metadata = read(paths.claude + ".json", "claude-code")?.oauthAccount
  if (claude?.claudeAiOauth) add("claude-code", claudeFile, "claude", claude.claudeAiOauth, () => json(claudeFile).claudeAiOauth, metadata)
  const stored = readStore(paths.usage)
  for (const row of stored.keys) {
    const provider = row.provider
    const identity = keyIdentity(row.apiKey)
    add("usage", paths.usage, provider, { apiKey: row.apiKey }, () => ({ apiKey: readStore(paths.usage).keys.find(key => key.provider === provider && keyIdentity(key.apiKey) === identity)?.apiKey }), { identityKey: identity })
  }
  return { connections: connections.filter(connection => !stored.ignored.includes(connection.accountID)), diagnostics }
}

type Discovered = { connections: Connection[]; diagnostics: string[] }
type CursorReading = { key: string; at: number; reading: Promise<Discovered & { settled: boolean }> }
const CURSOR_READINGS = Symbol.for("questgiver.cursor-sign-in-readings")
const cursorReadings = (): Map<string, CursorReading> => (globalThis as { [CURSOR_READINGS]?: Map<string, CursorReading> })[CURSOR_READINGS] ??= new Map()
export function cursorCredentialsFile(paths: DiscoveryPaths, environment: NodeJS.ProcessEnv = process.env) {
  if (process.platform === "win32") return join(environment.APPDATA ?? join(paths.home, "AppData/Roaming"), "Cursor", "auth.json")
  if (process.platform === "darwin") return join(paths.home, ".cursor", "auth.json")
  return join(environment.XDG_CONFIG_HOME ?? join(paths.home, ".config"), "cursor", "auth.json")
}
const fileState = (path: string) => { try { const seen = statSync(path); return seen.mtimeMs + ":" + seen.size } catch { return "absent" } }

export async function discoverCursorConnection(paths = discoveryPaths(), now: () => number = Date.now): Promise<Discovered> {
  const environment = { ...process.env }
  delete environment.CURSOR_API_KEY
  const command = process.platform === "win32" ? join(environment.LOCALAPPDATA ?? join(paths.home, "AppData/Local"), "cursor-agent/cursor-agent.cmd") : "cursor-agent"
  const credentials = cursorCredentialsFile(paths, environment)
  const key = [command, fileState(command), credentials, fileState(credentials)].join("\0"), readings = cursorReadings(), held = readings.get(command)
  if (held?.key === key) {
    const { settled, ...result } = await held.reading
    if (settled) return { ...result, diagnostics: [...result.diagnostics, "cursor: sign-in state is the cursor-agent status read at " + new Date(held.at).toISOString() + " (" + Math.max(0, Math.round((now() - held.at) / 1000)) + " s before this refresh); its credentials have not changed since"] }
  }
  const reading = { key, at: now(), reading: readCursorStatus(command, environment, credentials) }
  readings.set(command, reading)
  const { settled, ...result } = await reading.reading
  if (!settled && readings.get(command) === reading) readings.delete(command)
  return result
}

async function readCursorStatus(command: string, environment: NodeJS.ProcessEnv, credentials: string): Promise<Discovered & { settled: boolean }> {
  try {
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(process.platform === "win32" ? '"' + command + '"' : command, ["status", "--format", "json"], { encoding: "utf8", timeout: 5000, windowsHide: true, env: environment, shell: process.platform === "win32" },
        (error, out) => (error ? reject(error) : resolve(out))))
    const status = JSON.parse(stdout)
    const signedIn = (() => { try { return str(String(jwt(json(credentials).accessToken)?.sub ?? "").split("|").pop()) } catch { return undefined } })()
    const userID = str(status?.userInfo?.userId) ?? (Number.isFinite(status?.userInfo?.userId) ? String(status.userInfo.userId) : undefined) ?? signedIn
    if (status?.isAuthenticated !== true || !userID) return { connections: [], diagnostics: [], settled: true }
    return {
      settled: true,
      connections: [{
        id: "connection-" + hash("cursor:" + userID), accountID: opaqueAccountID("cursor", userID), identity: "account",
        owner: "cursor", provider: "cursor", plan: unknownPlan(), routeProviders: ["cursor"], modelPrefix: null,
        token: () => { try { return str(json(credentials).accessToken) } catch { return undefined } },
      }],
      diagnostics: [],
    }
  } catch {
    return { connections: [], diagnostics: ["cursor: authenticated CLI status unavailable"], settled: process.platform === "win32" && !existsSync(command) }
  }
}

export async function discoverAllConnections(paths = discoveryPaths()) {
  const files = discoverConnections(paths)
  const cursor = await discoverCursorConnection(paths)
  const ignored = readStore(paths.usage).ignored
  return { connections: [...files.connections, ...cursor.connections.filter(connection => !ignored.includes(connection.accountID))], diagnostics: [...files.diagnostics, ...cursor.diagnostics] }
}
