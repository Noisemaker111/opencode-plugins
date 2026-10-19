import { markLanded } from '../../scripts/landing-quiet.mjs'

export type ReloadOutcome = { ok: boolean; text: string; revision?: string }

export const landedTops = new Set<string>()

export function reloadLanded(root: string, waiter?: { questID: string; runID: string }): Promise<ReloadOutcome> {
  return markLanded(root, 'landed by a Quest worker', waiter).then(({ top }: { top: string }) => {
    landedTops.add(top)
    return { ok: true, text: `Update pending for ${top}: the landing is on v2. The runtime moves to it once no worker runs, or when the user presses Update.` }
  }, (error: unknown) => ({ ok: false, text: `Update not marked for ${root}: ${error instanceof Error ? error.message : String(error)}` }))
}
