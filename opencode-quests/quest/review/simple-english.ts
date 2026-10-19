import { hasIdentifier } from './plain-words'

export const SIMPLE_ENGLISH_LINE = 'Write in Simplified Technical English: action first, one instruction per sentence, under 20 words, active voice, present tense, options as a short list.'

export const SIMPLE_ENGLISH = SIMPLE_ENGLISH_LINE + ' Use the product’s own names. No coined terms, IDs, hashes or pasted tool replies in prose. Keep exact commands, exit codes, job IDs, commits and other evidence in their separate fields or a linked evidence file. Never shorten away the reason or the action needed to continue.'

export const SIMPLE_ENGLISH_MIN_SCORE = 0.8
const MAX_WORDS = 25

const JARGON = /\b(orchestrators?|helpers?|prod|production|staging|latest)\b/i
const PASSIVE = /\b(?:was|were|been|being)\s+(?:\w{2,}ed|built|done|made|sent|shown|given|taken|written|found|kept|left|seen)\b|\b(?:is|are|be)\s+(?:\w{2,}ed|built|done|made|sent|shown|given|taken|written|found|kept|left|seen)\s+by\b|\bby the\b/i
const NOMINAL = /\b\w+(?:tion|ment|ance|ence)\s+of\b/i
const NOT_VERB = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'we', 'i', 'you', 'they', 'he', 'she', 'my', 'our', 'your', 'quest', 'step', 'new', 'all', 'some', 'no', 'not', 'when', 'if', 'for', 'to', 'in', 'on', 'of', 'with', 'about', 'from', 'by'])
const JOINED = /;|\band then\b/i
const MANY = /\band (?:add|fix|make|run|show|start|stop|remove|update|write|test|check|merge|push|deploy|publish|build|create|move|open|save|send|delete|change)\b/i

export type SimpleEnglishKind = 'text' | 'instruction'

