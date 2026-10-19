import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const run = (command: string, args: string[]) => new Promise<string>((resolve, reject) => execFile(command, args, { windowsHide: true, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout)))

export function parseTasklist(csv: string, pids: number[]) {
  const wanted = new Set(pids), found = new Map<number, number>()
  for (const line of csv.split(/\r?\n/)) {
    const cells = [...line.matchAll(/"([^"]*)"/g)].map(match => match[1])
    const pid = Number(cells[1])
    if (!wanted.has(pid)) continue
    const kilobytes = Number(cells[4]?.replace(/[^0-9]/g, ''))
    if (Number.isFinite(kilobytes)) found.set(pid, kilobytes * 1024)
  }
  return found
}

export async function processMemory(pids: number[]): Promise<Map<number, number>> {
  if (!pids.length) return new Map()
  if (process.platform === 'win32') return parseTasklist(await run('tasklist', ['/FO', 'CSV', '/NH']), pids)
  const found = new Map<number, number>()
  await Promise.all(pids.map(async pid => {
    const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '')
    const kilobytes = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1])
    if (Number.isFinite(kilobytes)) found.set(pid, kilobytes * 1024)
  }))
  return found
}
