import {mkdirSync,unlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {isAbsolute,join,normalize,parse,resolve} from 'node:path'
import {questSettingsFile} from '../config/quest-settings.mjs'
import {readJsonSettings} from '../core/durable-file.mjs'

export const WINDOWS_WORKTREE_ROOT='C:\\qw'
export const WORKTREE_ROOT_OVERRIDE='QUESTGIVER_WORKTREE_ROOT'

const warned=new Set<string>()
function warnOnce(message:string){if(!warned.has(message)){warned.add(message);console.error('[quests] '+message)}}
const reason=(error:unknown)=>error instanceof Error?error.message:String(error)

export function defaultWorktreeRoot(platform:string=process.platform):string{
 return platform==='win32'?WINDOWS_WORKTREE_ROOT:''
}

export function checkWorktreeRoot(value:unknown,platform:string=process.platform):string{
 if(value===undefined)return defaultWorktreeRoot(platform)
 if(typeof value!=='string')throw Error('Invalid Quest worktree root: expected a folder path, or an empty value to turn it off')
 const root=value.trim()
 if(!root)return ''
 if(!isAbsolute(root)||parse(normalize(root)).root===normalize(root))throw Error('Invalid Quest worktree root: use an absolute folder that is not a drive root')
 return root
}

export function worktreeRoot(env:NodeJS.ProcessEnv=process.env,platform:string=process.platform):string|undefined{
 try{
  const override=env[WORKTREE_ROOT_OVERRIDE]
  const root=override!==undefined?override.trim():checkWorktreeRoot((readJsonSettings(questSettingsFile(env)) as {workspace?:{worktreeRoot?:unknown}}|undefined)?.workspace?.worktreeRoot,platform)
  return root?resolve(root):undefined
 }catch(error){
  warnOnce('Quest worktree root setting cannot be read ('+reason(error)+'); checkouts stay under .claude\\worktrees')
  return undefined
 }
}

export function usableWorktreeRoot(root:string|undefined):string|undefined{
 if(!root)return undefined
 try{
  mkdirSync(root,{recursive:true})
  const probe=join(root,'.write-probe-'+process.pid)
  writeFileSync(probe,'')
  unlinkSync(probe)
  return root
 }catch(error){
  warnOnce('Quest worktree root '+root+' cannot be written ('+reason(error)+'); checkouts stay under .claude\\worktrees')
  return undefined
 }
}

export function testTempRoot(root:string|undefined=worktreeRoot()):string{
 const usable=usableWorktreeRoot(root)
 if(!usable)return tmpdir()
 try{const temp=join(usable,'tmp');mkdirSync(temp,{recursive:true});return temp}catch{return tmpdir()}
}
