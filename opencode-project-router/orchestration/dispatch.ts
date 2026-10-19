export const WORKER_AGENTS: Record<string, string> = {
  "cliproxyapi/claude-opus-5": "proxy-claude",
  "cliproxyapi/claude-sonnet-5": "proxy-sonnet",
  "cliproxyapi/claude-haiku-4-5-20251001": "proxy-haiku",
  "cliproxyapi/gpt-5.6-sol": "proxy-sol",
  "cliproxyapi/gpt-5.6-luna": "proxy-luna",
  "cliproxyapi/gpt-5.6-terra": "proxy-terra",
  "cliproxyapi/claude-fable-5-1": "proxy-fable",
  "openai/gpt-5.6-luna-fast": "luna",
  "cliproxyapi/grok-4.6": "grok",
  "openai/gpt-6-astra": "astra",
  "cliproxyapi/gpt-6-astra": "astra-proxy",
}

export type WorkerRuntime = "native"

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max"

export type WorkerIdentity = {
  agentRole: "worker" | "orchestrator"
  providerID: string
  modelID: string
  runtime: WorkerRuntime
  openCodeSessionId?: string
  runtimeSessionId?: string
  parentID: string
  runID: string
  task: string
  reasoningEffort?: ReasoningEffort
  fast?: boolean
}

const FORBIDDEN_CALLER_FIELDS = ["agent", "agentRole", "role", "runtime", "subagent", "subagent_type"] as const

const VARIANT_HINT = /^(none|low|medium|high|xhigh|max)(-fast)?$/i

const LANE_REASONING_DEFAULT: Record<string, ReasoningEffort> = {
  "openai/gpt-5.6-luna-fast": "max",
  "openai/gpt-6-astra": "high",
  "cliproxyapi/gpt-6-astra": "high",
  "cliproxyapi/gpt-5.6-sol": "xhigh",
  "cliproxyapi/claude-fable-5-1": "high",
}

export function parseVariantHint(variant: unknown): { reasoningEffort?: ReasoningEffort; fast?: boolean } {
  const match = text(variant).toLowerCase().match(VARIANT_HINT)
  if (!match) return {}
  return { reasoningEffort: match[1] as ReasoningEffort, fast: !!match[2] }
}

export function reasoningEffortFor(providerID: string, modelID: string, variant: unknown): { reasoningEffort?: ReasoningEffort; fast: boolean } {
  const hint = parseVariantHint(variant)
  const fast = hint.fast || /-fast$/i.test(modelID)
  if (hint.reasoningEffort) return { reasoningEffort: hint.reasoningEffort, fast }
  return { reasoningEffort: LANE_REASONING_DEFAULT[`${providerID}/${modelID}`.toLowerCase()], fast }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function splitProviderModel(value: string): { providerID: string; modelID: string } | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return
  const providerID = value.slice(0, slash).trim()
  const modelID = value.slice(slash + 1).trim()
  if (!providerID || !modelID || /\s/.test(providerID)) return
  return { providerID, modelID }
}

export function taskDescription(input: Record<string, unknown>): string {
  return text(input.task) || text(input.prompt) || text(input.description)
}

export function canonicalWorkerTitle(identity: Pick<WorkerIdentity, "providerID" | "modelID" | "task">): string {
  return `${identity.providerID}/${identity.modelID} - ${identity.task}`
}

export type ChipFaceSession = {
  providerID?: string
  modelID?: string
  model?: string
  reasoningEffort?: ReasoningEffort
  fast?: boolean
}

export function subagentChipLabel(quest: { title: string }, session: ChipFaceSession): string {
  const model = session.providerID && session.modelID ? `${session.providerID}/${session.modelID}` : session.model
  const parts = [quest.title, model, session.reasoningEffort].filter(Boolean) as string[]
  if (session.fast) parts.push("fast")
  return `(${parts.join(", ")})`
}

export function bindWorkerSessions(identity: WorkerIdentity, sessions: { openCodeSessionId?: string; runtimeSessionId?: string }): WorkerIdentity {
  return { ...identity, openCodeSessionId: sessions.openCodeSessionId ?? identity.openCodeSessionId, runtimeSessionId: sessions.runtimeSessionId ?? identity.runtimeSessionId }
}

