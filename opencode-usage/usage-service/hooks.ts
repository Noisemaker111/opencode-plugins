import type { AccountSnapshot } from "./types"

export type UsageHooks = {
  recorded?(snapshot: AccountSnapshot, file: string): void
  refreshed?(snapshot: AccountSnapshot, options: { now: number; pollIntervalMs: number }): void
  span?<T>(name: string, run: () => Promise<T>): Promise<T>
}

const key = Symbol.for("usage-service.hooks")
const root = globalThis as unknown as Record<symbol, UsageHooks | undefined>

export function installUsageHooks(hooks: UsageHooks): void { root[key] = hooks }
export const usageHooks = (): UsageHooks => root[key] ?? {}
