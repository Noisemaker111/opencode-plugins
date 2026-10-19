import { freeBudgets } from "../usage/free-allowance"
import { onRouteHealthChange } from "../usage/route-limits"

export type FreeBudget = typeof freeBudgets extends (...args: never[]) => Map<string, infer V> ? V : never

const STALE_MS = 60_000
let snapshot: { at: number; budgets: Map<string, FreeBudget> } | null = null
let scheduled = false

export function refreshFreeBudgets(now = Date.now(), sources?: Parameters<typeof freeBudgets>[1]): void {
  snapshot = { at: now, budgets: freeBudgets(now, sources) }
}

function scheduleRefresh(): void {
  if (scheduled) return
  scheduled = true
  const timer = setTimeout(() => { scheduled = false; try { refreshFreeBudgets() } catch {} }, 0)
  timer.unref?.()
}

export function freeBudgetOf(key: string, now = Date.now()): FreeBudget | undefined {
  if (!snapshot || now - snapshot.at > STALE_MS) scheduleRefresh()
  return snapshot?.budgets.get(key)
}

onRouteHealthChange(scheduleRefresh)
