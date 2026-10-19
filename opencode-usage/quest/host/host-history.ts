import { existsSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { deliveredRunIDs } from '../workers/return-metadata'
import { automaticQuestPrompt } from '../giver/giver-instruction'
import type { Quest } from '../types'

export type HistoryItem = { at: string; kind: string; from: string; source: string; actor?: string; directory?: string; stepID?: string; runID?: string; state?: string; model?: string; route?: string; why?: string; method?: string; branch?: string; into?: string; command?: string; exitCode?: number | null; text?: string }
export type RecordedToolCall = { tool: string; input: any; status?: string; command?: string; directory?: string; exitCode: number | null; shellID?: string; startedAt?: number; completedAt?: number; error?: string }
const iso = (value: unknown, fallback: number) => new Date(typeof value === 'number' ? value : fallback).toISOString()
const texts = (content: any[]) => (content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')
const SHELL_TOOL = /^(?:.*\.)?(shell|bash|cmd|powershell|pwsh|terminal|exec)$/
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
function errorText(value: any): string | undefined {
  const error = value.state?.error ?? value.error
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object') return String(error.message ?? error.data?.message ?? error.type ?? JSON.stringify(error))
  if ((value.state?.status ?? value.status) !== 'error') return
  const content = value.state?.content ?? value.output
  return Array.isArray(content) ? content.map((part: any) => part?.text ?? '').join('\n') || 'error' : typeof content === 'string' && content ? content : 'error'
}

export function recordedToolCalls(content: unknown, time: any = {}): RecordedToolCall[] {
  const calls: RecordedToolCall[] = [], seen = new Set<any>()
  const walk = (value: any, stamp: any, nested: boolean) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) { for (const part of value) walk(part, stamp, nested); return }
    const tool = value.tool ?? value.name, input = value.state?.input ?? value.input ?? value.args
    const own = value.time ?? stamp
    if (typeof tool === 'string' && (nested || value.type === 'tool')) {
      const command = input?.command ?? input?.cmd ?? input?.script
      const shell = SHELL_TOOL.test(tool) && typeof command === 'string'
      const exit = [value.state?.metadata, value.metadata, value.output, value.result].flatMap(result => result ? [result.exitCode, result.exit, result.code] : []).find(Number.isInteger)
      const startedAt = finite(own?.ran) ?? finite(own?.created) ?? finite(value.start), completedAt = finite(own?.completed) ?? finite(value.end)
      const error = errorText(value), shellID = value.state?.metadata?.shellID ?? value.metadata?.shellID
      calls.push({ tool, input, status: value.state?.status ?? value.status, ...(shell ? { command, directory: input.workdir ?? input.cwd } : {}), exitCode: Number.isInteger(exit) ? exit : null, ...(shell && typeof shellID === 'string' ? { shellID } : {}), ...(startedAt !== undefined ? { startedAt } : {}), ...(completedAt !== undefined ? { completedAt } : {}), ...(error ? { error } : {}) })
    }
    const metadata = value.state?.metadata ?? value.metadata
    walk(metadata?.toolCalls, own, true)
    walk(metadata?.innerCalls, own, true)
  }
  walk(content, time, false)
  return calls
}

export type SessionToolCall = RecordedToolCall & { source: string }
export function sessionToolCalls(file: string, sessionID: string): { calls: SessionToolCall[]; diagnostics: string[] } {
  if (!existsSync(file)) return { calls: [], diagnostics: ['The host database ' + file + ' does not exist, so no tool calls or commands could be read.'] }
  const calls: SessionToolCall[] = [], diagnostics: string[] = []
  const db = new Database(file, { readonly: true })
  try {
    db.exec('PRAGMA busy_timeout=1000')
    const rows = db.query("select id, time_created, data from session_message where session_id = ? and type = 'assistant' order by seq").all(sessionID) as any[]
    for (const row of rows) {
      let message: any
      try { message = JSON.parse(row.data) } catch { diagnostics.push('Host message ' + row.id + ' is unreadable.'); continue }
      for (const call of recordedToolCalls(message.content, message.time ?? {})) calls.push({ ...call, startedAt: call.startedAt ?? finite(row.time_created), source: file + ':session_message:' + row.id })
    }
  } catch (error) { diagnostics.push('The host tool records could not be fully read: ' + (error instanceof Error ? error.message : String(error))) }
  finally { db.close() }
  return { calls, diagnostics }
}

