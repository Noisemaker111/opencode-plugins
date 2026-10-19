import { canonicalModelID, slugModel } from "./model-catalog"
import { DEPTHS, WORK_TYPE_PATTERN, depthOf, type Depth } from "./work-profile"
import { startsStrong, type Route, type RoutingRequest, type ValueWeights } from "./route-vocabulary"
import { aaPassPrior } from "./artificial-analysis"

export type RoutingSpeed = { mode: "capability" } | { mode: "fastest-within"; points: number } | { mode: "value" }
export type ValueSettings = { weights?: Partial<ValueWeights>; aaIndex?: Partial<Record<Depth, number>>; bars?: Partial<Record<Depth, number>>; tie?: number }
export type Rating = "strong" | "good" | "avoid"
export const RATINGS: Rating[] = ["strong", "good", "avoid"]
export const BENCHMARK_CATEGORIES: Record<string, string> = {
  coding: "DeepSWE v1.1 pass@1 where a route has it, otherwise the Artificial Analysis coding index",
  intelligence: "Artificial Analysis intelligence index",
  agentic: "Artificial Analysis agentic index",
  finance: "Artificial Analysis finance and accounting index",
  strategy: "Artificial Analysis strategy and ops index",
  legal: "Artificial Analysis legal index",
  healthcare: "Artificial Analysis healthcare and medical index",
  engineering: "Artificial Analysis engineering index",
  economics: "Artificial Analysis economics index",
}
export const benchmarkOfWorkType = (settings: { workTypes: { id: string; benchmark: string }[] } | undefined, workType: string | undefined) => settings?.workTypes.find(type => type.id === workType)?.benchmark
export const WORK_KINDS = ["judgement", "mechanical", "review", "landing"] as const
export type WorkKind = (typeof WORK_KINDS)[number]
export type WorkType = { id: string; label: string; description: string; benchmark: string; kind?: WorkKind }
export type DepthSettings = { exclude: string[]; speed: RoutingSpeed; exploration: number; bench?: number }
export type RatingRule = { model: string; workType: string; rating: Rating }
export type RoutingSettings = { version: 2; workTypes: WorkType[]; depths: Record<Depth, DepthSettings>; ratings: RatingRule[]; judgementOnly?: string[]; frontierSure?: number; allowanceWeight?: number; preferFree?: boolean; value?: ValueSettings }

export const VALUE_DEFAULTS = { weights: { cost: 0.3, time: 0.4, score: 0.3 } as ValueWeights, aaIndex: { standard: 30 } as Partial<Record<Depth, number>>, bars: { deep: 0.7, frontier: 0.72 } as Partial<Record<Depth, number>>, tie: 0.02 }
export const valueSettingsOf = (settings: Pick<RoutingSettings, "value">) => {
  const bar = (depth: Depth) => {
    const share = settings.value?.bars?.[depth]; if (share !== undefined) return share
    const index = settings.value?.aaIndex?.[depth] ?? VALUE_DEFAULTS.aaIndex[depth]; if (index !== undefined) return aaPassPrior(index)
    return VALUE_DEFAULTS.bars[depth] ?? 0
  }
  return { weights: { ...VALUE_DEFAULTS.weights, ...settings.value?.weights }, aaIndex: { ...VALUE_DEFAULTS.aaIndex, ...settings.value?.aaIndex } as Partial<Record<Depth, number>>, bars: Object.fromEntries(DEPTHS.map(depth => [depth, bar(depth)])) as Record<Depth, number>, tie: settings.value?.tie ?? VALUE_DEFAULTS.tie }
}
const valueRuleOf = (settings: Pick<RoutingSettings, "value">, depth: Depth) => { const value = valueSettingsOf(settings); return { weights: value.weights, bar: value.bars[depth], tie: value.tie } }

