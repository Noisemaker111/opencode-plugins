import { startsStrong, type RoutingRequest, type TaskClass } from "./route-vocabulary"
import { DEPTHS, STATED_PROFILE, depthOf, workTypeOf, type Depth } from "./work-profile"

export const TASK_CLASSES: TaskClass[] = ["coding", "review", "planning", "utility"]
export const DEFAULT_TASK: TaskClass = "coding"

export type TaskDemand = Partial<Pick<RoutingRequest, "qualityTolerance" | "minBenchmarkPassAt1" | "minSuccessRate" | "qualitySelection" | "preference">>
export type TaskDemands = Partial<Record<TaskClass, TaskDemand>>

export type Classification = { task: TaskClass; source: string; stated: boolean; depth?: Depth; workType?: string; profileSource?: string }

export type DispatchFacts = {
  task?: string
  depth?: string
  workType?: string
  readOnly?: boolean
  questKind?: string
  profileSource?: string
}

export function classifyDispatch(facts: DispatchFacts): Classification {
  const depth = depthOf(facts.depth), workType = workTypeOf(facts.workType)
  const sized = (classification: Omit<Classification, "depth" | "workType" | "profileSource">): Classification =>
    (depth || workType ? { ...classification, ...(depth ? { depth } : {}), ...(workType ? { workType } : {}), profileSource: facts.profileSource ?? STATED_PROFILE } : classification)
  if (facts.task !== undefined) {
    const stated = String(facts.task).trim().toLowerCase()
    if (!(TASK_CLASSES as string[]).includes(stated)) throw new Error("Unknown task class '" + facts.task + "'; use one of " + TASK_CLASSES.join(", "))
    return sized({ task: stated as TaskClass, source: "stated by the dispatching agent", stated: true })
  }
  if (facts.readOnly === true) return sized({ task: "review", source: "enforced read-only research access mode", stated: false })
  if (facts.questKind === "investigation") return sized({ task: "planning", source: "Quest kind investigation", stated: false })
  return sized({ task: DEFAULT_TASK, source: "unclassified; the default " + DEFAULT_TASK + " demand applies, never a cheaper class", stated: false })
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

export function validateTaskDemands(demands: TaskDemands | undefined): TaskDemands {
  if (demands === undefined) return {}
  if (!demands || typeof demands !== "object" || Array.isArray(demands)) throw new Error("Invalid per-task demands")
  for (const [task, demand] of Object.entries(demands)) {
    if (!(TASK_CLASSES as string[]).includes(task)) throw new Error("Unknown task class in demands: " + task)
    if (!demand || typeof demand !== "object") throw new Error(task + ": invalid demand")
    for (const [key, value] of Object.entries(demand)) {
      if (key === "qualitySelection" && ["floor", "near-best"].includes(String(value))) continue
      if (key === "preference" && ["economy", "cash", "latency", "capacity"].includes(String(value))) continue
      if (!["qualityTolerance", "minBenchmarkPassAt1", "minSuccessRate"].includes(key)) throw new Error(task + ": unknown demand '" + key + "'")
      if (!finite(value) || value < 0 || value > 1) throw new Error(task + "." + key + " must be a fraction in [0,1]")
    }
  }
  return demands
}

export type DepthBands = Partial<Record<Depth, { efforts?: string[]; maxCostWeight?: number; maxAllowanceShare?: number; maxCapabilityGap?: number }>>
export function migrateSizeBands(bands: Record<string, unknown> | undefined): DepthBands | undefined {
  if (!bands || typeof bands !== "object" || Array.isArray(bands)) return undefined
  return Object.fromEntries(Object.entries(bands).map(([size, band]) => [depthOf(size)!, band])) as DepthBands
}
export function validateDepthBands(bands: DepthBands | undefined): DepthBands {
  if (bands === undefined) return {}
  if (!bands || typeof bands !== "object" || Array.isArray(bands)) throw new Error("Invalid per-depth bands")
  for (const [size, band] of Object.entries(bands)) {
    if (!(DEPTHS as readonly string[]).includes(size)) throw new Error("Unknown depth in bands: " + size)
    if (!band || typeof band !== "object" || Array.isArray(band)) throw new Error(size + ": invalid band")
    for (const [key, value] of Object.entries(band)) {
      if (key === "efforts" && Array.isArray(value) && value.length && value.every(e => typeof e === "string" && e.trim())) continue
      if (key === "maxCostWeight" && finite(value) && value >= 1) continue
      if (key === "maxAllowanceShare" && finite(value) && value > 0 && value <= 1) continue
      if (key === "maxCapabilityGap" && finite(value) && value >= 0 && value <= 1) continue
      throw new Error(size + "." + key + (["efforts", "maxCostWeight", "maxAllowanceShare", "maxCapabilityGap"].includes(key) ? ": efforts is a non-empty list of reasoning levels, maxCostWeight a number of at least 1, maxAllowanceShare a fraction above 0 and at most 1, maxCapabilityGap a fraction from 0 to 1" : ": unknown band setting"))
    }
  }
  return bands
}
export function depthBand(classification: Classification, bands: DepthBands | undefined) {
  const depth = classification.depth
  const band = depth ? validateDepthBands(bands)[depth] : undefined
  return { depth: depth ?? "unstated", ...(band?.efforts ? { efforts: [...band.efforts] } : {}), ...(band?.maxCostWeight !== undefined ? { maxCostWeight: band.maxCostWeight } : {}), ...(band?.maxAllowanceShare !== undefined ? { maxAllowanceShare: band.maxAllowanceShare } : {}), ...(band?.maxCapabilityGap !== undefined ? { maxCapabilityGap: band.maxCapabilityGap } : {}) }
}

export function applyTaskDemand<T extends Omit<RoutingRequest, "now">>(request: T, demands: TaskDemands | undefined, task: TaskClass): T {
  const demand = validateTaskDemands(demands)[task]
  return { ...request, task, ...(demand ?? {}) }
}

export function describeDemand(classification: Classification, request: Pick<RoutingRequest, "qualityTolerance" | "minBenchmarkPassAt1" | "qualitySelection">) {
  const size = classification.depth || classification.workType ? "; " + [classification.workType ? "work " + classification.workType : "", classification.depth ? "depth " + classification.depth : ""].filter(Boolean).join(", ") + " (" + (classification.profileSource ?? STATED_PROFILE) + ")" : ""
  if (request.qualitySelection === "floor" || !startsStrong(classification.depth ?? "unstated")) return "task " + classification.task + " (" + classification.source + ")" + size + "; own quality floor " + ((request.minBenchmarkPassAt1 ?? 0) * 100).toFixed(1) + "% published prior, local outcomes checked separately"
  return "task " + classification.task + " (" + classification.source + ")" + size + "; tolerance " + (request.qualityTolerance * 100).toFixed(1) +
    "pp below the best published score" + (request.minBenchmarkPassAt1 === undefined ? "" : ", floor " + (request.minBenchmarkPassAt1 * 100).toFixed(1) + "%")
}
