import { dispatchPlanInput } from '../../models/dispatch-planner'
import { readAccountUsage } from '../../usage-service/on-computer'
import { servedOf, servedRouteName, type ServedRoute } from '../../models/routing-settings'

export async function servedRoutes(policyFile: string): Promise<ServedRoute[]> {
  const plan = await dispatchPlanInput({ policyFile, task: 'coding' }, async () => readAccountUsage())
  return servedOf(plan.routes)
}
export const servedRouteNames = (routes: ServedRoute[]) => [...new Set(routes.map(servedRouteName))].sort()