export const LANDING_WORK_TYPE = "landing"
export const SEED_WORK_TYPES: WorkType[] = [
  { id: "mechanical", label: "Mechanical edit", description: "version bumps, renames, config values, dependency bumps, one-line fixes, comment stripping", benchmark: "coding", kind: "mechanical" },
  { id: "writing", label: "Writing and docs", description: "README and docs, changelogs, prose, messages and copy", benchmark: "coding", kind: "mechanical" },
  { id: "ui", label: "UI", description: "interface, layout, styling and components", benchmark: "coding", kind: "judgement" },
  { id: "debugging", label: "Debugging", description: "finding the cause of wrong behaviour or a failing test and fixing it", benchmark: "coding", kind: "judgement" },
  { id: "feature", label: "Feature", description: "new behaviour across a few files", benchmark: "coding", kind: "judgement" },
  { id: "refactor", label: "Refactor", description: "restructuring code without changing what it does", benchmark: "coding", kind: "judgement" },
  { id: "architecture", label: "Architecture and design", description: "system design, redesigns and cross-cutting decisions", benchmark: "coding", kind: "judgement" },
  { id: "research", label: "Research", description: "investigation and read-only questions about code or the world", benchmark: "coding", kind: "judgement" },
  { id: "review", label: "Review", description: "reviewing a change for correctness and scope", benchmark: "coding", kind: "review" },
  { id: LANDING_WORK_TYPE, label: "Landing", description: "rebasing a branch onto v2, resolving its conflicts, running the checks and landing it", benchmark: "coding", kind: "landing" },
]
export function workKindOf(settings: Pick<RoutingSettings, "workTypes">, workType: string | undefined): WorkKind {
  if (!workType) return "judgement"
  const saved = settings.workTypes.find(type => type.id === workType)
  return saved?.kind ?? SEED_WORK_TYPES.find(type => type.id === workType)?.kind ?? "judgement"
}
export function judgementOnlyOf(settings: Pick<RoutingSettings, "judgementOnly" | "workTypes">, route: Pick<Route, "providerID" | "modelID" | "reasoning">, workType: string | undefined) {
  const kind = workKindOf(settings, workType)
  if (kind === "judgement") return undefined
  const pattern = (settings.judgementOnly ?? []).find(each => patternMatches(each, route))
  return pattern ? { pattern, kind } : undefined
}
const unsetDepth = (): DepthSettings => ({ exclude: [], speed: { mode: "capability" }, exploration: 0 })
export const unsetRoutingSettings = (): RoutingSettings => ({ version: 2, workTypes: structuredClone(SEED_WORK_TYPES), depths: Object.fromEntries(DEPTHS.map(depth => [depth, unsetDepth()])) as Record<Depth, DepthSettings>, ratings: [] })
export const ASSUMED_DEPTH: Depth = "standard"

