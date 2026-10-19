import { statSync } from "node:fs"
import { readJsonRecord } from "./durable-file.mjs"

const parsed = new Map<string, { stamp: string; value: unknown }>()

export function readJsonCached<T>(file: string): T | undefined {
  const info = statSync(file, { throwIfNoEntry: false })
  if (!info) return undefined
  const stamp = info.mtimeMs + ":" + info.size
  const held = parsed.get(file)
  if (held?.stamp === stamp) return structuredClone(held.value) as T
  const value = readJsonRecord(file) as T | undefined
  if (value === undefined) { parsed.delete(file); return undefined }
  parsed.set(file, { stamp, value })
  return structuredClone(value)
}
