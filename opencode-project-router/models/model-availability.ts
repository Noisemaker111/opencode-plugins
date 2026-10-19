import type { RequestRecord } from "../usage/telemetry"

export function unavailableModelError(error: unknown): boolean {
  const text = typeof error === "string" ? error : JSON.stringify(error) ?? ""
  return /\bmodel[_ -](?:not[_ -]found|retired|deprecated|decommissioned)\b/i.test(text)
    || /\bmodel\b[^\n]*\b(?:does not exist|not found|retired|decommissioned|no longer (?:available|supported))\b/i.test(text)
}

type Row = { key: string; unavailable: boolean; completedStart?: number }
type Tally = { finished: number; unavailable: number; lastCompletedStart: number; stale?: boolean }
export class ModelAvailability {
  private rows = new Map<string, Row>()
  private tallies = new Map<string, Tally>()
  clear() { this.rows.clear(); this.tallies.clear() }
  add(records: Iterable<RequestRecord>) {
    for (const record of records) {
      const prior = this.rows.get(record.id)
      if (prior) { this.rows.delete(record.id); this.count(prior, -1) }
      if (record.state !== "failed" && record.state !== "completed") continue
      if (!record.route?.providerID || !record.route?.modelID) continue
      const row: Row = { key: `${record.route.providerID}/${record.route.modelID}`, unavailable: record.state === "failed" && record.failure === "model-unavailable", ...(record.state === "completed" ? { completedStart: record.startedAt } : {}) }
      this.rows.set(record.id, row); this.count(row, 1)
    }
  }
  private count(row: Row, sign: 1 | -1) {
    let tally = this.tallies.get(row.key)
    if (!tally) this.tallies.set(row.key, tally = { finished: 0, unavailable: 0, lastCompletedStart: -Infinity })
    tally.finished += sign
    if (row.unavailable) tally.unavailable += sign
    if (row.completedStart === undefined) return
    if (sign > 0) tally.lastCompletedStart = Math.max(tally.lastCompletedStart, row.completedStart)
    else if (row.completedStart >= tally.lastCompletedStart) tally.stale = true
  }
  private lastCompletedStart(key: string, tally: Tally) {
    if (tally.stale) {
      tally.stale = false; tally.lastCompletedStart = -Infinity
      for (const row of this.rows.values()) if (row.key === key && row.completedStart !== undefined) tally.lastCompletedStart = Math.max(tally.lastCompletedStart, row.completedStart)
    }
    return tally.lastCompletedStart
  }
  unavailable(): Set<string> {
    const unavailable = new Set<string>()
    for (const [key, tally] of this.tallies) if (tally.finished > 0 && tally.finished === tally.unavailable) unavailable.add(key)
    return unavailable
  }
}
