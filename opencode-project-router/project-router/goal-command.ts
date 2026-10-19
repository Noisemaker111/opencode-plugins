export const GOAL_VERBS = ["start", "status", "pause", "cancel", "resume"] as const

export type GoalCommand =
  | { kind: "status" }
  | { kind: "intake"; goal: string }
  | { kind: "control"; action: (typeof GOAL_VERBS)[number]; questID?: string; stepIDs?: string[] }

export function goalCommand(input: string | undefined): GoalCommand {
  const text = (input ?? "").trim()
  if (!text) return { kind: "status" }
  const [action, questID, ...stepIDs] = text.split(/\s+/)
  if (!(GOAL_VERBS as readonly string[]).includes(action)) return { kind: "intake", goal: text }
  return { kind: "control", action: action as (typeof GOAL_VERBS)[number], questID, ...(stepIDs.length ? { stepIDs } : {}) }
}
