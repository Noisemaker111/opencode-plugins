import { readFileSync, readdirSync,statSync } from 'node:fs'
import { join } from 'node:path'
import {processStartedAt} from '../locking.mts'

export function processAlive(pid: number, startedAt?: number) {
  if(!Number.isSafeInteger(pid)||pid<1)return false
  if (pid === process.pid) return true
  try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false }
  if (startedAt === undefined || !Number.isFinite(startedAt)) return true
  const actual = processStartedAt(pid)
  return actual === undefined || Math.abs(actual - startedAt) <= 2000
}

type HostEndpoint = { url: string; authorization: string }
export type HostRecord = { id: string; pid: number; processStart?:string;record?:string; ownerPID?: number; generation?: string; channel?: string; root?: string; state: string; control: HostEndpoint; local?: HostEndpoint }
export function hostAlive(host:Pick<HostRecord,'pid'|'processStart'|'record'>){
 if(!Number.isSafeInteger(host.pid)||host.pid<1)return false
 if(!processAlive(host.pid))return false
 const start=processStartedAt(host.pid)
 if(host.processStart){const recorded=Number(/^(\d+)-\d+$/.exec(host.processStart)?.[1]);return Number.isFinite(recorded)&&(start===undefined||Math.abs(start-recorded)<=2000)}
 if(start!==undefined&&host.record){try{if(start>statSync(host.record).mtimeMs+2000)return false}catch{return false}}
 return true
}
export function hostRecords(directory = process.env.OPENCODE_HOST_POOL, diagnostics?: string[]): HostRecord[] {
  const result: HostRecord[] = []
  if (!directory) return result
  for (const name of readdirSync(directory).filter(name => name.endsWith('.json'))) {
    try { result.push({...JSON.parse(readFileSync(join(directory, name), 'utf8')),record:join(directory,name)}) }
    catch { diagnostics?.push('Unreadable host record: ' + join(directory, name)) }
  }
  return result
}
export function liveHostRecords(): HostRecord[] {
  return hostRecords().filter(hostAlive)
}

export function ownHostEndpoint(): HostEndpoint | undefined {
  const local = hostRecords().find(host => host.pid === process.pid)?.local
  return local && /^http:\/\/127\.0\.0\.1:\d+$/.test(local.url) && local.authorization ? local : undefined
}

export async function releaseHostLocations(matches: (directory: string) => boolean): Promise<number> {
  let closed = 0
  for (const host of liveHostRecords()) {
    if (!host.local || !/^http:\/\/127\.0\.0\.1:\d+$/.test(host.local.url) || !host.local.authorization) continue
    const call = (method: string, query = '') => fetch(host.local!.url + '/api/debug/location' + query, { method, headers: { authorization: host.local!.authorization }, signal: AbortSignal.timeout(5000) })
    try {
      const listed = await call('GET')
      if (!listed.ok) { await listed.body?.cancel(); continue }
      for (const row of await listed.json() as any[]) {
        const directory = row?.directory ?? row?.location?.directory
        if (typeof directory !== 'string' || !matches(directory)) continue
        const evicted = await call('DELETE', '?' + new URLSearchParams({ 'location[directory]': directory }))
        await evicted.body?.cancel()
        if (evicted.ok) closed++
      }
    } catch (error) { console.error('[quests] releasing host folders', host.pid, error instanceof Error ? error.message : error) }
  }
  return closed
}

export function sessionPermissions() {
  const own = ownHostEndpoint()
  if (!own) return undefined
  const call = async (sessionID: string, suffix: string, method: string, body?: unknown) => {
    const response = await fetch(own.url + '/api/session/' + encodeURIComponent(sessionID) + suffix, { method, headers: { authorization: own.authorization, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) throw Error('The host refused the permission ' + (method === 'GET' ? 'listing' : 'reply') + ' (' + response.status + '): ' + text.slice(0, 300))
    return text ? JSON.parse(text) : undefined
  }
  return {
    list: ({ sessionID }: { sessionID: string }) => call(sessionID, '/permission', 'GET'),
    reply: ({ sessionID, requestID, reply, message }: { sessionID: string; requestID: string; reply: string; message?: string }) => call(sessionID, '/permission/' + encodeURIComponent(requestID) + '/reply', 'POST', { decision: reply, ...(message ? { message } : {}) }),
  }
}
