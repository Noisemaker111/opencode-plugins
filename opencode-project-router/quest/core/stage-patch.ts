import type { QuestStage } from "../types"

type Plain = Record<string, unknown>
type Change = { set: Plain; unset: string[] } | { full: Plain }
export type StagesPatch = { order: string[]; changed: Record<string, Change> }

const plain = (value: unknown): Plain => JSON.parse(JSON.stringify(value))
const canon = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
const same = (a: unknown, b: unknown) => canon(a) === canon(b)

function rebuild(base: Plain, change: { set: Plain; unset: string[] }): Plain {
  const next: Plain = { ...base }
  for (const key of change.unset) delete next[key]
  return Object.assign(next, change.set)
}

function delta(before: Plain | undefined, after: Plain): Change | undefined {
  const base = before ?? {}
  const set: Plain = {}
  for (const [key, value] of Object.entries(after)) if (!(key in base) || !same(base[key], value)) set[key] = value
  const change = { set, unset: Object.keys(base).filter(key => !(key in after)) }
  if (!same(rebuild(base, change), after)) return { full: after }
  return before && !Object.keys(set).length && !change.unset.length ? undefined : change
}

export function stagesPatch(before: QuestStage[], after: QuestStage[]): StagesPatch | undefined {
  const next = after.map(stage => plain(stage))
  const order = next.map(stage => stage.id)
  if (order.some(id => typeof id !== "string") || new Set(order).size !== order.length) return undefined
  const prior = new Map(before.map(stage => [stage.id, plain(stage)]))
  const changed: Record<string, Change> = {}
  for (const stage of next) {
    const id = stage.id as string, change = delta(prior.get(id), stage)
    if (change) changed[id] = change
  }
  return { order: order as string[], changed }
}

export function applyStagesPatch(before: QuestStage[], patch: StagesPatch): QuestStage[] {
  const prior = new Map(before.map(stage => [stage.id, stage]))
  return patch.order.flatMap(id => {
    const change = patch.changed[id]
    if (!change) return prior.has(id) ? [prior.get(id)!] : []
    if ("full" in change) return [structuredClone(change.full) as unknown as QuestStage]
    return [rebuild((prior.get(id) ?? {}) as Plain, { set: structuredClone(change.set), unset: change.unset }) as unknown as QuestStage]
  })
}

export function patchedStages(payload: Record<string, any>): Partial<QuestStage>[] {
  if (Array.isArray(payload.stages)) return payload.stages
  const patch = payload.stagesPatch as StagesPatch | undefined
  if (!patch?.changed) return []
  return patch.order.filter(id => id in patch.changed).map(id => {
    const change = patch.changed[id]
    return "full" in change ? change.full : { id, ...change.set }
  }) as Partial<QuestStage>[]
}
