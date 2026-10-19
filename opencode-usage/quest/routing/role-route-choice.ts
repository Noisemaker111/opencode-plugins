import {automaticRequest,dispatchPlanInput} from '../../models/dispatch-planner'
import {configuredDispatchPolicyFile} from '../../models/dispatch-policy'
import {liveModelCatalog} from '../../models/live-routes'
import {planRoutes} from '../../models/route-planner'
import {timed} from '../../scripts/plugin-spans'
import {questSettingsFile} from '../config/quest-settings.mjs'
import {assertRoleSelection,isAutomatic,roleSelection,type RoleRoute} from './role-settings'
import {routingSettings,type RoutingSettings} from './routing-settings'

export type GiverRouteChoice={route:RoleRoute;why:string}
type Plan=Awaited<ReturnType<typeof dispatchPlanInput>>
type LoadUsage=Parameters<typeof dispatchPlanInput>[1]

export async function routeModelDeprecated(route:RoleRoute,now=Date.now()):Promise<boolean|undefined>{
 const slash=route.model.indexOf('/')
 if(slash<1)return false
 const catalog=await liveModelCatalog(now)
 if(catalog.source==='unavailable')return undefined
 const model=catalog.models.find(model=>model.providerID===route.model.slice(0,slash)&&model.modelID===route.model.slice(slash+1))
 return model?model.deprecated===true:undefined
}

export function giverRouteFromPlan(plan:Plan,routing:RoutingSettings):GiverRouteChoice{
 const request=automaticRequest(plan,routing).request
 const decision=planRoutes({request,routes:plan.routes,accounts:plan.accounts})
 const picked=decision.selected?plan.routes.find(route=>route.id===decision.selected!.routeID):undefined
 if(!picked)throw Error('Automatic routing found no route for the Quest Giver: '+decision.summary)
 const route:RoleRoute={model:picked.providerID+'/'+picked.modelID,...(picked.reasoning&&picked.reasoning!=='unknown'?{effort:picked.reasoning}:{})}
 assertRoleSelection('giver',route)
 return {route,why:'Automatic routing chose '+route.model+(route.effort?'#'+route.effort:'')+' for the Quest Giver: '+decision.summary}
}

export async function chooseGiverRoute(options:{file?:string;policyFile?:string;now?:number;plan?:Plan;loadUsage?:LoadUsage}={}):Promise<GiverRouteChoice>{
 const file=options.file??questSettingsFile()
 const selection=roleSelection('giver',file)
 if(!isAutomatic(selection))throw Error('The Quest Giver role is not set to automatic routing')
 const routing=routingSettings(file)
 return timed({plugin:'quests',name:'giver',op:'choose route',result:choice=>({route:choice.route.model+(choice.route.effort?'#'+choice.route.effort:''),outcome:'chosen'})},async()=>{
  const plan=options.plan??await dispatchPlanInput({policyFile:options.policyFile??configuredDispatchPolicyFile(),task:'planning',depth:'deep',now:options.now,routing},options.loadUsage)
  return giverRouteFromPlan(plan,routing)
 })
}
