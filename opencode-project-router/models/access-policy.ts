import { hostCatalog } from "./host-catalog"
import {generationFiles} from "../scripts/running-generation.mjs"
import {existsSync,mkdirSync,readFileSync} from "node:fs"
import {writeFileDurable} from "../quest/core/durable-file.mjs"
import {brotliDecompressSync,gunzipSync,inflateSync} from "node:zlib"
import * as zlib from "node:zlib"
import {dirname,join} from "node:path"
import {homedir} from "node:os"
import {verifyOAuthProxy} from "./subscription-policy"
import {bridgeAddress} from "./bridge-ports"
import {contextualError} from '../core/error.mts'
export type AccessPolicy={version:1;selectionRestrictions?:{modelPattern:string;forbiddenReasoning:string[];requireExplicitReasoning?:boolean;reason:string}[];routes:{providerID:string;modelPattern:string;verifyOAuthBroker?:boolean;evaluationOnly?:boolean;transports:{origin:string;pathPrefix:string}[]}[]}
const accessPolicyFile=()=>{
 const generation=generationFiles()
 if(generation)return join(generation,'models','access-policy.json')
 const configured=process.env.OPENCODE_CONFIG_DIR
 return configured&&existsSync(join(configured,'models','access-policy.json'))?join(configured,'models','access-policy.json'):join(import.meta.dirname,'access-policy.json')
}
export function configuredAccess():AccessPolicy{
 const file=process.env.OPENCODE_ACCESS_POLICY??accessPolicyFile()
 let policy:AccessPolicy
 try{policy=JSON.parse(readFileSync(file,'utf8'))}
 catch(cause){throw contextualError(cause,{operation:'load the model access policy',location:file,next:'Restore this policy file or set OPENCODE_ACCESS_POLICY to the intended existing file. No model request was sent.'})}
 if(policy.version!==1||!Array.isArray(policy.routes)||!policy.routes.length)throw contextualError('Invalid access policy; no requests authorized',{operation:'validate the model access policy',location:file,next:'Use version 1 with the allowed routes and transports. Do not disable the access policy.'})
 return {...policy,routes:policy.routes.map(route=>Array.isArray(route.transports)?{...route,transports:route.transports.map(transport=>typeof transport?.origin==='string'?{...transport,origin:bridgeAddress(transport.origin)}:transport)}:route)}
}
export function assertConfiguredModel(model:{providerID:string;id?:string;modelID?:string},policy=configuredAccess()){const id=model.id??model.modelID;if(!model.providerID||!id)throw new Error("Exact model identity is required");const route=policy.routes.find(r=>r.providerID===model.providerID&&new RegExp("^(?:"+r.modelPattern+")$").test(id));if(!route)throw new Error("User access policy does not allow "+model.providerID+"/"+id);return route}
export function evaluationOnlyProvider(providerID:string|undefined,policy?:AccessPolicy){
  if(!providerID)return false
  try{return (policy??configuredAccess()).routes.some(route=>route.providerID===providerID&&route.evaluationOnly===true)}catch{return false}
}
export function assertChatModel(model:{providerID:string;id?:string;modelID?:string},policy?:AccessPolicy){
  if(evaluationOnlyProvider(model.providerID,policy))throw new Error(model.providerID+"/"+(model.id??model.modelID??"")+" answers typed evaluation questions for the model router and permission (Jev) only; it cannot be a chat, giver or worker model")
}
type RequestAuthentication={credential?:unknown;request:Request}
function subscriptionRequest(url:URL,route:AccessPolicy['routes'][number],authentication?:RequestAuthentication){
 if(route.providerID!=='openai'||url.origin!=='https://api.openai.com'||url.pathname!=='/v1/responses'||!authentication)return false
 if(!route.transports.some(t=>t.origin==='https://chatgpt.com'&&t.pathPrefix==='/backend-api/codex/'))return false
 const credential=authentication.credential as {type?:string;methodID?:string;access?:string;expires?:number;metadata?:{clientID?:string;scopes?:string[]}}|undefined
 return credential?.type==='oauth'&&credential.methodID==='chatgpt-token-sharing'&&typeof credential.access==='string'&&!!credential.access&&typeof credential.expires==='number'&&credential.expires>Date.now()&&typeof credential.metadata?.clientID==='string'&&!!credential.metadata.clientID&&Array.isArray(credential.metadata.scopes)&&credential.metadata.scopes.includes('chatgpt.tokens.use.direct')&&authentication.request.headers.get('authorization')==='Bearer '+credential.access
}
export function assertConfiguredRequest(model:{providerID:string;id?:string;modelID?:string},requestURL:string,policy=configuredAccess(),authentication?:RequestAuthentication){
 const route=assertConfiguredModel(model,policy),url=new URL(requestURL)
 if(!route.transports.some(t=>url.origin===t.origin&&url.pathname.startsWith(t.pathPrefix))&&!subscriptionRequest(url,route,authentication)){
  const allowed=route.transports.map(transport=>transport.origin+transport.pathPrefix).join(', ')
  const subscription=model.providerID==='openai'&&url.origin==='https://api.openai.com'
  throw contextualError('Request transport is not allowed by user access policy. Allowed: '+allowed,{operation:'send a model request to '+model.providerID+'/'+(model.id??model.modelID),location:url.origin+url.pathname,next:subscription?'This address needs a verified ChatGPT subscription connection. In Quest Web Settings, Providers, use Sign in with ChatGPT and allow token sharing. API keys remain blocked. An isolated readiness probe has no copied provider login.':'Check this provider connection in Settings, Providers and use an allowed transport. Do not bypass the access policy.'})
 }
 return route
}

