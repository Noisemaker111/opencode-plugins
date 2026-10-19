import { questRoot } from "../root.mts"
import { compactQuestDispatch } from "./context"
import { QuestStore } from "../store"
import type { Quest } from "../types"
import { aliasModel, reasoningEffortFor, splitProviderModel, subagentChipLabel, WORKER_AGENTS } from "../../orchestration/dispatch"

export { WORKER_AGENTS } from "../../orchestration/dispatch"

export const QUEST_SUBAGENT_DESCRIPTION = [
  "Legacy internal Quest transport. Start new work with the Quest start or run operation and the Quest id.",
  "The Quest runtime prepares dispatch, applies configured routing and manages the worker workspace.",
  "Do not construct or copy dispatch envelopes yourself.",
].join(" ")

export const QUEST_SUBAGENT_INPUT = {
  type: "object" as const,
  properties: {
    agent: { type: "string", description: "Internal legacy runtime field. Use quest run for new work." },
    description: { type: "string", description: "Internal legacy display field. Use quest run for new work." },
    questID: { type: "string", description: "Canonical Quest ID. The worker prompt is derived from this Quest." },
    task: { type: "string", description: "Short task for the worker. Do not paste Quest fields." },
    cwd: { type: "string", description: "Working directory for the subagent (defaults to parent cwd)" },
    sessionID: { type: "string", description: "Existing Quest-bound session to continue" },
    model: { type: "string", description: "Exact provider/model for legacy dispatch. Use quest run for account-aware automatic routing." },
  },
  required: ["questID", "task", "agent", "description"],
  additionalProperties: false,
}

export type NativeSubagentInput = {
  agent: string
  description: string
  prompt: string
  sessionID?: string
  background: true
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function agentForModel(model: unknown): string {
  const raw = text(model)
  if (!raw) throw new Error("Legacy Quest dispatch requires an explicit provider/model; use quest run for account-aware automatic routing")
  const selected = splitProviderModel(raw) ?? aliasModel(raw)
  if (!selected) throw new Error(`Quest dispatch model must be claude, sonnet, haiku, grok, codex, or provider/model (got ${raw})`)
  const agent = WORKER_AGENTS[`${selected.providerID}/${selected.modelID}`]
  if (!agent) throw new Error(`No pinned worker agent for ${raw}; refusing to substitute another model`)
  return agent
}

export function readCanonicalQuest(questID: string): Quest {
  const quest = new QuestStore(questRoot()).read(questID)
  if (quest) return quest
  throw new Error(`Quest dispatch references unknown Quest ${questID}`)
}

export function derivedSpawnAgent(quest: Quest, input: Record<string, unknown>): string {
  const continuationID = text(input.sessionID)
  if (continuationID) {
    const target = quest.sessions.find((session) => session.sessionID === continuationID || session.openCodeSessionId === continuationID)
    if (!target) throw new Error(`Quest dispatch session ${continuationID} is not bound to Quest ${quest.id}`)
  }
  return agentForModel(input.model)
}

export function toNativeSubagentInput(input: Record<string, unknown>, quest: Quest): NativeSubagentInput {
  const task = text(input.task) || text(input.prompt) || text(input.description)
  if (!task) throw new Error("Quest dispatch requires task")
  const sessionID = text(input.sessionID) || undefined
  return {
    agent: derivedSpawnAgent(quest, input),
    description: dispatchChipLabel(quest, input),
    prompt: compactQuestDispatch(quest, task),
    sessionID,
    background: true,
  }
}

export function dispatchChipLabel(quest: Quest, input: Record<string, unknown>): string {
  const selected = splitProviderModel(text(input.model)) ?? aliasModel(input.model)
  if (!selected) return subagentChipLabel(quest, {})
  const reasoning = reasoningEffortFor(selected.providerID, selected.modelID, input.variant)
  return subagentChipLabel(quest, {
    providerID: selected.providerID,
    modelID: selected.modelID,
    reasoningEffort: reasoning.reasoningEffort,
    fast: reasoning.fast,
  })
}

export function validatePreparedSubagent(input: Record<string, unknown>, quest = readCanonicalQuest(text(input.questID))): NativeSubagentInput {
  const native = toNativeSubagentInput(input, quest)
  if (input.agent !== native.agent || input.description !== native.description) throw new Error("Dispatch fields are missing or stale. Use the Quest start or run operation with the Quest id; the runtime prepares dispatch and isolates the worker.")
  return native
}
