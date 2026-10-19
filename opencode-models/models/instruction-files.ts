import {existsSync,readFileSync} from "node:fs"
import {homedir} from "node:os"
import {dirname,isAbsolute,join,relative,resolve,sep} from "node:path"
import {generationFiles} from "../scripts/running-generation.mjs"
import JSON5 from "json5"

export const instructionsConfigFile=()=>{
 const dir=generationFiles()??process.env.OPENCODE_CONFIG_DIR
 return dir&&existsSync(join(dir,"opencode.jsonc"))?join(dir,"opencode.jsonc"):join(import.meta.dir,"..","opencode.jsonc")
}

export function configuredInstructionFiles(file=instructionsConfigFile(),home=homedir()):string[]{
 let config:any
 try{config=JSON5.parse(readFileSync(file,"utf8"))}catch{return []}
 if(!Array.isArray(config?.questInstructions))return []
 return config.questInstructions.flatMap((entry:unknown)=>{
  if(typeof entry!=="string"||!entry.trim()||/^[a-z][a-z0-9+.-]*:\/\//i.test(entry))return []
  const path=entry==="~"?home:/^~[\/\\]/.test(entry)?join(home,entry.slice(2)):entry
  return [isAbsolute(path)?resolve(path):resolve(dirname(file),path)]
 })
}

export function instructionLabel(path:string,root=dirname(instructionsConfigFile())){
 const inside=relative(root,path)
 return inside&&!inside.startsWith("..")&&!isAbsolute(inside)?inside.split(sep).join("/"):path
}

export function appendInstructionFiles(system:any[],paths:string[],label:(path:string)=>string=path=>path){
 const loaded=system.map(part=>typeof part?.text==="string"?part.text:"").join("\n")
 for(const path of paths){
  if(loaded.includes(`Instructions from: ${path}\n`)||loaded.includes(`Instructions from: ${label(path)}\n`))continue
  let content:string
  try{content=readFileSync(path,"utf8").replace(/\r\n/g,"\n")}catch{continue}
  system.push({type:"text",text:`Instructions from: ${label(path)}\n${content}`})
 }
}

export const PROMPT_HOOKS=["context","compaction"] as const

const SESSION_INSTRUCTIONS=Symbol.for("questgiver.session-instructions")
export type SessionInstructions=(sessionID:string)=>string[]|undefined
export function setSessionInstructions(resolve:SessionInstructions|undefined){(globalThis as any)[SESSION_INSTRUCTIONS]=resolve}
function sessionInstructions(sessionID:unknown):string[]|undefined{
 const resolve=(globalThis as any)[SESSION_INSTRUCTIONS] as SessionInstructions|undefined
 if(typeof sessionID!=="string"||!resolve)return
 try{return resolve(sessionID)}catch(error){console.error("[models] session instruction scope unavailable",error instanceof Error?error.message:String(error));return}
}

export async function installInstructionFiles(ctx:any){
 if(typeof ctx.session?.hook!=="function")throw new Error("Configured instruction files need the host context hook")
 const file=instructionsConfigFile(),paths=configuredInstructionFiles(file),root=dirname(file)
 for(const name of PROMPT_HOOKS)await ctx.session.hook(name,(event:any)=>{
  if(!Array.isArray(event.system))return
  const own=sessionInstructions(event.sessionID)
  if(own){appendInstructionFiles(event.system,own);return}
  appendInstructionFiles(event.system,paths,path=>instructionLabel(path,root))
 })
}
