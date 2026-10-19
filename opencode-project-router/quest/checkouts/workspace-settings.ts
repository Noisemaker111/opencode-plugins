import {questSettingsFile,readSettings,updateSettings,type SettingsSection} from '../config/quest-settings.mjs'
import {WORK_BRANCH,channelName} from '../channel.mjs'
import {checkWorktreeRoot} from './worktree-root.mts'
export type WorkspaceMode='worktree'|'shared'
export type WorkspaceSettings={version:1;workspaceMode:WorkspaceMode;worktreeRoot:string}
const WORKSPACE_SECTION:SettingsSection<WorkspaceSettings>={
 name:'workspace',
 check(saved){
  if(saved===undefined)return {version:1,workspaceMode:'worktree',worktreeRoot:checkWorktreeRoot(undefined)}
  const row=saved as WorkspaceSettings
  if(row.version!==1||!['worktree','shared'].includes(row.workspaceMode))throw Error('Invalid Quest workspace settings; preserve and repair the configuration')
  return {version:1,workspaceMode:row.workspaceMode,worktreeRoot:checkWorktreeRoot(row.worktreeRoot)}
 },
}
export function workspaceSettings(file=questSettingsFile()):WorkspaceSettings{return readSettings(WORKSPACE_SECTION,file)}
export function setWorkspaceMode(mode:WorkspaceMode,file=questSettingsFile()) {
 if(!['worktree','shared'].includes(mode))throw new Error('Workspace mode must be worktree or shared')
 if(mode==='shared'&&channelName(process.env.OPENCODE_RELEASE_CHANNEL)===WORK_BRANCH)throw new Error('V2 sessions require isolated worktrees; shared checkout mode is unavailable on this channel')
 return {...updateSettings(WORKSPACE_SECTION,current=>({...current,workspaceMode:mode}),file),appliesTo:'future runs; existing workspaces stay in place'}
}