export function simpleEnglishSentences(text: string): string[] {
  return text.split(/(?<=[A-Za-z)"'’][.!?])\s+|\n+/).map(row => row.trim()).filter(row => /\w/.test(row))
}

function verbFirst(sentence: string) {
  const first = sentence.replace(/^[^A-Za-z]+/, '').split(/\s+/)[0]?.toLowerCase() ?? ''
  return !!first && !NOT_VERB.has(first) && !/(?:ing|ed|tion)$/.test(first)
}

function sentenceIssues(sentence: string, kind: SimpleEnglishKind): string[] {
  const issues: string[] = [], quote = '"' + sentence.slice(0, 60) + (sentence.length > 60 ? '…' : '') + '"'
  const words = sentence.split(/\s+/).filter(Boolean).length
  if (words > MAX_WORDS) issues.push(quote + ': ' + words + ' words; use ' + MAX_WORDS + ' or fewer')
  if (PASSIVE.test(sentence)) issues.push(quote + ': passive voice; say who does it')
  const jargon = JARGON.exec(sentence)?.[0]
  if (jargon) issues.push(quote + ': "' + jargon + '" is not a product name')
  if (hasIdentifier(sentence)) issues.push(quote + ': remove ids and hashes')
  const nominal = NOMINAL.exec(sentence)?.[0]
  if (nominal) issues.push(quote + ': use the verb, not "' + nominal + '"')
  if (kind === 'instruction' && !verbFirst(sentence)) issues.push(quote + ': start with the action verb')
  if (JOINED.test(sentence) || kind === 'instruction' && MANY.test(sentence)) issues.push(quote + ': one instruction per sentence')
  return issues
}

export function simpleEnglishIssues(text: string, kind: SimpleEnglishKind = 'text'): string[] {
  return simpleEnglishSentences(text).flatMap(sentence => sentenceIssues(sentence, kind))
}

export function simpleEnglishScore(text: string, kind: SimpleEnglishKind = 'text'): number {
  const sentences = simpleEnglishSentences(text)
  return sentences.length ? sentences.filter(sentence => !sentenceIssues(sentence, kind).length).length / sentences.length : 1
}

type Card = { summary?: unknown; howToUse?: unknown }
type Written = { title?: unknown; description?: unknown; result?: Card; steps?: { title?: unknown; detail?: unknown; note?: unknown; result?: Card; blocker?: { requires?: unknown } }[] }

const PRODUCT_TERM: Record<string, string> = { orchestrator: 'Quest Giver', orchestrators: 'Quest Givers', helper: 'worker', helpers: 'workers', prod: 'main', production: 'main', staging: 'v2', latest: 'v2' }
const MODAL = /^(.+?)\s+(?:should|must|needs to|need to|will|can)\s+(\w+)(.*)$/i

const sentenceCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
const ended = (value: string) => { const trimmed = value.trim().replace(/[,;:]+$/, ''); return /[.!?]$/.test(trimmed) ? trimmed : trimmed + '.' }
const lowerFirst = (value: string) => /^[A-Z][a-z]/.test(value) ? value.charAt(0).toLowerCase() + value.slice(1) : value

function productTerms(sentence: string) {
  return sentence.replace(new RegExp(JARGON.source, 'gi'), word => {
    const term = PRODUCT_TERM[word.toLowerCase()] ?? word
    return /^[A-Z]/.test(word) ? sentenceCase(term) : term
  })
}

function verbToFront(sentence: string) {
  const modal = MODAL.exec(sentence.replace(/[.!?]$/, ''))
  if (modal) return ended('Make ' + lowerFirst(modal[1]) + ' ' + modal[2] + modal[3])
  return ended('Make sure ' + lowerFirst(sentence))
}

function splitJoined(sentence: string): string[] {
  const at = /;\s*|\s+and then\s+|\s+and\s+/i.exec(sentence)
  if (!at || at.index === 0) return [sentence]
  return [ended(sentence.slice(0, at.index)), ended(sentenceCase(sentence.slice(at.index + at[0].length)))]
}

function cutLong(sentence: string): string[] {
  if (sentence.split(/\s+/).filter(Boolean).length <= MAX_WORDS) return [sentence]
  const at = /,\s*|\s+so\s+/i.exec(sentence)
  if (!at || at.index === 0) return [sentence]
  return [ended(sentence.slice(0, at.index)), ended(sentenceCase(sentence.slice(at.index + at[0].length)))]
}

function actionableRewrite(sentence: string, kind: SimpleEnglishKind, rewritten: string) {
  if (rewritten.trim() !== sentence.trim()) return rewritten
  const actions: string[] = []
  if (PASSIVE.test(sentence)) actions.push('Name who acts and use active voice')
  const jargon = JARGON.exec(sentence)?.[0]
  if (jargon) actions.push('Replace "' + jargon + '" with the product name')
  if (hasIdentifier(sentence)) actions.push('Move the exact identifier to its own field')
  const nominal = NOMINAL.exec(sentence)?.[0]
  if (nominal) actions.push('Use a direct action verb')
  if (sentence.split(/\s+/).filter(Boolean).length > MAX_WORDS) actions.push('Split this into sentences with ' + MAX_WORDS + ' words or fewer')
  if (kind === 'instruction' && !verbFirst(sentence)) actions.push('Start with the action verb')
  if (JOINED.test(sentence) || kind === 'instruction' && MANY.test(sentence)) actions.push('Put each instruction in its own sentence')
  return actions.map(ended).join(' ')
}

export function simpleEnglishRewrite(sentence: string, kind: SimpleEnglishKind = 'text'): string {
  let parts = [productTerms(sentence)]
  if (sentenceIssues(parts[0], kind).some(issue => issue.endsWith('one instruction per sentence'))) parts = parts.flatMap(splitJoined)
  parts = parts.flatMap(cutLong)
  if (kind === 'instruction') parts = parts.map(part => verbFirst(part) ? part : verbToFront(part))
  return actionableRewrite(sentence, kind, parts.join(' '))
}

export type WordingIssue = { sentence: string; problems: string[]; rewrite: string }
export type WordingGroup = { field: string; kind: SimpleEnglishKind; blocking: boolean; issues: WordingIssue[] }

export function wordingIssues(text: string, kind: SimpleEnglishKind = 'text'): WordingIssue[] {
  return simpleEnglishSentences(text).flatMap(sentence => {
    const problems = sentenceIssues(sentence, kind).map(issue => issue.slice(issue.indexOf('": ') + 3))
    return problems.length ? [{ sentence, problems, rewrite: simpleEnglishRewrite(sentence, kind) }] : []
  })
}

export function wordingGroups(input: Written): WordingGroup[] {
  const fields: [string, unknown, SimpleEnglishKind][] = [['Title', input.title, 'instruction'], ['Description', input.description, 'text'], ['Result summary', input.result?.summary, 'text'], ['Result howToUse', input.result?.howToUse, 'text']]
  for (const step of Array.isArray(input.steps) ? input.steps : []) {
    const name = typeof step?.title === 'string' ? 'Step "' + step.title.slice(0, 40) + '"' : 'Step'
    fields.push([name + ' title', step?.title, 'instruction'], [name + ' detail', step?.detail, 'instruction'], [name + ' note', step?.note, 'text'], [name + ' result summary', step?.result?.summary, 'text'], [name + ' result howToUse', step?.result?.howToUse, 'text'], [name + ' blocker', step?.blocker?.requires, 'text'])
  }
  return fields.flatMap(([field, value, kind]) => {
    if (typeof value !== 'string') return []
    const issues = wordingIssues(value, kind)
    return issues.length ? [{ field, kind, blocking: simpleEnglishScore(value, kind) < SIMPLE_ENGLISH_MIN_SCORE, issues }] : []
  })
}

export function wordingReport(groups: WordingGroup[]): string {
  return groups.map(group => group.field + (group.blocking ? '' : ' (allowed, but better rewritten)') + ':\n' + group.issues.map(issue => '  - "' + issue.sentence + '": ' + issue.problems.join('; ') + '. Try: "' + issue.rewrite + '"').join('\n')).join('\n')
}

export function simpleEnglishProblems(input: Written): string[] {
  return wordingGroups(input).filter(group => group.blocking).map(group => group.field + ': ' + group.issues.map(issue => '"' + issue.sentence + '": ' + issue.problems.join('; ')).join('; '))
}
