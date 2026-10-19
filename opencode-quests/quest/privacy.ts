import { createHash } from "node:crypto"
import {redactSensitive} from '../core/error.mts'
export {redactSensitive}
export function redact(value: string, max = 500): string {
  return redactSensitive(value).slice(0, max)
}
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex") }
export function bounded<T>(values: T[], max = 500): T[] { return values.slice(-max) }
export function requestFingerprint(value: unknown): string {
  const identity = /^(?:id|.*ID|.*Id|.*Ref|ref|.*Key|path|uri|branch|worktree|file|files|repo|directory|digest)$/
  const normalized = JSON.stringify(value, (key, item) => typeof item === "string" ? identity.test(key) ? item : redact(item, 10_000).trim().replace(/\s+/g, " ") : item)
  return digest(normalized)
}