const PATTERN = /^(\*|[^/#\s*]+)\/([^/#\s*]+(?:\/[^/#\s*]+)*)(?:#([^#\s*]+))?$/
export function parseModelPattern(pattern: string) {
  const match = PATTERN.exec(typeof pattern === "string" ? pattern.trim() : "")
  if (!match) return undefined
  return { providerID: match[1], model: slugModel(canonicalModelID(match[2])), effort: match[3]?.toLowerCase() }
}
export function patternMatches(pattern: string, route: Pick<Route, "providerID" | "modelID" | "reasoning">) {
  const parsed = parseModelPattern(pattern)
  return !!parsed && (parsed.providerID === "*" || parsed.providerID.toLowerCase() === route.providerID.toLowerCase()) &&
    parsed.model === slugModel(canonicalModelID(route.modelID)) && (parsed.effort === undefined || parsed.effort === String(route.reasoning ?? "").toLowerCase())
}

function savedBenchKey(value: unknown): unknown {
  const row = value as { version?: number; depths?: Record<string, Record<string, unknown>> }
  if (row?.version !== 2 || !row.depths || typeof row.depths !== "object" || Array.isArray(row.depths) || !Object.values(row.depths).some(setting => setting && typeof setting === "object" && "replay" in setting)) return value
  return { ...row, depths: Object.fromEntries(Object.entries(row.depths).map(([depth, setting]) => {
    if (!setting || typeof setting !== "object" || !("replay" in setting)) return [depth, setting]
    const { replay, ...rest } = setting
    return [depth, "bench" in rest ? rest : { ...rest, bench: replay }]
  })) }
}
function withoutRaceShare(value: unknown): unknown {
  const row = value as { version?: number; depths?: Record<string, unknown> }
  if (row?.version !== 2 || !row.depths || typeof row.depths !== "object" || Array.isArray(row.depths)) return value
  return { ...row, depths: Object.fromEntries(Object.entries(row.depths).map(([depth, setting]) => {
    if (!setting || typeof setting !== "object" || !("race" in setting)) return [depth, setting]
    const { race: _retired, ...rest } = setting
    return [depth, rest]
  })) }
}
function withoutRetiredRoutingFields(value: unknown): unknown {
  const row = value as { version?: number; codexCloud?: unknown;calibrate?:unknown }
  if (row?.version !== 2 || !("codexCloud" in row)&&!("calibrate" in row)) return value
  const { codexCloud: _retired,calibrate:_probe, ...rest } = row
  return rest
}
function withLandingWorkType(value: unknown): unknown {
  const row = value as { version?: number; workTypes?: unknown }
  if (row?.version !== 2 || !Array.isArray(row.workTypes) || row.workTypes.some(type => (type as WorkType)?.id === LANDING_WORK_TYPE)) return value
  return { ...row, workTypes: [...row.workTypes, structuredClone(SEED_WORK_TYPES.find(type => type.id === LANDING_WORK_TYPE)!)] }
}
export function migrateRoutingSettings(value: unknown): unknown {
  const row = withLandingWorkType(savedBenchKey(withoutRaceShare(withoutRetiredRoutingFields(value)))) as { version?: number; automatic?: { exclude?: string[]; speed?: RoutingSpeed; bySize?: Record<string, { speed: RoutingSpeed }> } }
  if (row?.version !== 1 || !row.automatic || typeof row.automatic !== "object") return row
  const migrated = unsetRoutingSettings(), automatic = row.automatic
  for (const depth of DEPTHS) migrated.depths[depth] = { exclude: [...(automatic.exclude ?? [])], speed: automatic.speed ?? { mode: "capability" }, exploration: 0 }
  for (const [size, override] of Object.entries(automatic.bySize ?? {})) { const depth = depthOf(size); if (depth && override?.speed) migrated.depths[depth].speed = override.speed }
  return migrated
}

function speedProblem(speed: unknown, at: string) {
  const value = speed as RoutingSpeed
  if (!value || typeof value !== "object" || Array.isArray(value)) return at + " must be an object"
  if (value.mode === "capability") return Object.keys(value).length === 1 ? undefined : at + " takes no other field with mode capability"
  if (value.mode === "value") return Object.keys(value).length === 1 ? undefined : at + " takes no other field with mode value"
  if (value.mode !== "fastest-within") return at + ".mode must be capability, fastest-within or value"
  if (Object.keys(value).some(key => key !== "mode" && key !== "points")) return at + " has an unknown field"
  return typeof value.points === "number" && Number.isFinite(value.points) && value.points >= 0 && value.points <= 100 ? undefined : at + ".points must be a number of capability points from 0 to 100"
}
const patternProblem = (pattern: unknown, at: string) => typeof pattern === "string" && parseModelPattern(pattern) ? undefined : at + ": " + JSON.stringify(pattern) + " is not provider/model or provider/model#effort (provider may be *)"
export function routingSettingsProblem(value: unknown): string | undefined {
  const row = value as RoutingSettings
  if (!row || typeof row !== "object" || Array.isArray(row) || row.version !== 2) return "routing settings need version 2"
  if (Object.keys(row).some(key => !["version", "workTypes", "depths", "ratings", "judgementOnly", "frontierSure", "allowanceWeight", "preferFree", "value"].includes(key))) return "routing settings take only version, workTypes, depths, ratings, judgementOnly, frontierSure, allowanceWeight, preferFree and value"
  if (row.preferFree !== undefined && typeof row.preferFree !== "boolean") return "preferFree must be true or false"
  if (row.value !== undefined) {
    const value = row.value
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["weights", "aaIndex", "bars", "tie"].includes(key))) return "value takes weights, aaIndex, bars and tie"
    if (value.aaIndex !== undefined && (!value.aaIndex || typeof value.aaIndex !== "object" || Object.keys(value.aaIndex).some(key => !(DEPTHS as readonly string[]).includes(key)) || Object.values(value.aaIndex).some(i => typeof i !== "number" || !(i >= 0 && i <= 100)))) return "value.aaIndex takes routine, standard, deep and frontier, each an Artificial Analysis intelligence index from 0 to 100"
    if (value.weights !== undefined && (!value.weights || typeof value.weights !== "object" || Object.keys(value.weights).some(key => !["cost", "time", "score"].includes(key)) || Object.values(value.weights).some(w => typeof w !== "number" || !Number.isFinite(w) || w < 0))) return "value.weights take cost, time and score, each a number of 0 or more"
    if (value.bars !== undefined && (!value.bars || typeof value.bars !== "object" || Object.keys(value.bars).some(key => !(DEPTHS as readonly string[]).includes(key)) || Object.values(value.bars).some(b => typeof b !== "number" || !(b >= 0 && b <= 1)))) return "value.bars take routine, standard, deep and frontier, each a quality share from 0 to 1"
    if (value.tie !== undefined && !(typeof value.tie === "number" && value.tie >= 0 && value.tie <= 0.2)) return "value.tie must be a share from 0 to 0.2"
  }
  if (row.judgementOnly !== undefined) {
    if (!Array.isArray(row.judgementOnly)) return "judgementOnly must be a list of provider/model patterns"
    for (const pattern of row.judgementOnly) { const problem = patternProblem(pattern, "judgementOnly"); if (problem) return problem }
    if (new Set(row.judgementOnly.map(pattern => pattern.trim())).size !== row.judgementOnly.length) return "judgementOnly names a pattern twice"
  }
  if (row.allowanceWeight !== undefined && !(typeof row.allowanceWeight === "number" && Number.isFinite(row.allowanceWeight) && row.allowanceWeight >= 0)) return "allowanceWeight must be a number of minutes, 0 or more"
  if (row.frontierSure !== undefined && !(typeof row.frontierSure === "number" && row.frontierSure >= 0 && row.frontierSure <= 1)) return "frontierSure must be a share from 0 to 1"
  if (!Array.isArray(row.workTypes) || !row.workTypes.length) return "workTypes must list at least one work type"
  for (const [index, type] of row.workTypes.entries()) {
    const at = "workTypes[" + index + "]"
    if (!type || typeof type !== "object" || Object.keys(type).some(key => !["id", "label", "description", "benchmark", "kind"].includes(key))) return at + " takes id, label, description, benchmark and kind"
    if (type.kind !== undefined && !(WORK_KINDS as readonly string[]).includes(type.kind)) return at + ".kind must be one of " + WORK_KINDS.join(", ")
    if (typeof type.id !== "string" || !WORK_TYPE_PATTERN.test(type.id)) return at + ".id must be a short lowercase id such as writing"
    if (typeof type.label !== "string" || !type.label.trim()) return at + ".label must name the work type"
    if (typeof type.description !== "string") return at + ".description must be text"
    if (!Object.hasOwn(BENCHMARK_CATEGORIES, type.benchmark)) return at + ".benchmark must be one of " + Object.keys(BENCHMARK_CATEGORIES).join(", ")
  }
  if (new Set(row.workTypes.map(type => type.id)).size !== row.workTypes.length) return "workTypes names an id twice"
  if (!row.depths || typeof row.depths !== "object" || Array.isArray(row.depths)) return "depths must be an object"
  if (Object.keys(row.depths).some(key => !(DEPTHS as readonly string[]).includes(key)) || DEPTHS.some(depth => !row.depths[depth])) return "depths must set exactly " + DEPTHS.join(", ")
  for (const depth of DEPTHS) {
    const setting = row.depths[depth], at = "depths." + depth
    if (typeof setting !== "object" || Object.keys(setting).some(key => !["exclude", "speed", "exploration", "bench"].includes(key))) return at + " takes exclude, speed, exploration and bench"
    if (!Array.isArray(setting.exclude)) return at + ".exclude must be a list of provider/model patterns"
    for (const pattern of setting.exclude) { const problem = patternProblem(pattern, at + ".exclude"); if (problem) return problem }
    if (new Set(setting.exclude.map(pattern => pattern.trim())).size !== setting.exclude.length) return at + ".exclude names a pattern twice"
    const problem = speedProblem(setting.speed, at + ".speed"); if (problem) return problem
    if (typeof setting.exploration !== "number" || !(setting.exploration >= 0 && setting.exploration <= 1)) return at + ".exploration must be a share from 0 to 1"
    if (setting.bench !== undefined && (typeof setting.bench !== "number" || !Number.isSafeInteger(setting.bench) || setting.bench < 0)) return at + ".bench must be a whole number of benches per finished run, 0 or more"
    if (setting.bench && (depth === "deep" || depth === "frontier")) return at + ".bench must be 0: a landing starts no benches"
  }
  if (!Array.isArray(row.ratings)) return "ratings must be a list"
  for (const [index, rule] of row.ratings.entries()) {
    const at = "ratings[" + index + "]"
    if (!rule || typeof rule !== "object" || Object.keys(rule).some(key => !["model", "workType", "rating"].includes(key))) return at + " takes model, workType and rating"
    const problem = patternProblem(rule.model, at + ".model"); if (problem) return problem
    if (rule.workType !== "*" && !row.workTypes.some(type => type.id === rule.workType)) return at + ".workType must be * or one of the work types"
    if (!RATINGS.includes(rule.rating)) return at + ".rating must be one of " + RATINGS.join(", ")
  }
  return undefined
}

