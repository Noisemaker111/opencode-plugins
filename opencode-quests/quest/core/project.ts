import { realpathSync, statSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { createHash } from "node:crypto"

export { traceGitCall } from "../landing/git-steps"
import { driveAsync, driveSync, type GitResult, type GitSteps } from "../landing/git-steps"
function* identityGit(directory:string,args:string[]):GitSteps<GitResult> {
  const result=yield {cwd:directory,args,maxBuffer:262144}
  const code=(result.error as NodeJS.ErrnoException|undefined)?.code
  if(result.timedOut)throw new Error(`Git identity ${args[0]} timed out; source binding was not established. Wait for filesystem load to settle and retry explicitly`)
  if(result.error)throw new Error(`Git identity ${args[0]} capability failed (${code??result.error.name}); verify Git is available and the selected checkout is accessible`)
  if(result.signal)throw new Error(`Git identity ${args[0]} interrupted (${result.signal}); source binding was not established`)
  return result
}

export type ProjectIdentity = { id: string; root: string }
export const physicalDirectory = (directory:string) => {
  if(typeof directory!=="string"||!isAbsolute(directory))throw new Error("An absolute host-derived directory is required")
  const path=realpathSync.native(directory)
  if(!statSync(path).isDirectory())throw new Error("Source directory is unavailable")
  return path
}
export const physicalDirectoryIfPresent = (directory:string) => {
  try{return physicalDirectory(directory)}catch(error){
    if((error as NodeJS.ErrnoException)?.code==="ENOENT")return undefined
    if(error instanceof Error&&error.message==="Source directory is unavailable")return undefined
    throw error
  }
}
export function sourceCheckoutAsync(directory:string, expected?:ProjectIdentity) { return driveAsync(sourceCheckoutSteps(directory,expected)) }
export function* sourceCheckoutSteps(directory:string, expected?:ProjectIdentity):GitSteps<{project:ProjectIdentity;source:string}> {
  const physical=physicalDirectory(directory),project=yield* projectIdentitySteps(physical)
  if(expected&&(project.id!==expected.id||physicalDirectory(project.root)!==physicalDirectory(expected.root)))throw new Error("Source checkout belongs to a different project")
  const out=yield* identityGit(physical,["rev-parse","--show-toplevel"])
  if(out.status!==0)throw new Error("Cannot establish selected Git checkout")
  const source=physicalDirectory(out.stdout.trim())
  return {project,source}
}
export async function verifySourceBinding(context:{project:ProjectIdentity;directory?:string},directory:string) {
  const bound=context.directory&&(process.platform==="win32"?resolve(context.directory).toLowerCase():resolve(context.directory))
  if(!bound||bound!==(process.platform==="win32"?physicalDirectory(directory).toLowerCase():physicalDirectory(directory)))throw new Error("Selected source directory changed; explicitly authorize the destination again")
  const project=await projectIdentityAsync(directory)
  if(project.id!==context.project.id||physicalDirectory(project.root)!==physicalDirectory(context.project.root))throw new Error("Source checkout belongs to a different project")
}
type CachedIdentity = { stamp: string; root: string; configPaths:string[] }
const identityCache = new Map<string, CachedIdentity>()
const configDefaults = new Map<string, string[]>()
const configDefaultsKey = () => JSON.stringify(["GIT_CONFIG_SYSTEM","GIT_CONFIG_GLOBAL","GIT_CONFIG_NOSYSTEM","HOME","USERPROFILE","HOMEDRIVE","HOMEPATH","XDG_CONFIG_HOME","PATH","GIT_EXEC_PATH","PREFIX"].map(key=>[key,process.env[key]??""]))
export type ProjectIdentityMemory = { identities: [string, CachedIdentity][]; defaults: [string, string[]][] }
export function projectIdentityMemory(): ProjectIdentityMemory { return { identities: [...identityCache], defaults: [...configDefaults] } }
export function rememberProjectIdentities(memory: ProjectIdentityMemory | undefined) {
  for (const [key, value] of memory?.identities ?? []) if (!identityCache.has(key)) identityCache.set(key, value)
  for (const [key, value] of memory?.defaults ?? []) if (!configDefaults.has(key)) configDefaults.set(key, value)
}
export function gitMetadataDirectory(directory: string): string | undefined {
  for (let ancestor = directory;; ancestor = dirname(ancestor)) {
    try { statSync(join(ancestor, ".git")); return ancestor }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error }
    try { if (statSync(join(ancestor, "HEAD")).isFile() && statSync(join(ancestor, "objects")).isDirectory()) return ancestor }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error }
    if (dirname(ancestor) === ancestor) return undefined
  }
}
const pathKey = (path:string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)
type MetadataText = { version: string; text: string; digest: string; includes: boolean }
const metadataText = new Map<string, MetadataText>()
function readMetadata(path:string):MetadataText {
  const stat=statSync(path,{throwIfNoEntry:false})
  if(!stat)metadataText.delete(path)
  const version=stat?stat.ino+":"+stat.mtimeMs+":"+stat.ctimeMs+":"+stat.size:"",held=stat&&metadataText.get(path)
  if(held&&held.version===version)return held
  const text=readFileSync(path,"utf8")
  const value={version,text,digest:createHash("sha256").update(text).digest("hex"),includes:/(?:^|\n)\s*\[include(?:If)?(?:\s|\])/i.test(text)}
  if(stat)metadataText.set(path,value)
  return value
}
function gitStamp(directory:string, metadata:string|undefined,configPaths:string[]=[]) {
  const parts:string[]=[]
  let cacheable=!process.env.GIT_CONFIG
  const read=(path:string) => {
    try { const value=readMetadata(path);if(value.includes)cacheable=false;parts.push(pathKey(path),value.digest);return value.text }
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;parts.push(pathKey(path),"missing");return undefined}
  }
  const env=[process.env.GIT_DIR??"",process.env.GIT_WORK_TREE??"",process.env.GIT_COMMON_DIR??""]
  if(Object.entries(process.env).some(([key,value])=>/^GIT_CONFIG_KEY_/.test(key)&&/^include(?:if)?\./i.test(value??"")))cacheable=false
  parts.push(...["HOME","USERPROFILE","XDG_CONFIG_HOME","PATH","GIT_EXEC_PATH"].flatMap(key=>[key,process.env[key]??""]))
  parts.push(...env,...Object.keys(process.env).filter(key=>/^GIT_CONFIG(?:_|$)/.test(key)).sort().flatMap(key=>[key,process.env[key]??"",]))
  for(const key of ["GIT_CONFIG","GIT_CONFIG_GLOBAL","GIT_CONFIG_SYSTEM"]){const path=process.env[key];if(path)read(resolve(directory,path))}
  const home=process.env.HOME??process.env.USERPROFILE
  if(home){read(join(home,".gitconfig"));read(join(process.env.XDG_CONFIG_HOME||join(home,".config"),"git","config"))}
  for(const path of configPaths)read(path)
  let gitdir:string|undefined
  if(env[0])gitdir=physicalDirectory(resolve(directory,env[0]))
  else if(metadata){
    const entry=join(metadata,".git")
    let entryStat:ReturnType<typeof statSync>|undefined
    try{entryStat=statSync(entry)}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}
    if(entryStat?.isDirectory())gitdir=physicalDirectory(entry)
    else if(entryStat){const text=read(entry);const match=text?.trim().match(/^gitdir: (.+)$/);if(!match)throw Error("Invalid Git directory binding");gitdir=physicalDirectory(resolve(metadata,match[1]))}
    else gitdir=physicalDirectory(metadata)
  }
  if(!gitdir)return JSON.stringify(parts)
  parts.push(pathKey(gitdir))
  const commonBinding=read(join(gitdir,"commondir"))
  const common=physicalDirectory(env[2]?resolve(directory,env[2]):commonBinding?resolve(gitdir,commonBinding.trim()):gitdir)
  parts.push(pathKey(common))
  for(const base of new Set([gitdir,common]))for(const name of ["config","config.worktree","gitdir"])read(join(base,name))
  return (cacheable?"":"uncached:")+createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}
