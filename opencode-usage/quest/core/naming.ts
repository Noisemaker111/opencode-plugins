
const STAGE_WORDS = new Set([
  "scout", "scouting", "plan", "planning", "research", "design", "implement", "implementation",
  "build", "develop", "code", "verify", "verification", "validate", "validation", "test", "testing",
  "review", "integrate", "integration", "deploy", "deployment", "deliver", "delivery", "handover",
  "handoff", "cleanup", "setup", "audit", "inventory", "finalize", "execute", "execution", "wrap up",
])

export function bareStageName(value: string): boolean {
  return STAGE_WORDS.has(String(value ?? "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim())
}

const SPEAKER = /^\s*(?:jk|jon)\b|^\s*user\s*-?\s*(?:asks?|wants?|requests?|says?|said|picked|pivots?|directed|approved|corrected|showed|explicitly|decided|chose)\b/i

export function speakerAttribution(value: string): boolean { return SPEAKER.test(String(value ?? "")) }

export function namingProblems(input: { title?: string; objective?: string; steps?: { title?: string }[] }): string[] {
  const problems: string[] = []
  const title = String(input.title ?? "").trim(), objective = String(input.objective ?? "").trim()
  if (bareStageName(title))
    problems.push(`The title "${title}" names a lifecycle stage, not an outcome. Title the Quest by what is true once the work lands, specific enough that a sibling Quest could not carry the same title.`)
  if (speakerAttribution(objective))
    problems.push(`The objective opens by naming who spoke ("${objective.slice(0, 48)}..."). Open with the goal itself: the board shows the first sentence and truncates the rest, so who asked, the authorization and the exclusions belong in later sentences.`)
  for (const step of input.steps ?? []) {
    const stepTitle = String(step?.title ?? "").trim()
    if (bareStageName(stepTitle))
      problems.push(`Step "${stepTitle}" names a lifecycle stage, not this task's work. Title it with what that step does and the result that can be checked.`)
  }
  return problems
}
