import { UsageError, supports, unavailableOnComputer, type Backend, type Capabilities } from "./backend"
import { detailInput, includeInput, leanDisconnect, leanForecast, leanPlans, leanStart, leanStatus, leanUsage } from "./lean"
import { catalogEntry, providerCatalog } from "./providers"
import { redact, redactDeep } from "./redact"
import { USAGE_CONNECT, connectTools, toolScope } from "./scopes"
import type { UsageProvider } from "./types"
import { forecastView, plansView, usageView, type ReadAccount } from "./views"

const versions = ["2025-06-18", "2025-03-26", "2024-11-05"]
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false })
const text = (description: string) => ({ type: "string", description })
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const reads = ["plans", "usage", "forecast"]
const known = [...reads, ...connectTools]
const SHORT = "Short answer by default; detail=true returns the whole view."

export const INSTRUCTIONS = "Usage reads a person's AI subscription plans, usage windows and resets across providers. Call plans for the accounts, usage for each window's share used and reset, forecast for when a window runs out at its current pace. To connect accounts, call connect_start with no provider: it returns one sign-in link, or the exact command to run, per provider that is not connected yet. Show each link to the person exactly as given and never ask them to type or paste a key, token or code into this chat. Then call connect_status with the id of each to see it finish. Provider tokens stay on the person's computer."

type Tool = { name: string; description: string; inputSchema: { properties: Record<string, unknown>; required: string[] }; annotations: object }

const statusTool: Tool = { name: "status", description: "Says whether the linked computer's Usage service is online and, when it is not, why and when it comes back.", inputSchema: object({}), annotations: readOnly }

const allTools = (capabilities: Capabilities): Tool[] => {
  const account = text("An account id from plans, or the last six characters of one.")
  const provider = text("A provider id, such as openai, claude, opencode-go, ollama-cloud, cursor or grok.")
  return [
    { name: "plans", description: "Each connected account: provider, plan, next reset, stale flag and any error. " + SHORT, inputSchema: object({ detail: detailInput }), annotations: readOnly },
    { name: "usage", description: "Each account's usage windows: share left and when it resets. Filter by account or provider. " + SHORT, inputSchema: object({ account, provider, detail: detailInput, include: includeInput }), annotations: readOnly },
    { name: "forecast", description: "Which windows run out before their reset at the current pace. Filter by account or provider. " + SHORT, inputSchema: object({ account, provider, detail: detailInput }), annotations: readOnly },
    { name: "connect_start", description: "Start connecting a provider account. With no provider it starts every provider that is not connected yet and returns one link or command each. Never takes a secret.",
      inputSchema: object({ provider: { type: "string", enum: capabilities.connect.map(entry => entry.provider), description: "One provider to connect. Omit for every provider not connected yet." } }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    { name: "connect_status", description: "Whether a sign-in started by connect_start has finished: waiting, connected, failed or expired.",
      inputSchema: object({ id: text("The id connect_start returned.") }, ["id"]), annotations: readOnly },
    { name: "disconnect", description: "Stop Usage reading an account. It deletes a key Usage holds and hides an account another tool owns; it never signs out of that tool.",
      inputSchema: object({ account }, ["account"]), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  ]
}

export const listTools = (scopes: string[], capabilities: Capabilities): Tool[] =>
  allTools(capabilities).filter(tool => scopes.includes(toolScope(tool.name)) && supports(capabilities, tool.name) && (tool.name !== "connect_start" || capabilities.connect.length > 0))

export type Audit = {
  begin(tool: string, summary: Record<string, unknown>): Promise<{ limited: true; limit: number } | { limited: false; id: string }>
  end(id: string, outcome: string): Promise<void>
}
export type Context = { scopes: string[]; backend: Backend; audit?: Audit; now?: () => number }
type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } }

const clipped = (text: string, room: number) => text.length <= room ? text : text.slice(0, room - 1) + "…"
const failure = (code: string, message: string, next?: string) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, why: clipped(redact(message), 100), ...(next ? { next } : {}) }) }] })
const success = (structured: unknown) => ({ content: [{ type: "text", text: JSON.stringify(redactDeep(structured)) }] })

async function call(name: string, input: Record<string, unknown>, context: Context, capabilities: Capabilities) {
  const now = (context.now ?? Date.now)()
  const { backend } = context
  if (reads.includes(name)) {
    const accounts: ReadAccount[] = await backend.accounts()
    const filter = { account: input.account as string | undefined, provider: input.provider as string | undefined }
    const detail = input.detail === true
    if (name === "plans") return success(leanPlans(plansView(accounts, now, capabilities.timeZone), detail))
    if (name === "usage") return success(leanUsage(usageView(accounts, filter, now, capabilities.timeZone), detail, (input.include as string[] | undefined) ?? []))
    return success(leanForecast(forecastView(accounts, filter, now), detail))
  }
  if (name === "connect_start") {
    const offered = capabilities.connect.map(entry => entry.provider)
    const asked = input.provider as UsageProvider | undefined
    if (asked && !offered.includes(asked)) throw new UsageError("NOT_SUPPORTED", `${asked} cannot be connected from here. Offered: ${offered.join(", ") || "none"}.`)
    const connected = new Set((await backend.accounts()).map(account => account.provider))
    const providers = asked ? [asked] : offered.filter(provider => !connected.has(provider))
    if (!providers.length) return success(leanStart([]))
    const attempts = await Promise.all(providers.map(provider => backend.connectStart!(provider)))
    return success(leanStart(attempts))
  }
  if (name === "connect_status") {
    const status = await backend.connectStatus!(String(input.id))
    return success(leanStatus(status))
  }
  const result = await backend.disconnect!(String(input.account))
  return success(leanDisconnect(result))
}

