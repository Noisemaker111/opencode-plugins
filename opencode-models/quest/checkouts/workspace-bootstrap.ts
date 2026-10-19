import {existsSync,readFileSync} from 'node:fs'
import {dirname,isAbsolute,join,relative,resolve} from 'node:path'
import {driveAsync,gitRun} from '../landing/git-steps'

export type BootstrapStep={argv:string[];cwd?:string;description:string;timeoutMilliseconds?:number;kind?:'submodule'|'install';paths?:string[];workspaces?:boolean}
export type BootstrapDeclaration=string[]|BootstrapStep[]

const SUBMODULE_TIMEOUT_MS=900_000
const INSTALL_TIMEOUT_MS=600_000
const STEP_TIMEOUT_MS=120_000
const IGNORED_SEGMENTS=new Set(['node_modules','.git','.claude','.worktrees','.channels','.evidence','.visual-e2e','generations','dist','build','coverage','run','tmp','.cache'])

const isSteps=(value:BootstrapDeclaration|undefined):value is BootstrapStep[]=>!!value?.length&&typeof value[0]==='object'
function declaredStep(entry:unknown,index:number):BootstrapStep {
  if(Array.isArray(entry)){
    const argv=entry.filter((part):part is string=>typeof part==='string')
    if(!argv.length||argv.length!==entry.length)throw Error('quest.bootstrap entry '+(index+1)+' must be an array of nonempty command words')
    return {argv,description:'quest.bootstrap entry '+(index+1)}
  }
  const value=entry as {argv?:unknown;cwd?:unknown;description?:unknown;timeoutMilliseconds?:unknown}|null
  const argv=Array.isArray(value?.argv)?value!.argv.filter((part):part is string=>typeof part==='string'&&!!part.trim()):[]
  if(!argv.length||argv.length!==(value!.argv as unknown[]).length)throw Error('quest.bootstrap entry '+(index+1)+' must name argv as an array of nonempty strings')
  if(value!.cwd!==undefined&&(typeof value!.cwd!=='string'||!value!.cwd.trim()||isAbsolute(value!.cwd)||relative('.',value!.cwd).startsWith('..')))throw Error('quest.bootstrap entry '+(index+1)+' cwd must be a relative path inside the worktree')
  if(value!.timeoutMilliseconds!==undefined&&(typeof value!.timeoutMilliseconds!=='number'||!Number.isFinite(value!.timeoutMilliseconds)||value!.timeoutMilliseconds<=0))throw Error('quest.bootstrap entry '+(index+1)+' timeoutMilliseconds must be a positive number')
  return {argv,description:typeof value!.description==='string'&&value!.description.trim()?value!.description.trim():'quest.bootstrap entry '+(index+1),...(typeof value!.cwd==='string'?{cwd:value!.cwd}:{}) ,...(typeof value!.timeoutMilliseconds==='number'?{timeoutMilliseconds:value!.timeoutMilliseconds}:{})}
}

const committedFile=async(directory:string,name:string)=>existsSync(join(directory,name))&&(await driveAsync(gitRun(directory,['cat-file','-e','HEAD:./'+name],15000))).status===0
async function installer(directory:string,pkg:Record<string,any>):Promise<string[]|undefined> {
  const committed=async(names:string[])=>{for(const name of names)if(await committedFile(directory,name))return true;return false}
  const declared=typeof pkg.packageManager==='string'?String(pkg.packageManager).split('@')[0].toLowerCase():undefined
  if((declared===undefined||declared==='bun')&&await committed(['bun.lock','bun.lockb']))return ['bun','install','--frozen-lockfile']
  if((declared===undefined||declared==='pnpm')&&await committed(['pnpm-lock.yaml']))return ['pnpm','install','--frozen-lockfile']
  if((declared===undefined||declared==='yarn')&&await committed(['yarn.lock']))return ['yarn','install','--immutable']
  if((declared===undefined||declared==='npm')&&await committed(['package-lock.json']))return ['npm','ci']
  return undefined
}