export const depthSettings = (settings: RoutingSettings, depth: Depth | undefined) => settings.depths[depth ?? ASSUMED_DEPTH]
export function exclusionOf(settings: RoutingSettings, depth: Depth | undefined, route: Pick<Route, "providerID" | "modelID" | "reasoning">, workType?: string) {
  const byDepth = depthSettings(settings, depth).exclude.find(pattern => patternMatches(pattern, route))
  if (byDepth) return byDepth
  const judgement = judgementOnlyOf(settings, route, workType)
  return judgement ? judgement.pattern + " for " + judgement.kind + " work" : undefined
}
export function ratingOf(settings: RoutingSettings, route: Pick<Route, "providerID" | "modelID" | "reasoning">, workType: string | undefined) {
  const specific = (rule: RatingRule) => (rule.workType === "*" ? 0 : 2) + (parseModelPattern(rule.model)?.effort ? 1 : 0)
  return settings.ratings.filter(rule => (rule.workType === "*" || rule.workType === workType) && patternMatches(rule.model, route)).sort((a, b) => specific(b) - specific(a))[0]
}
export const describeSpeed = (speed: RoutingSpeed, depth: Depth = ASSUMED_DEPTH) => speed.mode === "value" ? "value rule: the lowest combined cost, time and quality penalty among routes that clear the " + depth + " quality bar" : startsStrong(depth)
  ? speed.mode === "capability" ? "strongest capability first" : "fastest route within " + speed.points + " points of the best capability that is its own published score or measured over enough runs"
  : speed.mode === "capability" ? "cheapest expected verified finish first, counting the steps sent back to the strongest admitted route" : "fastest expected verified finish among routes within " + speed.points + " points of the best capability that is its own published score or measured over enough runs"

