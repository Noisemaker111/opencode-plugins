export type RankCard = { id: string; name: string; title?: string; hubName?: string; folder?: string; aliases?: string[]; remote?: string; about?: string; hub?: string }
export type QuestHistory = Record<string, string[]>
export type Ranked<T extends RankCard> = { card: T; score: number }

const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'for', 'from', 'has', 'have', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'this', 'to', 'up', 'was', 'we', 'with', 'you', 'your', 'please', 'make', 'fix', 'add', 'get', 'need', 'want'])
const FIELDS = { name: 6, title: 5, folder: 4, aliases: 6, remote: 3, hub: 5, history: 1.2, about: 2 } as const
type Field = keyof typeof FIELDS
const K1 = 1.2, B = 0.75, NAME_MATCH = 8, PART_OF_WORD = 0.5, SHORTEST_PART = 4
const stem = (word: string) => word.length > 4 && word.endsWith('ies') ? word.slice(0, -3) + 'y' : word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word

export function tokens(text: string | undefined): string[] {
  if (!text) return []
  return text.normalize('NFKD').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1 && !STOPWORDS.has(word)).map(stem)
}
function occurrences(counts: Map<string, number>, term: string) {
  let found = counts.get(term) ?? 0
  if (term.length >= SHORTEST_PART) for (const [word, count] of counts) if (word !== term && word.includes(term)) found += PART_OF_WORD * count
  return found
}
const compact = (text: string | undefined) => (text ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '')
export function remoteName(remote: string | undefined) {
  if (!remote) return undefined
  const last = remote.replace(/\.git$/i, '').split(/[/:\\]/).filter(Boolean).at(-1)
  return last || undefined
}

function fieldText(card: RankCard, history: string[]): Record<Field, string> {
  const folder = compact(card.folder) === compact(card.name) ? '' : card.folder ?? ''
  return { name: card.name, title: card.title ?? '', folder, aliases: (card.aliases ?? []).join(' '), remote: remoteName(card.remote) ?? '', hub: [card.hubName, card.hub].filter(Boolean).join(' '), history: history.join('\n'), about: card.about ?? '' }
}

const requestWords = (request: string) => request.normalize('NFKD').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
function spelledOut(words: string[], name: string) {
  for (let start = 0; start < words.length; start++) {
    let joined = ''
    for (let end = start; end < words.length && joined.length < name.length; end++) joined += words[end]
    if (joined === name) return true
  }
  return false
}
function namedInRequest(words: string[], card: RankCard) {
  return [card.name, card.title, card.folder, ...(card.aliases ?? []), remoteName(card.remote)].some(name => {
    const squeezed = compact(name)
    return squeezed.length >= 3 && spelledOut(words, squeezed)
  })
}

const RETIRED_SHARE = 0.2
const RETIRED_WORDS = /(^|[^a-z0-9])(archive|archived|deprecated)([^a-z0-9]|$)/i
const retired = (card: RankCard) => RETIRED_WORDS.test(remoteName(card.remote) ?? '') || RETIRED_WORDS.test(card.title ?? '')

export const ABOUT_QUEST_GIVER = /\b(quest\s?giver|quest\s?web|(all|the|my|every)\s+quests|this\s+(app|project|repo|repository|codebase|site|chat))\b/i

export function rankProjects<T extends RankCard>(request: string, cards: T[], history: QuestHistory = {}, homeID?: string): Ranked<T>[] {
  const query = [...new Set(tokens(request))], words = requestWords(request)
  const documents = cards.map(card => {
    const text = fieldText(card, history[card.id] ?? [])
    const fields = Object.fromEntries((Object.keys(FIELDS) as Field[]).map(field => {
      const words = tokens(text[field]), counts = new Map<string, number>()
      for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
      return [field, { length: words.length, counts }]
    })) as Record<Field, { length: number; counts: Map<string, number> }>
    return { card, fields }
  })
  const total = documents.length
  const average = Object.fromEntries((Object.keys(FIELDS) as Field[]).map(field => [field, documents.reduce((sum, doc) => sum + doc.fields[field].length, 0) / Math.max(1, documents.filter(doc => doc.fields[field].length > 0).length) || 1])) as Record<Field, number>
  const frequency = new Map(query.map(term => [term, documents.filter(doc => (Object.keys(FIELDS) as Field[]).some(field => occurrences(doc.fields[field].counts, term) > 0)).length]))
  const idf = (term: string) => Math.log(1 + (total - frequency.get(term)! + 0.5) / (frequency.get(term)! + 0.5))
  const ranked = documents.map(({ card, fields }) => {
    let score = 0
    for (const term of query) {
      let weighted = 0
      for (const field of Object.keys(FIELDS) as Field[]) {
        const count = occurrences(fields[field].counts, term)
        if (!count) continue
        weighted += FIELDS[field] * count * (K1 + 1) / (count + K1 * (1 - B + B * fields[field].length / average[field]))
      }
      score += idf(term) * weighted
    }
    const named = namedInRequest(words, card)
    if (named) score += NAME_MATCH * Math.max(1, ...query.map(idf))
    if (retired(card) && !RETIRED_WORDS.test(request)) score *= RETIRED_SHARE
    return { card, score, named }
  })
  const home = homeID && ABOUT_QUEST_GIVER.test(request) ? ranked.find(row => row.card.id === homeID) : undefined
  if (home && !ranked.some(row => row.named && row !== home)) home.score = Math.max(...ranked.map(row => row.score)) + 1
  return ranked.sort((a, b) => b.score - a.score || a.card.name.localeCompare(b.card.name) || a.card.id.localeCompare(b.card.id)).map(({ card, score }) => ({ card, score }))
}
