import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { redact } from "../privacy"
import { finishedQuests } from "../core/retention"
import { enforceDirectoryBudget, TELEMETRY_BUDGET } from "../../scripts/telemetry-budget.mjs"

export const QUEST_ASSETS_DIRNAME = "quests-assets" as const

export type QuestArtifact = {
  name: string
  path?: string
  uri?: string
  label?: string
  revision?: number
  at: string
  verified: boolean
  digest?: string
}

export function questAssetsDir(projectRoot: string, questID: string): string {
  return join(projectRoot, ".opencode", QUEST_ASSETS_DIRNAME, questID)
}

export function ensureQuestAssetsDir(projectRoot: string, questID: string): string {
  const dir = questAssetsDir(projectRoot, questID)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const UI_CAPTURE_CONVENTION =
  "UI capture convention: before the first edit record label=before; " +
  "after each revision record label=revision N (N = 1, 2, …); " +
  "when the surface is accepted record label=after. " +
  "Every capture is an evidence-added event with kind=artifacts and a labeled " +
  "path under .opencode/quests-assets/<questID>/, so the board detail can " +
  "render the before -> after chain for the Quest."

function labelRevision(label: string | undefined, revision: unknown): number | undefined {
  if (Number.isSafeInteger(revision)) return revision as number
  const match = /^revision\s+(\d+)$/i.exec(String(label ?? "").trim())
  return match ? Number.parseInt(match[1], 10) : undefined
}

export function normalizeArtifact(value: unknown): QuestArtifact {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  if (!raw) throw new Error("artifact evidence must be an object with at least a name or path")
  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim()
    : typeof raw.path === "string" && raw.path.trim()
      ? basename(raw.path.trim())
      : typeof raw.uri === "string" && raw.uri.trim()
        ? basename(raw.uri.trim())
        : undefined
  if (!name) throw new Error("artifact evidence requires a name (or path/uri to derive one from)")
  const label = typeof raw.label === "string" && raw.label.trim() ? redact(raw.label.trim().slice(0, 60), 60) : undefined
  const revision = labelRevision(label, raw.revision)
  const at = typeof raw.at === "string" && raw.at ? raw.at : new Date().toISOString()
  return {
    name,
    path: typeof raw.path === "string" && raw.path.trim() ? raw.path.trim().replace(/\\/g, "/") : undefined,
    uri: typeof raw.uri === "string" && raw.uri.trim() ? raw.uri.trim() : undefined,
    label,
    revision,
    at,
    verified: raw.verified === true,
    digest: typeof raw.digest === "string" && raw.digest ? raw.digest : undefined,
  }
}

export function artifactChain(artifacts: QuestArtifact[]): QuestArtifact[] {
  const rank = (artifact: QuestArtifact): number => {
    const label = (artifact.label ?? "").toLowerCase().trim()
    if (label === "before") return -1_000_000
    if (label === "after") return 1_000_000
    return artifact.revision ?? 0
  }
  return [...artifacts].sort((a, b) =>
    rank(a) - rank(b) || String(a.at).localeCompare(String(b.at)) || a.name.localeCompare(b.name),
  )
}

export function artifactLine(artifact: QuestArtifact): string {
  const target = artifact.path ?? artifact.uri ?? artifact.name
  return `${artifact.label ?? "artifact"} — ${target}`
}

export type CaptureInput = {
  name?: string
  label: string
  revision?: number
  sourcePath?: string
  bytes?: Uint8Array
  ext?: string
  verified?: boolean
}

export function buildCaptureArtifact(projectRoot: string, questID: string, input: CaptureInput, at = new Date().toISOString()): QuestArtifact {
  const label = input.label.trim()
  if (!label) throw new Error("capture requires a label (before, after, or revision N)")
  const dir = ensureQuestAssetsDir(projectRoot, questID)
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "capture"
  let filename: string
  if (input.sourcePath) {
    filename = `${safeLabel}-${basename(input.sourcePath)}`
    const destination = join(dir, filename)
    if (destination !== input.sourcePath && !existsSync(destination)) copyFileSync(input.sourcePath, destination)
    else if (destination !== input.sourcePath) copyFileSync(input.sourcePath, destination)
  } else if (input.bytes) {
    const ext = input.ext ?? ".png"
    filename = `${safeLabel}-${(input.name ?? "capture").replace(/[^a-z0-9._-]+/gi, "-")}${(input.name ?? "").includes(".") ? "" : ext}`
    writeFileSync(join(dir, filename), input.bytes)
  } else {
    throw new Error("capture requires sourcePath or bytes")
  }
  const finished = finishedQuests(join(projectRoot, ".opencode", ".quest-runtime"))
  enforceDirectoryBudget(join(projectRoot, ".opencode", QUEST_ASSETS_DIRNAME), TELEMETRY_BUDGET.questAssetsBytes, { deletable: entry => finished(entry.name) })
  return normalizeArtifact({
    name: input.name ?? filename,
    path: [".opencode", QUEST_ASSETS_DIRNAME, questID, filename].join("/"),
    label,
    revision: input.revision ?? labelRevision(label, undefined),
    at,
    verified: input.verified === true,
  })
}
