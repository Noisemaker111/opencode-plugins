import {assertChatModel,assertConfiguredSelection} from '../../models/access-policy'
import {EFFORT_REQUIRED_ROLES,EVALUATION_ROLES,ROLES,currentName,type RoleName} from '../config/registry.mts'
import {questSettingsFile,questSettingsFileIn,readSettings,writeSettings,type SettingsSection} from '../config/quest-settings.mjs'

export {ROLES}
export type Role=RoleName
export type RoleRoute={model:string;effort?:string}
export type RoleReturn={healthyMinutes?:number;goodAnswers?:number}
type RoleOptions={fallback?:RoleRoute;returnAfter?:RoleReturn;historyBudget?:number}
export type RoleSelection=
 |(RoleRoute&{automatic?:false}&RoleOptions)
 |({automatic:true;model?:undefined;effort?:undefined;fallback?:undefined;returnAfter?:undefined;historyBudget?:number})
export type RoleSettings={version:1;roles:Partial<Record<Role,RoleSelection>>}
export const ROLE_SELECTION_FIELDS=['model','effort','automatic','fallback','returnAfter','historyBudget'] as const
export type RoleModel={providerID:string;id:string;variant?:string}

export const unsetRoleSettings=():RoleSettings=>({version:1,roles:{}})
export const isAutomatic=(selection:RoleSelection|undefined):selection is Extract<RoleSelection,{automatic:true}> => selection?.automatic===true
export const roleRouteOf=(selection:RoleSelection|undefined):RoleRoute|undefined=>{
 if(!selection||isAutomatic(selection))return undefined
 return {model:selection.model,...(selection.effort?{effort:selection.effort}:{})}
}
export const roleIdentity=(selection:RoleRoute)=>selection.model+(selection.effort?'#'+selection.effort:'')
export const roleRouteFromIdentity=(identity:string):RoleRoute|undefined=>{
 const [model,effort,...rest]=identity.split('#')
 if(!model||rest.length)return undefined
 const slash=model.indexOf('/')
 if(slash<1||slash===model.length-1)return undefined
 return {model,...(effort?{effort}:{})}
}
export function roleModel(selection:RoleRoute):RoleModel{
 const slash=selection.model.indexOf('/')
 return {providerID:selection.model.slice(0,slash),id:selection.model.slice(slash+1),...(selection.effort?{variant:selection.effort}:{})}
}

