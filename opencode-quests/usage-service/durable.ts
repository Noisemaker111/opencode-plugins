import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"

const retryable = new Set(["EACCES", "EBUSY", "EPERM"])
const pauses = [0, 25, 50, 100, 200, 400]
const pause = (milliseconds: number) => { if (milliseconds) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds) }

export function writeFileDurable(path: string, contents: string, options: { flag?: string; mode?: number } = {}): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, "." + randomBytes(4).toString("hex") + ".tmp")
  const fd = openSync(temporary, options.flag ?? "w", options.mode)
  let moved = false
  try {
    try { writeFileSync(fd, contents); fsyncSync(fd) } finally { closeSync(fd) }
    for (let attempt = 0; attempt < pauses.length; attempt++) {
      pause(pauses[attempt])
      try { renameSync(temporary, path); moved = true; break } catch (error: any) {
        if (!retryable.has(error?.code ?? "") || attempt === pauses.length - 1) throw error
      }
    }
  } finally { if (!moved) try { unlinkSync(temporary) } catch {} }
}
