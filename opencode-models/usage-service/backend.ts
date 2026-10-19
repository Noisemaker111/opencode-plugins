import type { ConnectKind } from "./providers"
import type { UsageProvider } from "./types"
import type { ReadAccount } from "./views"

export type Capabilities = {
  release: string | null
  generation: string | null
  timeZone?: string
  read: string[]
  operations: string[]
  connect: { provider: UsageProvider; kind: ConnectKind }[]
}

export const supports = (capabilities: Capabilities, name: string) => capabilities.read.includes(name) || capabilities.operations.includes(name)

export const unavailableOnComputer = (name: string, capabilities: Capabilities) =>
  `${name} is not available on the computer's Usage service (release ${capabilities.release ? capabilities.release.slice(0, 7) : "unknown"}). Update it to use ${name}.`

export type ConnectStart = {
  id: string
  provider: UsageProvider
  name: string
  kind: ConnectKind
  readsUsage: boolean
  url?: string
  code?: string
  command?: string
  formPath?: string
  steps: string[]
  tokenHome: string
  expiresAt: string | null
}

export type ConnectStatus = {
  id: string
  provider: UsageProvider
  state: "waiting" | "connected" | "failed" | "expired"
  account?: string
  message: string
}

export type Disconnected = {
  account: string
  provider: UsageProvider
  removedKey: boolean
  hidden: boolean
  stillSignedInVia: string[]
  command: string | null
  message: string
}

export type Backend = {
  capabilities(): Promise<Capabilities>
  accounts(): Promise<ReadAccount[]>
  connectStart?(provider: UsageProvider, options?: { another?: boolean }): Promise<ConnectStart>
  connectStatus?(id: string): Promise<ConnectStatus>
  disconnect?(account: string): Promise<Disconnected>
}

export class UsageError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
