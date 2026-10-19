import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { BROKER_LOGIN_FLAGS, startBrokerLogin, type BrokerLogin } from "./broker-login"
import { probeConnection } from "./adapters"
import { UsageError, type Backend, type Capabilities, type ConnectStart, type ConnectStatus, type Disconnected } from "./backend"
import type { Connection } from "./connections"
import { discoveryPaths, opaqueAccountID, type DiscoveryPaths } from "./connections"
import { catalogEntry, providerCatalog, type ConnectKind, type ProviderEntry } from "./providers"
import { ignoreAccount, keyIdentity, readStore, removeKey, saveKey, unignoreProvider } from "./store"
import type { AccountUsage, UsageProvider } from "./types"
import type { ReadAccount } from "./views"

export type HostAttempt = { attemptID: string; url: string; instructions: string; mode: "auto" | "code" }
export type HostIntegration = {
  start(integrationID: string, method: RegExp): Promise<HostAttempt>
  status(integrationID: string, attemptID: string): Promise<{ status: "pending" | "complete" | "failed" | "expired"; message?: string }>
  cancel(integrationID: string, attemptID: string): Promise<void>
}

export type LocalOptions = {
  accounts: (refresh: boolean) => Promise<AccountUsage[]>
  paths?: DiscoveryPaths
  host?: HostIntegration
  keyForm?: boolean
  release?: string | null
  fetch?: typeof fetch
  now?: () => number
  newID?: () => string
  brokerLogin?: (provider: UsageProvider) => Promise<BrokerLogin | undefined>
}

type Attempt = {
  provider: UsageProvider
  kind: ConnectKind
  before: Set<string>
  expiresAt: number
  host?: { integrationID: string; attemptID: string }
  hostDone?: boolean
}

export const ATTEMPT_MS = 15 * 60_000
const MAX_ATTEMPTS = 20

export type LocalBackend = Backend & {
  connectStart(provider: UsageProvider, options?: { another?: boolean }): Promise<ConnectStart>
  connectStatus(id: string): Promise<ConnectStatus>
  disconnect(account: string): Promise<Disconnected>
  submitKey(id: string, key: string): Promise<ConnectStatus>
}

