import type { UsageProvider } from "./types"

export type ConnectKind = "device-code" | "browser-link" | "key-form" | "local-command"

export type ProviderEntry = {
  provider: UsageProvider
  name: string
  readsUsage: boolean
  kind: ConnectKind
  hostIntegration?: { id: string; method: RegExp }
  command: string
  signOut: string | null
  keyAt?: string
  where: string
  tokenHome: string
}

export const providerCatalog: ProviderEntry[] = [
  {
    provider: "openai", name: "ChatGPT and Codex", readsUsage: true, kind: "device-code",
    hostIntegration: { id: "openai", method: /headless/i },
    command: "codex login --device-auth",
    signOut: "codex logout",
    where: "a sign-in page on auth.openai.com that asks for a short one-time code",
    tokenHome: "the sign-in store of the Codex or OpenCode on this computer; never sent to the hosted service",
  },
  {
    provider: "claude", name: "Claude Pro or Max", readsUsage: true, kind: "local-command",
    command: "claude auth login",
    signOut: "claude auth logout",
    where: "Claude's own sign-in in a browser on the computer that runs the command",
    tokenHome: ".claude/.credentials.json on this computer, written by Claude Code; never sent to the hosted service",
  },
  {
    provider: "opencode-go", name: "OpenCode Go", readsUsage: true, kind: "key-form",
    command: "usage connect opencode-go",
    signOut: null,
    keyAt: "https://opencode.ai/zen",
    where: "a private page on this site, or a hidden prompt in a terminal",
    tokenHome: ".config/usage/connections.json on this computer; the key passes through the hosted relay once and is not kept there",
  },
  {
    provider: "ollama-cloud", name: "Ollama Cloud", readsUsage: true, kind: "key-form",
    command: "usage connect ollama-cloud",
    signOut: null,
    keyAt: "https://ollama.com/settings/keys",
    where: "a private page on this site, or a hidden prompt in a terminal",
    tokenHome: ".config/usage/connections.json on this computer; the key passes through the hosted relay once and is not kept there",
  },
  {
    provider: "cursor", name: "Cursor", readsUsage: false, kind: "local-command",
    command: "cursor-agent login",
    signOut: "cursor-agent logout",
    where: "Cursor's own sign-in in a browser on the computer that runs the command",
    tokenHome: "Cursor's own files on this computer; Usage reads only whether you are signed in",
  },
  {
    provider: "grok", name: "Grok (xAI)", readsUsage: false, kind: "browser-link",
    hostIntegration: { id: "xai", method: /supergrok/i },
    command: "opencode auth login",
    signOut: "opencode auth logout",
    where: "a sign-in page that returns to this computer, so the browser must be on the same computer",
    tokenHome: "the OpenCode sign-in store on this computer; Usage reads only whether you are signed in",
  },
]

export const catalogEntry = (provider: string) => providerCatalog.find(entry => entry.provider === provider)
export const providerIDs = providerCatalog.map(entry => entry.provider)
