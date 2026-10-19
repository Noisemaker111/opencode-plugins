export type ErrorContext={operation:string;location:string;next:string}
export type ErrorDetails=ErrorContext&{reason:string}

function detailsOf(value:unknown):ErrorDetails|undefined{
 if(!value||typeof value!=='object')return
 const details=(value as {context?:unknown}).context
 if(!details||typeof details!=='object')return
 const row=details as Record<string,unknown>
 return ['operation','location','reason','next'].every(key=>typeof row[key]==='string')?details as ErrorDetails:undefined
}

export function redactSensitive(value:string):string{
 return value
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
  .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,'$1[REDACTED]@')
  .replace(/(https?:\/\/[^\s?#]+)[?#][^\s"'<>]*/gi,'$1?[REDACTED]')
  .replace(/\bBearer\s+[^\s"',;]+/gi,'Bearer [REDACTED]')
  .replace(/(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{12,}|gh[oprs]_[A-Za-z0-9_]{20,}|(?:access[_-]?token|refresh[_-]?token|token|secret|password|api[_-]?key|authorization|cookie|qg_session)\s*[:=]\s*[^\s,;]+)/gi,'[REDACTED]')
  .replace(/[\x00-\x1f\x7f]+/g,' ')
}

export function contextualError(cause:unknown,context:ErrorContext){
 const original=cause&&typeof cause==='object'?cause as {message?:unknown;code?:unknown;cause?:unknown;context?:ErrorDetails}:undefined
 const previous=detailsOf(cause)
 const reasons:string[]=[]
 let current:unknown=cause
 const seen=new Set<unknown>()
 for(let depth=0;current&&!seen.has(current)&&depth<3;depth++){
  seen.add(current)
  const row=typeof current==='object'?current as {message?:unknown;code?:unknown;cause?:unknown;context?:ErrorDetails;_tag?:unknown;status?:unknown;error?:unknown}:undefined
  const detail=detailsOf(current)
  const message=detail?.reason??(typeof row?.message==='string'?row.message:typeof current==='string'?current:typeof row?._tag==='string'?row._tag+(typeof row.status==='number'?' (HTTP '+row.status+')':''):'Unknown error')
  const code=typeof row?.code==='string'?row.code:undefined
  const reason=code&&!message.includes(code)?code+': '+message:message
  if(!reasons.includes(reason))reasons.push(reason)
  if(detail)break
  current=row?.cause??row?.error
 }
 if(!reasons.length)reasons.push('Unknown error')
 const details:ErrorDetails={
  operation:redactSensitive(previous?.operation??context.operation),
  location:redactSensitive(previous&&previous.location!==context.location?previous.location+'; reported at '+context.location:context.location),
  reason:redactSensitive(reasons.join(' Caused by: ')),
  next:redactSensitive(previous?.next??context.next),
 }
 const error=new Error(`Failed to ${details.operation}.\nWhere: ${details.location}\nCause: ${details.reason}\nNext: ${details.next}`,{cause})
 return Object.assign(error,{code:typeof original?.code==='string'?original.code:undefined,context:details})
}
