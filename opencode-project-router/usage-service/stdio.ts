import { createInterface } from "node:readline"
import type { Backend } from "./backend"
import { handleMcp } from "./mcp"
import { USAGE_CONNECT, USAGE_READ } from "./scopes"

export async function serveStdio(backend: Backend, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
  for await (const line of createInterface({ input })) {
    if (!line.trim()) continue
    let message: Parameters<typeof handleMcp>[0]
    try { message = JSON.parse(line) } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n")
      continue
    }
    const reply = await handleMcp(message, { scopes: [USAGE_READ, USAGE_CONNECT], backend })
    if (reply !== undefined) output.write(JSON.stringify(reply) + "\n")
  }
}