const token=(value:unknown)=>typeof value==='string'&&value.length>0&&value.trim()===value&&!/[\s#]/.test(value)
const wholePositive=(value:unknown)=>Number.isSafeInteger(value)&&(value as number)>0
function routeProblem(role:Role,path:string,row:Record<string,unknown>){
 const model=row.model
 if(!token(model)||(model as string).indexOf('/')<1||(model as string).endsWith('/'))return path+'.model must be provider/model'
 if(row.effort!==undefined&&!token(row.effort))return path+'.effort must be one word such as low, medium or high'
 if(EFFORT_REQUIRED_ROLES.includes(role)&&row.effort===undefined)return path+' needs an effort as well as a model'
 return undefined
}
function selectionProblem(role:Role,value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))return role+' must be {model, effort?, automatic?, fallback?, returnAfter?, historyBudget?}'
 const row=value as Record<string,unknown>
 const extra=Object.keys(row).find(key=>!(ROLE_SELECTION_FIELDS as readonly string[]).includes(key))
 if(extra)return role+' has no field "'+extra+'"; allowed: '+ROLE_SELECTION_FIELDS.join(', ')
 if(row.automatic!==undefined&&typeof row.automatic!=='boolean')return role+'.automatic must be true or false'
 if(row.automatic===true){
  if(role!=='giver')return role+'.automatic is only for the Quest Giver'
  if(row.model!==undefined||row.effort!==undefined)return role+'.automatic cannot name a model or effort; choose one or the other'
  if(row.fallback!==undefined||row.returnAfter!==undefined)return role+'.automatic has no fallback; automatic routing picks the primary route'
  if(row.historyBudget!==undefined&&!wholePositive(row.historyBudget))return role+'.historyBudget must be a whole number of context tokens above zero'
  return undefined
 }
 const problem=routeProblem(role,role,row)
 if(problem)return problem
 if(row.fallback!==undefined){
  const fallback=row.fallback
  if(!fallback||typeof fallback!=='object'||Array.isArray(fallback))return role+'.fallback must be {model, effort?}'
  const fallbackExtra=Object.keys(fallback).find(key=>key!=='model'&&key!=='effort')
  if(fallbackExtra)return role+'.fallback has no field "'+fallbackExtra+'"; allowed: model, effort'
  const fallbackProblem=routeProblem(role,role+'.fallback',fallback as Record<string,unknown>)
  if(fallbackProblem)return fallbackProblem
  if(roleIdentity(fallback as RoleRoute)===roleIdentity(row as RoleRoute))return role+'.fallback must differ from the set route'
 }
 if(row.returnAfter!==undefined){
  const back=row.returnAfter
  if(row.fallback===undefined)return role+'.returnAfter needs a fallback to return from'
  if(!back||typeof back!=='object'||Array.isArray(back))return role+'.returnAfter must be {healthyMinutes?, goodAnswers?}'
  const backExtra=Object.keys(back).find(key=>key!=='healthyMinutes'&&key!=='goodAnswers')
  if(backExtra)return role+'.returnAfter has no field "'+backExtra+'"; allowed: healthyMinutes, goodAnswers'
  const {healthyMinutes,goodAnswers}=back as Record<string,unknown>
  if(healthyMinutes===undefined&&goodAnswers===undefined)return role+'.returnAfter names healthyMinutes, goodAnswers or both'
  if(healthyMinutes!==undefined&&!wholePositive(healthyMinutes))return role+'.returnAfter.healthyMinutes must be a whole number above zero'
  if(goodAnswers!==undefined&&!wholePositive(goodAnswers))return role+'.returnAfter.goodAnswers must be a whole number above zero'
 }
 if(row.historyBudget!==undefined&&!wholePositive(row.historyBudget))return role+'.historyBudget must be a whole number of context tokens above zero'
 return undefined
}
export function roleSettingsProblem(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))return 'Role settings must be {version:1, roles}'
 const row=value as Record<string,unknown>
 const extra=Object.keys(row).find(key=>key!=='version'&&key!=='roles')
 if(extra)return 'Role settings have no field "'+extra+'"'
 if(row.version!==1)return 'Role settings version must be 1'
 const roles=row.roles
 if(!roles||typeof roles!=='object'||Array.isArray(roles))return 'roles must be an object of role selections'
 for(const [role,selection] of Object.entries(roles)){
  if(!ROLES.includes(role as Role))return 'Unknown role "'+role+'"; roles are '+ROLES.join(', ')
  const problem=selectionProblem(role as Role,selection)
  if(problem)return problem
 }
 return undefined
}
export function assertRoleSelection(role:Role,selection:RoleRoute){
 const model=roleModel(selection)
 if(!EVALUATION_ROLES.includes(role))assertChatModel(model)
 assertConfiguredSelection(model)
 return model
}
const cleanRoute=(route:RoleRoute):RoleRoute=>({model:route.model,...(route.effort?{effort:route.effort}:{})})
function cleanSelection(selection:RoleSelection):RoleSelection{
 if(isAutomatic(selection))return {automatic:true,...(selection.historyBudget!==undefined?{historyBudget:selection.historyBudget}:{})}
 return {...cleanRoute(selection),
  ...(selection.fallback?{fallback:cleanRoute(selection.fallback)}:{}),
  ...(selection.returnAfter?{returnAfter:{...(selection.returnAfter.healthyMinutes!==undefined?{healthyMinutes:selection.returnAfter.healthyMinutes}:{}),...(selection.returnAfter.goodAnswers!==undefined?{goodAnswers:selection.returnAfter.goodAnswers}:{})}}:{}),
  ...(selection.historyBudget!==undefined?{historyBudget:selection.historyBudget}:{})}
}
function currentRoles(value:unknown){
 const row=value as {roles?:unknown}|null
 if(!row||typeof row!=='object'||!row.roles||typeof row.roles!=='object'||Array.isArray(row.roles))return value
 return {...row,roles:Object.fromEntries(Object.entries(row.roles).flatMap(([role,selection])=>{const current=currentName(role);return current===null||!ROLES.includes(current as RoleName)?[]:[[current,selection]]}))}
}
const ROLE_SECTION:SettingsSection<RoleSettings>={
 name:'roles',
 check(saved){
  if(saved===undefined)return unsetRoleSettings()
  const value=currentRoles(saved)
  const problem=roleSettingsProblem(value)
  if(problem)throw Error('Invalid role settings: '+problem+'; repair the saved choice, nothing was substituted')
  return value as RoleSettings
 },
}
export function roleSettings(file=questSettingsFile()):RoleSettings{return readSettings(ROLE_SECTION,file)}
export function roleSelection(role:Role,file=questSettingsFile()):RoleSelection|undefined{return roleSettings(file).roles[role]}
export function setRoleSettings(value:unknown,file=questSettingsFile()):RoleSettings{
 const problem=roleSettingsProblem(value)
 if(problem)throw Error(problem)
 const clean=value as RoleSettings
 for(const role of ROLES){
  const selection=clean.roles[role],route=roleRouteOf(selection)
  if(!selection)continue
  if(route)try{assertRoleSelection(role,route)}catch(error){throw Error(role+': '+(error instanceof Error?error.message:String(error)))}
  if(selection.fallback)try{assertRoleSelection(role,selection.fallback)}catch(error){throw Error(role+'.fallback: '+(error instanceof Error?error.message:String(error)))}
 }
 const saved:RoleSettings={version:1,roles:Object.fromEntries(ROLES.flatMap(role=>{const selection=clean.roles[role];return selection?[[role,cleanSelection(selection)]]:[]}))}
 return writeSettings(ROLE_SECTION,saved,file)
}
export function withRoleModel<T extends {model?:string}>(saved:T,role:Role,directory:string):T{
 const route=roleRouteOf(roleSelection(role,questSettingsFileIn(directory)))
 return route?{...saved,model:roleIdentity(route)}:saved
}
export function roleWorkerModel(file=questSettingsFile()){const route=roleRouteOf(roleSelection('worker',file));return route?roleIdentity(route):undefined}
