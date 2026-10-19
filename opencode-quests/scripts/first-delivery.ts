const KEY = Symbol.for("questgiver.first-delivery")
const GENERATION = 4096
type Seen = { current: Set<string>; previous: Set<string> }
export function firstDelivery(consumer: string, event: unknown): boolean {
  const id = (event as { id?: unknown } | undefined)?.id
  if (typeof id !== "string" || !id) return true
  const state = globalThis as { [KEY]?: Map<string, Seen> }
  const consumers = state[KEY] ??= new Map()
  let seen = consumers.get(consumer)
  if (!seen) consumers.set(consumer, seen = { current: new Set(), previous: new Set() })
  if (seen.current.has(id) || seen.previous.has(id)) return false
  if (seen.current.size >= GENERATION) { seen.previous = seen.current; seen.current = new Set() }
  seen.current.add(id)
  return true
}
