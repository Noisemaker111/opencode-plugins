import type { AcceptanceCriterion, Deliverable } from "../types"

const SUB_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(\S.*)$/

const VERIFICATION = /\b(screenshot|screen shot|test|tests|verify|verified|prove|proof|confirm|passes|passing|evidence|benchmark|measure|smoke[- ]test|typecheck|lint)\b/i

const ACTION = /\b(add|build|create|implement|fix|remove|delete|replace|rename|update|migrate|wire|mount|register|expose|support|stop|extract|refactor|document|move|split|merge|enable|disable)\b/i

const MAX_ITEMS = 20
const MAX_LEN = 200

function trim(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= MAX_LEN ? flat : `${flat.slice(0, MAX_LEN - 1).trimEnd()}…`
}

function slug(text: string, index: number): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 5).join("-")
  return base || `item-${index + 1}`
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3)
}

export function subItems(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const items: string[] = []
  for (const line of lines) {
    const match = line.match(SUB_ITEM)
    if (match?.[1]) items.push(match[1].trim())
  }
  return items
}

function isAcceptance(item: string): boolean {
  return VERIFICATION.test(item) && !ACTION.test(item)
}

export function deliverablesFromRequest(text: string): Deliverable[] {
  const listed = subItems(text)
  const source = listed.length
    ? listed.filter((item) => !isAcceptance(item))
    : sentences(text).filter((s) => ACTION.test(s) && !isAcceptance(s))
  return uniqueBy(
    source.slice(0, MAX_ITEMS).map((item, index) => ({
      id: slug(item, index),
      title: trim(item),
      status: "pending" as const,
    })),
    (d) => d.id,
  )
}

export function acceptanceFromRequest(text: string): AcceptanceCriterion[] {
  const source = [...subItems(text), ...sentences(text)].filter(isAcceptance)
  return uniqueBy(
    source.slice(0, MAX_ITEMS).map((item, index) => ({
      id: slug(item, index),
      text: trim(item),
      satisfied: false,
    })),
    (c) => c.id,
  )
}

export type QuestPlan = { deliverables: Deliverable[]; acceptanceCriteria: AcceptanceCriterion[] }

export function planFromRequest(text: string): QuestPlan {
  return { deliverables: deliverablesFromRequest(text), acceptanceCriteria: acceptanceFromRequest(text) }
}