export type ModelSelection={providerID:string;id?:string;modelID?:string;variant?:string;reasoning?:string}
const effortAlias=(id:string)=>id.match(/(?:#|-)(none|low|medium|high|xhigh|max)(?:-fast)?$/i)?.[1]?.toLowerCase()
const restrictionsFor=(id:string,policy:AccessPolicy)=>
  (policy.selectionRestrictions??[]).filter(rule=>new RegExp("^(?:"+rule.modelPattern+")$","i").test(id))
export function assertConfiguredSelection(model:ModelSelection,policy=configuredAccess()){
  const id=model.modelID??model.id??""
  const route=assertConfiguredModel({providerID:model.providerID,id},policy)
  const efforts=[model.variant,model.reasoning,effortAlias(id)].filter((x):x is string=>typeof x==="string"&&!!x).map(x=>x.trim().toLowerCase())
  for(const rule of restrictionsFor(id,policy)){
    if(efforts.some(e=>rule.forbiddenReasoning.includes(e)))throw new Error(rule.reason+" ("+model.providerID+"/"+id+"#"+efforts.join(",")+")")
    if(rule.requireExplicitReasoning&&(!efforts.length||efforts.some(e=>["unknown","default","auto"].includes(e))))throw new Error("Explicit permitted reasoning is required for "+model.providerID+"/"+id+"; "+rule.reason)
  }
  return route
}
const DECODERS:Record<string,(bytes:Buffer)=>Buffer>={gzip:gunzipSync,"x-gzip":gunzipSync,deflate:inflateSync,br:brotliDecompressSync,...(typeof (zlib as any).zstdDecompressSync==="function"?{zstd:(zlib as any).zstdDecompressSync}:{})}
export async function requestJSON(request:Request){
  const copy=request.clone(),encodings=(copy.headers.get("content-encoding")??"").toLowerCase().split(",").map(x=>x.trim()).filter(x=>x&&x!=="identity")
  let bytes=Buffer.from(await copy.arrayBuffer())
  for(const encoding of encodings.reverse()){
    const decode=DECODERS[encoding]
    if(!decode)throw new Error("body encoding "+encoding+" cannot be read; content-type "+(copy.headers.get("content-type")??"none")+", "+bytes.length+" bytes")
    bytes=decode(bytes)
  }
  try{return JSON.parse(bytes.toString("utf8"))}
  catch{throw new Error("body is not JSON; content-type "+(copy.headers.get("content-type")??"none")+", encoding "+(encodings.join(",")||"none")+", "+bytes.length+" bytes")}
}
export async function assertRequestSelection(model:ModelSelection,request:Request,policy=configuredAccess()){
  assertConfiguredSelection(model,policy)
  if(!policy.selectionRestrictions?.length||!request.body)return
  let body:any
  try{body=await requestJSON(request)}catch(error){
    if(restrictionsFor(model.id??model.modelID??"",policy).length)throw new Error("Cannot verify reasoning in the outgoing request ("+(error instanceof Error?error.message:String(error))+")")
    return
  }
  const id=typeof body?.model==="string"?body.model:model.id??model.modelID
  const effective=[body?.reasoning_effort,body?.reasoning?.effort].filter((x):x is string=>typeof x==="string"&&!!x)
  for(const candidate of new Set([model.id??model.modelID,id])){
    if(!candidate||!restrictionsFor(candidate,policy).length)continue
    if(!effective.length)assertConfiguredSelection({providerID:model.providerID,id:candidate},policy)
    for(const reasoning of effective)assertConfiguredSelection({providerID:model.providerID,id:candidate,reasoning},policy)
  }
}

export const routeIdentity=(route:string)=>String(route??"").split("#")[0]
export const modelIdentity=(model:{providerID?:string;id?:string;modelID?:string})=>String(model?.providerID??"")+"/"+String(model?.id??model?.modelID??"")

export function requestedAgentRoute(agent?:string,source=process.env.OPENCODE_CONFIG_CONTENT,sessionID?:string,selection=process.env.OPENCODE_LAUNCH_SELECTION):string|undefined{
  if(!agent||typeof source!=="string"||!source)return
  try{
    const config=JSON.parse(source)
    if(selection){
      const launch=JSON.parse(selection)
      if(launch.explicitModel!==true||(typeof launch.sessionID==='string'&&launch.sessionID!==sessionID))return
    }
    if(config.default_agent!==agent)return
    const model=(config.agents??{})[agent]?.model
    return typeof model==="string"&&model.includes("/")?model:undefined
  }catch{return undefined}
}

export function substitutionNotice(requested:string|undefined,actual:string):string|undefined{
  const asked=requested?routeIdentity(requested):undefined
  if(!asked||!actual||asked===actual)return
  return "This session is bound to "+actual+", not the "+asked+" the launch asked for."
    +" Check the selected route and model catalog before continuing; a different binding alone does not establish why it changed."
}

export const substitutedProvider=(requested:string|undefined,actual:string)=>{
  const asked=requested?routeIdentity(requested):undefined
  if(!asked)return false
  return asked.slice(0,asked.indexOf("/"))!==actual.slice(0,actual.indexOf("/"))
}

export type SelectionSource="user-selected"|"task-routed"|"automatic-fallback"|"stale-session"
export type SelectionRecord={route:string;variant?:string;source:SelectionSource;at:string}
export type SelectionLedger=Record<string,SelectionRecord>
export const selectionStateFile=()=>process.env.OPENCODE_MODEL_SELECTION??join(process.env.XDG_STATE_HOME??join(homedir(),".local","state"),"opencode","model-selection.json")
export function readSelectionLedger(file=selectionStateFile()):SelectionLedger{
  try{const parsed=JSON.parse(readFileSync(file,"utf8"));return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{}}catch{return {}}
}
export function readSelection(sessionID:string|undefined,file=selectionStateFile()):SelectionRecord|undefined{
  if(!sessionID)return
  const row=readSelectionLedger(file)[sessionID]
  return row&&typeof row.route==="string"&&typeof row.source==="string"?row:undefined
}
export function recordSelection(sessionID:string|undefined,input:{route:string;variant?:string;source:SelectionSource},file=selectionStateFile()):SelectionRecord|undefined{
  if(!sessionID||!input.route)return
  try{
    const ledger=readSelectionLedger(file),row:SelectionRecord={route:input.route,...(input.variant?{variant:input.variant}:{}),source:input.source,at:new Date().toISOString()}
    ledger[sessionID]=row
    const bounded=Object.entries(ledger).sort((a,b)=>String(a[1]?.at??"").localeCompare(String(b[1]?.at??""))).slice(-500)
    mkdirSync(dirname(file),{recursive:true})
    writeFileDurable(file,JSON.stringify(Object.fromEntries(bounded)))
    return row
  }catch(error){console.error("[models] Could not record the session model selection:",error);return}
}
export function bindingProvenance(input:{requested?:string;actual:string;recorded?:SelectionRecord;requestedResolves?:boolean;sessionCreatedAt?:number;processStartedAt?:number}):{source:SelectionSource;substitution:boolean}{
  const actual=routeIdentity(input.actual),asked=input.requested?routeIdentity(input.requested):undefined
  const recorded=input.recorded?.route?routeIdentity(input.recorded.route):undefined
  const stale=input.sessionCreatedAt!==undefined&&input.processStartedAt!==undefined&&input.sessionCreatedAt<input.processStartedAt
  const carried=input.recorded?.source
  if(!asked||!actual||asked===actual)return {source:carried??(stale?"stale-session":"user-selected"),substitution:false}
  if(recorded&&recorded===actual)return {source:carried??"user-selected",substitution:false}
  if(input.requestedResolves===true)return {source:stale?"stale-session":"user-selected",substitution:false}
  return {source:"automatic-fallback",substitution:true}
}
export function describeSelection(sessionID:string|undefined,actual?:string,file=selectionStateFile()){
  const record=readSelection(sessionID,file),route=routeIdentity(actual??record?.route??"")
  if(!route&&!record)return
  return {route:route||record!.route,variant:record?.variant,source:record?.source,selectedAt:record?.at,selectedByUser:record?.source==="user-selected"}
}

export function refusalNotice(input:{model:{providerID?:string;id?:string;modelID?:string};reason:string;requested?:string}):string{
  const actual=modelIdentity(input.model)
  const head="Nothing was sent to the model, and this prompt was not answered. "+input.reason+"."
  return head+" "+(substitutionNotice(input.requested,actual)??"The session is bound to "+actual+".")
}

export const answersPrompt=(kind:unknown)=>kind===undefined||kind===null||kind==="primary"||kind==="compaction"
export const ANNOUNCE_DELAYS_MS=[0,250,750,1750] as const
export function announcer(sessionApi:{synthetic?:Function}|undefined,delays:readonly number[]=ANNOUNCE_DELAYS_MS){
  const said=new Set<string>()
  return (sessionID:string|undefined,text:string)=>{
    const key=String(sessionID)+" :: "+text
    if(!sessionID||said.has(key))return
    said.add(key)
    if(typeof sessionApi?.synthetic!=="function"){console.error("[models] request refused and ctx.session.synthetic is unavailable to say so:",text);return}
    void (async()=>{
      let last:unknown
      for(const delay of delays){
        if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay))
        try{await sessionApi.synthetic!({sessionID,text,description:text});return}catch(error){last=error}
      }
      console.error("[models] could not deliver a refused-request notice to",sessionID,last,text)
    })()
  }
}

