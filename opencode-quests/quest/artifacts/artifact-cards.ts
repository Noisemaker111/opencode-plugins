import {sanitizeArtifactHtml} from './artifact-html'
import type {Artifact} from './artifact-views'

type Result={output?:unknown;content?:unknown;metadata?:Record<string,unknown>}
type ToolEvent={tool?:unknown;sessionID?:unknown;id?:unknown;callID?:unknown;status?:unknown;result?:Result}

export const SHOW_ARTIFACT_TOOL=/(^|[_.])show_artifact$/

export const cardShown=(title:string)=>'Card shown: '+title

function parsed(value:unknown):unknown{
 if(typeof value!=='string')return value
 try{return JSON.parse(value)}catch{return undefined}
}

export function artifactFromResult(result:Result|undefined):Artifact|undefined{
 if(!result)return undefined
 const text=Array.isArray(result.content)?result.content.find((item:any)=>item?.type==='text'&&typeof item.text==='string') as {text:string}|undefined:undefined
 for(const candidate of [parsed(result.output),parsed(text?.text)]){
  const row=candidate as Partial<Artifact>|undefined
  if(!row||typeof row!=='object'||typeof row.title!=='string'||typeof row.html!=='string')continue
  const view=row.view==='quest'||row.view==='usage'?row.view:'html'
  return {title:row.title,view,...(typeof row.questID==='string'?{questID:row.questID}:{}),html:sanitizeArtifactHtml(row.html)}
 }
 return undefined
}

const keyOf=(event:ToolEvent)=>String(event.sessionID??'')+' '+String(event.id??event.callID??'')

export class ArtifactCards{
 private readonly executing=new Map<string,Artifact[]>()

 before(event:ToolEvent){
  if(event.tool==='execute')this.executing.set(keyOf(event),[])
 }

 after(event:ToolEvent){
  const tool=String(event.tool??''),key=keyOf(event),result=event.result
  if(tool==='execute'){
   const cards=this.executing.get(key)
   this.executing.delete(key)
   if(cards?.length&&result)result.metadata={...(result.metadata??{}),artifacts:cards}
   return
  }
  if(!result||event.status==='error'||!SHOW_ARTIFACT_TOOL.test(tool))return
  const artifact=artifactFromResult(result)
  if(!artifact)return
  this.executing.get(key)?.push(artifact)
  result.output=cardShown(artifact.title)
  result.content=[{type:'text',text:cardShown(artifact.title)}]
  result.metadata={...(result.metadata??{}),artifact}
 }
}

export async function installArtifactCards(ctx:{tool?:{hook?:Function}},cards=new ArtifactCards()){
 const hook=ctx?.tool?.hook
 if(typeof hook!=='function')return
 await hook('execute.before',(event:ToolEvent)=>{cards.before(event??{})})
 await hook('execute.after',(event:ToolEvent)=>{cards.after(event??{})})
 return cards
}
