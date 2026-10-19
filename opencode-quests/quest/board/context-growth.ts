import type {RequestRecord} from '../../usage/telemetry'

export type ContextTurn={at:number;context:number;fixed:number;history:number;route:string}
export type ContextGrowth={sessionID:string;turns:number;first:number|null;last:number|null;peak:number|null;fixed:number|null;history:number|null;growthPerTurn:number|null;series:ContextTurn[]}

const promptTokens=(r:RequestRecord)=>{
 if(typeof r.context?.tokens==='number'&&Number.isFinite(r.context.tokens))return r.context.tokens
 const {input,cacheRead,cacheWrite}=r.tokens
 return input===null||cacheRead===null||cacheWrite===null?null:input+cacheRead+cacheWrite
}
const fixedTokens=(r:RequestRecord)=>{
 const parts=r.composition?.parts
 if(!Array.isArray(parts)||!parts.length)return null
 return parts.filter(part=>part.kind==='system'||part.kind==='tool').reduce((sum,part)=>sum+(Number.isFinite(part.tokens)?part.tokens:0),0)
}

export function contextGrowth(sessionID:string,records:RequestRecord[]):ContextGrowth{
 const rows=records.filter(r=>r.sessionID===sessionID&&r.state!=='running').map(r=>({r,context:promptTokens(r)})).filter((row):row is {r:RequestRecord;context:number}=>row.context!==null).sort((a,b)=>a.r.startedAt-b.r.startedAt)
 if(!rows.length)return {sessionID,turns:0,first:null,last:null,peak:null,fixed:null,history:null,growthPerTurn:null,series:[]}
 const measuredFixed=rows.map(row=>fixedTokens(row.r)).filter((value):value is number=>value!==null)
 const fixed=measuredFixed.length?Math.min(...measuredFixed):rows[0].context
 const series=rows.map(({r,context})=>{const own=fixedTokens(r)??fixed;return {at:r.startedAt,context,fixed:own,history:Math.max(0,context-own),route:r.route.providerID+'/'+r.route.modelID+(r.route.variant?'#'+r.route.variant:'')}})
 const first=series[0].context,last=series.at(-1)!.context
 return {sessionID,turns:series.length,first,last,peak:Math.max(...series.map(row=>row.context)),fixed,history:Math.max(0,last-fixed),growthPerTurn:series.length>1?Math.round((last-first)/(series.length-1)):null,series}
}

export function historyOverBudget(growth:ContextGrowth,budget:number|undefined){
 return budget!==undefined&&growth.history!==null&&growth.history>budget
}