type Computer = { capabilities: Capabilities } | { capabilities?: undefined; code: string; problem: string }

async function computer(backend: Backend): Promise<Computer> {
  try { return { capabilities: await backend.capabilities() } } catch (error) {
    return { code: error instanceof UsageError ? error.code : "HOST_UNREACHABLE", problem: error instanceof Error ? error.message : "The linked computer is not reachable." }
  }
}

export async function handleMcp(message: Message, context: Context): Promise<unknown | undefined> {
  if (message.id === undefined || message.id === null) return undefined
  const answer = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result })
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion ?? ""
      return answer({ protocolVersion: versions.includes(asked) ? asked : versions[0], capabilities: { tools: {} }, serverInfo: { name: "usage", version: "1.0.0" }, instructions: INSTRUCTIONS })
    }
    case "ping": return answer({})
    case "tools/list": {
      const running = await computer(context.backend)
      return answer({ tools: running.capabilities ? [...listTools(context.scopes, running.capabilities), statusTool] : [statusTool] })
    }
    case "tools/call": {
      const name = message.params?.name ?? ""
      const raw = message.params?.arguments ?? {}
      if (name === "status") {
        const running = await computer(context.backend)
        const head = running.capabilities ? `Usage service release ${running.capabilities.release ?? "unknown"}, ${listTools(context.scopes, running.capabilities).length} tools.` : running.problem
        return answer(success({ head, state: running.capabilities ? "online" : "unavailable", code: running.capabilities ? "OK" : running.code }))
      }
      if (!known.includes(name)) return answer(failure("UNKNOWN_TOOL", "Unknown tool: " + name))
      const scope = toolScope(name)
      if (!context.scopes.includes(scope)) return answer(failure("SCOPE_REQUIRED", `${name} needs the ${scope} scope. The person can allow it for this app, then connect again.`))
      const running = await computer(context.backend)
      if (!running.capabilities) return answer(failure(running.code, running.problem))
      const tool = allTools(running.capabilities).find(candidate => candidate.name === name)!
      if (!listTools(context.scopes, running.capabilities).some(listed => listed.name === name)) return answer(failure("NOT_AVAILABLE", unavailableOnComputer(name, running.capabilities)))
      if (typeof raw !== "object" || !raw || Array.isArray(raw)) return answer(failure("INVALID_INPUT", `${name} takes an object.`))
      const input = raw as Record<string, unknown>
      const allowed = Object.keys(tool.inputSchema.properties)
      const extra = Object.keys(input).find(key => !allowed.includes(key))
      if (extra) return answer(failure("INVALID_INPUT", `${name} has no field "${extra}"; allowed: ${allowed.join(", ") || "none"}`, "Check tools/list for fields."))
      if (input.detail !== undefined && typeof input.detail !== "boolean") return answer(failure("INVALID_INPUT", '"detail" must be true or false.'))
      if (input.include !== undefined && (!Array.isArray(input.include) || input.include.some(part => part !== "unknown"))) return answer(failure("INVALID_INPUT", '"include" takes a list of: unknown.'))
      for (const key of allowed) if (key !== "detail" && key !== "include" && input[key] !== undefined && typeof input[key] !== "string") return answer(failure("INVALID_INPUT", `"${key}" must be a string.`))
      const missing = tool.inputSchema.required.find(key => typeof input[key] !== "string" || !(input[key] as string).trim())
      if (missing) return answer(failure("INVALID_INPUT", `${name} needs "${missing}" as a non-empty string.`))
      if (name === "connect_start" && input.provider && !catalogEntry(String(input.provider))) return answer(failure("INVALID_INPUT", `Unknown provider. Known: ${providerCatalog.map(entry => entry.provider).join(", ")}.`))
      let audited: string | undefined
      if (scope === USAGE_CONNECT && name !== "connect_status" && context.audit) {
        const begun = await context.audit.begin(name, { provider: input.provider, account: input.account })
        if (begun.limited) return answer(failure("RATE_LIMITED", `Too many changes from this app: at most ${begun.limit} a minute. Wait a moment and try again.`))
        audited = begun.id
      }
      try {
        const result = await call(name, input, context, running.capabilities)
        if (audited) await context.audit!.end(audited, "done")
        return answer(result)
      } catch (error) {
        const reason = error instanceof Error ? error.message : "The request failed."
        if (audited) await context.audit!.end(audited, "refused: " + redact(reason).slice(0, 150))
        return answer(failure(error instanceof UsageError ? error.code : "REQUEST_FAILED", reason))
      }
    }
    default: return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
  }
}
