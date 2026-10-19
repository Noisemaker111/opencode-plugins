import {announcer,modelIdentity,readSelection,refusalNotice,routeIdentity} from '../../models/access-policy'
import {SUMMARY_RESOLVED_NOTE} from './giver-compaction'
import {assertGiverModel,type GiverModelRef} from './giver-settings'
import {assertRoleSelection,isAutomatic,roleModel,roleRouteFromIdentity,roleRouteOf,roleSelection,type RoleRoute} from '../routing/role-settings'
import {chooseGiverRoute,routeModelDeprecated,type GiverRouteChoice} from '../routing/role-route-choice'
import {recordHandoff,routeAvailability,usageAvailability} from '../routing/role-routes'
import {questSettingsFile} from '../config/quest-settings.mjs'
import { SessionReferences } from '../host/session-references'
import {readUserGiver,saveUserGiver,releaseUserGiver} from '../giver-registry.mjs'
import {randomBytes} from 'node:crypto'
import {acquireLock} from '../locking.mts'
import {readAllQuests} from '../index'
import {questMemberships} from '../permissions/shared-guard'
import {withinWorkerLineage,workerCannotReachGiver} from '../workers/worker-reach'
import {physicalDirectory,physicalDirectoryIfPresent,projectIdentity,verifySourceBinding} from '../core/project'
import {QuestError,checkoutProjectRoot,type QuestContext} from '../api'
import {explicitDirectory} from '../core/explicit-path'
import {QuestStore} from '../store'
import {questRoot} from '../root.mts'
import type {QuestHost} from '../runs/runtime'
import {continuationWorkspace} from '../runs/continuation-workspace'
import {giverFolder} from '../host/serving-release'
import {readOwnershipMap} from './ownership-map'
import {GIVER_CHANGED} from '../runs/session-lineage'
const unwrap=(v:any)=>v?.data??v
function namedGiver(store:QuestStore,row:any){
 const names=new SessionReferences(store.runtime),existing=names.get(row.id)
 if(!existing)names.register({sessionID:row.id,title:typeof row.title==='string'&&row.title.trim()?row.title:'Quest giver'})
 return row
}
const worker=(store:QuestStore,id:string)=>questMemberships(store,id).some(({run})=>(run.openCodeSessionId??run.sessionID)===id)
export function retiredGivers(row:any):string[]{return [...new Set([...(Array.isArray(row?.previousSessionIDs)?row.previousSessionIDs:[]),...(typeof row?.previousSessionID==='string'?[row.previousSessionID]:[])])].filter((id):id is string=>typeof id==='string'&&id!==row?.sessionID)}
export function retiredGiverError(row:any,sessionID:string):QuestError|undefined{
 if(!retiredGivers(row).includes(sessionID))return undefined
 return new QuestError('GIVER_RETIRED','This conversation is a retired Quest Giver and can no longer act on Quests. '+(row?.state==='bound'&&row.sessionID?'The current Quest Giver is '+row.sessionID+'.':'A new Quest Giver is starting.')+' Stop here; the current Quest Giver carries on with every Quest.')
}
export function refuseRetiredGiver(store:QuestStore,sessionID:string){const error=retiredGiverError(readUserGiver(store.runtime),sessionID);if(error)throw error}
export const userGiverID=(store=new QuestStore(questRoot()))=>readUserGiver(store.runtime)?.sessionID as string|undefined
function rootConversation(store:QuestStore,row:any){if(!row?.id?.startsWith('ses_')||row.parentID||row.parent_id||worker(store,row.id))throw new QuestError('GIVER_IDENTITY_INVALID','The user giver must be a verified root conversation, never an execution worker')}
function eligible(store:QuestStore,row:any){rootConversation(store,row)}
function elected(store:QuestStore,row:any){eligible(store,row);if(row.agent!=='quest-giver')throw new QuestError('GIVER_IDENTITY_INVALID','A Quest Giver is elected from a conversation opened with the quest-giver agent')}
export async function bindUserGiver(store:QuestStore,host:any,sessionID:string,previousSessionIDs?:string[]){
 const row=unwrap(await host.get({sessionID}));if(row?.id!==sessionID)throw new QuestError('GIVER_IDENTITY_INVALID','Host returned a different giver');eligible(store,row)
 const lock=acquireLock(store.runtime,'user-giver',{timeoutMs:0})
 try{const prior=readUserGiver(store.runtime);const retired=retiredGiverError(prior,sessionID)??(previousSessionIDs?.includes(sessionID)?retiredGiverError({previousSessionIDs},sessionID):undefined);if(retired)throw retired;if(prior&&prior.sessionID!==sessionID)throw new QuestError('SINGLE_GIVER_REQUIRED','Continue in your existing Quest Giver: '+(prior.sessionID??'creation outcome unknown; inspect before retrying'));saveUserGiver(store.runtime,{...prior,state:'bound',sessionID,directory:physicalDirectory(row.location.directory),model:row.model,...(previousSessionIDs?{previousSessionIDs}:{})});namedGiver(store,row);recordAutomaticStart(store,row.model);if(previousSessionIDs?.length)handBackQuests(store,previousSessionIDs);return row}finally{lock.release()}
}
function followGiverLocation(store:QuestStore,prior:any,row:any){
 const at=row?.location?.directory
 if(typeof at!=='string'||!at)return
 const current=physicalDirectoryIfPresent(at)
 if(!current)return
 if(prior.directory&&physicalDirectoryIfPresent(prior.directory)===current)return
 saveUserGiver(store.runtime,{...prior,directory:current})
}
export async function refreshUserGiverLocation(store:QuestStore,host:any){
 const prior=readUserGiver(store.runtime)
 if(prior?.state!=='bound'||!prior.sessionID)return
 const row=unwrap(await host.get({sessionID:prior.sessionID}))
 if(row?.id!==prior.sessionID)return
 followGiverLocation(store,prior,row)
 namedGiver(store,row)
}
export type GiverModel={providerID:string;id:string;variant?:string}
export function roleGiverModel(file=questSettingsFile()):GiverModel|undefined{
 const route=roleRouteOf(roleSelection('giver',file))
 return route?roleModel(route):undefined
}
export async function giverStartModel(file=questSettingsFile(),preferred?:RoleRoute,options:{now?:number;choose?:()=>Promise<GiverRouteChoice>}={}):Promise<GiverModel|undefined>{
 const selection=roleSelection('giver',file)
 if(!isAutomatic(selection))return roleGiverModel(file)
 if(preferred)try{
  const now=options.now??Date.now()
  if(await routeModelDeprecated(preferred,now)!==true&&routeAvailability(preferred,now).state!=='down'&&usageAvailability(preferred,now).state!=='exhausted'){assertRoleSelection('giver',preferred);return roleModel(preferred)}
 }catch{}
 try{const chosen=options.choose?await options.choose():await chooseGiverRoute({file,now:options.now});return roleModel(chosen.route)}
 catch(error){throw new QuestError('GIVER_MODEL_UNAVAILABLE','Automatic routing could not choose a Quest Giver route: '+failureText(error))}
}
export function recordAutomaticStart(store:Pick<QuestStore,'runtime'>,model:GiverModel|undefined,why='automatic routing chose the Quest Giver route'){
 if(!isAutomatic(roleSelection('giver')))return
 const identity=giverModelIdentity(model),route=identity?roleRouteFromIdentity(identity):undefined
 if(!route)return
 try{recordHandoff(store.runtime,'giver',why,questSettingsFile(),undefined,route)}catch(error){console.error('[quests] automatic Quest Giver route not recorded',error instanceof Error?error.message:error)}
}
export type UserGiverOptions={model?:GiverModel}
type GiverHost=Pick<QuestHost,'create'|'get'> & Partial<Pick<QuestHost,'switchModel'|'interrupt'>>
const sameModel=(a:any,b:GiverModel)=>a?.providerID===b.providerID&&a?.id===b.id&&(a?.variant??undefined)===(b.variant??undefined)
const giverHistory=(history:unknown,retired:string|undefined,current:string)=>[...new Set([...(retired?[retired]:[]),...(Array.isArray(history)?history:[])])].filter((id):id is string=>typeof id==='string'&&id!==current)
const candidateSessionID=()=>`ses_${randomBytes(16).toString('base64url')}`
const exactModel=(model:GiverModelRef|undefined):GiverModel|undefined=>{const id=model?.id??model?.modelID;return model?.providerID&&id?{providerID:model.providerID,id,...(model.variant?{variant:model.variant}:{})}:undefined}
function chosenByUser(binding:any,sessionID:string,model:GiverModelRef|undefined){
 const exact=exactModel(model)
 if(!exact)return false
 if(binding?.state!=='bound'||binding.sessionID!==sessionID||binding.automaticRouting!==true||!sameModel(binding.model,exact))return true
 const selection=readSelection(sessionID)
 return selection?.source==='user-selected'&&routeIdentity(selection.route)===modelIdentity(exact)&&(selection.variant??undefined)===(exact.variant??undefined)
}
function rememberChosenModel(store:QuestStore,sessionID:string,model:GiverModelRef){
 const exact=exactModel(model),binding=readUserGiver(store.runtime)
 if(!exact||binding?.state!=='bound'||binding.sessionID!==sessionID||(binding.automaticRouting===false||binding.automaticRouting===undefined)&&sameModel(binding.model,exact))return
 let lock:ReturnType<typeof acquireLock>
 try{lock=acquireLock(store.runtime,'user-giver',{timeoutMs:0})}catch{return}
 try{const current=readUserGiver(store.runtime);if(current?.state==='bound'&&current.sessionID===sessionID)saveUserGiver(store.runtime,{...current,model:exact,automaticRouting:false})}finally{lock.release()}
}
function selectedModel(row:any){
 if(row.automaticRouting===true)return undefined
 if(!row.model?.providerID||!row.model?.id)throw new QuestError('GIVER_MODEL_INVALID','The explicit Quest Giver model is missing from its saved binding; it was not substituted')
 return row.model as GiverModel
}
function recoveryCandidate(store:QuestStore,row:any,prior:any){
 elected(store,row)
 if(typeof row.location?.directory!=='string'||!row.location.directory)throw new QuestError('GIVER_IDENTITY_INVALID','Recovered Quest Giver has no service directory')
 if(prior.directory&&physicalDirectoryIfPresent(prior.directory)&&physicalDirectory(row.location.directory)!==physicalDirectory(prior.directory))throw new QuestError('GIVER_IDENTITY_INVALID','Recovered Quest Giver is bound to a different service directory')
 const selected=selectedModel(prior)
 if(selected&&!sameModel(row.model,selected))throw new QuestError('GIVER_MODEL_MISMATCH','Host did not preserve the exact selected giver model and reasoning variant')
}
const ABSENT_SESSION=new Set(['Session.NotFoundError','SessionNotFoundError'])
export function hostSessionAbsent(error:unknown){
 const failure=error as any
 if(!failure||typeof failure!=='object')return false
 if([failure._tag,failure.error?._tag,failure.cause?._tag].some(tag=>ABSENT_SESSION.has(tag)))return true
 return (failure.response?.status??failure.error?.status??failure.status??failure.cause?.response?.status??failure.cause?.status)===404
}
const failureText=(error:unknown)=>error instanceof Error?error.message||(error as any)._tag||error.name:String(error)
async function inspectCandidate(host:Pick<QuestHost,'get'>,sessionID:string){
 let answer:any
 try{answer=await host.get({sessionID})}catch(error){
  if(hostSessionAbsent(error))return undefined
  throw new QuestError('GIVER_RECOVERY_UNAVAILABLE','The host could not inspect the uncertain Quest Giver: '+failureText(error))
 }
 const status=answer?.response?.status??answer?.error?.status??answer?.status
 if(status!==undefined&&status!==404&&!answer?.data)throw new QuestError('GIVER_RECOVERY_UNAVAILABLE','The host could not inspect the uncertain Quest Giver (status '+status+')')
 const row=unwrap(answer)
 if(!row?.id)return undefined
 if(row.id!==sessionID)throw new QuestError('GIVER_IDENTITY_INVALID','Host returned a different giver during recovery')
 return row
}
function restoredBinding(store:QuestStore,row:any,prior:any){
 elected(store,row)
 if(typeof row.location?.directory!=='string'||!row.location.directory)throw new QuestError('GIVER_IDENTITY_INVALID','Recovered Quest Giver has no service directory')
 const at=physicalDirectory(row.location.directory),before=prior.priorBinding
 if(before?.sessionID!==row.id)return {...prior,state:'bound',sessionID:row.id,directory:at,model:row.model,previousSessionID:undefined,reason:undefined,candidateSessionID:undefined,replacement:undefined,priorBinding:undefined}
 if(before.directory&&physicalDirectoryIfPresent(before.directory)&&at!==physicalDirectory(before.directory))throw new QuestError('GIVER_IDENTITY_INVALID','The previous Quest Giver moved to a different service directory')
 if(before.automaticRouting!==true&&before.model&&!sameModel(row.model,before.model))throw new QuestError('GIVER_MODEL_MISMATCH','The previous Quest Giver no longer runs its saved model and reasoning variant')
 return {...before,state:'bound',directory:at,...(before.automaticRouting===true?{model:row.model}:{})}
}
export type UserGiverRecovery={state:'recovered'|'restored';sessionID:string;previousSessionID?:string;model?:GiverModel}|{state:'vacant';candidateSessionID:string}
async function reconcileUserGiverUnlocked(store:QuestStore,host:Pick<QuestHost,'get'>):Promise<UserGiverRecovery>{
 const prior=readUserGiver(store.runtime)
 if(!prior)throw new QuestError('GIVER_NOT_READY','There is no Quest Giver outcome to recover')
 if(prior.state==='bound')return{state:'recovered',sessionID:prior.sessionID,previousSessionID:prior.previousSessionID,model:prior.model}
 if(!prior.candidateSessionID)throw new QuestError('GIVER_OUTCOME_UNKNOWN','The older uncertain giver record has no candidate identity; inspect the host before releasing it')
 const candidate=await inspectCandidate(host,prior.candidateSessionID)
 let candidateError:unknown
 if(candidate){
  try{if(retiredGivers(prior).includes(candidate.id))throw retiredGiverError(prior,candidate.id);recoveryCandidate(store,candidate,prior)}catch(error){candidateError=error}
  if(!candidateError){
   saveUserGiver(store.runtime,{...prior,state:'bound',sessionID:candidate.id,directory:physicalDirectory(candidate.location.directory),model:candidate.model,previousSessionID:prior.previousSessionID,previousSessionIDs:prior.replacement?giverHistory(prior.previousSessionIDs,prior.previousSessionID,candidate.id):prior.previousSessionIDs,reason:undefined,candidateSessionID:undefined,replacement:undefined,priorBinding:undefined})
   namedGiver(store,candidate)
   if(prior.replacement&&prior.previousSessionID)handBackQuests(store,[prior.previousSessionID])
   return{state:'recovered',sessionID:candidate.id,previousSessionID:prior.previousSessionID,model:candidate.model}
  }
 }
 if(prior.replacement&&prior.previousSessionID){
  const previous=await inspectCandidate(host,prior.previousSessionID)
  if(!previous)throw new QuestError('GIVER_RECOVERY_REQUIRED','Neither the replacement candidate nor the previous Quest Giver can be verified')
  const restored=restoredBinding(store,previous,prior)
  saveUserGiver(store.runtime,restored)
  namedGiver(store,previous)
  return{state:'restored',sessionID:previous.id,model:restored.model}
 }
 if(candidateError)throw candidateError
 releaseUserGiver(store.runtime)
 return{state:'vacant',candidateSessionID:prior.candidateSessionID}
}
export async function recoverUserGiver(store:QuestStore,host:Pick<QuestHost,'get'>){
 const lock=acquireLock(store.runtime,'user-giver',{timeoutMs:0})
 try{return await reconcileUserGiverUnlocked(store,host)}finally{lock.release()}
}
export async function setUserGiverModel(store:QuestStore,host:Pick<QuestHost,'get'> & Partial<Pick<QuestHost,'switchModel'>>,sessionID:string,model:GiverModel){
 if(!model?.providerID||!model?.id||('variant'in model&&!model.variant))throw new QuestError('GIVER_MODEL_INVALID','An exact provider, model, and optional non-empty reasoning variant are required')
 assertGiverModel(model,true)
 if(!host.switchModel)throw new QuestError('GIVER_MODEL_UNAVAILABLE','The connected Quest Giver cannot switch models through its authenticated host')
 const lock=acquireLock(store.runtime,'user-giver',{timeoutMs:0})
 try{
  const prior=readUserGiver(store.runtime)
  if(prior?.state!=='bound'||prior.sessionID!==sessionID)throw new QuestError('SINGLE_GIVER_REQUIRED','Change the model on the currently bound Quest Giver')
  let switchError:unknown
  try{await host.switchModel({sessionID,model})}catch(error){switchError=error}
  const row=unwrap(await host.get({sessionID}))
  if(row?.id!==sessionID)throw new QuestError('GIVER_IDENTITY_INVALID','Host returned a different giver after switching its model')
  eligible(store,row)
  if(!sameModel(row.model,model)){if(switchError)throw switchError;throw new QuestError('GIVER_MODEL_MISMATCH','Host did not preserve the exact selected giver model and reasoning variant')}
  saveUserGiver(store.runtime,{...prior,directory:physicalDirectory(row.location.directory),model:{...model},automaticRouting:false})
  return{sessionID,model:{...model},automaticRouting:false as const}
 }finally{lock.release()}
}
export function questWebGiverModel(value=process.env.OPENCODE_QUEST_WEB_MODEL){
 if(!value)return undefined
 const slash=value.indexOf('/'),providerID=value.slice(0,slash),selected=value.slice(slash+1)
 const parts=selected.split('#'),id=parts[0],variant=parts[1]
 if(slash<1||!id||parts.length>2||(parts.length===2&&!variant))throw new QuestError('GIVER_MODEL_INVALID','Quest Web model must be a provider/model identity with an optional explicit reasoning variant')
 return {providerID,id,...(variant?{variant}:{})}
}
export async function ensureUserGiver(store:QuestStore,host:any,currentID?:string,directory=process.cwd(),options:UserGiverOptions={}){
 let prior=readUserGiver(store.runtime)
 const retired=new Set(retiredGivers(prior))
 if(prior&&prior.state!=='bound'){const recovered=await recoverUserGiver(store,host);if(recovered.state!=='vacant')prior=readUserGiver(store.runtime);else prior=undefined}
 if(prior){const row=unwrap(await host.get({sessionID:prior.sessionID}));if(row?.id!==prior.sessionID)throw new QuestError('GIVER_IDENTITY_INVALID','Host returned a different giver');rootConversation(store,row);followGiverLocation(store,prior,row);return namedGiver(store,row)}
 if(currentID){const row=unwrap(await host.get({sessionID:currentID}));if(row?.id!==currentID)throw new QuestError('GIVER_IDENTITY_INVALID','Host returned a different session');if(row?.agent==='quest-giver'&&!retired.has(row.id)&&!worker(store,row.id)&&!row.parentID)return bindUserGiver(store,host,row.id)}
 const ids=[...new Set(readAllQuests(store.projectRoot,{includeArchived:true}).flatMap(r=>r.quest?.integrationOwner?.startsWith('ses_')?[r.quest.integrationOwner]:[]))]
 const candidates:any[]=[]
 let reached=0
 for(const id of ids){
  let row:any
  try{row=unwrap(await host.get({sessionID:id}))}catch{continue}
  if(row?.id!==id)continue
  reached++
  if(retired.has(id))continue
  try{eligible(store,row)}catch{continue}
  candidates.push(row)
 }
 if(ids.length&&!reached)throw new QuestError('GIVER_UNREACHABLE','No recorded Quest Giver answered on this host; reconnect it instead of creating another')
 if(candidates.length){candidates.sort((a,b)=>(Date.parse(b.time?.updated)||Number(b.time?.updated)||0)-(Date.parse(a.time?.updated)||Number(a.time?.updated)||0));return bindUserGiver(store,host,candidates[0].id)}
 const lock=acquireLock(store.runtime,'user-giver',{timeoutMs:0})
 try{if(readUserGiver(store.runtime))throw new QuestError('GIVER_CREATION_BUSY','Another request is establishing your giver; refresh');const requested=candidateSessionID(),at=physicalDirectory(directory);let candidate=requested;saveUserGiver(store.runtime,{state:'launching',candidateSessionID:candidate,directory:at,model:options.model,automaticRouting:!options.model});try{const created=unwrap(await host.create({id:requested,title:'Quest Giver',agent:'quest-giver',location:{directory:at},...(options.model?{model:options.model}:{})}));candidate=created?.id??requested;saveUserGiver(store.runtime,{state:'launching',candidateSessionID:candidate,directory:at,model:options.model,automaticRouting:!options.model});const row=unwrap(await host.get({sessionID:candidate}));if(row?.id!==candidate)throw new QuestError('GIVER_IDENTITY_INVALID','Host returned a different created giver');recoveryCandidate(store,row,{directory:at,model:options.model,automaticRouting:!options.model});saveUserGiver(store.runtime,{state:'bound',sessionID:row.id,directory:physicalDirectory(row.location.directory),model:row.model,automaticRouting:!options.model});recordAutomaticStart(store,row.model);return namedGiver(store,row)}catch(error){saveUserGiver(store.runtime,{state:'unknown',candidateSessionID:candidate,directory:at,model:options.model,automaticRouting:!options.model,reason:'Creation outcome requires inspection before retrying: '+String(error)});throw error}}finally{lock.release()}
}

