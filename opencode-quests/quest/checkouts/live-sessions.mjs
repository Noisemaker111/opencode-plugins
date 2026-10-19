import {existsSync,readdirSync,readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;if(pid===process.pid)return true;try{process.kill(pid,0);return true}catch(error){return error?.code!=='ESRCH'}}
const json=file=>{try{return JSON.parse(readFileSync(file,'utf8'))}catch{return undefined}}
const list=directory=>{try{return readdirSync(directory)}catch{return []}}

export function liveSessionFolders(home=homedir()){
 const root=join(home,'.claude'),live=list(join(root,'sessions')).filter(name=>name.endsWith('.json')).map(name=>json(join(root,'sessions',name))).filter(session=>session&&alive(session.pid)&&typeof session.sessionId==='string')
 const folders=live.flatMap(session=>typeof session.cwd==='string'?[{path:session.cwd,session:session.sessionId,why:'a live Claude session works here'}]:[])
 const ids=new Set(live.map(session=>session.sessionId))
 for(const project of list(join(root,'projects')))for(const id of ids){
  const subagents=join(root,'projects',project,id,'subagents')
  if(!existsSync(subagents))continue
  for(const name of list(subagents).filter(name=>name.endsWith('.meta.json'))){
   const meta=json(join(subagents,name))
   if(typeof meta?.worktreePath==='string')folders.push({path:meta.worktreePath,session:id,why:'a sub-agent of a live Claude session works here'})
  }
 }
 return folders
}
