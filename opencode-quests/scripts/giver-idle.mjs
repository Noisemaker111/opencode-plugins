import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { channelHostPool, channelQuestRegistry } from './channel-migrate.mjs'
import { readUserGiver } from '../quest/giver-registry.mjs'

const channels = () => join(homedir(), '.config', 'opencode', '.channels')

const askActive = async local => {
  const response = await fetch(local.url + '/api/session/active', { headers: { authorization: local.authorization }, signal: AbortSignal.timeout(5000) })
  if (!response.ok) { await response.body?.cancel(); throw Error('the host answered ' + response.status) }
  const body = await response.json()
  return body?.data ?? body
}

export async function giverTurnInFlight({ registry = channels(), channel = 'v2', ask = askActive } = {}) {
  const sessionID = readUserGiver(dirname(channelQuestRegistry(registry, channel)))?.sessionID
  if (!sessionID) return false
  const pool = channelHostPool(registry, channel)
  let names = []
  try { names = readdirSync(pool).filter(name => name.endsWith('.json')) } catch {}
  for (const name of names) {
    try {
      const host = JSON.parse(readFileSync(join(pool, name), 'utf8'))
      if (!host.local?.url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(host.local.url)) continue
      const active = await ask(host.local)
      if (active && typeof active === 'object' && Object.hasOwn(active, sessionID)) return true
    } catch {}
  }
  return false
}
