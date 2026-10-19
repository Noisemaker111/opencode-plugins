import { discardSession } from '../routing/bind-and-ask'
import type { PassedOver, Withheld } from '../../models/dispatch-planner'

export const AUTH_UNAVAILABLE = 'auth_unavailable'
export const CLAUDE_AUTH_CACHE_MS = 60_000
export type ClaudeAuthStatus = 'ok' | typeof AUTH_UNAVAILABLE
type RouteIdentity = { providerID: string; modelID: string; reasoning?: string }
export type ClaudeAuthCheck = (route: RouteIdentity) => Promise<ClaudeAuthStatus>
type CheckHost = { create: (input: any) => Promise<any>; generate?: (input: any) => Promise<any>; delete?: (input: any) => Promise<any> }
type Selected = { route: RouteIdentity & { id: string }; ledger: { withdraw(runID: string): void }; record?: { passedOver: PassedOver[] }; decision?: { summary: string } | null }

const unwrap = (value: any) => value?.data ?? value
export const isClaudeRoute = (route: RouteIdentity) => route.providerID === 'cliproxyapi' && route.modelID.startsWith('claude-')
export const isGptRoute = (route: RouteIdentity) => route.modelID.startsWith('gpt-')
export const authUnavailable = (value: unknown) => /auth_unavailable/i.test(value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value ?? ''))

let known: { at: number; status: ClaudeAuthStatus } | undefined
export const resetClaudeAuth = () => { known = undefined }
export const noteClaudeAuthUnavailable = (at = Date.now()) => { known = { at, status: AUTH_UNAVAILABLE } }

export async function claudeAuthStatus(check: ClaudeAuthCheck, route: RouteIdentity, now = Date.now()): Promise<ClaudeAuthStatus> {
  if (known && now - known.at < CLAUDE_AUTH_CACHE_MS) return known.status
  const status = await check(route)
  known = { at: now, status }
  return status
}

export function hostClaudeAuth(host: CheckHost, directory: string): ClaudeAuthCheck {
  return async route => {
    if (typeof host.generate !== 'function') return 'ok'
    let created: any
    try {
      const variant = route.reasoning && route.reasoning !== 'unknown' ? { variant: route.reasoning } : {}
      created = unwrap(await host.create({ title: 'Claude auth check', agent: 'speed-calibration', model: { providerID: route.providerID, id: route.modelID, ...variant }, location: { directory } }))
      if (!created?.id) return 'ok'
      await host.generate({ sessionID: created.id, prompt: 'Reply with the single digit 1.' })
      return 'ok'
    } catch (error) {
      return authUnavailable(error) ? AUTH_UNAVAILABLE : 'ok'
    } finally {
      if (created?.id) await discardSession(host, created.id)
    }
  }
}

export async function withClaudeFallback<S extends Selected>(input: { runID: string; explicit: boolean; check: ClaudeAuthCheck; first: S; choose: (withheld: Withheld) => Promise<S> }): Promise<S> {
  const { first } = input
  if (input.explicit || !isClaudeRoute(first.route)) return first
  if (await claudeAuthStatus(input.check, first.route) === 'ok') return first
  first.ledger.withdraw(input.runID)
  const second = await input.choose(route => isGptRoute(route) ? undefined : 'Claude ' + AUTH_UNAVAILABLE + ': only GPT routes are considered')
  const said = 'Claude ' + AUTH_UNAVAILABLE + ' on ' + first.route.id + ', so the run fell back to ' + second.route.id
  const left: PassedOver = { routeID: first.route.id, model: first.route.providerID + '/' + first.route.modelID, ...(first.route.reasoning ? { effort: first.route.reasoning } : {}), why: AUTH_UNAVAILABLE + '; fell back to ' + second.route.id }
  return {
    ...second,
    ...(second.decision ? { decision: { ...second.decision, summary: said + '; ' + second.decision.summary } } : {}),
    ...(second.record ? { record: { ...second.record, passedOver: [left, ...second.record.passedOver] } } : {}),
  }
}
