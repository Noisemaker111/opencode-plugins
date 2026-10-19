import { readAllQuests } from "../index"
import { questReference } from "../core/references"
import type { QuestStore } from "../store"
import { markOf } from "./verdict"
import { DAY_MS, hygieneSettings } from "./policy"
import { hygienePass, openQuests } from "./sweep"

const RECENT_MS = 7 * DAY_MS

export async function hygieneReadout(store: QuestStore, now = Date.now()) {
  const settings = hygieneSettings()
  const wouldAct = await hygienePass(store, { dryRun: true, now, settings })
  const open = openQuests(store.projectRoot)
  const flagged = open.flatMap(q => {
    const mark = markOf(q)
    return mark && (mark.kind === "stale" || mark.kind === "needs a look") ? [{ quest: questReference(q), title: q.title, kind: mark.kind, reason: mark.reason, since: mark.at }] : []
  })
  const closed = readAllQuests(store.projectRoot, { includeArchived: true }).flatMap(({ quest }) => {
    const archive = quest?.archive
    return quest && archive?.automatic && now - Date.parse(archive.at) <= RECENT_MS
      ? [{ quest: questReference(quest), title: quest.title, kind: archive.kind ?? "closed", reason: archive.reason ?? "", at: archive.at }]
      : []
  })
  const collapsed = open.flatMap(q => Number(q.extensions.sends) > 1 ? [{ quest: questReference(q), title: q.title, sends: Number(q.extensions.sends) }] : [])
  const apply = settings.apply.length ? settings.apply.join(", ") : "nothing (report only)"
  return {
    at: now,
    head: `Hygiene: ${closed.length} closed, ${collapsed.length} with repeated sends, ${flagged.length} flagged, ${wouldAct.rows.length} would act now. Applying: ${apply}.`,
    closed,
    collapsed,
    flagged,
    wouldAct: wouldAct.rows.map(({ quest, title, kind, reason }) => ({ quest, title, kind, reason })),
    kept: wouldAct.kept,
    settings: { staleDays: settings.staleDays, supersedeDays: settings.supersedeDays, apply: settings.apply },
  }
}
