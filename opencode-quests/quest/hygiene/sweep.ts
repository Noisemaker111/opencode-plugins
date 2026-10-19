import { readAllQuests } from "../index"
import { questReference } from "../core/references"
import { QuestWorkspaces } from "../workspaces"
import type { QuestStore } from "../store"
import type { Quest } from "../types"
import { verdictOf, isArchiving, markOf, type Verdict } from "./verdict"
import { HYGIENE_SOURCE, hygieneSettings, type HygieneKind, type HygieneSettings } from "./policy"
import { questFacts } from "./facts"
import { isRuntimeProject } from "../giver/giver-settings"

export type HygieneRow = { quest: string; title: string; kind: HygieneKind; reason: string; applied: boolean }
export type HygieneRun = { rows: HygieneRow[]; kept: number }

export function openQuests(projectRoot: string): Quest[] {
  return readAllQuests(projectRoot).flatMap(({ quest }) => quest && quest.contractVersion === 2 && !quest.archive && !quest.delivered && quest.state !== "Archived" ? [quest] : [])
}

function write(store: QuestStore, q: Quest, verdict: NonNullable<Verdict>, now: number) {
  const at = new Date(now).toISOString()
  const options = { expectedRevision: q.revision }
  if (verdict.kind === "clear") return store.apply(q.id, "patched", { extensionsRemoved: [["hygiene"]] }, HYGIENE_SOURCE, options)
  if (isArchiving(verdict.kind)) {
    const relationships = verdict.keeper ? { ...q.relationships, duplicateOf: verdict.keeper } : undefined
    return store.apply(q.id, "patched", { archive: { at, reason: verdict.reason, accepted: verdict.kind === "done elsewhere", automatic: true, kind: verdict.kind }, ...(relationships ? { relationships } : {}) }, HYGIENE_SOURCE, options)
  }
  return store.apply(q.id, "patched", { extensionsPatch: { hygiene: { kind: verdict.kind, reason: verdict.reason, at } } }, HYGIENE_SOURCE, options)
}

const unchanged = (q: Quest, verdict: { kind: HygieneKind; reason: string }) => {
  const mark = markOf(q)
  return !!mark && mark.kind === verdict.kind && (verdict.kind === "stale" || mark.reason === verdict.reason)
}

export async function hygienePass(store: QuestStore, options: { only?: Set<string>; now?: number; settings?: HygieneSettings; dryRun?: boolean; isRuntime?: (root: string) => boolean; until?: number } = {}): Promise<HygieneRun> {
  const now = options.now ?? Date.now(), settings = options.settings ?? hygieneSettings(), isRuntime = options.isRuntime ?? isRuntimeProject, runtimeRoots = new Map<string, boolean>()
  const inRuntime = (q: Quest) => { const root = q.project?.root ?? ""; if (!runtimeRoots.has(root)) runtimeRoots.set(root, isRuntime(root)); return runtimeRoots.get(root)! }
  const open = openQuests(store.projectRoot), workspaces = new QuestWorkspaces(store.runtime)
  const rows: HygieneRow[] = []
  let kept = 0
  const targets = open.filter(q => !options.only || options.only.has(q.id))
  const facts = await Promise.all(targets.map(q => questFacts(store, q, open, workspaces).catch((error: unknown) => ({ error }))))
  for (const [index, q] of targets.entries()) {
    if (options.until !== undefined && Date.now() > options.until) { console.error("[quests] hygiene stopped at its time limit; the rest wait for the next change"); break }
    let verdict: Verdict
    const found = facts[index]
    try { if ("error" in found) throw found.error; verdict = verdictOf(q, found, now, settings) } catch (error) { console.error("[quests] hygiene", q.id, error); continue }
    if (!verdict) { kept++; continue }
    const scoped = inRuntime(q)
    if (verdict.kind === "clear") {
      if (!options.dryRun && scoped) try { write(store, q, verdict, now) } catch (error) { console.error("[quests] hygiene clear", q.id, error) }
      continue
    }
    const applied = !options.dryRun && scoped && settings.apply.includes(verdict.kind)
    const reason = scoped ? verdict.reason : verdict.reason + " Another project, so it is only reported."
    rows.push({ quest: questReference(q), title: q.title, kind: verdict.kind, reason, applied })
    if (!applied || unchanged(q, verdict)) continue
    try { write(store, q, verdict, now) } catch (error) { console.error("[quests] hygiene", q.id, error) }
  }
  return { rows, kept }
}
