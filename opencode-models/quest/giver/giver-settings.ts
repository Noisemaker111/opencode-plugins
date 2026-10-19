import {questSettingsFile,readSettings,writeSettings,type SettingsSection} from '../config/quest-settings.mjs'
import {currentName} from '../config/registry.mts'
import {QuestError} from '../api'
import {evaluationOnlyProvider} from '../../models/access-policy'
import {driveSync,gitRun} from '../landing/git-steps'
export type QuestPacingSelection={maxConcurrent:number;until:number}
export type GiverSettings={version:1;computerUse?:string[];checkItWorks?:boolean;pacing?:QuestPacingSelection;selfFix?:boolean}
export const RUNTIME_REPOSITORY='Noisemaker111/questgiver'
function repoFullName(remoteURL:string){
 const match=/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteURL.trim())
 return match?match[1]+'/'+match[2]:undefined
}
export function isRuntimeProject(root:string){
 const remote=driveSync(gitRun(root,['config','--get','remote.origin.url']))
 return remote.status===0&&repoFullName(remote.stdout)===RUNTIME_REPOSITORY
}
function validPacing(value:unknown):value is QuestPacingSelection {
 if(!value||typeof value!=='object'||Array.isArray(value))return false
 const row=value as QuestPacingSelection
 return Object.keys(row).every(key=>['maxConcurrent','until'].includes(key))&&Number.isSafeInteger(row.maxConcurrent)&&row.maxConcurrent>=1&&Number.isFinite(row.until)&&Number.isFinite(new Date(row.until).getTime())&&row.until>0
}
export function questPacingConcurrency(settings:GiverSettings,now:number,choice:{maxConcurrent?:number;delivery?:string;workspaceMode:string}) {
 if(choice.maxConcurrent!==undefined)return choice.maxConcurrent
 if(choice.delivery==='quest-pr'||choice.workspaceMode!=='worktree')return 1
 const pacing=settings.pacing
 return pacing&&Number.isFinite(now)&&now<pacing.until?pacing.maxConcurrent:1
}
export function pacingInstruction(now=Date.now()) {
 const pacing=giverSettings().pacing
 return pacing&&now<pacing.until
  ? 'Temporary inference pacing: at most '+pacing.maxConcurrent+' workers per Quest started after saving this setting, until '+new Date(pacing.until).toISOString()+'. Omit workflow.maxConcurrent and run.maxConcurrent to use this setting; preserve an explicit Quest concurrency choice. This setting changes concurrency, not model or reasoning selections.'
  : ''
}
const validComputerUse=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(name=>typeof name==='string'&&/^[A-Za-z0-9-]+$/.test(name))
export const selfFixEnabled=()=>giverSettings().selfFix===true
function withoutRetiredSettings(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))return value
 const {allowedModels:_retired,...rest}=value as Record<string,unknown>
 return Object.fromEntries(Object.entries(rest).filter(([name])=>currentName(name)!==null))
}
function valid(value:unknown):value is GiverSettings {
 if(!value||typeof value!=='object'||Array.isArray(value))return false
 const row=value as GiverSettings
 return Object.keys(row).every(key=>['version','computerUse','checkItWorks','pacing','selfFix'].includes(key))&&row.version===1&&(row.computerUse===undefined||validComputerUse(row.computerUse))&&(row.checkItWorks===undefined||typeof row.checkItWorks==='boolean')&&(row.pacing===undefined||validPacing(row.pacing))&&(row.selfFix===undefined||typeof row.selfFix==='boolean')
}
const GIVER_SECTION:SettingsSection<GiverSettings>={
 name:'giver',
 check(saved){
  const value=saved===undefined?{version:1}:withoutRetiredSettings(saved)
  if(!valid(value))throw new QuestError('GIVER_SETTINGS_INVALID','Repair the saved computer-use servers and inference pacing in Agent settings')
  return value
 },
}
export function giverSettings(file=questSettingsFile()):GiverSettings {
 try{return readSettings(GIVER_SECTION,file)}catch{throw new QuestError('GIVER_SETTINGS_INVALID','Repair the saved computer-use servers and inference pacing in Agent settings')}
}
export function setGiverSettings(input:GiverSettings,file=questSettingsFile()) {
 const value=withoutRetiredSettings(input)
 if(!valid(value))throw new QuestError('GIVER_SETTINGS_INVALID','Name computer-use servers as MCP server names, and pacing with a whole number of workers and a future end')
 return writeSettings(GIVER_SECTION,value,file)
}
export type GiverModelRef={providerID?:string;id?:string;modelID?:string;variant?:string}
export const giverModelIdentity=(model:GiverModelRef|undefined)=>{const id=model?.id??model?.modelID;return model?.providerID&&id?model.providerID+'/'+id+(model.variant?'#'+model.variant:''):undefined}
const chooseInConversation='Choose the model and reasoning effort in the model menu under the message box, then send again'
export function assertGiverModel(model:GiverModelRef|undefined,chosen:boolean) {
 const identity=giverModelIdentity(model)
 if(!identity)throw new QuestError('GIVER_MODEL_UNCHOSEN','The Quest Giver has no model. '+chooseInConversation)
 if(evaluationOnlyProvider(model!.providerID))throw new QuestError('GIVER_MODEL_EVALUATION_ONLY',identity+' answers typed evaluation questions only and cannot be the Quest Giver. '+chooseInConversation)
 if(!chosen)throw new QuestError('GIVER_MODEL_UNCHOSEN','No model has been chosen for the Quest Giver; '+identity+' is only the host default and was not used. '+chooseInConversation)
 return identity
}