export const MODEL_ALIASES: Record<string, { providerID: string; modelID: string }> = {
  claude: { providerID: "cliproxyapi", modelID: "claude-opus-5" },
  opus: { providerID: "cliproxyapi", modelID: "claude-opus-5" },
  sonnet: { providerID: "cliproxyapi", modelID: "claude-sonnet-5" },
  haiku: { providerID: "cliproxyapi", modelID: "claude-haiku-4-5-20251001" },
  grok: { providerID: "cliproxyapi", modelID: "grok-4.6" },
  astra: { providerID: "openai", modelID: "gpt-6-astra" },
  codex: { providerID: "cliproxyapi", modelID: "gpt-5.6-sol" },
}

export function aliasModel(value: unknown): { providerID: string; modelID: string } | undefined {
  const raw = text(value).toLowerCase()
  return raw ? MODEL_ALIASES[raw] : undefined
}

const DISPATCH_TOOLS = /^(task|subagent)$/i

export function canonicalizeDispatch(event: unknown): WorkerIdentity | undefined {
  const ev = (event ?? {}) as Record<string, unknown>
  const tool = text(ev.tool ?? ev.name)
  if (!DISPATCH_TOOLS.test(tool)) return

  const input = (ev.input ?? ev.args) as Record<string, unknown> | undefined
  if (!input || typeof input !== "object") throw new Error("Quest dispatch requires an input object")
  const requested = splitProviderModel(text(input.model)) ?? aliasModel(input.model)
  const preparedAgent = requested && typeof input.description === "string" && input.agent === WORKER_AGENTS[`${requested.providerID}/${requested.modelID}`]
  const forbidden = FORBIDDEN_CALLER_FIELDS.find((field) => field in input && !(field === "agent" && preparedAgent))
  if (forbidden) throw new Error(`Quest dispatch derives hidden role/runtime; caller field ${forbidden} is forbidden`)

  const task = taskDescription(input)
  if (!task) throw new Error("Quest dispatch requires task")
  if (!text(input.questID)) throw new Error("Quest dispatch requires questID")
  const selected = splitProviderModel(text(input.model)) ?? aliasModel(input.model)
  if (!selected) throw new Error("Legacy Quest dispatch requires an explicit provider/model; use quest run for account-aware automatic routing")
  if (selected.providerID === "claude-code") throw new Error("claude-code was retired; choose a native route")

  const parentID = text(ev.sessionID ?? ev.parentSessionID)
  const runID = text(ev.callID ?? ev.id ?? ev.messageID)
  if (!parentID || !runID) throw new Error("Quest dispatch requires parent session and run IDs")
  const reasoning = selected ? reasoningEffortFor(selected.providerID, selected.modelID, input.variant) : { reasoningEffort: undefined, fast: false }
  const identity: WorkerIdentity = {
    agentRole: "worker",
    providerID: selected?.providerID ?? "",
    modelID: selected?.modelID ?? "",
    runtime: "native",
    parentID,
    runID,
    task,
    reasoningEffort: reasoning.reasoningEffort,
    fast: reasoning.fast,
  }
  if (selected) input.model = `${selected.providerID}/${selected.modelID}`
  ev.workerIdentity = identity
  const metadata = ev.metadata && typeof ev.metadata === "object" ? ev.metadata as Record<string, unknown> : {}
  const title = identity.providerID && identity.modelID ? canonicalWorkerTitle(identity) : identity.task
  ev.metadata = { ...metadata, worker: { ...identity, title } }
  return identity
}

export function workerIdentityFromEvent(event: unknown): WorkerIdentity | undefined {
  const value = (event as { workerIdentity?: unknown } | undefined)?.workerIdentity
  return value && typeof value === "object" ? value as WorkerIdentity : undefined
}

export function nativeSessionNavigation(identity: WorkerIdentity, row: { id?: string; parentID?: string }): { type: "session"; sessionID: string } | undefined {
  if (identity.runtime !== "native") return
  const sessionID = identity.openCodeSessionId
  if (!sessionID || row.id !== sessionID) return
  if (row.parentID && row.parentID !== identity.parentID) return
  return { type: "session", sessionID }
}
