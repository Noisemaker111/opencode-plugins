import { Duration, Effect } from 'effect'

export function observeWorker(session, { active, messages = [], permissions = [], forms = [], expected, now = Date.now() } = {}) {
  const time = value => typeof value === 'number' ? value : Date.parse(value ?? '')
  const updated = Math.max(time(session?.time?.updated) || 0, ...messages.map(m => time(m.time?.completed ?? m.time?.streamed ?? m.time?.created) || 0))
  const base = { checkedAt: new Date(now).toISOString(), lastActivityAt: updated ? new Date(updated).toISOString() : undefined, provider: session?.model?.providerID, model: session?.model?.id, reasoning: session?.model?.variant ?? 'unknown' }
  if (permissions.length) {
    const clean = value => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, '').slice(0,180)
    const requests = permissions.slice(0,3).map(request => {
      const action = clean(request.action ?? 'permission')
      const resources = ['read','external_directory'].includes(action) && Array.isArray(request.resources) ? request.resources.filter(value=>typeof value==='string').slice(0,2).map(clean) : []
      return { action, resources }
    })
    const detail = requests.map(request=>request.action+(request.resources.length?' ('+request.resources.join(', ')+')':'')).join('; ')
    return { ...base, state: 'blocked', permissions: requests, reason: 'Waiting for host permission: '+detail+(permissions.length>3?'; '+(permissions.length-3)+' more':'')+'. The Quest Giver reviews this request; you can also open the worker. Existing launch retained.' }
  }
  if (forms.length) return { ...base, state: 'blocked', reason: 'Waiting for a worker question. Open the worker session to review. Existing launch retained.' }
  if (active === false) {
    const aborted = abortedTurn(messages)
    if (aborted) {
      const pending=expected?.permissionDecisions?.findLast(decision=>decision.reply==='reject'&&decision.request?.source?.messageID===aborted.id)
      if(pending&&pending.state!=='acknowledged')return {...base,state:'unknown',reason:'Refusal delivery is not yet acknowledged; retain this run until its reply is reconciled'}
      const stoppedByUser=/Host reported execution interrupted: user/.test(expected?.result??'')
      const refused=!stoppedByUser&&expected?.permissionDecisions?.findLast(decision=>decision.reply==='reject'&&decision.state==='acknowledged'&&decision.request?.source?.messageID===aborted.id&&time(decision.at)<=time(aborted.at))
      return { ...base, state: 'interrupted', outcome: 'interrupted', completedAt: aborted.at, reason: refused?'Permission refusal interrupted the worker tool message; resume the remaining assignment without the refused action.':'The worker turn was aborted ('+aborted.detail+'); no automatic restart is authorized by this observation' }
    }
  }
  if (active !== true && session?.outcome && time(session.time?.idle) >= updated) return { ...base, state: { succeeded: 'completed', failed: 'failed', interrupted: 'interrupted' }[session.outcome] ?? 'unknown', outcome: session.outcome, completedAt: new Date(time(session.time.idle)).toISOString(), reason: 'Persisted host execution outcome; step completion is separate' }
  if (active !== false && expected?.providerID && expected?.modelID && expected?.reasoningEffort && (session?.agent !== expected.agentRole || session?.model?.providerID !== expected.providerID || session?.model?.id !== expected.modelID || session?.model?.variant !== expected.reasoningEffort)) return { ...base, state: 'blocked', reason: 'Host agent/model/reasoning differs from the recorded dispatch. Return to your Quest Giver to inspect and restore the existing assignment; do not redispatch.' }
  if (active === true) return { ...base, state: 'running', reason: 'Owning host confirms an active execution' }
  if (active === false) return { ...base, state: 'unknown', hostIdle: true, answered: messages.some(message => message?.type === 'assistant'), reason: 'Host has no active execution or terminal outcome; inspect the session before retrying' }
  return { ...base, state: 'unknown', reason: active === false ? 'Host has no active execution or terminal outcome; inspect the session before retrying' : 'Session exists; live execution is not confirmed' }
}
export function abortedTurn(messages = []) {
  for (const message of [...messages].reverse()) {
    if (message?.type === 'user') return undefined
    if (!message || message.type !== 'assistant') continue
    const error = message.error
    const type = String(error?.type ?? '')
    if (message.finish !== 'error' || type !== 'aborted') return undefined
    const at = message.time?.completed ?? message.time?.created
    return { id: message.id, at: at ? new Date(at).toISOString() : undefined, detail: String(error?.message ?? 'aborted') }
  }
  return undefined
}
export function observationFailure(error, now = Date.now()) {
  const status = error?.status ?? error?.response?.status
  return { state: status === 404 ? 'missing' : 'unreachable', checkedAt: new Date(now).toISOString(), reason: status === 404 ? 'Owning host no longer holds this session; it was pruned or never persisted. The run is over and the step is free to redispatch.' : 'Owning host inspection failed. Check its connection, then refresh; do not redispatch an uncertain worker.' }
}

/** @type {<T>(operation: (signal: AbortSignal) => PromiseLike<T>, milliseconds?: number) => Promise<T>} */
export function boundedInspection(operation, milliseconds = 5000) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const signal = yield* Effect.abortSignal
      return yield* Effect.tryPromise({ try: () => operation(signal), catch: error => error })
    }).pipe(
      Effect.scoped,
      Effect.timeout(Duration.millis(milliseconds)),
      Effect.catchTag('TimeoutError', () => Effect.fail(new Error('Host inspection timed out')))
    )
  )
}
