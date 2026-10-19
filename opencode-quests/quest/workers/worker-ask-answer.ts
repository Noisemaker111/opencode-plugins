import { QuestError } from '../api'
import { automaticQuestPrompt } from '../giver/giver-instruction'
import { hostPermissionDomain } from '../host/host-observation'
import { sessionPermissions } from '../host/host-role'
import { readAllQuests } from '../index'
import { TERMINAL_RUN } from '../runs/session-lineage'
import { WorkerPermissions } from '../permissions/worker-permissions'
import type { QuestStore } from '../store'
import type { Quest, QuestSession } from '../types'

const unwrap = (value: any) => value?.data ?? value
const runID = (run: QuestSession) => run.runID ?? run.callID
const words = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

export function clearAnsweredAsk(store: QuestStore, sessionID: unknown, requestID: unknown) {
  if (typeof requestID !== 'string' || !requestID) return false
  for (const row of readAllQuests(store.projectRoot)) {
    const run = row.quest?.sessions.find(s => s.awaiting?.requestID === requestID && (typeof sessionID !== 'string' || (s.openCodeSessionId ?? s.sessionID) === sessionID))
    if (!row.quest || !run || TERMINAL_RUN.has(run.state)) continue
    store.apply(row.quest.id, 'session-state', { callID: run.callID, state: run.state, preserveTerminal: true, awaiting: null }, 'quest:worker-ask-answered')
    return true
  }
  return false
}

export function quotedAfter(messages: any[], quote: string, since: string) {
  const wanted = words(quote), after = Date.parse(since)
  if (!/\w/.test(wanted)) return undefined
  return messages.find(message => message?.type === 'user' && !automaticQuestPrompt(message.metadata) && typeof message.text === 'string'
    && Number(message.time?.created) >= after && words(message.text).includes(wanted))
}

export async function answerWorkerAsk(store: QuestStore, host: any, callerID: string, input: { id: string; runID?: string; reply: 'once' | 'reject'; quote?: string }) {
  const quest: Quest | undefined = store.read(input.id)
  if (!quest) throw new QuestError('NOT_FOUND', 'Quest not found: ' + input.id)
  const waiting = quest.sessions.filter(run => run.awaiting && !TERMINAL_RUN.has(run.state) && (!input.runID || runID(run) === input.runID))
  if (!waiting.length) throw new QuestError('NO_PENDING_ASK', 'No worker on this Quest is waiting for an answer' + (input.runID ? ' in run ' + input.runID : ''))
  if (waiting.length > 1) throw new QuestError('INVALID_INPUT', 'More than one worker is waiting; name the run: ' + waiting.map(runID).join(', '))
  const run = waiting[0], ask = run.awaiting!
  const service = new WorkerPermissions(store, host, sessionPermissions() ?? hostPermissionDomain(host))
  const view = await service.inspect(callerID, quest.id, runID(run))
  const request = view.requests.find((row: any) => row.requestID === ask.requestID)
  if (!request) {
    store.apply(quest.id, 'session-state', { callID: run.callID, state: run.state, preserveTerminal: true, awaiting: null }, 'quest:worker-ask-answered')
    return { state: 'already answered', runID: runID(run), ask: ask.ask, note: 'The worker is no longer waiting on this ask, so nothing was sent and the ask was cleared from the Quest.' }
  }
  const quote = input.quote?.trim()
  if (!quote) throw new QuestError('QUOTE_REQUIRED', 'Quote the user\'s own words that decide this ask: ' + ask.ask)
  const messages = unwrap(await host.context({ sessionID: callerID }))
  const source = Array.isArray(messages) ? quotedAfter(messages, quote, ask.at) : undefined
  if (!source) throw new QuestError('QUOTE_NOT_FOUND', 'Nothing was answered: those words are not in a message written to you since the worker asked (' + ask.at + '). Quote his message exactly, or leave the ask to him in Quest Web.')
  const reason = 'Answered from the giver conversation, quoting message ' + source.id + ': "' + quote + '"'
  await service.reply(callerID, { questID: quest.id, runID: runID(run), requestID: ask.requestID, requestKey: request.requestKey, reply: input.reply, reason }, 'user')
  store.apply(quest.id, 'session-state', { callID: run.callID, state: run.state, preserveTerminal: true, awaiting: null }, 'quest:worker-ask-answered')
  return { state: input.reply === 'once' ? 'allowed once' : 'rejected', runID: runID(run), ask: ask.ask, quote, messageID: source.id }
}