export function clearProjectIdentityCache() { identityCache.clear(); metadataText.clear(); configDefaults.clear() }

export function projectIdentity(directory: string): ProjectIdentity { return driveSync(projectIdentitySteps(directory)) }
export function projectIdentityAsync(directory: string): Promise<ProjectIdentity> { return driveAsync(projectIdentitySteps(directory)) }
export function projectIdentityWithoutGit(directory: string): ProjectIdentity | undefined {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return undefined
  const root = physicalDirectory(directory)
  try { return statSync(join(root, ".git")).isDirectory() ? { id: identityHash(root), root } : undefined } catch { return undefined }
}
const BINDING_CHANGED = "Git repository binding changed during discovery"
const DISCOVERY_ATTEMPTS = 3
export function* projectIdentitySteps(directory: string): GitSteps<ProjectIdentity> {
  for (let attempt = 1; ; attempt++) {
    try { return yield* projectIdentityAttempt(directory) }
    catch (error) { if (attempt >= DISCOVERY_ATTEMPTS || !(error instanceof Error) || !error.message.startsWith(BINDING_CHANGED)) throw error }
  }
}
function* projectIdentityAttempt(directory: string): GitSteps<ProjectIdentity> {
  if (typeof directory !== "string" || !isAbsolute(directory)) throw new Error("Project requires an absolute trusted session directory")
  const queried = physicalDirectory(directory)
  let root = queried
  if (!statSync(root).isDirectory()) throw new Error("Project directory is unavailable")
  const metadata = gitMetadataDirectory(queried)
  if (!metadata && !process.env.GIT_DIR && !process.env.GIT_WORK_TREE && !process.env.GIT_COMMON_DIR) return { id: identityHash(queried), root: queried }
  const key=pathKey(metadata&&!process.env.GIT_DIR&&!process.env.GIT_WORK_TREE&&!process.env.GIT_COMMON_DIR?metadata:queried),cached = identityCache.get(key)
  const cachedStamp=gitStamp(queried,metadata,cached?.configPaths)
  if (!cachedStamp.startsWith("uncached:") && cached && cached.stamp === cachedStamp) { physicalDirectory(cached.root); return { id: identityHash(cached.root), root: cached.root } }
  const origins=yield* identityGit(queried,["config","--show-origin","--null","--name-only","--list"])
  if(origins.status!==0)throw Error("Cannot establish Git configuration origins")
  const configPaths=origins.stdout.split("\0").filter((_,index)=>index%2===0).filter(origin=>origin.startsWith("file:")).map(origin=>resolve(queried,origin.slice(5)))
  const defaultsKey=configDefaultsKey()
  let defaultPaths=configDefaults.get(defaultsKey)
  if(!defaultPaths){
    const found:string[]=[]
    for(const variable of ["GIT_CONFIG_SYSTEM","GIT_CONFIG_GLOBAL"]){
      const defaults=yield* identityGit(queried,["var",variable])
      if(defaults.status!==0&&defaults.status!==1)throw Error("Cannot establish Git default configuration paths")
      if(defaults.status===0)found.push(...defaults.stdout.trim().split("\n").filter(Boolean).map(path=>path.trim()))
    }
    configDefaults.set(defaultsKey,defaultPaths=found)
  }
  configPaths.push(...defaultPaths.map(path=>resolve(queried,path)))
  const stamp=gitStamp(queried,metadata,configPaths)
  const git = yield* identityGit(root,["rev-parse", "--is-inside-work-tree"])
  if (git.status === 0 && git.stdout.trim() === "true") {
    const listing = yield* identityGit(root,["worktree", "list", "--porcelain", "-z"])
    if (listing.status !== 0) throw new Error("Cannot resolve the owning Git project")
    const first = listing.stdout.split("\0").find(line => line.startsWith("worktree "))?.slice(9)
    if (!first || !isAbsolute(first)) throw new Error("Git did not report the main project path")
    root = physicalDirectory(first)
  } else if (git.error || (git.status !== 0 && !/not a git repository/i.test(git.stderr))) {
    throw new Error("Cannot establish Git project identity; check repository access")
  }
  const finalStamp=gitStamp(queried,metadata,configPaths)
  if(finalStamp!==stamp)throw Error(BINDING_CHANGED + "; explicitly retry after the change settles")
  if(git.status===0&&!stamp.startsWith("uncached:"))identityCache.set(key, { stamp, root, configPaths })
  return { id: identityHash(root), root }
}
const identityHash = (root: string) => createHash("sha256").update(process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root)).digest("hex")
