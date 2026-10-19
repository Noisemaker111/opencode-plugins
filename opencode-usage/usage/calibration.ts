import { createHash } from "node:crypto"
import { outputIncludingReasoning, type RequestRecord } from "./telemetry"
export type Observation = { id: string; accountID: string; windowID: string; at: number; usedPoints: number; resetAt: number | null; regime: string; precisionPoints: number | null; reportingDelayMilliseconds: number | null; replenishing?: boolean }
export type CalibrationSample = { id: string; accountID: string; windowID: string; regime: string; routeKey: string; sessionIDs: string[]; requestIDs: string[]; from: number; to: number; features: number[]; points: { low: number; high: number }; provenance: "provider-observed" }
export const routeKey = (r: RequestRecord) => {const v=r.route;return JSON.stringify([v.providerID,v.modelID,v.reasoning??v.variant??"unknown",v.variant??v.reasoning??"unknown",v.harness??"native",v.serviceTier??"default"])}
export function canonicalRouteKey(key:string){try{const value=JSON.parse(key);return Array.isArray(value)?JSON.stringify(value):routeKey({route:value} as RequestRecord)}catch{return key}}
export function tokenFeatures(r: RequestRecord): number[] | null {
  const t = r.tokens, output = outputIncludingReasoning(r)
  return [t.input,t.cacheRead,t.cacheWrite,output].some(n => n === null || !Number.isFinite(n) || n! < 0) ? null : [t.input!,t.cacheRead!,t.cacheWrite!,output!]
}
export function pairInterval(before: Observation, after: Observation, records: RequestRecord[], coverage: { complete: boolean; externalActivity: boolean | "unknown" }) {
  const reject = (reason: string) => ({ sample: null, reason })
  if ([before,after].some(o=>!Number.isFinite(o.at)||!Number.isFinite(o.usedPoints)||o.usedPoints<0||o.usedPoints>100||o.precisionPoints!==null&&(!Number.isFinite(o.precisionPoints)||o.precisionPoints<0)||o.reportingDelayMilliseconds!==null&&(!Number.isFinite(o.reportingDelayMilliseconds)||o.reportingDelayMilliseconds<0))) return reject("Invalid observation")
  if (!coverage.complete || coverage.externalActivity !== false) return reject("Account activity coverage is incomplete")
  if (before.accountID !== after.accountID || before.windowID !== after.windowID || before.regime !== after.regime) return reject("Account, window or plan regime changed")
  if (before.resetAt !== after.resetAt || before.resetAt === null || before.resetAt <= after.at || before.replenishing || after.replenishing) return reject("Reset or replenishment crosses interval")
  if (!(after.at > before.at) || before.precisionPoints === null || after.precisionPoints === null || before.reportingDelayMilliseconds === null || after.reportingDelayMilliseconds === null) return reject("Observation timing or precision is unknown")
  const delay = Math.max(before.reportingDelayMilliseconds,after.reportingDelayMilliseconds)
  const all = [...new Map(records.map(r=>[r.id,r])).values()].filter(r=>r.accountID === before.accountID)
  const rows = all.filter(r=>r.startedAt >= before.at && r.startedAt < after.at)
  if (!rows.length || all.some(r=>r.startedAt < before.at && (r.completedAt === undefined || r.completedAt+delay > before.at)) || rows.some(r=>r.completedAt === undefined || r.completedAt+delay > after.at)) return reject("Requests are unsettled at interval boundaries")
  if (new Set(rows.map(routeKey)).size !== 1) return reject("Mixed routes require separate identifiable samples")
  const features = rows.map(tokenFeatures)
  if (features.some(f=>f === null)) return reject("Actual token components are missing")
  const uncertainty = (before.precisionPoints+after.precisionPoints)/2, delta = after.usedPoints-before.usedPoints
  if (delta < -uncertainty) return reject("Counter decreased without an identified reset")
  if (delta <= uncertainty) return reject("Rounded movement is unresolved; combine a longer quiet interval")
  return { sample: { id: before.id+":"+after.id, accountID: before.accountID, windowID: before.windowID, regime: before.regime, routeKey: routeKey(rows[0]), sessionIDs: [...new Set(rows.map(r=>r.sessionID))], requestIDs: rows.map(r=>r.id), from:before.at,to:after.at,features: [0,1,2,3].map(i=>features.reduce((n,f)=>n+f![i],0)), points:{low:Math.max(0,delta-uncertainty),high:delta+uncertainty},provenance:"provider-observed" } as CalibrationSample, reason:null }
}
const dot=(a:number[],b:number[])=>a.reduce((n,v,i)=>n+v*b[i],0)
function solve(a:number[][], b:number[]): number[] | null {
  const m=a.map((r,i)=>[...r,b[i]]),n=b.length
  for(let i=0;i<n;i++) { let pivot=i; for(let j=i+1;j<n;j++) if(Math.abs(m[j][i])>Math.abs(m[pivot][i])) pivot=j
    if(Math.abs(m[pivot][i])<1e-9) return null
    ;[m[i],m[pivot]]=[m[pivot],m[i]];const v=m[i][i];for(let k=i;k<=n;k++)m[i][k]/=v
    for(let j=0;j<n;j++)if(j!==i){const f=m[j][i];for(let k=i;k<=n;k++)m[j][k]-=f*m[i][k]}
  } return m.map(r=>r[n])
}
export type Calibration = { version:string; accountID:string;windowID:string;regime:string;routeKey:string;trainedAt:number; validUntil?:number; weights:number[]; method:"weighted"|"aggregate-scale"; identifiable:boolean; trainingSamples:number; heldOutSamples:number; trainingRequestIDs:string[]; heldOutRequestIDs:string[]; mixRange:{low:number;high:number}[]; validation:{meanAbsoluteErrorPoints:number; biasPoints:number; intervalCoverage:number; baselineMeanAbsoluteErrorPoints:number; upperErrorPoints:number}; state:"validated"|"drift" }
export function fitCalibration(training:CalibrationSample[],heldOut:CalibrationSample[],options:{now:number;maxAgeMilliseconds:number;maxErrorPoints:number}):Calibration {
  if(!Number.isFinite(options.now)||!Number.isFinite(options.maxAgeMilliseconds)||options.maxAgeMilliseconds<=0||!Number.isFinite(options.maxErrorPoints)||options.maxErrorPoints<0)throw new Error("Invalid calibration age or error policy")
  if(training.length<5||heldOut.length<2)throw new Error("Need at least five training and two later held-out intervals")
  const first=training[0], all=[...training,...heldOut], key=(s:CalibrationSample)=>[s.accountID,s.windowID,s.regime,canonicalRouteKey(s.routeKey)].join("|")
  if (all.some(s=>s.features.length!==4||s.features.some(n=>!Number.isFinite(n)||n<0)||![s.from,s.to,s.points.low,s.points.high].every(Number.isFinite)||s.to<=s.from||s.points.low<0||s.points.high<s.points.low)) throw new Error("Invalid calibration sample")
  if(all.some(s=>key(s)!==key(first)||s.to>options.now||options.now-s.to>options.maxAgeMilliseconds))throw new Error("Calibration regime or age mismatch")
  const trainIDs=new Set(training.flatMap(s=>s.requestIDs)), trainSessions=new Set(training.flatMap(s=>s.sessionIDs))
  if(heldOut.some(s=>s.from<Math.max(...training.map(t=>t.to))||s.requestIDs.some(id=>trainIDs.has(id))||s.sessionIDs.some(id=>trainSessions.has(id))))throw new Error("Validation must use later independent sessions")
  const sorted=[...all].sort((a,b)=>a.from-b.from);if(sorted.some((s,i)=>i>0&&s.from<sorted[i-1].to))throw new Error("Overlapping intervals cannot count as independent samples")
  const scale=[0,1,2,3].map(i=>Math.max(1,...training.map(s=>s.features[i]))), x=training.map(s=>s.features.map((v,i)=>v/scale[i])),y=training.map(s=>(s.points.low+s.points.high)/2)
  const matrix=[0,1,2,3].map(i=>[0,1,2,3].map(j=>x.reduce((n,r)=>n+r[i]*r[j],0))),b=[0,1,2,3].map(i=>x.reduce((n,r,k)=>n+r[i]*y[k],0))
  const identifiable=solve(matrix,b)!==null
  const baseline=training.reduce((n,s,i)=>n+s.features.reduce((a,b)=>a+b,0)*y[i],0)/training.reduce((n,s)=>n+s.features.reduce((a,b)=>a+b,0)**2,0)
  if(!Number.isFinite(baseline))throw new Error("No measured token activity")
  let weights=Array(4).fill(baseline)
  if(identifiable) { let best=Infinity
    for(let mask=1;mask<16;mask++){const active=[0,1,2,3].filter(i=>mask&(1<<i)),v=solve(active.map(i=>active.map(j=>matrix[i][j])),active.map(i=>b[i]));if(!v||v.some(n=>n<0))continue
      const w=[0,0,0,0];active.forEach((i,k)=>w[i]=v[k]/scale[i]);const loss=training.reduce((n,s,i)=>n+(dot(s.features,w)-y[i])**2,0);if(loss<best){best=loss;weights=w}}
  }
  const errors=heldOut.map(s=>dot(s.features,weights)-(s.points.low+s.points.high)/2),bounds=heldOut.map((s,i)=>Math.abs(errors[i])+(s.points.high-s.points.low)/2)
  const mae=errors.reduce((n,e)=>n+Math.abs(e),0)/errors.length, upper=Math.max(...bounds)
  const mixRange=[0,1,2,3].map(i=>{const v=training.map(s=>s.features[i]/s.features.reduce((a,b)=>a+b,0));return {low:Math.min(...v),high:Math.max(...v)}})
  return {version:createHash("sha256").update(JSON.stringify({training,heldOut,weights})).digest("hex").slice(0,16),accountID:first.accountID,windowID:first.windowID,regime:first.regime,routeKey:first.routeKey,trainedAt:options.now,validUntil:options.now+options.maxAgeMilliseconds,weights,method:identifiable?"weighted":"aggregate-scale",identifiable,trainingSamples:training.length,heldOutSamples:heldOut.length,trainingRequestIDs:[...trainIDs],heldOutRequestIDs:heldOut.flatMap(s=>s.requestIDs),mixRange,validation:{meanAbsoluteErrorPoints:mae,biasPoints:errors.reduce((n,e)=>n+e,0)/errors.length,intervalCoverage:heldOut.filter((s,i)=>Math.abs(errors[i])<=(s.points.high-s.points.low)/2).length/heldOut.length,baselineMeanAbsoluteErrorPoints:heldOut.reduce((n,s)=>n+Math.abs(s.features.reduce((a,b)=>a+b,0)*baseline-(s.points.low+s.points.high)/2),0)/heldOut.length,upperErrorPoints:upper},state:upper>options.maxErrorPoints?"drift":"validated"}
}
export function predictAllowance(calibration:Calibration,request:RequestRecord,options:{now:number;maxAgeMilliseconds?:number;regime:string}) {
  const f=tokenFeatures(request)
  const expiry=Math.min(calibration.validUntil??Infinity,options.maxAgeMilliseconds===undefined?Infinity:calibration.trainedAt+options.maxAgeMilliseconds)
  if(!Number.isFinite(expiry)||!Number.isFinite(options.now)||options.now>expiry)return null
  if(calibration.state!=="validated"||calibration.accountID!==request.accountID||canonicalRouteKey(calibration.routeKey)!==routeKey(request)||calibration.regime!==options.regime||options.now<calibration.trainedAt||!f)return null
  const total=f.reduce((a,b)=>a+b,0)
  if(!calibration.identifiable&&total>0&&f.some((v,i)=>v/total<calibration.mixRange[i].low-0.02||v/total>calibration.mixRange[i].high+0.02))return null
  const points=dot(f,calibration.weights),error=calibration.validation.upperErrorPoints
  return {provenance:"calibrated" as const,points,low:Math.max(0,points-error),high:points+error,version:calibration.version,windowID:calibration.windowID,heldOutMeanAbsoluteErrorPoints:calibration.validation.meanAbsoluteErrorPoints}
}
