export const DEPTHS = ["routine", "standard", "deep", "frontier"] as const
export type Depth = (typeof DEPTHS)[number]
export const LEGACY_SIZE_DEPTH: Record<string, Depth> = { small: "routine", medium: "standard", large: "deep" }
export const DEPTH_LEVELS: Record<Depth, string> = {
  routine: "Routine: mechanical or well-trodden, no judgment calls (a version bump, a rename, a typo, a README line)",
  standard: "Standard: ordinary work with a few parts and some investigation (a UI change, a small feature, a clear bug)",
  deep: "Deep: many parts or careful reasoning across the codebase (a tricky bug, a cross-cutting refactor)",
  frontier: "Frontier: needs a lot of thought, the hardest design or intricate work (a system redesign, a subtle concurrency or correctness problem)",
}
export const STATED_PROFILE = "stated by the dispatching agent"
export const WORK_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export type WorkProfile = { workType?: string; depth?: Depth }

export function depthOf(value: unknown): Depth | undefined {
  if (value === undefined || value === null) return undefined
  const stated = String(value).trim().toLowerCase()
  if ((DEPTHS as readonly string[]).includes(stated)) return stated as Depth
  if (LEGACY_SIZE_DEPTH[stated]) return LEGACY_SIZE_DEPTH[stated]
  throw new Error("Unknown depth '" + value + "'; use one of " + DEPTHS.join(", "))
}
export function workTypeOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const stated = String(value).trim().toLowerCase()
  if (!WORK_TYPE_PATTERN.test(stated)) throw new Error("A work type is a short lowercase id such as writing or debugging, not '" + value + "'")
  return stated
}
export function stepProfile(step: { depth?: unknown; workType?: unknown; size?: unknown } | undefined): WorkProfile {
  if (!step) return {}
  const depth = depthOf(step.depth ?? step.size), workType = workTypeOf(step.workType)
  return { ...(workType ? { workType } : {}), ...(depth ? { depth } : {}) }
}
export const deeper = (a: Depth | undefined, b: Depth | undefined) => a === undefined ? b : b === undefined ? a : DEPTHS.indexOf(b) > DEPTHS.indexOf(a) ? b : a
export function combinedProfile(profiles: WorkProfile[], fallback: WorkProfile = {}): WorkProfile {
  const filled = profiles.map(profile => ({ workType: profile.workType ?? fallback.workType, depth: profile.depth ?? fallback.depth }))
  const depth = filled.reduce<Depth | undefined>((deepest, profile) => deeper(deepest, profile.depth), undefined)
  const leading = filled.find(profile => profile.depth === depth && profile.workType) ?? filled.find(profile => profile.workType)
  return { ...(leading?.workType ? { workType: leading.workType } : {}), ...(depth ? { depth } : {}) }
}
export const sameProfile = (a: WorkProfile, b: WorkProfile) => a.depth === b.depth && a.workType === b.workType
export const joinsChain = (step: Parameters<typeof stepProfile>[0], profile: WorkProfile, first: WorkProfile) => !Object.keys(stepProfile(step)).length || sameProfile(profile, first)

export const WORK_TAG = "work:", DEPTH_TAG = "depth:", LEGACY_SIZE_TAG = "size:"
export const profileTags = (profile: WorkProfile) => [...(profile.workType ? [WORK_TAG + profile.workType] : []), ...(profile.depth ? [DEPTH_TAG + profile.depth] : [])]
export const taggedWorkType = (tags: string[]) => tags.find(tag => tag.startsWith(WORK_TAG))?.slice(WORK_TAG.length)
export function taggedDepth(tags: string[]): Depth | undefined {
  const depth = tags.find(tag => tag.startsWith(DEPTH_TAG))?.slice(DEPTH_TAG.length)
  if (depth && (DEPTHS as readonly string[]).includes(depth)) return depth as Depth
  return LEGACY_SIZE_DEPTH[tags.find(tag => tag.startsWith(LEGACY_SIZE_TAG))?.slice(LEGACY_SIZE_TAG.length) ?? ""]
}
export function savedProfile(step: { depth?: unknown; workType?: unknown; size?: unknown } | undefined): WorkProfile {
  try { return stepProfile(step) } catch { return {} }
}
