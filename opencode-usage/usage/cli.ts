#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { v2StateDirectory, channelPointerFile, stateEnvironment, selectedChannelName } from "../scripts/channel-migrate.mjs"

export function hostStateEnvironment(environment: NodeJS.ProcessEnv = process.env, home = homedir()): Record<string, string> {
  const chosen = [...Object.keys(stateEnvironment("")), "OPENCODE_ACCOUNT_USAGE_FILE", "OPENCODE_PASSIVE_LEDGER_FILE"]
  if (chosen.some(key => environment[key])) return {}
  const registry = join(home, ".config/opencode/.channels")
  if (selectedChannelName(registry, environment) !== "v2" || !existsSync(channelPointerFile(registry, "v2"))) return {}
  return stateEnvironment(v2StateDirectory(registry))
}

const interrupt = String.fromCharCode(3), erase = String.fromCharCode(127)

async function hiddenPrompt(question: string): Promise<string> {
  process.stdout.write(question)
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim()
  return new Promise(resolve => {
    let value = ""
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === interrupt) { process.stdout.write("\n"); process.exit(130) }
        if (character === "\r" || character === "\n") {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.off("data", onData)
          process.stdout.write("\n")
          return resolve(value.trim())
        }
        value = character === erase ? value.slice(0, -1) : value + character
      }
    }
    process.stdin.on("data", onData)
  })
}

async function connectWithKey(provider: string | undefined) {
  const { catalogEntry } = await import("../usage-service/on-computer")
  const { usageProductBackend } = await import("./mcp")
  const entry = provider ? catalogEntry(provider) : undefined
  if (!entry) throw new Error("usage connect <provider>; providers that take a key: opencode-go, ollama-cloud")
  if (entry.kind !== "key-form") throw new Error(entry.name + " signs in with: " + entry.command)
  const backend = usageProductBackend({ keyForm: true })
  const attempt = await backend.connectStart(entry.provider)
  const status = await backend.submitKey(attempt.id, await hiddenPrompt(entry.name + " key (get one at " + entry.keyAt + "), typed hidden: "))
  console.log(status.state + ": " + status.message)
  if (status.state === "failed") process.exitCode = 1
}

export async function main(args = process.argv.slice(2)) {
  Object.assign(process.env, hostStateEnvironment())
  const { usageTools, callUsage } = await import("./tools")
  const [command, ...rest] = args
  if (!command || command === "--help" || command === "help") {
    console.log("usage <operation> [JSON object | - (stdin)]\nusage mcp\nusage connect <provider>\n\n" + usageTools.map(op => `${op.name.replace(/^usage_/, "")}  ${op.description}`).join("\n"))
    return
  }
  if (command === "mcp") {
    if (rest.length) throw new Error("usage mcp takes no arguments")
    const { serveUsageStdio } = await import("./mcp")
    await serveUsageStdio()
    return
  }
  if (command === "connect") {
    if (rest.length > 1) throw new Error("usage connect takes one provider and asks for the key privately")
    await connectWithKey(rest[0])
    return
  }
  const name = command.startsWith("usage_") ? command : `usage_${command}`
  if (rest.length > 1) throw new Error("Pass a single JSON object as the operation argument")
  const input = rest.length ? JSON.parse(rest[0] === "-" ? await Bun.stdin.text() : rest[0]!) : {}
  const result = await callUsage(name, input)
  console.log(result.content)
}

if (import.meta.main) main().catch(error => {
  console.error(JSON.stringify({ code: "REQUEST_FAILED", message: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
