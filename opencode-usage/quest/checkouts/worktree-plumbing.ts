import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { driveAsync, gitOut, gitRun, type GitSteps } from "../landing/git-steps"
import { usableWorktreeRoot, worktreeRoot } from "./worktree-root.mts"

export const pathKey = (path:string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)
const HOME_MAX_AGE_MS=5_000
const homeCache=new Map<string,{at:number;home:string}>()
let homesHeldForOperation=false
export function clearWorktreeHomeCache(){homeCache.clear()}
export function holdWorktreeHomesForOperation(){homesHeldForOperation=true}
export function* worktreeHomeSteps(root:string,settingRoot:string|undefined=worktreeRoot()):GitSteps<string> {
  const key=pathKey(root),now=Date.now(),cached=homeCache.get(key)
  if(cached&&(homesHeldForOperation||now-cached.at<HOME_MAX_AGE_MS))return cached.home
  const configured=yield {cwd:root,args:["config","--get","quest.worktreeRoot"],timeout:15000}
  const value=configured.status===0?configured.stdout.trim():""
  const usable=value?undefined:usableWorktreeRoot(settingRoot)
  let home:string
  if(value){if(!isAbsolute(value))throw new Error("quest.worktreeRoot must be an absolute path");home=resolve(value)}
  else if(usable)home=usable
  else{
    const common=yield {cwd:root,args:["rev-parse","--path-format=absolute","--git-common-dir"],timeout:15000}
    const dir=common.status===0?common.stdout.trim():""
    home=join(dir&&basename(dir).toLowerCase()===".git"?dirname(resolve(dir)):resolve(root),".claude","worktrees")
  }
  if(homeCache.size>64)for(const [entry,value] of homeCache)if(now-value.at>=HOME_MAX_AGE_MS)homeCache.delete(entry)
  homeCache.set(key,{at:now,home});return home
}
export function declaredWorktreeHome(root:string):Promise<string> { return driveAsync(worktreeHomeSteps(root)) }

export const inside = (root: string, path: string) => { const rel = relative(root, path); return !!rel && !rel.startsWith("..") && !isAbsolute(rel) }
export function git(cwd: string, args: string[]): Promise<string> { return driveAsync(gitOut(cwd, args)) }
export function gitStatus(cwd: string, args: string[]): Promise<number|null> { return driveAsync(gitRun(cwd, args)).then(result => result.status) }
export async function worktreeExclusions(root:string) {
  return (await git(root,["worktree","list","--porcelain","-z"])).split("\0")
    .filter(field=>field.startsWith("worktree ")).map(field=>field.slice(9))
    .filter(path=>inside(resolve(root),resolve(path)))
    .map(path=>":(exclude,literal)"+relative(root,path).replaceAll("\\","/")).sort()
}

const LOCK_PREFIX="Quest run "
export async function lockWorktree(root:string,path:string,runID:string,channel?:string) {
  await git(root,["worktree","lock","--reason",LOCK_PREFIX+runID+(channel?" on "+channel:"")+" owns this checkout",path])
}
export async function questLockReason(root:string,path:string):Promise<string|undefined> {
  const entry=(await git(root,["worktree","list","--porcelain","-z"])).split("\0\0").map(block=>block.split("\0")).find(fields=>fields[0]?.startsWith("worktree ")&&pathKey(fields[0].slice(9))===pathKey(path))
  const locked=entry?.find(field=>field==="locked"||field.startsWith("locked "))
  return locked?.startsWith("locked "+LOCK_PREFIX)?locked.slice(7):undefined
}
export async function unlockQuestWorktree(root:string,path:string):Promise<boolean> {
  if(!await questLockReason(root,path))return false
  await git(root,["worktree","unlock",path])
  return true
}

export async function moveLinkedWorktree(root:string,from:string,to:string) {
  const moved=await driveAsync(gitRun(root,["worktree","move",from,to]))
  if(moved.status===0)return
  if(!/submodule/i.test(moved.stderr??""))throw new Error("Git worktree move failed: "+(moved.stderr||moved.error?.message||"unknown error").trim())
  const listed=await git(from,["submodule","status","--recursive"])
  const modules=(await Promise.all(listed.split(/\r?\n/).map(async line=>{
    const path=/^.[0-9a-f]+ (.+?)(?: \(.*\))?$/.exec(line)?.[1]
    if(!path)return []
    const working=join(from,path),pointer=join(working,".git")
    if(!existsSync(pointer)||!lstatSync(pointer).isFile())return []
    const text=readFileSync(pointer,"utf8"),gitdir=/^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim()
    if(!gitdir)return []
    const moduleDir=resolve(working,gitdir),config=join(moduleDir,"config")
    const worktree=(await driveAsync(gitRun(root,["config","--file",config,"core.worktree"]))).stdout.trim()
    return [{path,text,moduleDir,config,worktree}]
  }))).flat()
  const slash=(path:string)=>path.replaceAll("\\","/")
  renameSync(from,to)
  try {
    await git(root,["worktree","repair",to])
    for(const module of modules){
      const working=join(to,module.path)
      writeFileSync(join(working,".git"),"gitdir: "+slash(relative(working,module.moduleDir))+"\n")
      await git(root,["config","--file",module.config,"core.worktree",slash(relative(module.moduleDir,working))])
    }
    if(pathKey((await git(to,["rev-parse","--show-toplevel"])).trim())!==pathKey(to))throw new Error("Moved worktree does not resolve to its new path")
    for(const module of modules)if(pathKey((await git(join(to,module.path),["rev-parse","--show-toplevel"])).trim())!==pathKey(join(to,module.path)))throw new Error("Moved submodule "+module.path+" does not resolve to its new path")
  } catch(error) {
    try {
      for(const module of modules){
        writeFileSync(join(to,module.path,".git"),module.text)
        if(module.worktree)await git(root,["config","--file",module.config,"core.worktree",module.worktree])
      }
      renameSync(to,from);await git(root,["worktree","repair",from])
    } catch(undo) { throw new Error("Worktree move failed and could not be undone: "+(error instanceof Error?error.message:String(error))+"; undo: "+(undo instanceof Error?undo.message:String(undo))) }
    throw error
  }
}

