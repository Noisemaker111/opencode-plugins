import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { channelRuntimes } from "../quest/host/channel-runtimes.mjs"
import { ledgerScopeTotals } from "./passive-ledger"
import type { Reservation } from "../models/route-reservations"
import type { AccountUsage } from "../usage-service/on-computer"

const inFlight = (row: Reservation) => row.state === "active" || row.state === "unknown"
type ChannelUse = { channel: string; inFlight: number; runs: string[]; reservedPoints: Record<string, number>; windows: { windowID: string; from: string; requests: number | null; tokens: number | null }[]; problem?: string }

function reservations(runtime: { questRuntime: string }): { rows: Reservation[]; problem?: string } {
  const file = join(runtime.questRuntime, "route-reservations.json")
  if (!existsSync(file)) return { rows: [] }
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))
    return Array.isArray(value?.reservations) ? { rows: value.reservations } : { rows: [], problem: "route reservation ledger unreadable: " + file }
  } catch (error) { return { rows: [], problem: "route reservation ledger unreadable: " + (error instanceof Error ? error.message : String(error)) } }
}

export function channelQuotaView(accounts: AccountUsage[], now = Date.now(), home = homedir()) {
  const runtimes = channelRuntimes(home).map(runtime => ({ ...runtime, ledger: runtime.telemetry + ".ledger.sqlite", held: reservations(runtime) }))
  const rows = accounts.map(account => {
    const windows = account.windows.filter(window => window.scope === "shared" && window.resetAt && window.durationSeconds)
      .map(window => ({ window, from: Date.parse(window.resetAt!) - window.durationSeconds! * 1000 }))
    const channels: ChannelUse[] = runtimes.map(runtime => {
      const mine = runtime.held.rows.filter(row => row.accountID === account.id && inFlight(row))
      const reservedPoints: Record<string, number> = {}
      for (const row of mine) for (const [id, points] of Object.entries(row.windows ?? {})) if (Number.isFinite(points)) reservedPoints[id] = (reservedPoints[id] ?? 0) + points
      const used = windows.map(({ window, from }) => {
        let totals = null
        try { totals = existsSync(runtime.ledger) ? ledgerScopeTotals({ accountID: account.id, source: "opencode", from, to: now }, runtime.ledger) : null } catch {}
        return { windowID: window.id, from: new Date(from).toISOString(), requests: totals?.requests ?? null, tokens: totals?.knownTokens ?? null }
      })
      return { channel: runtime.channel, inFlight: mine.length, runs: mine.map(row => row.runID), reservedPoints, windows: used, ...(runtime.held.problem ? { problem: runtime.held.problem } : {}) }
    })
    return { accountID: account.id, provider: account.provider,
      windows: windows.map(({ window }) => ({ windowID: window.id, remainingPercent: window.remainingPercent, resetAt: window.resetAt, observedAt: window.observedAt })),
      inFlight: channels.reduce((sum, channel) => sum + channel.inFlight, 0), channels }
  })
  return { at: new Date(now).toISOString(), channels: runtimes.map(runtime => runtime.channel), accounts: rows,
    basis: "Remaining allowance is the provider's own meter for the account, so it already includes every channel's spend. In-flight runs and reserved points come from every channel's route reservations, and admission counts them all against the same account windows. Requests are the ones each channel recorded since the window started." }
}
