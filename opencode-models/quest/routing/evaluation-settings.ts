import {digest} from '../privacy'
import {dispatchPlanInput,configuredDispatchPolicyFile,dispatchReservationFile} from '../../models/dispatch-planner'
import {RouteReservations} from '../../models/route-reservations'
import {assertChatModel,assertConfiguredSelection} from '../../models/access-policy'
import {liveProviderModels} from '../../models/provider-live-models'
import {keylessAccountID} from '../../models/live-routes'
import {questSettingsFile,readSettings,writeSettings,type SettingsSection} from '../config/quest-settings.mjs'
export type EvaluationSettings={version:1;enabled:boolean;model?:string;preference:'economy'|'cash'|'latency'|'quota'}
type StoredEvaluationSettings=Omit<EvaluationSettings,'enabled'>&{enabled?:boolean}
const PREFERENCES=['economy','cash','latency','quota']
function validEvaluationSettings(value:unknown):value is StoredEvaluationSettings{
 const row=value as StoredEvaluationSettings
 return !!row&&typeof row==='object'&&!Array.isArray(row)&&row.version===1&&(row.enabled===undefined||typeof row.enabled==='boolean')&&PREFERENCES.includes(row.preference)&&(row.model===undefined||typeof row.model==='string'&&!!row.model.trim())
}
export function evaluationSection(name:string,empty:EvaluationSettings):SettingsSection<EvaluationSettings>{
 return {
  name,
  check(saved){
   if(saved===undefined)return empty
   if(!validEvaluationSettings(saved))throw Error('Invalid evaluation settings for '+name+'; preserve and repair the user selection')
   return {version:1,enabled:saved.enabled===true,preference:saved.preference,model:saved.model}
  },
 }
}
export function evaluationSettings(section:SettingsSection<EvaluationSettings>,file=questSettingsFile()):EvaluationSettings{return readSettings(section,file)}
export function setEvaluationSettings(section:SettingsSection<EvaluationSettings>,value:EvaluationSettings,file=questSettingsFile()):EvaluationSettings{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['version','enabled','preference','model'].includes(key))||typeof value.enabled!=='boolean'||!validEvaluationSettings(value))throw Error('Invalid evaluation selection')
 return writeSettings(section,value,file)
}
export async function evaluationCandidates(settings:EvaluationSettings,availableModels?:string[]){
 const plan=await dispatchPlanInput({task:'utility',model:settings.model,policyFile:configuredDispatchPolicyFile()})
 const routes=plan.routes.filter(r=>r.harness==='native'&&r.serviceTier==='default'&&(!availableModels||availableModels.includes(r.providerID+'/'+r.modelID)))
 const request={...plan.request,primaryRouteID:undefined,fallback:undefined,preference:settings.preference==='quota'?'capacity' as const:settings.preference}
 return {...plan,routes,request}
}
export async function keylessEvaluationRoute(settings:EvaluationSettings,availableModels:string[]|undefined,error:unknown){
 if(!settings.model||!String(error).includes('AUTHORIZED_ROUTE_UNAVAILABLE'))return
 const [identity,reasoning='unknown']=settings.model.split('#'),slash=identity.indexOf('/')
 if(slash<1)return
 let served=availableModels?.includes(identity)??false
 if(!served)served=(await liveProviderModels().catch(()=>({identities:[] as string[]}))).identities.includes(identity)
 if(!served)return
 const providerID=identity.slice(0,slash),modelID=identity.slice(slash+1)
 assertConfiguredSelection({providerID,id:modelID,...(reasoning!=='unknown'?{reasoning}:{})})
 return {
  route:{id:'keyless-'+digest(identity),providerID,modelID,reasoning,harness:'native' as const,serviceTier:'default' as const,accountID:keylessAccountID(providerID)},
  ledger:{settle(){}},
  decision:{summary:'Configured model '+settings.model+' is served without an account'},
  keyless:true as const,
 }
}
export async function reserveEvaluationRoute(runtime:string,runID:string,settings:EvaluationSettings,availableModels:string[]|undefined){
 if(settings.enabled!==true)throw Error('This model router is disabled; enable it in Agent settings before reserving a route')
 if(settings.model){const identity=settings.model.split('#')[0],slash=identity.indexOf('/');if(slash>0)assertChatModel({providerID:identity.slice(0,slash),id:identity.slice(slash+1)})}
 let plan:Awaited<ReturnType<typeof evaluationCandidates>>
 try{plan=await evaluationCandidates(settings,availableModels)}
 catch(error){const open=await keylessEvaluationRoute(settings,availableModels,error);if(open)return open;throw error}
 const ledger=new RouteReservations(dispatchReservationFile(runtime)),result=ledger.reserve(runID,plan)
 if(!result.reservation)throw Error(result.decision?.summary??'No user-authorized available route')
 const route=plan.routes.find(r=>r.id===result.reservation!.routeID)
 if(!route)throw Error('Reserved route is unavailable; no substitute selected')
 return {route,ledger,decision:result.decision}
}