const processStartedAt=()=>Date.now()-process.uptime()*1000
async function sessionStartedAt(sessionApi:{get?:Function}|undefined,sessionID:string|undefined):Promise<number|undefined>{
  if(!sessionID||typeof sessionApi?.get!=="function")return
  try{
    const response=await sessionApi.get({sessionID}),row=response?.data??response
    const created=row?.time?.created??row?.created
    const value=typeof created==="string"?Date.parse(created):typeof created==="number"?created:undefined
    return typeof value==="number"&&Number.isFinite(value)?value:undefined
  }catch{return}
}
async function catalogResolves(catalog:any,route:string|undefined):Promise<boolean|undefined>{
  if(!route)return
  try{
    const list=typeof catalog?.model?.list==="function"?await catalog.model.list():undefined
    const models=list?.data??list
    if(!Array.isArray(models))return
    const [providerID,...rest]=routeIdentity(route).split("/"),id=rest.join("/")
    return models.some((model:any)=>model?.providerID===providerID&&(model?.id===id||model?.modelID===id))
  }catch{return}
}

export async function installAccessGuard(ctx:{session?:{hook?:Function;synthetic?:Function;get?:Function};event?:{subscribe:Function};integration?:{connection:{active:(integrationID:string)=>Promise<any>;resolve:(connection:any)=>Promise<unknown>}};} & import("./host-catalog").CatalogHost){
  if(typeof ctx.session?.hook!=="function")throw new Error("Cannot install configured access policy")
  configuredAccess()
  const announce=announcer(ctx.session)
  const known=new Map<string,SelectionRecord>()
  const selectionFor=(sessionID:string|undefined)=>sessionID?known.get(sessionID)??readSelection(sessionID):undefined
  const remember=(sessionID:string|undefined,input:{route:string;variant?:string;source:SelectionSource})=>{
    if(!sessionID||!input.route)return
    const row:SelectionRecord={route:input.route,...(input.variant?{variant:input.variant}:{}),source:input.source,at:new Date().toISOString()}
    known.set(sessionID,row)
    recordSelection(sessionID,input)
  }
  if(ctx.event?.subscribe){
    const stream=await ctx.event.subscribe({})
    void(async()=>{for await(const event of stream){
      if(event?.type==='session.model.selected'&&event.data?.sessionID){
        const model=event.data.model??{}
        remember(event.data.sessionID,{route:modelIdentity(model),variant:typeof model.variant==="string"?model.variant:undefined,source:'user-selected'})
      }
    }})().catch(error=>console.error('[models] Model selection observation failed',error))
  }
  const evaluate=async(event:any)=>{
    const launchRoute=requestedAgentRoute(event?.agent,undefined,event?.sessionID)
    const actual=modelIdentity(event?.model??{})
    if(!actual||actual==="/")return {launchRoute,actual,decision:undefined}
    const recorded=selectionFor(event?.sessionID)
    const mismatch=!!launchRoute&&routeIdentity(launchRoute)!==actual&&routeIdentity(recorded?.route??"")!==actual
    const decision=bindingProvenance({
      requested:launchRoute,
      actual,
      recorded,
      requestedResolves:mismatch?await catalogResolves(hostCatalog(ctx),launchRoute):undefined,
      sessionCreatedAt:mismatch?await sessionStartedAt(ctx.session,event?.sessionID):undefined,
      processStartedAt:processStartedAt(),
    })
    if(launchRoute&&(!recorded||routeIdentity(recorded.route)!==actual))remember(event?.sessionID,{route:actual,variant:event?.model?.variant,source:decision.source})
    return {launchRoute,actual,decision}
  }
  await ctx.session.hook("context",async(event:any)=>{
    const {launchRoute,actual,decision}=await evaluate(event)
    if(!decision?.substitution||!substitutedProvider(launchRoute,actual))return
    const notice=substitutionNotice(launchRoute,actual)
    if(notice)announce(event?.sessionID,notice)
  })
  await ctx.session.hook("http.request",async(event:any)=>{
    try{
      const policy=configuredAccess()
       let credential:unknown
       if(event.model?.providerID==='openai'&&new URL(event.request.url).origin==='https://api.openai.com'&&ctx.integration?.connection){
         const connection=await ctx.integration.connection.active('openai')
         if(connection)credential=await ctx.integration.connection.resolve(connection)
       }
       const route=assertConfiguredRequest(event.model,event.request.url,policy,{credential,request:event.request})
      await assertRequestSelection(event.model,event.request,policy)
      if(route.verifyOAuthBroker&&new URL(event.request.url).origin!==verifyOAuthProxy().origin)throw new Error("Configured broker origin does not match its verified endpoint")
    }catch(error){
      const reason=error instanceof Error?error.message:String(error)
      if(!answersPrompt(event?.kind)){console.error("[models] refused a",event.kind,"request:",reason);throw error}
      const {launchRoute,decision}=await evaluate(event).catch(()=>({launchRoute:undefined,decision:undefined}))
      announce(event?.sessionID,refusalNotice({model:event?.model??{},reason,requested:decision?.substitution?launchRoute:undefined}))
      throw error
    }
  })
}
