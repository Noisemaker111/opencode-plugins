import {basename} from 'node:path'
import {ROLES,roleSettings,type Role,type RoleSelection,type RoleSettings} from './role-settings'
import {questSettingsFile,type SettingsSection} from '../config/quest-settings.mjs'
import {evaluationSettings,type EvaluationSettings} from './evaluation-settings'
import {JUDGE_SECTION} from './model-router'
import {PERMISSION_JEV_SECTION} from '../permissions/permission-jev'

export type RoleRow={role:Role;selection:RoleSelection|null;source:string}
export type RolesAnswer={settingsFile:string;settings:RoleSettings;roles:RoleRow[]}

const fromIdentity=(identity:string):RoleSelection=>{const [model,effort]=identity.split('#');return {model,...(effort?{effort}:{})}}
function evaluationFallback(section:SettingsSection<EvaluationSettings>,file:string):Omit<RoleRow,'role'>{
 try{const saved=evaluationSettings(section,file);return saved.model?{selection:fromIdentity(saved.model),source:basename(file)}:{selection:null,source:'automatic'}}
 catch{return {selection:null,source:basename(file)+' could not be read'}}
}
function fallback(role:Role,settings:RoleSettings):Omit<RoleRow,'role'>{
 if(role==='worker')return {selection:null,source:'automatic'}
 if(role==='model-router')return evaluationFallback(JUDGE_SECTION,questSettingsFile())
 if(role==='permission-jev')return evaluationFallback(PERMISSION_JEV_SECTION,questSettingsFile())
 if(role==='giver')return {selection:null,source:'model menu'}
 return {selection:null,source:'unset'}
}
export function rolesAnswer(settings:RoleSettings,file=questSettingsFile()):RolesAnswer{
 return {settingsFile:file,settings,roles:ROLES.map(role=>{const set=settings.roles[role];return set?{role,selection:set,source:'set'}:{role,...fallback(role,settings)}})}
}
export const readRoles=(file=questSettingsFile())=>rolesAnswer(roleSettings(file),file)
