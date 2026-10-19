import { digest } from "../privacy"
import { validateQuest } from "./schema"
import type { ParsedQuest, Quest } from "../types"

const KNOWN = ["contractVersion","description","reward","request","project","archive","result","delivered","schema","id","ref","revision","lifecycleEpoch","createdAt","updatedAt","title","objective","kind","priority","state","reason","nextAction","executingCount","executionChangedAt","owner","integrationOwner","requestFingerprint","scope","relationships","deliverables","acceptanceCriteria","usageInstructions","stages","setbacks","sessions","claims","evidence","unresolvedWork","completionPolicy","missingRequirements","notificationCursor","migration","eventCursors","appliedEventIDs","history","earlierCount","earlierSessions","abandoned","extensions"] as const
const known = new Set<string>(KNOWN)

export function parseQuestMarkdown(raw: string): ParsedQuest {
  const match = /^(?:\uFEFF)?---(\r?\n)([\s\S]*?)\1---(?:\1|$)/.exec(raw)
  if (!match) return { body: raw, rawFrontmatter: "", raw, readonly: true, errors: ["missing or malformed frontmatter"], humanHash: digest(raw) }
  const front = match[2], body = raw.slice(match[0].length), value: Record<string, unknown> = {}, errors: string[] = []
  for (const line of front.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line)
    if (!field) { errors.push(`unsupported frontmatter line: ${line.slice(0, 80)}`); continue }
    if (!known.has(field[1])) continue
    try { value[field[1]] = JSON.parse(field[2]) } catch { errors.push(`invalid JSON value for ${field[1]}`) }
  }
  if (!Array.isArray(value.usageInstructions)) value.usageInstructions = []
  if (!Array.isArray(value.stages)) value.stages = []
  value.stages = (value.stages as unknown[]).map((stage) => stage && typeof stage === "object" ? { status: "pending", needs: [], todos: [], proofs: [], attempt: 1, claim: { repos: [], include: [], exclude: [] }, ...(stage as object) } : stage)
  if (!Array.isArray(value.setbacks)) value.setbacks = []
  if (Array.isArray(value.deliverables)) value.deliverables = (value.deliverables as unknown[]).map((item, index) => typeof item === "string" ? { id: `item-${index + 1}`, title: item, status: "pending" } : item)
  if (Array.isArray(value.acceptanceCriteria)) value.acceptanceCriteria = (value.acceptanceCriteria as unknown[]).map((item, index) => typeof item === "string" ? { id: `accept-${index + 1}`, text: item, satisfied: false } : item)
  errors.push(...validateQuest(value))
  const readonly = errors.length > 0
  return { quest: value as Quest, body, rawFrontmatter: front, raw, readonly, errors, humanHash: humanHash(front, body) }
}

function humanHash(front: string, body: string): string {
  const humanFront = front.split(/\r?\n/).filter((line) => {
    const key = /^([A-Za-z][A-Za-z0-9]*):/.exec(line)?.[1]
    return !key || !known.has(key) || key === "extensions"
  }).join("\n")
  return digest(`${humanFront}\0${body}`)
}

export function serializeQuestMarkdown(quest: Quest, body = "", prior?: ParsedQuest): string {
  const eol = prior?.raw.includes("\r\n") ? "\r\n" : "\n"
  let lines = prior ? prior.rawFrontmatter.split(/\r?\n/) : []
  const emitted = new Set<string>()
  lines = lines.map((line) => {
    const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line)
    if (!field || !known.has(field[1])) return line
    const key = field[1] as keyof Quest
    emitted.add(key)
    const value = quest[key]
    return value === undefined ? `# removed ${key}` : `${key}: ${JSON.stringify(value)}`
  })
  for (const key of KNOWN) if (!emitted.has(key) && quest[key as keyof Quest] !== undefined) lines.push(`${key}: ${JSON.stringify(quest[key as keyof Quest])}`)
  const front = lines.join(eol).replace(new RegExp(`${eol}+$`), "")
  return `---${eol}${front}${eol}---${eol}${body}`
}

export function assertHumanContentUnchanged(before: ParsedQuest, afterRaw: string): void {
  const after = parseQuestMarkdown(afterRaw)
  if (before.humanHash !== after.humanHash) throw new Error("concurrent human content conflict")
}
