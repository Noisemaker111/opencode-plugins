import { posix } from "node:path"

export const SOURCE = /\.(ts|tsx|mts|mjs|js|cjs)$/
const SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`]([^"'`\n]+)["'`]/g
const LITERAL = /["'`]((?:\.{1,2}\/|[\w-]+\/)[\w./-]+\.(?:ts|tsx|mts|mjs|js|cjs|json|md|ps1))["'`]/g
const CANDIDATES = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts", "/index.mjs", "/index.js"]

function resolver(files) {
  const known = new Set(files)
  return (from, spec) => {
    const bases = spec.startsWith(".") ? [posix.join(posix.dirname(from), spec)] : [posix.normalize(spec), posix.join(posix.dirname(from), spec)]
    for (const base of bases) for (const suffix of CANDIDATES) {
      const path = base + suffix
      if (known.has(path)) return path
      const swapped = path.replace(/\.js$/, ".ts")
      if (known.has(swapped)) return swapped
    }
  }
}

function targets(file, read, resolve) {
  if (!SOURCE.test(file)) return []
  let text
  try { text = read(file) } catch { return [] }
  const found = new Set()
  for (const pattern of [SPECIFIER, LITERAL]) for (const match of text.matchAll(pattern)) {
    const target = resolve(file, match[1])
    if (target && target !== file) found.add(target)
  }
  return [...found]
}

export function importGraph(files, read) {
  const resolve = resolver(files)
  const users = new Map()
  for (const file of files) for (const target of targets(file, read, resolve)) (users.get(target) ?? users.set(target, new Set()).get(target)).add(file)
  return users
}

export function importClosure(roots, files, read) {
  const resolve = resolver(files)
  const reached = new Set(roots), queue = [...roots]
  while (queue.length) for (const target of targets(queue.pop(), read, resolve)) if (!reached.has(target)) { reached.add(target); queue.push(target) }
  return reached
}
