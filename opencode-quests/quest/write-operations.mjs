import { questOperations } from './operations.mjs'

export const READ_SCOPE = 'quest:read'
export const WRITE_SCOPE = 'quest:write'
export const MESSAGE_SCOPE = 'giver:message'
export const GRANT_HEADER = 'x-quest-grant'

export const scopeOperations = {
  [WRITE_SCOPE]: ['create', 'update', 'archive', 'start', 'stop'],
  [MESSAGE_SCOPE]: ['message'],
}
export const scopeSummary = {
  [READ_SCOPE]: 'Read the Quest board, workers, usage, routes, context, owners and hand-offs. Changes nothing.',
  [WRITE_SCOPE]: 'Create, update, archive, start and stop Quests, the same way Quest Web does. Every action is labeled with the app\'s name and recorded.',
  [MESSAGE_SCOPE]: 'Send messages to the Quest Giver, labeled with the app\'s name. The Quest Giver knows they are not from you and decides what to do.',
}

export const grantLevels = {
  read: [READ_SCOPE],
  write: [READ_SCOPE, WRITE_SCOPE],
  message: [READ_SCOPE, WRITE_SCOPE, MESSAGE_SCOPE],
}
export const scopesText = scopes => scopes.join(' ')
export const parseScopes = text => [...new Set(String(text ?? '').split(/\s+/).filter(scope => Object.values(grantLevels).flat().includes(scope)))]
export const levelOf = scopes => scopes.includes(MESSAGE_SCOPE) ? 'message' : scopes.includes(WRITE_SCOPE) ? 'write' : 'read'
export const operationScope = name => Object.entries(scopeOperations).find(([, names]) => names.includes(name))?.[0]
export const scopePermits = (scopes, operation) => {
  const scope = operationScope(operation)
  return scope !== undefined && scopes.includes(scope)
}

export const grantAttribution = (client, scopes) => `id=${client.id}; name=${encodeURIComponent(client.name)}; scopes=${scopes.join(',')}`
export function parseGrant(value) {
  if (typeof value !== 'string') return undefined
  const id = /(?:^|;)\s*id=([^;]+)/.exec(value)?.[1]?.trim()
  const name = /(?:^|;)\s*name=([^;]+)/.exec(value)?.[1]?.trim()
  const scopes = /(?:^|;)\s*scopes=([^;]*)/.exec(value)?.[1] ?? ''
  if (!id || !name) return undefined
  let decoded = name
  try { decoded = decodeURIComponent(name) } catch {}
  return { id, name: decoded, scopes: parseScopes(scopes.replace(/,/g, ' ')) }
}

const unclaimable = ['sender', 'fromMessage']
const without = input => ({ ...input, properties: Object.fromEntries(Object.entries(input.properties ?? {}).filter(([key]) => !unclaimable.includes(key))), required: (input.required ?? []).filter(key => !unclaimable.includes(key)) })
export const writeOperations = Object.fromEntries(Object.values(scopeOperations).flat().map(name => [name, { ...questOperations[name], input: without(questOperations[name].input) }]))

export function writeTools(scopes) {
  return Object.entries(writeOperations)
    .filter(([name]) => scopePermits(scopes, name))
    .map(([name, op]) => ({ name, description: op.description, inputSchema: op.input, annotations: op.annotations }))
}
