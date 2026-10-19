import { readFileSync, realpathSync, mkdirSync, copyFileSync } from "node:fs"
import {writeFileDurable} from "../quest/core/durable-file.mjs"
import { enforceDirectoryBudget, retentionFrom, TELEMETRY_BUDGET } from "../scripts/telemetry-budget.mjs"
import { join, dirname, resolve, basename } from "node:path"

export const releaseDispatchPolicyFile = () => join(import.meta.dir, "dispatch-policy.json")
export const userDispatchPolicyFile = () => process.env.OPENCODE_DISPATCH_POLICY?.trim() || undefined
export const configuredDispatchPolicyFile = () => userDispatchPolicyFile() ?? releaseDispatchPolicyFile()

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const isObject = (value: unknown): value is Record<string, Json> => !!value && typeof value === "object" && !Array.isArray(value)

type Identified = Record<string, Json> & { id: string }
const identified = (value: Json): value is Identified[] => Array.isArray(value) && value.every(item => isObject(item) && typeof item.id === "string")
const byIdentity = (base: Json, user: Json): [Identified[], Identified[]] | undefined => identified(base) && base.length > 0 && identified(user) ? [base, user] : undefined
export function overlayPolicy(base: Json, user: Json): Json {
  const lists = byIdentity(base, user)
  if (lists) {
    const [release, saved] = lists
    return [...release.map(entry => { const own = saved.find(item => item.id === entry.id); return own ? overlayPolicy(entry, own) : entry }), ...saved.filter(item => !release.some(entry => entry.id === item.id))]
  }
  if (!isObject(base) || !isObject(user)) return user
  const merged: Record<string, Json> = { ...base }
  for (const [key, value] of Object.entries(user)) merged[key] = key in base ? overlayPolicy(base[key], value) : value
  return merged
}
export function policyOverrides(base: Json, user: Json): Json | undefined {
  const lists = byIdentity(base, user)
  if (lists) {
    const [release, saved] = lists
    const kept = saved.filter(item => { const entry = release.find(each => each.id === item.id); return !entry || policyOverrides(entry, item) !== undefined })
    return kept.length ? kept : undefined
  }
  if (isObject(base) && isObject(user)) {
    const kept = Object.entries(user).flatMap(([key, value]): [string, Json][] => {
      if (!(key in base)) return [[key, value]]
      const differs = policyOverrides(base[key], value)
      return differs === undefined ? [] : [[key, differs]]
    })
    return kept.length ? Object.fromEntries(kept) : undefined
  }
  return JSON.stringify(base) === JSON.stringify(user) ? undefined : user
}

const same = (a: string, b: string) => {
  const real = (path: string) => { try { return realpathSync.native(path) } catch { return resolve(path) } }
  const [x, y] = [real(a), real(b)]
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y
}
const parse = (file: string) => JSON.parse(readFileSync(file, "utf8"))
export class UnregisteredPolicyRouteError extends Error {
  constructor(readonly routeIDs: string[], readonly source: string) {
    super("The dispatch policy (" + source + ") names routes it does not register: " + routeIDs.join(", ") + ". Register each route under routes or remove it from the request.")
    this.name = "UnregisteredPolicyRouteError"
  }
}
export function unregisteredPolicyRoutes(policy: { request?: { allowedRouteIDs?: string[]; primaryRouteID?: string; fallback?: { routeIDs?: string[] } }; routes?: { id: string }[] }) {
  if (!Array.isArray(policy?.routes)) return []
  const registered = new Set(policy.routes.map(route => route.id)), request = policy.request ?? {}
  const named = [...(request.allowedRouteIDs ?? []), ...(request.primaryRouteID === undefined ? [] : [request.primaryRouteID]), ...(request.fallback?.routeIDs ?? [])]
  return [...new Set(named.filter(id => !registered.has(id)))]
}
export function assertPolicyRoutesRegistered(policy: Parameters<typeof unregisteredPolicyRoutes>[0], source: string) {
  const missing = unregisteredPolicyRoutes(policy)
  if (missing.length) throw new UnregisteredPolicyRouteError(missing, source)
  return policy
}
export function readDispatchPolicy(file = configuredDispatchPolicyFile()): any {
  const user = userDispatchPolicyFile(), release = releaseDispatchPolicyFile()
  if (!user || !same(file, user) || same(user, release)) return assertPolicyRoutesRegistered(parse(file), primaryRouteSource(file))
  return overlayPolicy(assertPolicyRoutesRegistered(parse(release), primaryRouteSource(release)) as Json, parse(file))
}

export function compactUserPolicy(file = userDispatchPolicyFile(), now = Date.now()) {
  if (!file) throw new Error("OPENCODE_DISPATCH_POLICY names no user policy file")
  const release = parse(releaseDispatchPolicyFile()), saved = parse(file)
  const overrides = (policyOverrides(release, saved) ?? {}) as Record<string, Json>
  const effectiveBefore = JSON.stringify(overlayPolicy(release, saved)), effectiveAfter = JSON.stringify(overlayPolicy(release, overrides))
  if (effectiveBefore !== effectiveAfter) throw new Error("Compacting would change the effective policy; nothing was written")
  const backup = join(dirname(file), "backups", String(now), basename(file))
  mkdirSync(dirname(backup), { recursive: true })
  copyFileSync(file, backup)
  enforceDirectoryBudget(join(dirname(file), "backups"), TELEMETRY_BUDGET.backupsBytes, { cutoff: retentionFrom(now) })
  writeFileDurable(file, JSON.stringify(overrides, null, 2) + "\n")
  return { overrides, backup }
}

export function primaryRouteSource(file: string) {
  const user = userDispatchPolicyFile()
  if (!user || !same(file, user)) return same(file, releaseDispatchPolicyFile()) ? "the release policy" : "the policy " + file
  try { return parse(user)?.request?.primaryRouteID !== undefined ? "the user policy " + user : "the release policy" } catch { return "the user policy " + user }
}

type PoolRoute = { id: string; providerID?: string; modelID?: string; reasoning?: string }
export function automaticPoolProblem(policy: { request?: { allowedRouteIDs?: string[]; judgedPool?: string }; routes?: PoolRoute[] }, excluded: (route: PoolRoute) => string | undefined = () => undefined) {
  const routes = policy.routes ?? [], allowed = policy.request?.allowedRouteIDs ?? []
  const connected = policy.request?.judgedPool === "connected"
  const pool = connected ? routes : routes.filter(route => allowed.includes(route.id))
  if (pool.some(route => !excluded(route))) return undefined
  const named = connected ? "every route the policy defines" : "the allowed routes list (" + (allowed.join(", ") || "empty") + ")"
  return pool.length ? named + " is excluded by routing settings (" + pool.map(route => route.id + ": " + excluded(route)).join("; ") + "), so automatic routing has no route" : named + " names no route the policy defines, so automatic routing has no route"
}

export function writeUserPolicy(file: string, before: any, after: any) {
  if (JSON.stringify(before?.request) !== JSON.stringify(after?.request)) throw new Error("Refusing to write " + file + ": this writer may not change request")
  const effective = userDispatchPolicyFile() && same(file, userDispatchPolicyFile()!) && !same(file, releaseDispatchPolicyFile()) ? overlayPolicy(parse(releaseDispatchPolicyFile()), after) as any : after
  const problem = automaticPoolProblem(effective)
  if (problem) throw new Error("Refusing to write " + file + ": " + problem)
  writeFileDurable(file, JSON.stringify(after, null, 2) + "\n")
}
