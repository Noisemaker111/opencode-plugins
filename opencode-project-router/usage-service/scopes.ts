export const USAGE_READ = "usage:read"
export const USAGE_CONNECT = "usage:connect"
export const usageLevels = { read: [USAGE_READ], connect: [USAGE_READ, USAGE_CONNECT] }
export type UsageLevel = keyof typeof usageLevels

export const usageScopeSummary = {
  [USAGE_READ]: "Read each account's plan, usage windows, resets and forecast. Changes nothing.",
  [USAGE_CONNECT]: "Start a sign-in for a provider account and disconnect one. Each action is labeled with the app's name and recorded.",
}

export const connectTools = ["connect_start", "connect_status", "disconnect"]
export const toolScope = (name: string) => connectTools.includes(name) ? USAGE_CONNECT : USAGE_READ

const known: string[] = [USAGE_READ, USAGE_CONNECT]
export const parseUsageScopes = (text: unknown): string[] => [...new Set(String(text ?? "").split(/\s+/).filter(scope => known.includes(scope)))]
export const asksForUsage = (text: unknown) => parseUsageScopes(text).length > 0
export const usageLevelOf = (scopes: string[]): UsageLevel => scopes.includes(USAGE_CONNECT) ? "connect" : "read"