async function submoduleDeclarations(directory:string):Promise<{name:string;path?:string;url?:string}[]> {
  const listed=await driveAsync(gitRun(directory,['config','--file','.gitmodules','--get-regexp','^submodule\\..*\\.(path|url)$'],15000))
  if(listed.status!==0)return []
  const byName=new Map<string,{name:string;path?:string;url?:string}>()
  for(const line of listed.stdout.split(/\r?\n/)){
    const match=/^submodule\.(.+)\.(path|url)\s+(.+)$/.exec(line.trim())
    if(!match)continue
    const entry=byName.get(match[1]!)??byName.set(match[1]!,{name:match[1]!}).get(match[1]!)!
    if(match[2]==='path')entry.path=match[3]!.trim().replaceAll('\\','/').replace(/\/+$/,'');else entry.url=match[3]!.trim()
  }
  return [...byName.values()]
}
const standalone=(url:string)=>/^[a-z][a-z0-9+.-]*:\/\//i.test(url)||/^[^/\\:]+@[^:]+:/.test(url)||isAbsolute(url)

async function submoduleStep(directory:string,onDemand:string[]):Promise<BootstrapStep|undefined> {
  const all=await submoduleDeclarations(directory),skipped=new Set(onDemand.map(clean))
  const declared=all.filter(({path})=>!path||!skipped.has(clean(path)))
  if(!declared.length)return
  const urls=declared.flatMap(({name,url})=>url&&standalone(url)?['-c','submodule.'+name+'.url='+url]:[])
  const only=declared.length<all.length?['--',...declared.flatMap(({path})=>path?[path]:[])]:[]
  return {argv:['git','-c','core.longpaths=true',...urls,'submodule','update','--init','--recursive',...only],description:'initialize declared submodules',timeoutMilliseconds:SUBMODULE_TIMEOUT_MS,kind:'submodule',paths:declared.flatMap(({path})=>path?[path]:[])}
}

