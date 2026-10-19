export type WorkerReturnMetadata = { questWorkerReturn: true; questID: string; runID: string; runIDs: string[] }

export function workerReturnMetadata(questID: string, runID: string, deliveredWith: string[] = []): WorkerReturnMetadata {
  return { questWorkerReturn: true, questID, runID, runIDs: [...new Set([...deliveredWith, runID])] }
}

export function deliveredRunIDs(metadata: unknown): string[] {
  const row = metadata as Partial<WorkerReturnMetadata> | null | undefined
  if (row?.questWorkerReturn !== true) return []
  const listed = Array.isArray(row.runIDs) ? row.runIDs.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
  return [...new Set([...listed, ...(typeof row.runID === 'string' && row.runID ? [row.runID] : [])])]
}