async function candidateAbsent(host:Pick<QuestHost,'get'>,sessionID:string){
 try{return !await inspectCandidate(host,sessionID)}catch{return false}
}
export async function replaceUserGiver(store:QuestStore,host:GiverHost,directory=process.cwd(),options:{model?:GiverModel}={}){
 const lock=acquireLock(store.runtime,'user-giver',{timeoutMs:0})
 try{
  const prior=readUserGiver(store.runtime)
  if(!prior||prior.state!=='bound')throw new QuestError('GIVER_NOT_READY','There is no bound Quest Giver to succeed yet')
  const current=unwrap(await host.get({sessionID:prior.sessionID}))
  if(current?.id!==prior.sessionID)throw new QuestError('GIVER_IDENTITY_INVALID','Host returned a different current giver')
  rootConversation(store,current)
  const at=directory
  const conversation=exactModel(current.model)
  const selected=options.model??roleGiverModel()??(conversation&&chosenByUser(prior,prior.sessionID,conversation)?conversation:selectedModel(prior)),requested=candidateSessionID()
  const base={...prior,model:selected??prior.model,automaticRouting:!selected}
  let candidate=requested,answered=false
  saveUserGiver(store.runtime,{...base,state:'launching',directory:physicalDirectory(at),previousSessionID:prior.sessionID,candidateSessionID:candidate,replacement:true,priorBinding:prior})
  try{
   const created=unwrap(await host.create({id:requested,title:'Quest Giver',agent:'quest-giver',location:{directory:physicalDirectory(at)},...(selected?{model:selected}:{})}))
   answered=true
   candidate=created?.id??requested
   saveUserGiver(store.runtime,{...base,state:'launching',directory:physicalDirectory(at),previousSessionID:prior.sessionID,candidateSessionID:candidate,replacement:true,priorBinding:prior})
   const row=unwrap(await host.get({sessionID:candidate}))
   if(row?.id!==candidate)throw new QuestError('GIVER_IDENTITY_INVALID','Host returned a different replacement giver')
   recoveryCandidate(store,row,{...base,directory:physicalDirectory(at)})
   saveUserGiver(store.runtime,{...base,state:'bound',sessionID:row.id,directory:physicalDirectory(row.location.directory),model:row.model,previousSessionID:prior.sessionID,previousSessionIDs:giverHistory(prior.previousSessionIDs,prior.sessionID,row.id),reason:undefined,candidateSessionID:undefined,replacement:undefined})
   namedGiver(store,row)
   handBackQuests(store,[prior.sessionID])
   if(typeof host.interrupt==='function')try{await host.interrupt({sessionID:prior.sessionID})}catch(error){console.error('[quests] the retired Quest Giver turn was not stopped',error instanceof Error?error.message:error)}
   return {sessionID:row.id,previousSessionID:prior.sessionID,model:row.model}
  }catch(error){
   if(!answered&&await candidateAbsent(host,candidate)){saveUserGiver(store.runtime,prior);throw error}
   saveUserGiver(store.runtime,{...base,state:'unknown',directory:physicalDirectory(at),previousSessionID:prior.sessionID,candidateSessionID:candidate,replacement:true,priorBinding:prior,reason:'Replacement outcome requires inspection before retrying: '+String(error)})
   throw error
  }
 }finally{lock.release()}
}
export function adoptQuestGiver(store:QuestStore,id:string){const sessionID=userGiverID(store),q=store.read(id);if(!sessionID||!q||q.integrationOwner===sessionID)return q;return store.apply(id,'patched',{integrationOwner:sessionID,extensions:{...q.extensions,previousGivers:[...new Set([...(q.extensions.previousGivers as string[]??[]),...(q.integrationOwner?[q.integrationOwner]:[])])] }},'quest:user-giver',{expectedRevision:q.revision})}
export function handBackQuests(store:QuestStore,leaving:string[]){
 const gone=new Set(leaving.filter(id=>typeof id==='string'&&id))
 const current=userGiverID(store)
 if(!current||!gone.size)return []
 const moved:string[]=[]
 for(const row of readOwnershipMap(store).quests){
  if(!row.giver||row.giver.current||!gone.has(row.giver.sessionID))continue
  try{if(adoptQuestGiver(store,row.questID)?.integrationOwner===current)moved.push(row.questID)}catch(error){console.error('[quests] a Quest of a leaving Quest Giver was not handed back',row.questID,error instanceof Error?error.message:error)}
 }
 return moved
}
export async function handedOverContext(store:QuestStore,host:Pick<QuestHost,'get'>,context:QuestContext,questID:string):Promise<QuestContext|undefined>{
 if(!context.giverDirectory)return undefined
 const registered=readUserGiver(store.runtime)
 if(registered?.state!=='bound'||!registered.sessionID||registered.sessionID===context.sessionID||!retiredGivers(registered).includes(context.sessionID))return undefined
 const session=unwrap(await host.get({sessionID:registered.sessionID}))
 if(session?.id!==registered.sessionID)return undefined
 rootConversation(store,session)
 adoptQuestGiver(store,questID)
 return {...context,...giverContext(store,session,context.requestID,questID,false,context.turnID)}
}
export type GiverCreate={projectRoot?:unknown}
const PROJECT_REQUIRED_MESSAGE='No Quest was created. Pass projectRoot: a path the user named, or the directory of the candidate you chose from project_resolve called with request set to the user\'s words.'
function namedProjectContext(session:any,requestID:string,turnID:string|undefined,origin:string,projectRoot:unknown):QuestContext{
 if(projectRoot===undefined)throw new QuestError('PROJECT_REQUIRED',PROJECT_REQUIRED_MESSAGE)
 const project=checkoutProjectRoot(projectRoot),written=String(projectRoot).trim()
 return {sessionID:session.id,requestID,turnID,project,directory:physicalDirectory(explicitDirectory(written)??written),giverDirectory:origin}
}
export function giverContext(store:QuestStore,session:any,requestID:string,questID?:string,creating:GiverCreate|false=false,turnID?:string):QuestContext {
 const registered=readUserGiver(store.runtime),origin=giverFolder(session)
 if(!registered||registered.sessionID!==session.id)return {sessionID:session.id,requestID,turnID,directory:origin,project:projectIdentity(origin)}
 rootConversation(store,session)
 const q=questID?store.read(questID):undefined
 if(!q&&creating)return namedProjectContext(session,requestID,turnID,origin,creating.projectRoot)
 const recorded=q?((q.extensions.giverSourceDirectory as string)??q.project!.root):origin
 const directory=physicalDirectoryIfPresent(recorded)
 if(!directory){
  if(!q?.project)throw new QuestError('PROJECT_UNAVAILABLE','The Quest Giver\'s folder is gone: '+recorded+'. Open the Quest Giver in a folder that exists.')
  return {sessionID:session.id,requestID,turnID,project:q.project,directory:recorded,missingDirectory:recorded,giverDirectory:origin}
 }
 const project=projectIdentity(directory);if(q?.project&&project.id!==q.project.id)throw new QuestError('PROJECT_MISMATCH','The recorded Quest source no longer belongs to its project')
 return {sessionID:session.id,requestID,turnID,project,directory,giverDirectory:origin}
}
export async function verifyGiverBinding(store:QuestStore,context:QuestContext,session:any){
  const workspace=await continuationWorkspace(store,context)
  if(!context.giverDirectory)return await verifySourceBinding(workspace?{project:context.project,directory:physicalDirectory(session?.location?.directory)}:context,session?.location?.directory)
 if(userGiverID(store)!==context.sessionID||session?.id!==context.sessionID||giverFolder(session)!==giverFolder({location:{directory:context.giverDirectory}}))throw new QuestError('GIVER_BINDING_CHANGED',GIVER_CHANGED)
  rootConversation(store,session);if(!workspace)await verifySourceBinding(context,context.directory!)
}

