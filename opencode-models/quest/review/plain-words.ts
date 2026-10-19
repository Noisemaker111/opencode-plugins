import { redactSensitive } from '../privacy'

export const identifiers = /\b(?:ses_[A-Za-z0-9]+|msg_[A-Za-z0-9]+|run_[A-Za-z0-9]+|\d{4}-\d{6}-[a-f0-9]{4,}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|[0-9a-f]{12,}|[0-9a-hjkmnp-tv-z]{26})\b/gi

export function plainWords(value: unknown): string {
  return redactSensitive(typeof value === 'string' ? value : '').replace(identifiers, '')
    .replace(/\brevision \d+\b/gi, '').replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1')
    .replace(/\(\s*\)/g, '').trim()
}

export function sentence(value: unknown): string {
  const text = plainWords(value)
  return text.replace(/([^.!?])$/, '$1.')
}

export function namedRouteProvider(text: string, providerID?: string): string {
  return text.replace(/unknown provider for model (\S+)/gi, (_, model: string) => `the ${providerID || 'selected'} route found no provider for model ${model}`)
}

export const WORKER_CANNOT_REACH_GIVER = 'Workers do not talk to the Quest Giver. Save the blocker on your step with quest_report (status blocked, owner, requires) and end your turn.'

export function noteReason(value: unknown): string {
  const text = plainWords(value)
  if (/SINGLE_GIVER_REQUIRED|WORKER_CANNOT_REACH_GIVER|Continue in your (?:one|existing) Quest Giver|Only your Quest Giver can hand on|Workers do not talk to the Quest Giver|Workers cannot talk to the Quest Giver/.test(text))
    return 'The worker tried to reach the Quest Giver, which workers cannot do. Start the step again.'
  if (/^(The worker location .* has no Quest tools:|Worker cannot save assigned Quest results:)/.test(text))
    return 'The worker’s Quest tools did not load. Fix the saved tool error before starting it again.'
  if (/^Workspace preparation failed at /.test(text) && /\bENOSPC\b|No space left on device|There is not enough space on the disk/i.test(text))
    return 'The worker’s checkout could not be prepared because the disk ran out of space. Free space on that drive, or move the package cache with its own setting, before starting it again. The checkout stays in place.'
  if (/^Workspace preparation failed at /.test(text))
    return 'The worker’s checkout could not be prepared. Fix the saved preparation error before starting it again.'
  if (/No evidenced, funded route/.test(text)) {
    const reset = /resets?\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(text)?.[1]
    if (reset) return `Usage is used up and resets at ${reset}. Wait for it to reset before trying again.`
    const blocked = blockingSetting(text)
    return blocked ? `Routing cannot start this work. ${blocked} Change the blocking settings, or name another route, before trying again.`
      : 'Routing cannot start this work. Check the saved routing refusal before trying again.'
  }
  if (/^(Dispatch owner \d+ (?:on \S+ )?exited during|Execution ended with the host process|Planned before this host started)/.test(text))
    return 'The host stopped before the worker could finish. Its checkout stays in place. Start the step again.'
  if (/^Host reported execution succeeded/.test(text)) return 'The worker finished its turn.'
  if (/^Host reported execution interrupted: user/.test(text)) return 'A session or tool outside the Quest stop action stopped the worker. The host names no sender or order, and no order is recorded. Its checkout and unfinished work are kept.'
  if (/^Host reported execution failed: Failed to execute statement/.test(text) && /LockTimeoutError|database is locked/.test(text))
    return 'The worker stopped because the host could not save to its database: another host process held the database lock (Failed to execute statement: database is locked' + (/(\d+) host processes shared the host database/.exec(text)?.[1]?.replace(/^/, '; ').concat(' host processes shared it') ?? '') + '). The host waits five seconds for that lock, then gives up. This is a host cause, not a route fault. Its checkout stays in place. Start the step again.'
  if (/^Host reported execution failed: Failed to execute statement/.test(text) && /database or disk is full/.test(text))
    return 'The worker stopped because the host could not save to its database: the database or disk was full (Failed to execute statement). This is a host cause, not a route fault. Free space before starting the step again.'
  if (/^Host reported execution (failed|interrupted)/.test(text))
    return sentence('The worker stopped' + (text.includes(':') ? ': ' + text.slice(text.indexOf(':') + 1).trim() : ' before finishing'))
  return text
}

const BLOCKING_SETTINGS: [RegExp, (match: RegExpExecArray) => string][] = [
  [/below task quality floor(?: \(minSuccessRate ([\d.]+%)\)(?:: (\d+ of \d+) measured runs accepted)?)?/, m => `the quality floor (minSuccessRate${m[1] ? ' ' + m[1] : ''}) in the saved dispatch policy${m[2] ? '. The diff reviewer accepted ' + m[2] + ' of its measured runs' : ''}`],
  [/insufficient or invalid measured outcomes/, () => 'the measured run rules (minTrials and minSuccessRate) in the saved dispatch policy'],
  [/is below the task floor/, () => 'the published score floor (minBenchmarkPassAt1) in the saved dispatch policy'],
  [/route is not allowed by user policy/, () => 'the allowed routes list (allowedRouteIDs) in the saved dispatch policy'],
  [/automatic routing excludes \S+(?: at depth \w+)? \(routing settings\)|\d+ routes? excluded by routing settings/, () => 'the route exclusion in the excluded models list on the Routing page'],
  [/depth (\w+) band/, m => `the ${m[1]} depth settings on the Routing page`],
  [/outside configured price range/, () => 'the price range (economyPriceTolerance) in the saved dispatch policy'],
  [/Measured outcomes unavailable: Error: .*access policy/i, () => 'the access policy'],
  [/account is not authenticated|on an account that is not signed in/, () => 'the account sign-in'],
  [/explicit route is not registered/, () => 'the primary route (primaryRouteID) in the dispatch policy, which names a route the policy does not define'],
]

export function blockingSetting(refusal: string): string | undefined {
  const detail = refusal.split(' | candidates:')[0]
  const causes = new Set<string>()
  for (const [pattern, name] of BLOCKING_SETTINGS)
    for (const match of detail.matchAll(new RegExp(pattern.source, 'g' + pattern.flags))) causes.add(name(match))
  const route = /authorized\.\s*:\s*(?!\d+ routes?\b)(\S+) /.exec(detail)?.[1]
  const named = [...causes].map(cause => cause.split('. '))
  if (causes.size) return named.map(([setting, ...details], index) => (index ? ` Routing also skips ${route ? 'it' : 'them'} because of ` : `Routing skips ${route ? 'the route ' + route : 'every route'} because of `) + setting + '.' + details.map(detail => ' ' + detail + '.').join('')).join('')
  return undefined
}

export const hasIdentifier = (value: string) => new RegExp(identifiers.source, 'i').test(value)
