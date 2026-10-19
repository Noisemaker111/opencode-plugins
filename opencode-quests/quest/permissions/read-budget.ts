import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { questMemberships } from './shared-guard'
import { userGiverID } from '../giver/user-giver'
import { readUserGiver } from '../giver-registry.mjs'
import { workerSessionID } from './worker-permissions'
import type { QuestStore } from '../store'

export const READ_RESULT_CHAR_BUDGET = 8000

function nextReadLine(head: string): number | undefined {
  const numbers = [...head.matchAll(/^(\d+): /gm)]
  if (!numbers.length) return undefined
  return Number(numbers[numbers.length - 1]![1]) + 1
}

function escapedLength(text: string): number {
  return JSON.stringify(text).length - 2
}

export function boundReadText(text: string, budget = READ_RESULT_CHAR_BUDGET): string {
  if (escapedLength(text) <= budget) return text
  const allowance = 140
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (escapedLength(text.slice(0, middle)) + allowance <= budget) low = middle
    else high = middle - 1
  }
  const newline = text.lastIndexOf('\n', low)
  const head = text.slice(0, newline > 0 ? newline : low)
  const next = nextReadLine(head)
  const note = next === undefined
    ? `[read result bounded at ${budget} of ${text.length} characters; re-read with an offset, or grep for the part you need]`
    : `[read result bounded at ${budget} of ${text.length} characters; continue with offset: ${next}]`
  return head + '\n\n' + note
}

type Part = { type?: string; text?: string; [key: string]: unknown }

export function boundReadResult<T>(result: T, budget = READ_RESULT_CHAR_BUDGET): T {
  const record = result as any
  if (record && typeof record === 'object' && typeof record.content === 'string') {
    if (escapedLength(record.content) <= budget) return result
    return { ...record, content: boundReadText(record.content, budget) } as T
  }
  const content = (Array.isArray(result) ? result : record?.content) as Part[] | undefined
  if (!Array.isArray(content)) return result
  const textTotal = content.reduce((n, part) => n + (part?.type === 'text' && typeof part.text === 'string' ? escapedLength(part.text) : 0), 0)
  if (textTotal <= budget) return result
  const nonText = content.filter(part => part?.type !== 'text' || typeof part.text !== 'string')
  const first = content.find(part => part?.type === 'text' && typeof part.text === 'string') as Part
  const bounded: Part = {
    ...first,
    text: escapedLength(first.text!) > budget
      ? boundReadText(first.text!, budget)
      : first.text! + `\n\n[read result bounded at ${budget} of ${textTotal} characters; later text was omitted]`,
  }
  const output = [bounded, ...nonText]
  return (Array.isArray(result) ? output : { ...(result as any), content: output }) as T
}

function giverRealPath(path: unknown, base: string): string | undefined {
  if (typeof path !== 'string' || !path.trim()) return undefined
  try { return realpathSync.native(isAbsolute(path) ? path : resolve(base, path)) }
  catch { return undefined }
}

function giverReader(store: QuestStore, sessionID: unknown): { base: string } | undefined {
  if (typeof sessionID !== 'string' || !sessionID) return undefined
  try {
    const row = readUserGiver(store.runtime)
    return row?.sessionID === sessionID
      ? { base: typeof row.directory === 'string' && row.directory ? row.directory : store.projectRoot }
      : undefined
  } catch { return undefined }
}

export function isQuestSession(store: QuestStore, sessionID: unknown): boolean {
  if (typeof sessionID !== 'string' || !sessionID) return false
  if (userGiverID(store) === sessionID) return true
  return questMemberships(store, sessionID).some(({ run, archived }) => !archived && workerSessionID(run) === sessionID)
}

export async function installReadBudget(ctx: any, store: QuestStore, budget = READ_RESULT_CHAR_BUDGET) {
  if (typeof ctx?.tool?.transform !== 'function') return
  await ctx.tool.transform((draft: any) => {
    draft.update('read', (tool: any) => {
      const original = tool.execute
      if (typeof original !== 'function') return
      tool.execute = async (input: any, context: any) => {
        const giver = giverReader(store, context?.sessionID)
        const realPath = giver && giverRealPath(input?.path, giver.base)
        const readInput = realPath && realPath !== input.path ? { ...input, path: realPath } : input
        const result = await original(readInput, context)
        try { return isQuestSession(store, context?.sessionID) ? boundReadResult(result, budget) : result }
        catch { return result }
      }
    })
  })
}
