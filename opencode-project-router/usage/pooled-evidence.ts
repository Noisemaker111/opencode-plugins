import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { channelRuntimes } from "../quest/host/channel-runtimes.mjs"
import { readWorkflowOutcomes, workflowOutcomesFile, type WorkflowStore } from "./workflow-outcomes"
import { TELEMETRY_FILE } from "./telemetry-store"

const key = (path: string) => { let full = resolve(path); try { full = realpathSync(path) } catch {} return process.platform === "win32" ? full.toLowerCase() : full }

export function peerTelemetryFiles(own = TELEMETRY_FILE, runtimes: { telemetry: string }[] = channelRuntimes()) {
  const mine = key(own)
  return [...new Set(runtimes.map(runtime => runtime.telemetry).filter(file => existsSync(file) && key(file) !== mine))]
}

export function readPooledOutcomes(own = workflowOutcomesFile(), peers = peerTelemetryFiles().map(file => file + ".workflows.json")) {
  const store = readWorkflowOutcomes(own), seen = new Set(store.runs.map(run => run.runID)), diagnostics: string[] = []
  const runs = [...store.runs]
  for (const file of peers) {
    if (key(file) === key(own) || !existsSync(file)) continue
    try { for (const run of readWorkflowOutcomes(file).runs) if (!seen.has(run.runID)) { seen.add(run.runID); runs.push(run) } }
    catch (error) { diagnostics.push("outcomes of " + file + " unreadable: " + (error instanceof Error ? error.message : String(error))) }
  }
  return { store: { version: 1, runs } as WorkflowStore, diagnostics, pooled: runs.length - store.runs.length }
}
