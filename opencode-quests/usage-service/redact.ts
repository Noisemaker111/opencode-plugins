const patterns: [RegExp, string][] = [
  [/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[redacted]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bqg[a-z]?_[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|secret|password|\bkey|\btoken)["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, "$1[redacted]"],
]

export function redact(text: string): string {
  return patterns.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text)
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T
  if (Array.isArray(value)) return value.map(redactDeep) as T
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)])) as T
  return value
}
