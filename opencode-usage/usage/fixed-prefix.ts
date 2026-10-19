import { readLedger, PASSIVE_LEDGER_FILE, type LedgerRow } from "./passive-ledger"
import { sessionRoles, hostAgents, whoIs, BUDGET_ROLES, type BudgetRole } from "./session-budget"

export type FixedPrefixQuery = { from?: number; to?: number }
export type FixedPrefixSources = { projectRoot: string; runtime: string; ledgerFile?: string; hostFile?: string; now?: () => number }
type Section = { name: string; kind: "system" | "tool"; versions: number; tokens: number | null; sharedWith: BudgetRole[] }

const DAY = 86_400_000
export const DEFAULT_FIXED_PREFIX_WINDOW = "1d"
const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[values.length >> 1] : null
const sum = (values: number[]) => values.reduce((n, v) => n + v, 0)
const promptOf = (row: LedgerRow) => (row.tokens.input ?? 0) + (row.tokens.cacheRead ?? 0) + (row.tokens.cacheWrite ?? 0)
const nameOf = (entry: string) => { const at = entry.lastIndexOf("#"); return at > 0 ? entry.slice(0, at) : entry }

function entries(row: LedgerRow) {
  const prefix = row.request?.prefix
  if (!prefix) return []
  const sized = (list: string[], tokens: number[] | undefined, kind: "system" | "tool") => list.map((entry, i) => ({ entry, kind, tokens: tokens?.length === list.length ? tokens[i] : null }))
  return [...sized(prefix.system, prefix.tokens?.system, "system"), ...sized(prefix.tools, prefix.tokens?.tools, "tool")]
}

export function fixedPrefixPicture(sources: FixedPrefixSources, query: FixedPrefixQuery = {}) {
  const now = (sources.now ?? Date.now)(), from = query.from ?? now - DAY, to = query.to ?? now
  const ledger = readLedger({ from, to, source: "opencode" }, sources.ledgerFile ?? PASSIVE_LEDGER_FILE)
  const rows = ledger.rows.filter(row => row.state === "completed").sort((a, b) => a.startedAt - b.startedAt)
  const known = sessionRoles(sources.projectRoot, sources.runtime), parents = new Map<string, string>()
  for (const row of rows) if (row.parentID) parents.set(row.sessionID, row.parentID)
  const agents = hostAgents([...new Set(rows.map(row => row.sessionID))].filter(id => id.startsWith("ses_")), sources.hostFile)
  const roleOf = new Map<string, BudgetRole>(), first = new Map<string, LedgerRow>()
  for (const row of rows) {
    if (!roleOf.has(row.sessionID)) roleOf.set(row.sessionID, whoIs(row, known, parents, agents).role)
    if (!first.has(row.sessionID) && row.request?.prefix) first.set(row.sessionID, row)
  }
  const entryRoles = new Map<string, Set<BudgetRole>>()
  for (const [session, row] of first) for (const { entry } of entries(row)) (entryRoles.get(entry) ?? entryRoles.set(entry, new Set()).get(entry)!).add(roleOf.get(session)!)

  const roles = BUDGET_ROLES.flatMap(role => {
    const sessions = [...first.entries()].filter(([session]) => roleOf.get(session) === role).map(([, row]) => row)
    const all = rows.filter(row => roleOf.get(row.sessionID) === role)
    if (!all.length) return []
    const measured = sessions.map(row => entries(row)).filter(list => list.length && list.every(item => item.tokens !== null)).map(list => sum(list.map(item => item.tokens!)))
    const signatures = new Set(sessions.map(row => JSON.stringify(row.request!.prefix!.system) + JSON.stringify(row.request!.prefix!.tools)))
    const byName = new Map<string, { kind: "system" | "tool"; versions: Set<string>; tokens: number[]; shared: Set<BudgetRole> }>()
    for (const row of sessions) for (const item of entries(row)) {
      const name = nameOf(item.entry), held = byName.get(item.kind + ":" + name) ?? byName.set(item.kind + ":" + name, { kind: item.kind, versions: new Set(), tokens: [], shared: new Set() }).get(item.kind + ":" + name)!
      held.versions.add(item.entry)
      if (item.tokens !== null) held.tokens.push(item.tokens)
      for (const other of entryRoles.get(item.entry) ?? []) if (other !== role) held.shared.add(other)
    }
    const sections: Section[] = [...byName.entries()].map(([key, held]) => ({ name: key.slice(held.kind.length + 1), kind: held.kind, versions: held.versions.size, tokens: median(held.tokens), sharedWith: [...held.shared] }))
      .sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.name.localeCompare(b.name))
    const opening = sessions.map(row => row.tokens)
    return [{
      role, sessions: sessions.length, requests: all.length,
      fixedTokens: median(measured), fixedTokensMeasuredSessions: measured.length,
      firstPromptTokens: median(sessions.map(promptOf)),
      prefixVersions: signatures.size,
      firstRequest: { cacheWrite: sum(opening.map(t => t.cacheWrite ?? 0)), cacheRead: sum(opening.map(t => t.cacheRead ?? 0)), uncached: sum(opening.map(t => t.input ?? 0)) },
      allRequests: { cacheWrite: sum(all.map(row => row.tokens.cacheWrite ?? 0)), cacheRead: sum(all.map(row => row.tokens.cacheRead ?? 0)), uncached: sum(all.map(row => row.tokens.input ?? 0)) },
      changingSections: sections.filter(section => section.versions > 1).map(section => section.kind + " " + section.name),
      sections,
    }]
  }).sort((a, b) => b.requests - a.requests)

  const shared = [...entryRoles.entries()].filter(([, set]) => set.size > 1).map(([entry, set]) => {
    const tokens = median([...first.values()].flatMap(row => entries(row).filter(item => item.entry === entry && item.tokens !== null).map(item => item.tokens!)))
    return { name: nameOf(entry), roles: [...set], tokens }
  }).sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1))

  return {
    at: now, from, to, roles, shared,
    basis: "Each session's first completed request in the usage ledger gives its fixed prefix: the system sections (prompt, model, environment, date, skills, instructions files, Quest brief) and the tool definitions sent before any chat. Section sizes are o200k counts recorded with the request; requests recorded before sizes were kept show the first prompt total instead, which also holds the first message. versions counts distinct texts of a section across a role's sessions: more than one means that section changes between sessions and cannot be cache-read from another session. sharedWith names the other roles that sent the identical text.",
    diagnostics: ledger.diagnostics,
  }
}