export function automaticRouting(settings: RoutingSettings, routes: Route[], classification: { depth?: Depth; workType?: string }): NonNullable<RoutingRequest["automatic"]> {
  const depth = classification.depth ?? ASSUMED_DEPTH, setting = settings.depths[depth]
  const exclude: Record<string, string> = {}, ratings: NonNullable<NonNullable<RoutingRequest["automatic"]>["ratings"]> = {}
  for (const route of routes) {
    const pattern = exclusionOf(settings, depth, route)
    if (pattern) { exclude[route.id] = pattern + " at depth " + depth; continue }
    const judgement = judgementOnlyOf(settings, route, classification.workType)
    if (judgement) { exclude[route.id] = judgement.pattern + " is kept for judgement work, and " + classification.workType + " is " + judgement.kind + " work"; continue }
    const rule = ratingOf(settings, route, classification.workType)
    if (rule?.rating === "avoid") exclude[route.id] = rule.model + " rated avoid for " + (rule.workType === "*" ? "all work" : rule.workType)
    else if (rule) ratings[route.id] = { rating: rule.rating, basis: "you rated " + rule.model + " " + rule.rating + " for " + (rule.workType === "*" ? "all work" : rule.workType) }
  }
  return { exclude, ...(Object.keys(ratings).length ? { ratings } : {}), ...(setting.speed.mode === "fastest-within" ? { fastestWithin: setting.speed.points / 100 } : {}), ...(settings.allowanceWeight ? { allowanceWeight: settings.allowanceWeight } : {}), ...(setting.speed.mode === "value" ? { value: valueRuleOf(settings, depth) } : {}), ...(settings.preferFree !== undefined ? { preferFree: settings.preferFree } : {}) }
}

