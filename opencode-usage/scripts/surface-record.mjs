import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileDurable } from '../quest/core/durable-file.mjs'

export const surfaceFile = hub => join(hub, '.opencode', '.quest-runtime', 'surfaces.json')

export function readSurfaces(hub) {
  try { return { previous: {}, failures: {}, ...JSON.parse(readFileSync(surfaceFile(hub), 'utf8')) } } catch { return { previous: {}, failures: {} } }
}

function writeSurfaces(hub, record) {
  mkdirSync(dirname(surfaceFile(hub)), { recursive: true })
  writeFileDurable(surfaceFile(hub), JSON.stringify(record, null, 2) + '\n')
}

export const rememberVersion = (hub, worker, versionId) => {
  if (!versionId) return
  const record = readSurfaces(hub)
  record.previous[worker] = versionId
  writeSurfaces(hub, record)
}

export const previousVersion = (hub, worker) => readSurfaces(hub).previous[worker]

export function recordFailure(hub, name, failure) {
  const record = readSurfaces(hub)
  record.failures[name] = { ...failure, at: new Date().toISOString() }
  writeSurfaces(hub, record)
}

export function clearFailure(hub, name) {
  const record = readSurfaces(hub)
  if (!record.failures[name]) return
  delete record.failures[name]
  writeSurfaces(hub, record)
}
