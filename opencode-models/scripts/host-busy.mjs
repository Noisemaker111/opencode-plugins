import { liveOwnership, liveWorkerRuns, SPARE_QUEST } from '../quest/checkouts/folder-owners.mjs'
import { giverTurnInFlight } from './giver-idle.mjs'

export async function busyCount({ workers = () => liveWorkerRuns().length, giver = giverTurnInFlight } = {}) {
  return workers() + ((await giver()) ? 1 : 0)
}

export const workerReceipts = () => liveOwnership().receipts.filter(entry => entry.receipt.questID !== SPARE_QUEST)

export function workerHolder(receipts = workerReceipts()) {
  const receipt = receipts[0]?.receipt
  if (!receipt) return undefined
  return receipt.branch ? receipt.branch.replace(/^quest\//, '') : receipt.questID ?? 'a Quest worker'
}

export async function busyHolder({ workers = workerReceipts, giver = giverTurnInFlight } = {}) {
  return workerHolder(workers()) ?? ((await giver()) ? 'the Quest Giver turn' : undefined)
}