export function hostHistory(quest: Quest, file: string, giverID?: string): { items: HistoryItem[]; diagnostics: string[] } {
  if (!existsSync(file)) return { items: [], diagnostics: ['The host command history is unavailable.'] }
  const items: HistoryItem[] = [], diagnostics: string[] = []
  const sessions = new Map(quest.sessions.flatMap(run => {
    const id = run.openCodeSessionId ?? run.sessionID
    return id ? [[id, run] as const] : []
  }))
  const requests = new Set((quest.request ?? []).map(request => request.messageID))
  const db = new Database(file, { readonly: true })
  try {
    const givers = [giverID, quest.integrationOwner, ...(quest.extensions.previousGivers as string[] ?? []), ...quest.sessions.map(run => run.parentID)].filter((id): id is string => typeof id === 'string')
    for (const sessionID of new Set([...sessions.keys(), ...givers])) {
      const run = sessions.get(sessionID)
      const directory = db.query('select directory from session_v2 where id = ?').get(sessionID) as { directory?: string } | null
      const rows = db.query('select id, type, time_created, data from session_message where session_id = ? order by seq').all(sessionID) as any[]
      const finished = new Map<string, { exitCode: number | null; state?: string }>()
      for (const row of rows) {
        if (row.type !== 'synthetic') continue
        const metadata = JSON.parse(row.data).metadata ?? {}
        if (metadata.source === 'shell' && typeof metadata.shellID === 'string') finished.set(metadata.shellID, { exitCode: Number.isInteger(metadata.exit) ? metadata.exit : null, state: metadata.state })
      }
      const worker = run && !givers.includes(sessionID)
      for (const row of rows) {
        const message = JSON.parse(row.data), metadata = message.metadata ?? {}, at = iso(row.time_created, row.time_created)
        const source = file + ':session_message:' + row.id
        if (row.type === 'user' && worker) items.push({ at, kind: 'worker prompt', from: metadata.questHistoryOrigin?.from ?? 'runtime', source, actor: run.parentID ?? 'Quest Giver', runID: run.runID ?? run.callID, text: message.text ?? texts(message.content), directory: directory?.directory })
        else if (row.type === 'user') {
          const text = message.text ?? texts(message.content)
          if (metadata.questID === quest.id && (deliveredRunIDs(metadata).length || automaticQuestPrompt(metadata))) items.push({ at, kind: 'hand-off', from: 'runtime', source, actor: sessionID, text, runID: metadata.runID })
          else if (!automaticQuestPrompt(metadata) && (metadata.questID === quest.id || requests.has(row.id) || typeof text === 'string' && text.includes(quest.ref ?? quest.id))) items.push({ at, kind: 'message', from: metadata.questHistoryOrigin?.from ?? 'unknown', source, actor: 'Jon', text, directory: directory?.directory })
        }
        if (!run || row.type !== 'assistant') continue
        for (const call of recordedToolCalls(message.content, message.time ?? {})) {
          if (call.command === undefined) continue
          const background = call.exitCode === null && call.shellID ? finished.get(call.shellID) : undefined
          items.push({ at: iso(call.startedAt, row.time_created), kind: 'command', from: 'runtime', source, actor: sessionID, directory: call.directory ?? directory?.directory, runID: run.runID ?? run.callID, command: call.command, exitCode: background ? background.exitCode : call.exitCode, state: background?.state ?? call.status })
        }
      }
    }
  } catch (error) { diagnostics.push('The host history could not be fully read: ' + (error instanceof Error ? error.message : String(error))) }
  finally { db.close() }
  return { items, diagnostics }
}
