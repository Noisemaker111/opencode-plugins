import { resolveDispatchSelector } from '../models/dispatch-planner'
import { readDispatchPolicy } from '../models/dispatch-policy'
import { getAccountUsage } from '../usage-service/on-computer'
import { liveDispatchRoutes } from '../models/live-routes'
import { describeSelection } from '../models/access-policy'
import { ledgerLockStatus } from '../orchestration/orchestration-ledger'
import { DEPTHS } from '../models/work-profile'
import { exclusionOf, type RoutingSettings } from '../models/routing-settings'
import { routingSettings } from './routing/routing-settings'
export function excludedCandidateRouteIDs(routes: { id:string; providerID:string; modelID:string; reasoning:string }[], settings: RoutingSettings) {
  return new Set(routes.filter(route => DEPTHS.every(depth => !!exclusionOf(settings, depth, route))).map(route => route.id))
}
export function exactRouteRow(route: {id:string;accountID:string;providerID:string;modelID:string;serviceTier:string;reasoning:string;harness:string;admission?:string}, selector:string) {
  return {selector,model:`${route.providerID}/${route.modelID}`,routeID:route.id,accountID:route.accountID,serviceTier:route.serviceTier,reasoning:route.reasoning,harness:route.harness,admission:route.admission??null}
}
export async function routeFeedback(model?: string, hostCapable = true, sessionID?: string, view?: 'candidates') {
  if (!hostCapable) return { code: 'HOST_CAPABILITY_MISSING', action: 'Open a fresh session with a verified plugin generation' }
  let policy: any
  try { policy = readDispatchPolicy() } catch { return { code: 'AUTHORIZED_ROUTE_UNAVAILABLE', action: 'Inspect the configured route policy; quota availability does not add a route' } }
  const snapshot = await getAccountUsage()
  let discoveryError:string|undefined
  try { const live = await liveDispatchRoutes(policy, snapshot); policy = { ...policy, routes: [...live.curated, ...live.derived], request: { ...policy.request, allowedRouteIDs: [...new Set([...(policy.request.allowedRouteIDs ?? []), ...live.derived.map((r: any) => r.id)])] } } } catch(error) { discoveryError=error instanceof Error?error.message:String(error) }
  let settings: RoutingSettings
  try { settings = routingSettings() } catch(error) { return { code:'ROUTING_SETTINGS_INVALID', action:error instanceof Error ? error.message : String(error) } }
  const excludedRouteIDs=excludedCandidateRouteIDs(policy.routes,settings)
  const scope={scope:'dispatch-candidates',catalogComplete:false,discoveryError,session:describeSelection(sessionID),automatic:{preference:policy.request.preference,task:policy.request.task,byTask:policy.request.byTask,byDepth:policy.request.byDepth},note:'These are worker dispatch candidates, not all host models or supported efforts. Chat model selection is separate. Omit workflow.model for automatic selection; an exact worker selector includes reasoning.'}
  const candidates=resolveDispatchSelector(policy,'',snapshot,excludedRouteIDs).candidates
  if(view==='candidates')return {...scope,code:'ROUTE_CANDIDATES',candidates,action:'Choose one exact selector to inspect its route status, or omit the model override for automatic routing'}
  if(!model)return {...scope,code:'AUTOMATIC_ROUTING',action:'Start the saved Quest without a model override to use its configured automatic routing; use the candidates view to inspect configured choices'}
  const selection=resolveDispatchSelector(policy,model,snapshot,excludedRouteIDs)
  if(!selection.route)return {...scope,...selection,action:'For an explicit worker choice include its reasoning; for automatic selection omit workflow.model. No replacement selected'}
  const route = selection.route, account = snapshot.accounts.find(a => a.id === route.accountID)
  const connectedWithoutQuota = account?.state === 'unsupported' && account.connections.length > 0
  const code = connectedWithoutQuota ? 'ROUTE_CONFIGURED' : !account || account.freshness.stale ? 'STALE_QUOTA' : account.state !== 'available' ? 'ACCOUNT_HOLD' : 'ROUTE_CONFIGURED'
  return { ...scope,code, route:exactRouteRow(route,model), account: account ? { id: account.id, state: account.state, freshness: account.freshness, windows: account.windows.slice(0, 8).map(w => ({ id: w.id, state: w.state, remainingPercent: w.remainingPercent, resetAt: w.resetAt })) } : null, orchestrationLock: ledgerLockStatus(), action: 'Discovery is not admission. Quest run rechecks ownership, budget, account and reservations; unknown launches require inspection' }
}
