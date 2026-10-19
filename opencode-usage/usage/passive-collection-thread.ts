import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads"
import type { CollectorReceipt } from "./passive-ledger"

export type PassiveCollection = { collected: true; receipt: CollectorReceipt } | { collected: false; notBefore?: number }

export function collectPassiveOffThread(): Promise<PassiveCollection> {
 return new Promise((resolve, reject) => {
  const worker = new Worker(new URL(import.meta.url), { workerData: { passiveCollection: true } })
  let answered = false
  worker.once("message", (answer: { result?: PassiveCollection; error?: string }) => { answered = true; answer.error !== undefined ? reject(new Error(answer.error)) : resolve(answer.result!) })
  worker.once("error", reject)
  worker.once("exit", code => { if (!answered) reject(new Error("Passive usage collection thread ended without a result (exit " + code + ")")) })
 })
}

if (!isMainThread && workerData?.passiveCollection) void (async () => {
 try { const { collectPassive } = await import("./passive-ledger"); parentPort!.postMessage({ result: await collectPassive() }) }
 catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
 finally { parentPort!.close() }
})()
