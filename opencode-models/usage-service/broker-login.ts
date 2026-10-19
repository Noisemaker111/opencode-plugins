import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { UsageProvider } from "./types"

export const BROKER_LOGIN_FLAGS: Partial<Record<UsageProvider, string>> = { claude: "-claude-login", openai: "-codex-device-login", grok: "-xai-login" }
export const BROKER_LOGIN_WAIT_MS = 20_000
export const BROKER_LOGIN_LIFETIME_MS = 15 * 60_000

export type BrokerLogin = { url: string; code?: string }

export const brokerExecutable = (environment: NodeJS.ProcessEnv = process.env) =>
  environment.OPENCODE_CLIPROXY_EXE ?? join(environment.LOCALAPPDATA ?? "", "CLIProxyAPI", "cli-proxy-api.exe")

export function readLoginOutput(text: string): BrokerLogin | undefined {
  const url = text.match(/https:\/\/\S+/)?.[0]
  if (!url) return undefined
  const code = text.match(/(?:device code|enter this code)\s*:\s*([A-Z0-9-]{4,})/i)?.[1]
  return { url, ...(code ? { code } : {}) }
}

export function startBrokerLogin(provider: UsageProvider, config: string, options: { executable?: string; spawnLogin?: typeof spawn; waitMs?: number } = {}): Promise<BrokerLogin | undefined> {
  const flag = BROKER_LOGIN_FLAGS[provider], executable = options.executable ?? brokerExecutable()
  if (!flag || !existsSync(executable) || !existsSync(config)) return Promise.resolve(undefined)
  return new Promise(resolve => {
    let child: ChildProcess, text = "", settled = false
    const finish = (value: BrokerLogin | undefined) => { if (settled) return; settled = true; clearTimeout(wait); resolve(value) }
    try { child = (options.spawnLogin ?? spawn)(executable, ["-config", config, flag, "-no-browser"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) }
    catch { return resolve(undefined) }
    const wait = setTimeout(() => { finish(undefined); child.kill() }, options.waitMs ?? BROKER_LOGIN_WAIT_MS)
    const lifetime = setTimeout(() => child.kill(), BROKER_LOGIN_LIFETIME_MS)
    lifetime.unref?.()
    const read = (chunk: Buffer) => {
      text += chunk.toString()
      const login = readLoginOutput(text)
      if (login && (provider === "claude" || login.code)) finish(login)
    }
    child.stdout?.on("data", read)
    child.stderr?.on("data", read)
    child.on("error", () => finish(undefined))
    child.on("exit", () => { clearTimeout(lifetime); finish(readLoginOutput(text)) })
  })
}
