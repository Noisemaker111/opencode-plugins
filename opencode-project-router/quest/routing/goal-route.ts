import { resolveDispatchSelector, type DispatchPolicy } from '../../models/dispatch-planner'
import { readDispatchPolicy } from '../../models/dispatch-policy'
import { liveDispatchRoutes } from '../../models/live-routes'
import { getAccountUsage } from '../../usage-service/on-computer'
import type { AccountSnapshot } from '../../usage-service/on-computer'
import type { GoalRoute } from '../runs/continuation'
import { QuestError } from '../api'

export async function goalRoute(selector:string, pin?:GoalRoute) {
  const snapshot=await getAccountUsage()
  const policy:DispatchPolicy=readDispatchPolicy()
  const live=await liveDispatchRoutes(policy,snapshot)
  return resolveGoalRoute({...policy,routes:[...live.curated,...live.derived]},snapshot,selector,pin)
}

export function resolveGoalRoute(policy:DispatchPolicy,snapshot:AccountSnapshot,selector:string,pin?:GoalRoute):GoalRoute {
  let result=resolveDispatchSelector(policy,selector,snapshot)
  if(!result.route&&result.code==='AUTHORIZED_ROUTE_UNAVAILABLE'&&pin)
    result=resolveDispatchSelector(policy,`${pin.providerID}/${pin.modelID}#${pin.reasoning}`,snapshot)
  if(!result.route)throw new QuestError(result.code,'Select an exact authorized route from project_route_status')
  const r=result.route
  const route={routeID:r.id,accountID:r.accountID,providerID:r.providerID,modelID:r.modelID,reasoning:r.reasoning,serviceTier:r.serviceTier}
  if(pin){
    for(const key of ['accountID','providerID','modelID','reasoning','serviceTier'] as const)
      if(route[key]!==pin[key])throw new QuestError('GOAL_ROUTE_CHANGED','Authorized account/service route changed')
    return {...route,routeID:pin.routeID}
  }
  return route
}
