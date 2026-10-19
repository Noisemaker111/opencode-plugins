import type { Quest } from "../types"
import { latestSessionAttempts } from "../runs/session-lineage"

export function completionMissing(q: Quest): string[] {
  const out: string[] = []
  if (!q.stages.length) out.push("steps")
  for (const step of q.stages) if (step.status !== "done") out.push(`step ${step.id}`)
  if (latestSessionAttempts(q.sessions).some(s => ["planned", "executing", "waiting", "blocked"].includes(s.state))) out.push("active runs")
  return out
}