export async function installUserGiverContext(store:QuestStore,host:any){
 const announce=announcer(host,[0])
 await host.hook?.('http.request',async(event:any)=>{
  const registered=readUserGiver(store.runtime),isRegistered=registered?.state==='bound'&&registered.sessionID===event.sessionID
  if(!isRegistered&&(event.agent!=='quest-giver'||worker(store,event.sessionID)))return
  try{assertGiverModel(event.model,chosenByUser(registered,event.sessionID,event.model))}
  catch(error){announce(event.sessionID,refusalNotice({model:event.model??{},reason:error instanceof Error?error.message:String(error)}));throw error}
  if(isRegistered)rememberChosenModel(store,event.sessionID,event.model)
 })
 await host.hook?.('compaction',(event:any)=>{
  const registered=readUserGiver(store.runtime)
  if(registered?.state!=='bound'||registered.sessionID!==event.sessionID||!Array.isArray(event.system))return
  if(!event.system.some((part:any)=>part?.text===SUMMARY_RESOLVED_NOTE))event.system.push({type:'text',text:SUMMARY_RESOLVED_NOTE})
 })
 await host.hook?.('context',async(event:any)=>{
  const registered=readUserGiver(store.runtime),isRegistered=registered?.state==='bound'&&registered.sessionID===event.sessionID
  if(!isRegistered&&(event.agent!=='quest-giver'||worker(store,event.sessionID)))return
  const retired=retiredGiverError(registered,event.sessionID)
  if(retired){if(Array.isArray(event.system))event.system.push({type:'text',text:retired.message});throw retired}
  if(registered?.state==='launching')throw new QuestError('GIVER_CREATION_BUSY','A new Quest Giver is starting; this conversation does not take the role')
  let row:any
  try{row=await ensureUserGiver(store,host,event.sessionID)}catch(error){
   if(isRegistered&&Array.isArray(event.system))event.system.push({type:'text',text:`The registered Quest Giver session ${event.sessionID} is no longer eligible. ${error instanceof Error?error.message:'The host could not confirm its identity'} Quest tools are unavailable until you inspect or succeed this giver.`})
   throw error
  }
  if(row.id===event.sessionID)return
  const incoming=unwrap(await host.get({sessionID:event.sessionID}))
  if(incoming?.id!==event.sessionID)throw new QuestError('GIVER_IDENTITY_INVALID','Host returned a different session')
  try{rootConversation(store,incoming)}
  catch{if(await withinWorkerLineage(store,host,incoming))throw workerCannotReachGiver();throw new QuestError('SINGLE_GIVER_REQUIRED','Continue in your existing Quest Giver: '+row.id)}
  const history=giverHistory(readUserGiver(store.runtime)?.previousSessionIDs,row.id,event.sessionID)
  const previous=releaseUserGiver(store.runtime)
  row=await bindUserGiver(store,host,event.sessionID,history)
  if(row.id!==event.sessionID)throw new QuestError('SINGLE_GIVER_REQUIRED','Continue in your existing Quest Giver: '+row.id)
  if(Array.isArray(event.system))event.system.push({type:'text',text:`This conversation is now your Quest Giver${previous?`, succeeding ${previous}`:''}. That conversation and its Quests are untouched; workers report here from now on.`})
 })
}
const MOVE_READS=25,MOVE_READ_GAP_MS=200,MOVES=Symbol.for('questgiver.giver-moves')
type MoveHost={move?:(input:any)=>Promise<any>;get:(input:any)=>Promise<any>}
export function moveGiver(store:QuestStore,host:MoveHost,giver:{sessionID:string},directory:string):Promise<boolean>{
 const moves=(globalThis as any)[MOVES]??=new Map<string,Promise<boolean>>()
 const key=store.runtime+'|'+giver.sessionID+'|'+physicalDirectory(directory)
 const running=moves.get(key)
 if(running)return running
 const move=moveGiverNow(store,host,giver,directory).then(moved=>{if(moved)console.error('[quests] Quest Giver moved to the serving release:',physicalDirectory(directory));return moved}).finally(()=>moves.delete(key))
 moves.set(key,move)
 return move
}
async function moveGiverNow(store:QuestStore,host:MoveHost,giver:{sessionID:string},directory:string){
 if(typeof host.move!=='function')return false
 const target=physicalDirectory(directory)
 try{
  const movedTo=(row:any)=>typeof row?.location?.directory==='string'&&physicalDirectoryIfPresent(row.location.directory)===target
  let moved=movedTo(unwrap(await host.move({sessionID:giver.sessionID,directory:target})))
  for(let read=0;!moved&&read<MOVE_READS;read++){
   moved=movedTo(unwrap(await host.get({sessionID:giver.sessionID})))
   if(!moved&&read+1<MOVE_READS)await new Promise(resolve=>setTimeout(resolve,MOVE_READ_GAP_MS))
  }
  if(!moved){console.error('[quests] Quest Giver not moved: the host still reports its old folder after '+MOVE_READS+' reads');return false}
 }catch(error){console.error('[quests] Quest Giver not moved',error instanceof Error?error.message:error);return false}
 const current=readUserGiver(store.runtime)
 if(current?.sessionID!==giver.sessionID)return false
 saveUserGiver(store.runtime,{...current,directory:target})
 return true
}
