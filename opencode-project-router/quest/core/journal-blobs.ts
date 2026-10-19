import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeFileDurable } from "./durable-file.mjs"

const BLOB_MIN_CHARS = 4096
const BLOB_KEY = "$blob"
const HASH = /^[0-9a-f]{64}$/

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const blobFile = (runtimeRoot: string, hash: string) => join(runtimeRoot, "blobs", hash)

function walk(value: unknown, leaf: (value: unknown) => unknown): unknown {
  const replaced = leaf(value)
  if (replaced !== value) return replaced
  if (Array.isArray(value)) {
    const items = value.map(item => walk(item, leaf))
    return items.some((item, index) => item !== value[index]) ? items : value
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => [key, walk(item, leaf)] as const)
    return entries.some(([key, item]) => item !== (value as Record<string, unknown>)[key]) ? Object.fromEntries(entries) : value
  }
  return value
}

function reference(runtimeRoot: string, text: string) {
  const hash = digest(text), file = blobFile(runtimeRoot, hash)
  if (!existsSync(file)) writeFileDurable(file, text)
  return { [BLOB_KEY]: hash }
}

const isReference = (value: unknown): value is Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === BLOB_KEY && HASH.test((value as Record<string, string>)[BLOB_KEY])
}

function text(runtimeRoot: string, hash: string) {
  try {
    const body = readFileSync(blobFile(runtimeRoot, hash), "utf8")
    if (digest(body) === hash) return body
  } catch {}
  return `[blob unavailable: ${hash}]`
}

export function externalizeBlobs<T>(runtimeRoot: string, value: T): T {
  return walk(value, item => typeof item === "string" && item.length >= BLOB_MIN_CHARS ? reference(runtimeRoot, item) : item) as T
}

export function hasBlobReference(line: string) { return line.includes(`"${BLOB_KEY}"`) }
export function resolveBlobs<T>(runtimeRoot: string, value: T): T {
  return walk(value, item => isReference(item) ? text(runtimeRoot, item[BLOB_KEY]) : item) as T
}