function onDemandSubmodules(directory:string):string[] {
  let pkg:Record<string,any>
  try{pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'))}catch{return []}
  const declared=(pkg.quest as Record<string,unknown>|undefined)?.submodulesOnDemand
  if(declared===undefined)return []
  if(!Array.isArray(declared)||declared.some(path=>typeof path!=='string'||!path.trim()))throw Error('quest.submodulesOnDemand must list submodule paths')
  return declared as string[]
}

const clean=(path:string)=>path.replaceAll('\\','/').replace(/^(\.\/)+/,'').replace(/\/+$/,'')
const within=(a:string,b:string)=>b===''||a===b||a.startsWith(b+'/')
const overlaps=(a:string,b:string)=>within(a,b)||within(b,a)

export function neededPreparation(steps:BootstrapStep[],files?:string[]):{run:BootstrapStep[];skipped:BootstrapStep[]} {
  const prefixes=(files??[]).map(file=>clean(file.split(/[*?[{]/)[0]!))
  if(!prefixes.length||prefixes.some(prefix=>prefix===''||prefix==='.'))return {run:steps,skipped:[]}
  const keep=steps.map(step=>step.kind==='submodule'||!step.cwd||prefixes.some(prefix=>overlaps(prefix,clean(step.cwd!))))
  steps.forEach((step,index)=>{
    if(step.kind!=='submodule')return
    const paths=(step.paths??[]).map(clean)
    keep[index]=!paths.length||paths.some(path=>prefixes.some(prefix=>overlaps(prefix,path))||steps.some((other,at)=>{
      if(!keep[at]||other.kind==='submodule')return false
      const folder=clean(other.cwd??'')
      return other.kind==='install'?within(folder,path)||(!!other.workspaces&&within(path,folder)):overlaps(folder,path)
    }))
  })
  return {run:steps.filter((_,index)=>keep[index]),skipped:steps.filter((_,index)=>!keep[index])}
}

async function manifestPaths(directory:string):Promise<string[]> {
  const listed=await driveAsync(gitRun(directory,['ls-files','-z','--','*package.json']))
  if(listed.status!==0)return []
  return listed.stdout.split('\0').filter(Boolean)
}

export async function workspaceBootstrap(directory:string,configured?:BootstrapDeclaration):Promise<BootstrapStep[]> {
  if(isSteps(configured))return configured
  if(configured?.length&&typeof configured[0]==='string')return [{argv:configured as string[],description:'configured policy bootstrap'}]
  const steps:BootstrapStep[]=[]
  if(existsSync(join(directory,'.gitmodules'))){const step=await submoduleStep(directory,onDemandSubmodules(directory));if(step)steps.push(step)}
  if(await committedFile(directory,'pyproject.toml')&&await committedFile(directory,'uv.lock'))steps.push({argv:['uv','sync','--locked'],description:'restore the declared Python environment',timeoutMilliseconds:INSTALL_TIMEOUT_MS,kind:'install'})
  const manifests=await manifestPaths(directory)
  if(!manifests.includes('package.json'))return steps
  const root=JSON.parse(readFileSync(join(directory,'package.json'),'utf8')) as Record<string,any>
  const declares=(pkg:Record<string,any>)=>Object.keys({...pkg.dependencies,...pkg.devDependencies,...pkg.optionalDependencies}).length>0||!!pkg.workspaces
  const installAt=async(relativeDirectory:string,pkg:Record<string,any>)=>{
    if(!declares(pkg))return
    const argv=await installer(join(directory,relativeDirectory),pkg)
    if(argv)steps.push({argv,description:'install dependencies in '+(relativeDirectory||'.'),timeoutMilliseconds:INSTALL_TIMEOUT_MS,...(relativeDirectory?{cwd:relativeDirectory}:{}),kind:'install',...(pkg.workspaces?{workspaces:true}:{})})
    else if(!relativeDirectory)throw Error("Configure this project's preparation before creating an editing worker: package.json declares dependencies, but no supported package manager with a committed lockfile was found")
  }
  await installAt('',root)
  const seen=new Set<string>(['package.json'])
  for(const manifest of manifests){
    const name=manifest.replaceAll('\\','/')
    if(seen.has(name)||!name.endsWith('/package.json'))continue
    const directoryPart=dirname(name)
    if(!directoryPart||directoryPart==='.')continue
    if(directoryPart.split('/').some(part=>IGNORED_SEGMENTS.has(part)))continue
    seen.add(name)
    let pkg:Record<string,any>
    try{pkg=JSON.parse(readFileSync(join(directory,name),'utf8'))}catch(error){throw Error('Declared manifest '+name+' is unreadable: '+(error instanceof Error?error.message:String(error)))}
    await installAt(directoryPart,pkg)
  }
  const declared=(root.quest as Record<string,unknown>|undefined)?.bootstrap
  if(declared!==undefined){
    if(!Array.isArray(declared))throw Error('quest.bootstrap must be an array of commands')
    declared.forEach((entry,index)=>steps.push(declaredStep(entry,index)))
  }
  return steps
}

export function describeBootstrapStep(step:BootstrapStep):string {
  return step.description+' ('+step.argv[0]+')'
}

export const bootstrapStepTimeout=(step:BootstrapStep):number=>step.timeoutMilliseconds??STEP_TIMEOUT_MS
export const bootstrapWorkspacePath=(root:string,step:BootstrapStep):string=>step.cwd?resolve(root,step.cwd):root

export function landingCheck(directory:string):BootstrapStep&{shell:boolean}|undefined {
  let root:Record<string,any>
  try{root=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'))}catch{return}
  const declared=(root.quest as Record<string,unknown>|undefined)?.landingCheck
  if(declared!==undefined){const step=declaredStep(declared,0);return {...step,description:'quest.landingCheck',shell:false}}
  return projectCheck(directory)
}

export function projectCheck(directory:string):BootstrapStep&{shell:boolean}|undefined {
  let root:Record<string,any>
  try{root=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'))}catch{return}
  const declared=(root.quest as Record<string,unknown>|undefined)?.check
  if(declared!==undefined){const step=declaredStep(declared,0);return {...step,description:'quest.check',shell:false}}
  const test=root.scripts?.test
  if(typeof test!=='string'||!test.trim()||/no test specified/.test(test))return
  const named=typeof root.packageManager==='string'?String(root.packageManager).split('@')[0].toLowerCase():undefined
  const locked=[['bun.lock','bun'],['bun.lockb','bun'],['pnpm-lock.yaml','pnpm'],['yarn.lock','yarn'],['package-lock.json','npm']].find(([file])=>existsSync(join(directory,file)))?.[1]
  const manager=['bun','pnpm','yarn','npm'].includes(named??'')?named!:locked??'bun'
  return {argv:[manager,'run','test'],description:'the package test script',shell:process.platform==='win32'&&manager!=='bun'}
}