const count = (n: number | null) => n === null ? "?" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n)
export function formatFixedPrefix(value: ReturnType<typeof fixedPrefixPicture>) {
  if (!value.roles.length) return ["No completed requests with a recorded prefix in this window.", ...value.diagnostics].join("\n")
  return [
    "Fixed prefix per role, " + new Date(value.from).toISOString() + " to " + new Date(value.to).toISOString(),
    ...value.roles.flatMap(r => [
      "", r.role + ": " + r.sessions + " sessions, " + r.requests + " requests; fixed prefix " + count(r.fixedTokens) + " tokens (" + r.fixedTokensMeasuredSessions + " measured), first prompt " + count(r.firstPromptTokens) + "; " + r.prefixVersions + " prefix versions",
      "  first request: cache write " + count(r.firstRequest.cacheWrite) + ", cache read " + count(r.firstRequest.cacheRead) + ", uncached " + count(r.firstRequest.uncached),
      "  all requests: cache write " + count(r.allRequests.cacheWrite) + ", cache read " + count(r.allRequests.cacheRead) + ", uncached " + count(r.allRequests.uncached),
      ...(r.changingSections.length ? ["  changes between sessions: " + r.changingSections.join(", ")] : []),
      ...r.sections.map(s => "    " + s.kind + " " + s.name + ": " + count(s.tokens) + (s.versions > 1 ? ", " + s.versions + " versions" : "") + (s.sharedWith.length ? ", same text in " + s.sharedWith.join(", ") : "")),
    ]),
    ...(value.shared.length ? ["", "Identical across roles:", ...value.shared.map(s => "  " + s.name + " " + count(s.tokens) + " in " + s.roles.join(", "))] : []),
    ...value.diagnostics,
  ].join("\n")
}