export function localBackend(options: LocalOptions): LocalBackend {
  const paths = options.paths ?? discoveryPaths()
  const now = options.now ?? Date.now
  const newID = options.newID ?? randomUUID
  const attempts = new Map<string, Attempt>()
  const tracked = (id: string): Attempt => {
    const attempt = attempts.get(id)
    if (!attempt) throw new UsageError("UNKNOWN_ATTEMPT", "No sign-in with that id is open on this computer. Start again with connect_start.")
    return attempt
  }
  const kindFor = (entry: ProviderEntry): ConnectKind => {
    if (entry.kind === "key-form") return options.keyForm ? "key-form" : "local-command"
    if (entry.hostIntegration) return options.host ? entry.kind : "local-command"
    return entry.kind
  }
  const remember = (id: string, attempt: Attempt) => {
    for (const [key, held] of attempts) if (held.expiresAt < now()) attempts.delete(key)
    while (attempts.size >= MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value!)
    attempts.set(id, attempt)
  }
  const commandStart = (id: string, entry: ProviderEntry, note?: string): ConnectStart => ({
    id, provider: entry.provider, name: entry.name, kind: "local-command", readsUsage: entry.readsUsage, command: entry.command,
    steps: [...(note ? [note] : []), `Run the command on the computer whose ${entry.name} account should be read.`, `Finish the sign-in in ${entry.where}.`, "Then check connect_status; Usage picks the account up by itself."],
    tokenHome: entry.tokenHome, expiresAt: new Date(now() + ATTEMPT_MS).toISOString(),
  })

  const brokerLogin = options.brokerLogin ?? ((provider: UsageProvider) => startBrokerLogin(provider, join(paths.config, "cliproxyapi", "config.localhost.yaml")))

  async function connectStart(provider: UsageProvider, start: { another?: boolean } = {}): Promise<ConnectStart> {
    const entry = catalogEntry(provider)
    if (!entry) throw new UsageError("UNKNOWN_PROVIDER", "Usage does not know that provider.")
    unignoreProvider(paths.usage, provider)
    const before = new Set((await options.accounts(false)).map(account => account.id))
    const id = newID()
    const expiresAt = now() + ATTEMPT_MS
    const kind = kindFor(entry)
    if (start.another && BROKER_LOGIN_FLAGS[provider]) {
      const login = await brokerLogin(provider).catch(() => undefined)
      if (login) {
        const linkKind: ConnectKind = login.code ? "device-code" : "browser-link"
        remember(id, { provider, kind: linkKind, before, expiresAt })
        return {
          id, provider, name: entry.name, kind: linkKind, readsUsage: entry.readsUsage, url: login.url, ...(login.code ? { code: login.code } : {}),
          steps: login.code
            ? [`Open the link and sign in to the other ${entry.name} account.`, "Enter the code shown below when the page asks for it.", "Then check connect_status; CLIProxy adds the account beside the ones it holds."]
            : [`Open the link in a browser on the computer Usage reads and sign in to the other ${entry.name} account.`, "Then check connect_status; CLIProxy adds the account beside the ones it holds."],
          tokenHome: "a new account file in CLIProxy's folder on this computer; never sent to the hosted service", expiresAt: new Date(expiresAt).toISOString(),
        }
      }
    }
    if (kind === "key-form") {
      remember(id, { provider, kind, before, expiresAt })
      return {
        id, provider, name: entry.name, kind, readsUsage: entry.readsUsage, formPath: `/usage/connect/${id}`,
        steps: [`Get a key at ${entry.keyAt}.`, "Open the private page and paste the key there. Do not paste it into this chat.", "Then check connect_status."],
        tokenHome: entry.tokenHome, expiresAt: new Date(expiresAt).toISOString(),
      }
    }
    if (kind === "device-code" || kind === "browser-link") {
      try {
        const started = await options.host!.start(entry.hostIntegration!.id, entry.hostIntegration!.method)
        if (started.mode === "auto") {
          remember(id, { provider, kind, before, expiresAt, host: { integrationID: entry.hostIntegration!.id, attemptID: started.attemptID } })
          const code = kind === "device-code" ? /code:\s*(\S+)/i.exec(started.instructions)?.[1] : undefined
          return {
            id, provider, name: entry.name, kind, readsUsage: entry.readsUsage, url: started.url, ...(code ? { code } : {}),
            steps: kind === "device-code"
              ? [`Open the link and sign in to ${entry.name}.`, "Enter the one-time code shown below when the page asks for it.", "Then check connect_status."]
              : [`Open the link in a browser on the same computer as the computer Usage reads, and sign in to ${entry.name}.`, "Then check connect_status."],
            tokenHome: entry.tokenHome, expiresAt: new Date(expiresAt).toISOString(),
          }
        }
        await options.host!.cancel(entry.hostIntegration!.id, started.attemptID).catch(() => undefined)
      } catch {}
      remember(id, { provider, kind: "local-command", before, expiresAt })
      return commandStart(id, entry, "A sign-in link could not be made on this computer, so use the command instead.")
    }
    remember(id, { provider, kind, before, expiresAt })
    return commandStart(id, entry)
  }

  async function connectStatus(id: string): Promise<ConnectStatus> {
    const attempt = tracked(id)
    const entry = catalogEntry(attempt.provider)!
    const report = (state: ConnectStatus["state"], message: string, account?: string): ConnectStatus => ({ id, provider: attempt.provider, state, message, ...(account ? { account } : {}) })
    if (now() > attempt.expiresAt) return report("expired", "This sign-in timed out. Start again with connect_start.")
    if (attempt.host && !attempt.hostDone) {
      const seen = await options.host!.status(attempt.host.integrationID, attempt.host.attemptID)
      if (seen.status === "failed") return report("failed", seen.message || "The provider refused the sign-in.")
      if (seen.status === "expired") return report("expired", "The provider's sign-in timed out. Start again with connect_start.")
      if (seen.status === "pending") return report("waiting", `Waiting for you to finish signing in to ${entry.name}.`)
      attempt.hostDone = true
    }
    const accounts = await options.accounts(true)
    const fresh = accounts.find(account => account.provider === attempt.provider && !attempt.before.has(account.id))
    if (fresh) return report("connected", `${entry.name} is connected.`, fresh.id)
    const existing = accounts.find(account => account.provider === attempt.provider)
    if (attempt.hostDone && existing) return report("connected", `${entry.name} signed in; that account was already connected.`, existing.id)
    return report("waiting", `No new ${entry.name} account yet. If you signed in with an account already listed in plans, it is already connected.`)
  }

  async function submitKey(id: string, key: string): Promise<ConnectStatus> {
    const attempt = tracked(id)
    if (attempt.kind !== "key-form") throw new UsageError("NOT_A_KEY_FORM", "This sign-in does not take a key.")
    if (now() > attempt.expiresAt) return { id, provider: attempt.provider, state: "expired", message: "This sign-in timed out. Start again with connect_start." }
    const entry = catalogEntry(attempt.provider)!
    const trial: Connection = {
      id: "connection-trial", accountID: "trial", identity: "connection", owner: "usage", provider: attempt.provider, routeProviders: [attempt.provider], modelPrefix: null,
      plan: { name: null, rateLimitTier: null, multiplier: null, provenance: "unknown", observedAt: null }, token: () => key.trim(),
    }
    const probed = await probeConnection(trial, { now, fetch: options.fetch ?? fetch, refreshPlan: false })
    if (!("windows" in probed) && probed.state === "auth-required") return { id, provider: attempt.provider, state: "failed", message: `${entry.name} did not accept that key. Check it and open the page again.` }
    try { saveKey(paths.usage, attempt.provider, key) } catch (error) {
      return { id, provider: attempt.provider, state: "failed", message: error instanceof Error ? error.message : "The key could not be saved." }
    }
    return connectStatus(id)
  }

  async function disconnect(account: string): Promise<Disconnected> {
    const all = await options.accounts(false)
    const found = all.filter(candidate => candidate.id === account || candidate.id.endsWith(account))
    if (!found.length) throw new UsageError("UNKNOWN_ACCOUNT", "No connected account matches that. Call plans for the ids.")
    if (found.length > 1) throw new UsageError("AMBIGUOUS_ACCOUNT", "More than one account matches that. Use the full id from plans.")
    const target = found[0]
    const owners = [...new Set(target.connections.map(connection => connection.owner))]
    const held = readStore(paths.usage).keys.find(row => row.provider === target.provider && opaqueAccountID(row.provider, keyIdentity(row.apiKey)) === target.id)
    const removedKey = owners.includes("usage") && held ? removeKey(paths.usage, target.provider, keyIdentity(held.apiKey)) : false
    const others = owners.filter(owner => owner !== "usage")
    if (others.length) ignoreAccount(paths.usage, target.id)
    const signOut = others.length ? catalogEntry(target.provider)?.signOut ?? null : null
    const parts = [
      removedKey ? "The key Usage held was deleted from this computer." : "",
      others.length ? `Usage no longer reads or reports this account. It is still signed in through ${others.join(" and ")}${signOut ? `; to sign out there, run ${signOut}` : ""}. connect_start reads it again.` : "",
    ].filter(Boolean)
    return { account: target.id, provider: target.provider, removedKey, hidden: others.length > 0, stillSignedInVia: others, command: signOut, message: parts.join(" ") || "Nothing was changed." }
  }

  const capabilities = async (): Promise<Capabilities> => ({
    release: options.release ?? null,
    generation: null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    read: ["plans", "usage", "forecast"],
    operations: ["connect_start", "connect_status", "disconnect"],
    connect: providerCatalog.map(entry => ({ provider: entry.provider, kind: kindFor(entry) })),
  })

  return { capabilities, accounts: async () => (await options.accounts(false)) as ReadAccount[], connectStart, connectStatus, disconnect, submitKey }
}
