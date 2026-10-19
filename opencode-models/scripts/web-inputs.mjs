import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { importClosure } from "./import-graph.mjs"

const WEB_DIRECTORY = "apps/quest-web/"
const WEB_SHARED = /^(package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|scripts\/(core-suite|import-graph|web-inputs)\.mjs|apps\/questgiver\/vendor\/opencode)$/

export function webInputs(tree, directory = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")) {
  if (!tree) return ""
  const listed = spawnSync("git", ["-C", directory, "ls-tree", "-r", "--full-tree", tree], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 28 })
  if (listed.status !== 0) return ""
  const blobs = new Map(listed.stdout.split("\n").filter(Boolean).map(row => [row.slice(row.indexOf("\t") + 1), row.slice(0, row.indexOf("\t")).split(" ")[2]]))
  const files = [...blobs.keys()]
  const reached = importClosure(files.filter(file => file.startsWith(WEB_DIRECTORY)), files, file => readFileSync(join(directory, file), "utf8"))
  const inputs = files.filter(file => reached.has(file) || WEB_SHARED.test(file)).sort()
  return createHash("sha256").update(inputs.map(file => file + " " + blobs.get(file)).join("\n")).digest("hex")
}
