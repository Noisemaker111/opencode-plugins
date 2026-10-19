type Plain = Record<string, unknown>
export type ExtensionRemoval = string[]

const plain = (value: unknown): value is Plain => !!value && typeof value === "object" && !Array.isArray(value)

function diff(before: Plain, after: Plain, path: string[], removed: ExtensionRemoval[]): Plain {
  const patch: Plain = {}
  for (const key of Object.keys(before)) if (after[key] === undefined) removed.push([...path, key])
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue
    const old = before[key]
    if (plain(old) && plain(value)) {
      const nested = diff(old, value, [...path, key], removed)
      if (Object.keys(nested).length) patch[key] = nested
    } else if (JSON.stringify(old) !== JSON.stringify(value)) patch[key] = value
  }
  return patch
}

export function extensionPatch(before: Plain, after: Plain): { patch: Plain; removed: ExtensionRemoval[] } {
  const removed: ExtensionRemoval[] = []
  return { patch: diff(before, after, [], removed), removed }
}

function merge(target: Plain, patch: Plain) {
  for (const [key, value] of Object.entries(patch)) {
    if (plain(value) && plain(target[key])) merge(target[key], value)
    else target[key] = structuredClone(value)
  }
}

export function applyExtensionPatch(target: Plain, patch: Plain, removed: ExtensionRemoval[] = []): Plain {
  merge(target, patch)
  for (const path of removed) {
    const parent = path.slice(0, -1).reduce<unknown>((node, key) => plain(node) ? node[key] : undefined, target)
    if (plain(parent)) delete parent[path.at(-1)!]
  }
  return target
}

export const changedExtensions = (payload: Plain): Plain => (payload.extensions ?? payload.extensionsPatch ?? {}) as Plain
