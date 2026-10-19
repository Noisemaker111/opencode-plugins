import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function buildInputs(top, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-inputs-'))
  try {
    const inputs = new Set()
    for (const [index, entry] of entries.entries()) {
      const meta = join(dir, index + '.json')
      const built = spawnSync('bun', ['build', entry.file, ...(entry.args ?? []), '--outdir', join(dir, 'out' + index), '--metafile=' + meta], { cwd: top, windowsHide: true, encoding: 'utf8', timeout: 120_000 })
      if (built.status !== 0) return undefined
      for (const name of Object.keys(JSON.parse(readFileSync(meta, 'utf8')).inputs ?? {})) inputs.add(name.replace(/\\/g, '/'))
    }
    return inputs
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function outsideBuild(changed, roots, inputs) {
  if (!inputs) return false
  return changed.every(path => !roots.some(root => path.startsWith(root + '/')) && !inputs.has(path))
}
