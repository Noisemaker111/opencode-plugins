import { availableParallelism } from 'node:os'

export const LOAD_CHECK_KINDS = ['core', 'affected', 'gate', 'gate-retry']
export const FULL_GATE_KIND = 'gate'
export const AFFECTED_KIND = 'affected'

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return undefined
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function concurrentChecks(rows, row) {
  const length = row.end - row.start
  if (!(length > 0)) return 0
  let shared = 0
  for (const other of rows) {
    if (other === row || !LOAD_CHECK_KINDS.includes(other.name)) continue
    const overlap = Math.min(row.end, other.end) - Math.max(row.start, other.start)
    if (overlap > 0) shared += overlap
  }
  return shared / length
}

function kindLoad(all, kind, files) {
  const rows = all.filter(row => row.name === kind && row.end > row.start && row.files > 0)
  const buckets = new Map()
  for (const row of rows) {
    const others = Math.round(concurrentChecks(all, row))
    const bucket = buckets.get(others) ?? buckets.set(others, []).get(others)
    bucket.push((row.end - row.start) / 1000 / row.files)
  }
  const byLoad = [...buckets.entries()].sort(([a], [b]) => a - b)
    .map(([others, perFile]) => ({ others, runs: perFile.length, secondsPerFile: median(perFile), seconds: median(perFile) * files }))
  const unloaded = byLoad[0]
  return { files, runs: rows.length, unloadedSeconds: unloaded?.seconds, unloadedAt: unloaded?.others, measuredUnloaded: unloaded?.others === 0, byLoad }
}

export function gateLoadInputs(rows, { cores = availableParallelism(), since = 0, now = Date.now() } = {}) {
  const all = rows.filter(row => row.plugin === 'checks' && LOAD_CHECK_KINDS.includes(row.name) && row.start >= since && Number.isFinite(row.start) && Number.isFinite(row.end))
  const latest = kind => all.filter(row => row.name === kind && row.files > 0).sort((a, b) => b.start - a.start)[0]?.files ?? 0
  const affectedFiles = median(all.filter(row => row.name === AFFECTED_KIND && row.files > 0).map(row => row.files)) ?? 0
  return {
    measuredAt: new Date(now).toISOString(),
    ...(since ? { since: new Date(since).toISOString() } : {}),
    cores,
    checkRuns: all.length,
    gate: kindLoad(all, FULL_GATE_KIND, latest(FULL_GATE_KIND)),
    affected: kindLoad(all, AFFECTED_KIND, affectedFiles),
  }
}

export function gateLoadText(inputs) {
  const line = (label, load) => {
    const base = load.unloadedSeconds === undefined ? 'no run measured' : `${Math.round(load.unloadedSeconds)} s ${load.measuredUnloaded ? 'with no other check running' : `at its lightest measured load (${load.unloadedAt} other checks)`}`
    const levels = load.byLoad.map(level => `${level.others} other: ${Math.round(level.seconds)} s over ${level.runs} run(s)`).join('; ')
    return `${label} (${load.files} files): ${base}. ${levels || 'No runs.'}`
  }
  return [
    `Machine: ${inputs.cores} processors. ${inputs.checkRuns} check runs measured${inputs.since ? ' since ' + inputs.since : ''}.`,
    line('Full gate', inputs.gate),
    line('check:affected', inputs.affected),
  ].join('\n')
}

export const NEAR_UNLOADED = 1.25

const levelAt = (load, others) => load.byLoad.find(level => level.others === others)

export function workerAdmission(inputs, { near = NEAR_UNLOADED } = {}) {
  const { gate, affected, cores } = inputs
  const base = { cores, near, measuredAt: inputs.measuredAt, checkRuns: inputs.checkRuns, gateFiles: gate.files, affectedFiles: affected.files }
  if (!gate.measuredUnloaded || !(gate.unloadedSeconds > 0)) {
    return { ...base, slots: null, basis: 'unmeasured', gateUnloadedSeconds: null, gateSecondsAtSlots: null, affectedUnloadedSeconds: affected.measuredUnloaded ? affected.unloadedSeconds : null, affectedSecondsAtSlots: null }
  }
  const within = (load, others) => {
    if (!load.measuredUnloaded) return true
    const level = levelAt(load, others)
    return level !== undefined && level.seconds <= load.unloadedSeconds * near
  }
  let slots = 1
  while (slots < cores && within(gate, slots) && within(affected, slots)) slots++
  const at = (load, others) => levelAt(load, others)?.seconds ?? null
  return {
    ...base, slots, basis: 'measured',
    gateUnloadedSeconds: gate.unloadedSeconds, gateSecondsAtSlots: at(gate, slots - 1),
    affectedUnloadedSeconds: affected.measuredUnloaded ? affected.unloadedSeconds : null, affectedSecondsAtSlots: at(affected, slots - 1),
    gateSecondsAtNext: at(gate, slots), affectedSecondsAtNext: at(affected, slots),
  }
}

const seconds = value => value === null || value === undefined ? 'not measured' : `${Math.round(value)} s`

export function workerAdmissionText(admission) {
  if (admission.basis === 'unmeasured') return `Worker admission: no limit yet. No full gate has been measured with no other check running on this ${admission.cores}-processor machine, so no number can be derived.`
  const next = admission.gateSecondsAtNext === null || admission.gateSecondsAtNext === undefined ? 'the next count has no measured run' : `${seconds(admission.gateSecondsAtNext)} with ${admission.slots} other check${admission.slots === 1 ? "" : "s"}`
  return `Worker admission: ${admission.slots} worker${admission.slots === 1 ? '' : 's'} at a time. The full gate takes ${seconds(admission.gateUnloadedSeconds)} with no other check and ${seconds(admission.gateSecondsAtSlots)} beside ${admission.slots - 1} other check${admission.slots === 2 ? "" : "s"}; ${next}. check:affected takes ${seconds(admission.affectedUnloadedSeconds)} alone and ${seconds(admission.affectedSecondsAtSlots)} at that count. A new worker starts only while gate time stays within ${Math.round((admission.near - 1) * 100)}% of its unloaded time. This machine has ${admission.cores} processors.`
}