export type ServedRoute = Pick<Route, "id" | "providerID" | "modelID" | "reasoning">
export const servedOf = (routes: Pick<Route, "id" | "providerID" | "modelID" | "reasoning" | "verified">[]): ServedRoute[] => routes.filter(route => route.verified).map(({ id, providerID, modelID, reasoning }) => ({ id, providerID, modelID, reasoning }))
export const servedRouteName = (route: Pick<Route, "providerID" | "modelID" | "reasoning">) => route.providerID + "/" + route.modelID + (route.reasoning ? "#" + route.reasoning : "")
export type SettingsPattern = { at: string; pattern: string }
export function settingsPatterns(settings: Pick<RoutingSettings, "depths" | "ratings"> & Partial<Pick<RoutingSettings, "judgementOnly">>): SettingsPattern[] {
  return [
    ...DEPTHS.flatMap(depth => (settings.depths[depth]?.exclude ?? []).map(pattern => ({ at: "depths." + depth + ".exclude", pattern: pattern.trim() }))),
    ...settings.ratings.map((rule, index) => ({ at: "ratings[" + index + "].model", pattern: rule.model.trim() })),
    ...(settings.judgementOnly ?? []).map(pattern => ({ at: "judgementOnly", pattern: pattern.trim() })),
  ]
}
export const servedMatches = (pattern: string, served: ServedRoute[]) => served.filter(route => patternMatches(pattern, route)).map(servedRouteName)
export type PatternMatch = SettingsPattern & { matches: string[] }
export const patternMatchReport = (settings: Pick<RoutingSettings, "depths" | "ratings">, served: ServedRoute[]): PatternMatch[] =>
  settingsPatterns(settings).map(entry => ({ ...entry, matches: servedMatches(entry.pattern, served) }))

function editDistance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]
}
export function closestServed(pattern: string, served: ServedRoute[]): string[] {
  const parsed = parseModelPattern(pattern)
  if (!parsed || !served.length) return []
  const scored = [...new Set(served.map(servedRouteName))].map(name => {
    const route = served.find(each => servedRouteName(each) === name)!
    const model = editDistance(parsed.model, slugModel(canonicalModelID(route.modelID)))
    const provider = parsed.providerID === "*" ? 0 : editDistance(parsed.providerID.toLowerCase(), route.providerID.toLowerCase())
    return { name, distance: model * 2 + provider }
  })
  const best = Math.min(...scored.map(row => row.distance))
  return scored.filter(row => row.distance === best).map(row => row.name).sort()
}
export type ServedCheck = { served: ServedRoute[]; allowUnserved?: string[]; saved?: Pick<RoutingSettings, "depths" | "ratings"> }
export function unservedPatternProblem(settings: RoutingSettings, check: ServedCheck): string | undefined {
  const allowed = new Set((check.allowUnserved ?? []).map(pattern => pattern.trim()))
  const kept = new Set(check.saved ? settingsPatterns(check.saved).map(entry => entry.at.replace(/\[\d+\]/, "[]") + " " + entry.pattern) : [])
  const problems = settingsPatterns(settings).filter(entry => !allowed.has(entry.pattern) && !kept.has(entry.at.replace(/\[\d+\]/, "[]") + " " + entry.pattern) && !servedMatches(entry.pattern, check.served).length)
  if (!problems.length) return undefined
  return problems.map(entry => {
    const closest = closestServed(entry.pattern, check.served)
    return entry.at + ": " + JSON.stringify(entry.pattern) + " matches no route served now" + (closest.length ? "; closest served: " + closest.join(", ") : "; the host serves no route")
  }).join("\n") + "\nSpell each pattern as a served route is spelled (quest routing lists them), or name it in allowUnserved to save it for a route not served today"
}
