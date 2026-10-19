import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import type { UsageProvider } from "./types"

export const CONNECTIONS_BUDGET_BYTES = 64 * 1024
const MAX_KEYS = 20, MAX_IGNORED = 50, MAX_KEY_LENGTH = 512

export type StoredKey = { provider: UsageProvider; apiKey: string; addedAt: string }
export const keyIdentity = (apiKey: string) => "usage:" + createHash("sha256").update(apiKey.trim()).digest("hex").slice(0, 20)
export type Store = { schema: 1; keys: StoredKey[]; ignored: string[] }
const empty = (): Store => ({ schema: 1, keys: [], ignored: [] })

function readStrict(file: string): Store {
  if (!existsSync(file)) return empty()
  const data = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""))
  if (data?.schema !== 1) throw new Error("The saved connections file has an unknown schema.")
  const keys = Array.isArray(data.keys) ? data.keys.filter((row: any) => row && typeof row.provider === "string" && typeof row.apiKey === "string" && row.apiKey) : []
  const ignored = Array.isArray(data.ignored) ? data.ignored.filter((id: unknown) => typeof id === "string") : []
  return { schema: 1, keys, ignored }
}

export function readStore(file: string): Store {
  try { return readStrict(file) } catch { return empty() }
}

function writeStore(file: string, store: Store) {
  const body = JSON.stringify({ schema: 1, keys: store.keys.slice(-MAX_KEYS), ignored: store.ignored.slice(-MAX_IGNORED) })
  if (Buffer.byteLength(body) > CONNECTIONS_BUDGET_BYTES) throw new Error("The saved connections are over their size budget.")
  mkdirSync(dirname(file), { recursive: true })
  const temporary = file + "." + randomUUID() + ".tmp"
  writeFileSync(temporary, body, { mode: 0o600 })
  try { chmodSync(temporary, 0o600) } catch {}
  renameSync(temporary, file)
}

export function saveKey(file: string, provider: UsageProvider, apiKey: string, now = new Date()): void {
  const key = apiKey.trim()
  if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) throw new Error("That is not a usable key.")
  const store = readStrict(file)
  writeStore(file, { ...store, keys: [...store.keys.filter(row => !(row.provider === provider && row.apiKey === key)), { provider, apiKey: key, addedAt: now.toISOString() }], ignored: store.ignored })
}

export function removeKey(file: string, provider: UsageProvider, identity?: string): boolean {
  const store = readStrict(file)
  const keys = store.keys.filter(row => row.provider !== provider || identity !== undefined && keyIdentity(row.apiKey) !== identity)
  if (keys.length === store.keys.length) return false
  writeStore(file, { ...store, keys })
  return true
}

export function ignoreAccount(file: string, accountID: string): void {
  const store = readStrict(file)
  if (!store.ignored.includes(accountID)) writeStore(file, { ...store, ignored: [...store.ignored, accountID] })
}

export function unignoreProvider(file: string, provider: UsageProvider): void {
  const store = readStrict(file)
  const ignored = store.ignored.filter(id => !id.startsWith(provider + "-"))
  if (ignored.length !== store.ignored.length) writeStore(file, { ...store, ignored })
}
