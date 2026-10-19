import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import JSON5 from "json5"
import { writeFileDurable } from "./quest/core/durable-file.mjs"

export const HEALTH_FILE = join(homedir(), ".local", "state", "opencode", "plugin-health.json")
const MAX_ERROR = 700

export type PluginHealth = {
  path: string
  phase: "syntax" | "import" | "init" | "hook" | "schema"
  timestamp: string
  error: string
  action: "quarantined" | "disabled" | "fail-closed" | "reloaded"
}

function redact(value: unknown): string {
  return String(value ?? "error")
    .replace(/(api[_-]?key|password|token|authorization)\s*[:=]\s*[^\s,;}]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9+/]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR)
}

export function readPluginHealth(file = HEALTH_FILE): PluginHealth[] {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

export function recordPluginHealth(entry: Omit<PluginHealth, "timestamp">, file = HEALTH_FILE) {
  try {
    const rows = readPluginHealth(file).filter((x) => x.path !== entry.path)
    rows.push({ ...entry, error: redact(entry.error), timestamp: new Date().toISOString() })
    writeFileDurable(file, JSON.stringify(rows, null, 2) + "\n")
  } catch (error) { console.error(`[plugin-health] could not record ${entry.path} in ${file}:`, error) }
}

export function clearPluginHealth(path: string, file = HEALTH_FILE) {
  try {
    const rows = readPluginHealth(file).filter((x) => x.path !== path)
    writeFileDurable(file, JSON.stringify(rows, null, 2) + "\n")
  } catch (error) { console.error(`[plugin-health] could not clear ${path} in ${file}:`, error) }
}

function jsonc(text: string): any {
  return JSON5.parse(text)
}

export const SERVER_ENTRYPOINTS = ["server.ts", "server.tsx", "server.js", "server.mjs", "index.ts", "index.tsx", "index.js", "index.mjs"]
function firstFile(dir: string, names: string[]): string | undefined {
  for (const name of names) { const path = join(dir, name); if (existsSync(path) && statSync(path).isFile()) return path }
  return undefined
}
export function serverEntrypoint(dir: string): string | undefined {
  const explicit = firstFile(dir, SERVER_ENTRYPOINTS)
  if (explicit) return explicit
  try { const main = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.main; if (typeof main === "string") return firstFile(dir, [main]) } catch {}
  return undefined
}

export function configuredPluginPaths(root: string): string[] {
  const out: string[] = []
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return
    let path: string | undefined
    if (value.startsWith("file://")) {
      try { path = new URL(value).pathname.replace(/^\/(\w):/, "$1:").replaceAll("/", "\\") } catch {}
    }
    path ??= resolve(root, value.replace(/^\.\//, ""))
    if (existsSync(path) && statSync(path).isDirectory()) path = serverEntrypoint(path) ?? path
    out.push(path)
  }
  const config = "opencode.jsonc", path = join(root, config)
  if (existsSync(path)) {
    const parsed = jsonc(readFileSync(path, "utf8"))
    if (!Array.isArray(parsed.plugin)) throw new Error(`${config}: plugin must be an array`)
    for (const plugin of parsed.plugin) add(plugin)
  }
  const live = join(root, "plugins")
  const walk = (dir: string) => { if (!existsSync(dir)) return; for (const name of readdirSync(dir)) { const path=join(dir,name); if(statSync(path).isDirectory())walk(path); else if(/\.(?:ts|tsx|js|mjs)$/.test(name))out.push(resolve(path)) } }
  walk(live)
  return [...new Set(out)]
}

export async function validateConfiguredPlugins(root: string, file = HEALTH_FILE, extra: string[] = []) {
  const failures: PluginHealth[] = []
  let paths: string[]
  try { paths = [...new Set([...configuredPluginPaths(root), ...extra.map((p) => resolve(root, p))])] }
  catch (error) {
    const e = { path: "opencode.jsonc", phase: "schema" as const, error: redact(error), action: "quarantined" as const }
    recordPluginHealth(e, file); return [{ ...e, timestamp: new Date().toISOString() }]
  }
  for (const path of paths) {
    const rel = path.startsWith(root) ? path.slice(root.length + 1).replaceAll("\\", "/") : path
    if (!existsSync(path)) {
      const e = { path: rel, phase: "syntax" as const, error: "file does not exist", action: "quarantined" as const }
      recordPluginHealth(e, file); failures.push({ ...e, timestamp: new Date().toISOString() }); continue
    }
    if (statSync(path).isDirectory()) {
      const e = { path: rel, phase: "schema" as const, error: "plugin directory has no server.ts or index.ts entrypoint; a directory without one is skipped silently", action: "quarantined" as const }
      recordPluginHealth(e, file); failures.push({ ...e, timestamp: new Date().toISOString() }); continue
    }
    const source = readFileSync(path, "utf8")
    try { new Bun.Transpiler({ loader: path.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(source) }
    catch (error) { const e={path:rel,phase:"syntax" as const,error:redact(error),action:"quarantined" as const};recordPluginHealth(e,file);failures.push({...e,timestamp:new Date().toISOString()});continue }
    try {
      const mod = await import(path + `?preflight=${Date.now()}`)
      if (!mod?.default) throw new Error("missing default plugin export")
      clearPluginHealth(rel, file)
    } catch (error) {
      const e = { path: rel, phase: "import" as const, error: redact(error), action: "quarantined" as const }
      recordPluginHealth(e, file); failures.push({ ...e, timestamp: new Date().toISOString() })
    }
  }
  return failures
}

if (import.meta.main) {
  const root = process.env.OPENCODE_CONFIG_ROOT ?? join(homedir(), ".config", "opencode")
  const failures = await validateConfiguredPlugins(root)
  if (failures.length) { console.error(JSON.stringify({ ok: false, failures }, null, 2)); process.exit(1) }
  console.log(JSON.stringify({ ok: true, plugins: configuredPluginPaths(root) }, null, 2))
}
