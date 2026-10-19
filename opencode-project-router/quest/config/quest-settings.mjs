import {dirname,isAbsolute,join,normalize,parse,resolve} from 'node:path'
import {homedir} from 'node:os'
import {readJsonSettings,writeFileDurable} from '../core/durable-file.mjs'
import {acquireLock} from '../locking.mts'
import {questRoot} from '../root.mts'

const absolute=(value,name)=>{
 if(!isAbsolute(value)||(process.platform==='win32'&&parse(normalize(value)).root==='\\'))throw Error(name+' must be an absolute path independent of the project directory')
 return normalize(value)
}
export const QUEST_SETTINGS_FILE_NAME='quest.json'
export const questSettingsFileIn=directory=>join(directory,QUEST_SETTINGS_FILE_NAME)
export function questSettingsFile(env=process.env){
 const explicit=(env.OPENCODE_QUEST_SETTINGS??'').trim(),ledger=(env.OPENCODE_QUEST_ROOT??'').trim()
 if(explicit)return questSettingsFileIn(dirname(absolute(explicit,'OPENCODE_QUEST_SETTINGS')))
 if(ledger)return questSettingsFileIn(join(absolute(ledger,'OPENCODE_QUEST_ROOT'),'.opencode'))
 return questSettingsFileIn(join(homedir(),'.config','opencode'))
}

const LEGACY_IMPORTS={
 giver:()=>[join(questRoot(),'.opencode','.quest-runtime','giver-models.json'),v=>v],
 roles:folder=>[join(folder,'roles.json'),v=>v],
 routing:folder=>[join(folder,'routing.json'),v=>v],
 bench:folder=>[join(folder,'bench.json'),v=>v],
 judge:folder=>[join(folder,'router-judge.json'),v=>v],
 'permission-jev':folder=>[join(folder,'permission-allower.json'),v=>v],
 workspace:folder=>[join(folder,'quest-settings.json'),v=>v&&{version:v.version,workspaceMode:v.workspaceMode}],
 delivery:folder=>[join(folder,'quest-settings.json'),v=>v?.delivery],
}
export const LEGACY_SETTINGS_FILES=['quest-settings.json','routing.json','roles.json','router-judge.json','permission-allower.json',join('.quest-runtime','giver-models.json')]
const legacyValue=(name,file)=>{
 const source=LEGACY_IMPORTS[name]?.(dirname(file))
 const raw=source?readJsonSettings(source[0]):undefined
 const local=raw===undefined?undefined:source[1](raw)
 if(local!==undefined)return local
 const runtime=(process.env.OPENCODE_QUEST_ROOT??'').trim()
 if(name!=='delivery'||!runtime||resolve(file)!==resolve(questSettingsFile()))return local
 const global=readJsonSettings(join(homedir(),'.config','opencode',QUEST_SETTINGS_FILE_NAME))
 return global?.delivery
}

const readDocument=file=>{
 const value=readJsonSettings(file)
 return value&&typeof value==='object'&&!Array.isArray(value)?value:{}
}
export function readSettings(section,file=questSettingsFile()){
 const document=readDocument(file)
 if(section.name in document)return section.check(document[section.name])
 return legacyValue(section.name,file)===undefined?section.check(undefined):updateSettings(section,current=>current,file)
}
export function writeSettings(section,value,file=questSettingsFile()){
 return persist(section,file,()=>value)
}
export function updateSettings(section,update,file=questSettingsFile()){
 return persist(section,file,document=>update(section.check(section.name in document?document[section.name]:legacyValue(section.name,file))))
}
function persist(section,file,next){
 const lock=acquireLock(dirname(file),'quest-settings')
 try{
  const document=readDocument(file),value=section.check(next(document))
  writeFileDurable(file,JSON.stringify({...document,[section.name]:value},null,2)+'\n')
  return value
 }finally{lock.release()}
}
