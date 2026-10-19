import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { uptime } from 'node:os'
import { join } from 'node:path'

export function receiptName(pid, runtime, instance) {
  return 'host-' + pid + '-' + createHash('sha256').update(String(runtime)).digest('hex').slice(0, 12) + (instance ? '-' + String(instance).slice(0, 8) : '') + '.json'
}

export function processLiveness(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'gone'
  try { process.kill(pid, 0); return 'alive' } catch (error) {
    return error.code === 'ESRCH' ? 'gone' : 'unsignalable'
  }
}

export const bootedAt = () => Date.now() - uptime() * 1000

export function readRegistry(directory) {
  let names
  try { names = readdirSync(directory).filter(name => name.endsWith('.json')) } catch { return { endpoints: [], removed: 0, rejected: [] } }
  const boot = bootedAt(), endpoints = [], rejected = []
  let removed = 0
  for (const name of names) {
    const path = join(directory, name)
    let mtimeMs, endpoint
    try { mtimeMs = statSync(path).mtimeMs } catch { continue }
    const drop = (reason) => { rejected.push(reason); try { unlinkSync(path) ; removed++ } catch (error) { if (error.code !== 'ENOENT') rejected.push('could not remove ' + name + ': ' + error.code) } }
    if (mtimeMs < boot) { drop('written before this boot'); continue }
    try { endpoint = JSON.parse(readFileSync(path, 'utf8')) } catch { drop('unreadable'); continue }
    if (endpoint?.version !== 2) { drop('older discovery format'); continue }
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url ?? '') || typeof endpoint.token !== 'string') { drop('malformed endpoint'); continue }
    const liveness = processLiveness(endpoint.pid)
    if (liveness === 'gone') { drop('process ' + endpoint.pid + ' is gone'); continue }
    endpoints.push({ ...endpoint, path, mtimeMs, liveness })
  }
  endpoints.sort((a, b) => (b.startedAt ?? b.mtimeMs) - (a.startedAt ?? a.mtimeMs) || b.mtimeMs - a.mtimeMs)
  return { endpoints, removed, rejected }
}
