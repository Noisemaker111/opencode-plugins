import { readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type ModelIdentity = { providerID: string; id?: string; modelID?: string }
const supported = new Set(["openai", "opencode-go", "ollama-cloud", "cliproxyapi", "grok-sub"])
export function assertSubscriptionModel(model: ModelIdentity) {
  const provider = model.providerID.toLowerCase(), id = model.id ?? model.modelID ?? ""
  if (provider === "opencode" && /-free$/.test(id)) return
  if (supported.has(provider)) return
  throw new Error(`Subscription-only policy: ${model.providerID}/${id} has no approved free or subscription route. API-priced usage is disabled, including named requests.`)
}

export function assertOAuthProxyConfig(config: any, credentials: any[]) {
  if (config.host !== "127.0.0.1" && config.host !== "localhost") throw new Error("Subscription broker must bind to loopback")
  for (const [key, value] of Object.entries(config)) {
    if ((key.endsWith("-api-key") || ["openai-compatibility", "vertex", "ampcode"].includes(key)) && value && (!Array.isArray(value) || value.length)) {
      throw new Error(`Subscription broker has an API-priced or unverified route: ${key}`)
    }
  }
  if (config.plugins?.enabled) throw new Error("Subscription broker has unverified executor plugins")
  if (config["quota-exceeded"]?.["antigravity-credits"] !== false) throw new Error("Subscription broker must disable credit fallback")
  if (!credentials.some((c) => c.disabled !== true)) throw new Error("Subscription broker has no enabled OAuth accounts")
  for (const credential of credentials.filter((c) => c.disabled !== true)) {
    if (!["codex", "claude", "xai"].includes(credential.type) || !credential.refresh_token || credential.api_key || credential["api-key"] || ["apikey", "api_key"].includes(credential.auth_mode)) {
      throw new Error("Subscription broker contains a non-OAuth or unverified credential")
    }
  }
}

export const brokerConfigFile = () => process.env.OPENCODE_CLIPROXY_CONFIG ?? join(homedir(), ".config/opencode/cliproxyapi/config.localhost.yaml")

export function verifyOAuthProxy(configFile = brokerConfigFile()) {
  const config = Bun.YAML.parse(readFileSync(configFile, "utf8")) as any
  const directory = String(config["auth-dir"] ?? "~/.cli-proxy-api").replace(/^~(?=[\\/]|$)/, homedir())
  const credentials = readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")))
  assertOAuthProxyConfig(config, credentials)
  const apiKey = Array.isArray(config["api-keys"]) && typeof config["api-keys"][0] === "string" ? config["api-keys"][0] as string : undefined
  return { origin: `http://${config.host}:${config.port}`, apiKey, credentials: credentials.filter((c) => c.disabled !== true).map((c) => c.type) }
}

export function assertSubscriptionRequest(model: ModelIdentity, requestURL: string, proxyOrigin: string) {
  assertSubscriptionModel(model)
  const url = new URL(requestURL), provider = model.providerID.toLowerCase()
  if (["cliproxyapi", "grok-sub"].includes(provider) && url.origin === proxyOrigin && url.pathname.startsWith("/v1/")) return
  if (provider === "openai" && url.protocol === "https:" && url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex/")) return
  if (["opencode", "opencode-go"].includes(provider) && url.protocol === "https:" && ["opencode.ai", "api.opencode.ai"].includes(url.hostname)) return
  if (provider === "ollama-cloud" && url.protocol === "https:" && url.hostname === "ollama.com" && url.pathname.startsWith("/v1/")) return
  throw new Error(`Subscription-only policy: ${provider} request has no verified subscription transport. Direct API billing and legacy CLI model bridges are disabled.`)
}
