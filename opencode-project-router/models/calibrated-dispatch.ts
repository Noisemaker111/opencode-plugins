import type {Route} from "./route-planner"
import type {Tokens,RequestRecord} from "../usage/telemetry-api"
import {predictAllowance,canonicalRouteKey,routeKey,type Calibration} from "../usage/telemetry-api"
export type DispatchForecasts={maxAgeMilliseconds:number;tokensByRoute:Record<string,Tokens>}
export function calibratedRoutes(routes:Route[],calibrations:Calibration[],regimes:Record<string,string>,policy:DispatchForecasts|undefined,now:number){
 if(!policy)return routes
 if(!Number.isFinite(policy.maxAgeMilliseconds)||policy.maxAgeMilliseconds<=0)throw new Error("Invalid dispatch calibration age policy")
 return routes.map(route=>{const tokens=policy.tokensByRoute[route.id];if(!tokens)return route
  const record:RequestRecord={id:"forecast",sessionID:"forecast",accountID:route.accountID,accountRegime:regimes[route.accountID],route:{providerID:route.providerID,modelID:route.modelID,reasoning:route.reasoning,variant:route.reasoning==="unknown"?undefined:route.reasoning,harness:route.harness,serviceTier:route.serviceTier},kind:"forecast",startedAt:now,state:"running",tokens}
  const fits=new Map<string,Calibration>();for(const c of calibrations.filter(c=>c.accountID===route.accountID&&canonicalRouteKey(c.routeKey)===routeKey(record)&&c.regime===record.accountRegime).sort((a,b)=>a.trainedAt-b.trainedAt))fits.set(c.windowID,c)
  const quotaPerTask={...route.quotaPerTask};for(const c of fits.values()){const forecast=predictAllowance(c,record,{now,maxAgeMilliseconds:policy.maxAgeMilliseconds,regime:record.accountRegime??"unknown"});if(forecast)quotaPerTask[c.windowID]=Math.max(quotaPerTask[c.windowID]??0,forecast.high)}
  return {...route,quotaPerTask}
 })
}
