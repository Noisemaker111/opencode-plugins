import {automaticQuestPrompt} from './giver-instruction'

type Resolution={state:string;targets:{directory?:string;root?:string}[]}
const normal=(path:unknown)=>typeof path==='string'?path.split('\\').join('/').replace(/\/+$/,'').toLowerCase():''

function resolutionsIn(value:unknown,found:Resolution[]){
 if(Array.isArray(value)){for(const item of value)resolutionsIn(item,found);return}
 if(!value||typeof value!=='object')return
 const row=value as Record<string,unknown>
 if(typeof row.state==='string'&&['clarify','resolved'].includes(row.state)&&Array.isArray(row.targets)&&row.targets.every(item=>item&&typeof item==='object')){found.push(row as unknown as Resolution);return}
 for(const item of Object.values(row))resolutionsIn(item,found)
}
function resolutionsOf(part:any):Resolution[]{
 if(part?.type!=='tool'||part.state?.status!=='completed'||!/\bproject_resolve\b/.test(String(part.state.input?.code??part.input?.code??'')))return []
 const found:Resolution[]=[]
 for(const piece of Array.isArray(part.state.content)?part.state.content:[]){
  if(typeof piece?.text!=='string')continue
  try{resolutionsIn(JSON.parse(piece.text),found)}catch{}
 }
 return found
}
export function projectResolutionsThisTurn(messages:any[],assistantIndex:number):Resolution[]{
 const found:Resolution[]=[]
 for(let i=assistantIndex;i>=0;i--){
  const message=messages[i]
  if(message?.type==='idle'||message?.type==='user'&&!automaticQuestPrompt(message.metadata))break
  if(message?.type!=='assistant'||!Array.isArray(message.content))continue
  for(const part of [...message.content].reverse())found.unshift(...resolutionsOf(part))
 }
 return found
}
export function projectNotChosen(messages:any[],assistantIndex:number,projectRoot:string,giverRoot:string|undefined):string|undefined{
 const resolutions=projectResolutionsThisTurn(messages,assistantIndex)
 if(!resolutions.some(row=>row.state==='clarify'))return undefined
 const chosen=normal(projectRoot)
 if(chosen&&chosen===normal(giverRoot))return undefined
 const resolved=resolutions.filter(row=>row.state==='resolved').flatMap(row=>row.targets.flatMap(target=>[normal(target.directory),normal(target.root)]))
 if(resolved.includes(chosen))return undefined
 return 'No Quest was created. project_resolve answered clarify, so no project stands out, and '+projectRoot+' is not one it resolved. If the request is about Quest Giver itself, use the project you run from'+(giverRoot?' ('+giverRoot+')':'')+'. Otherwise ask the user with 2-4 of its candidates, then call project_resolve with selectors set to the directory they pick and create from that resolved target.'
}
