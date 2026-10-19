import {existsSync,mkdirSync,readFileSync} from "node:fs"
import {dirname} from "node:path"
import {writeFileDurable} from "../quest/core/durable-file.mjs"

export type HostOutage={from:number;to:number;reason:string}
export const hostOutagesFile=(outcomesFile:string)=>outcomesFile+".host-outages.json"

const valid=(o:HostOutage)=>!!o&&Number.isFinite(o.from)&&Number.isFinite(o.to)&&o.from<=o.to&&typeof o.reason==="string"&&o.reason.trim().length>0&&o.reason.length<=300

export function readHostOutages(outcomesFile:string):HostOutage[]{
 const file=hostOutagesFile(outcomesFile)
 if(!existsSync(file))return []
 const data=JSON.parse(readFileSync(file,"utf8")) as {version:1;outages:HostOutage[]}
 if(!data||data.version!==1||!Array.isArray(data.outages)||!data.outages.every(valid))throw Error("Unreadable host outage record "+file)
 return data.outages
}

export function recordHostOutage(outcomesFile:string,outage:HostOutage):HostOutage[]{
 if(!valid(outage))throw Error("A host outage needs a start, an end not before it, and a reason")
 const outages=readHostOutages(outcomesFile)
 if(!outages.some(o=>o.from===outage.from&&o.to===outage.to))outages.push(outage)
 const file=hostOutagesFile(outcomesFile)
 mkdirSync(dirname(file),{recursive:true})
 writeFileDurable(file,JSON.stringify({version:1,outages}),{mode:0o600})
 return outages
}

export const outageAt=(outages:HostOutage[],at:number)=>outages.find(o=>at>=o.from&&at<=o.to)
