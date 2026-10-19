export type UsageProvider = "openai" | "claude" | "opencode-go" | "ollama-cloud" | "grok" | "cursor"
export type AccountWindow = {
  id: string
  label: string
  scope: "shared" | "model" | "feature" | "unknown"
  model?: string
  durationSeconds: number | null
  precisionPoints?: number
  reportingDelayMilliseconds?: number
  usedPercent: number | null
  remainingPercent: number | null
  resetAt: string | null
  dollars?: { used: number; limit: number | null }
  observedAt: string
  state: "available" | "exhausted" | "unknown"
}
export type AccountPlan = {
  name: string | null
  rateLimitTier: string | null
  multiplier: number | null
  provenance: "provider-observed" | "credential-metadata" | "unknown"
  observedAt: string | null
}
export type PublicConnection = {
  id: string
  owner: "broker" | "opencode" | "codex" | "claude-code" | "cursor" | "usage"
  routeProviders: string[]
  modelPrefix: string | null
}
export type AccountUsage = {
  id: string
  provider: UsageProvider
  identity: "account" | "connection"
  connections: PublicConnection[]
  plan: AccountPlan
  windows: AccountWindow[]
  extraUsage: { enabled: boolean | null }
  activeConnectionID?: string
  freshness?: { stale: boolean; ageSeconds: number | null; resetPending: boolean }
  state: "available" | "exhausted" | "unknown" | "auth-required" | "unsupported"
  observedAt: string | null
  attemptedAt: string | null
  nextAttemptAt: string | null
  failures: number
  throttles?: number
  throttledAt?: string | null
  error: string | null
}
export type AccountSnapshot = {
  schema: 1
  updatedAt: string
  accounts: AccountUsage[]
  diagnostics: string[]
}
