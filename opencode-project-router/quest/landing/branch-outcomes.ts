import type { Quest } from "../types"

export type BranchOutcome = { outcome: "landed" | "dropped"; reason?: string; stepID: string; at: string }
export type BranchReport = { branch: string; outcome: "landed" | "dropped"; reason?: string }

export function branchOutcomes(q: Pick<Quest, "extensions">): Record<string, BranchOutcome> {
  const saved = q.extensions?.branchOutcomes
  return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, BranchOutcome> : {}
}

export function branchCounts(q: Pick<Quest, "extensions">): { landed: number; dropped: number } | undefined {
  const rows = Object.values(branchOutcomes(q))
  if (!rows.length) return undefined
  return { landed: rows.filter(row => row?.outcome === "landed").length, dropped: rows.filter(row => row?.outcome === "dropped").length }
}

export function recordBranchOutcomes(saved: Record<string, BranchOutcome>, reports: unknown, stepID: string, at = new Date().toISOString()): { saved: Record<string, BranchOutcome> } | { problem: string } {
  if (!Array.isArray(reports)) return { problem: "branches must list each branch with its outcome" }
  const next = { ...saved }
  for (const report of reports as BranchReport[]) {
    if (!report || typeof report !== "object" || Object.keys(report).some(key => !["branch", "outcome", "reason"].includes(key))) return { problem: "Each branch entry has branch, outcome and reason only" }
    const branch = typeof report.branch === "string" ? report.branch.trim() : ""
    if (!branch) return { problem: "Each branch entry needs the branch name" }
    if (report.outcome !== "landed" && report.outcome !== "dropped") return { problem: "A branch outcome is landed or dropped" }
    if (report.reason !== undefined && typeof report.reason !== "string") return { problem: "A branch reason must be text" }
    const reason = report.reason?.trim()
    if (report.outcome === "dropped" && !reason) return { problem: "Nothing was saved. A dropped branch needs the reason it was dropped, such as a newer copy of the same change or the change already on v2." }
    next[branch] = { outcome: report.outcome, ...(reason ? { reason } : {}), stepID, at }
  }
  return { saved: next }
}
