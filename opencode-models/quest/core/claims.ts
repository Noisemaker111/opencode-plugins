import { existsSync, statSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import type { FileClaim, Quest } from "../types"

function globRe(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*")
  return new RegExp(`^${escaped}$`, "i")
}

export function claimTree(claim: FileClaim): string {
  const wt = claim.worktree?.trim()
  if (wt && existsSync(wt) && statSync(wt).isDirectory() && resolve(wt).toLowerCase() !== resolve(claim.repo).toLowerCase()) {
    return resolve(wt).toLowerCase()
  }
  return resolve(claim.repo).toLowerCase()
}

export function claimMatches(claim: FileClaim, file: string): boolean {
  const root = resolve(claim.repo), target = resolve(file), rel = relative(root, target).split(sep).join("/")
  if (rel.startsWith("..")) return false
  return claim.include.some((g) => globRe(g).test(rel)) && !claim.exclude.some((g) => globRe(g).test(rel))
}
export function claimConflicts(quests: Quest[]): Array<{ a: string; b: string; reason: string }> {
  const out: Array<{ a: string; b: string; reason: string }> = []
  for (let i = 0; i < quests.length; i++) for (let j = i + 1; j < quests.length; j++) {
    for (const a of quests[i].claims.filter((x) => x.state === "active")) for (const b of quests[j].claims.filter((x) => x.state === "active")) {
      if (resolve(a.repo).toLowerCase() !== resolve(b.repo).toLowerCase()) continue
      if (claimTree(a) !== claimTree(b)) continue
      const samples = [...a.include, ...b.include].filter((x) => !x.includes("*"))
      if (samples.some((f) => claimMatches(a, resolve(a.repo, f)) && claimMatches(b, resolve(b.repo, f))) || a.include.includes("**/*") || b.include.includes("**/*")) out.push({ a: quests[i].id, b: quests[j].id, reason: `overlapping claims in ${a.repo}` })
    }
  }
  return out
}
