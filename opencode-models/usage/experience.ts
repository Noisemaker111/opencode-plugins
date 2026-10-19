import type { AccountUsage } from "../usage-service/on-computer"
import type { Observation } from "./calibration"
import type { LedgerRow } from "./passive-ledger"
import type { UsageTarget } from "./usage-target"
import type { BurnControl } from "./burn-control"
import { accountRegime } from "./calibration-store"
import { outputIncludingReasoning } from "./telemetry"
import { portfolioPacing } from "./portfolio-pacing"

export type ExperienceQuery = {
  accountID: string; windowID?: string; resetAt?: number | null; regime?: string
  view?: "summary" | "timeline" | "requests"; source?: LedgerRow["source"]
  sessionID?: string; from?: number; to?: number; offset?: number; limit?: number; timeZone?: string
}
export type ExperienceEvidence = {
  now: number; accounts: AccountUsage[]; observations: Observation[]; requests: LedgerRow[]
  targets: UsageTarget[]; controls: BurnControl[]
  collectorAt?: number | null; coverageFrom?: number | null; hostScanAt?: number | null
  counterGaps?: { at: number; sessionID: string }[]; diagnosticCount?: number
}
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)
const number = (n: unknown) => finite(n) && n >= 0 ? n : null
const stamp = (s: string | null | undefined) => { const n = Date.parse(s ?? ""); return finite(n) ? n : null }
const range = (times: number[]) => times.length ? { from: times.reduce((a,b)=>Math.min(a,b)), to: times.reduce((a,b)=>Math.max(a,b)) } : null
const age = (at: number | null, now: number) => at === null || at > now ? null : now-at
const epochKey = (o: Pick<Observation,"regime"|"resetAt">) => JSON.stringify([o.regime,o.resetAt])
const page = <T>(rows: T[], offset: number, limit: number) => ({ total: rows.length, offset, limit, nextOffset: offset+limit<rows.length?offset+limit:null, items: rows.slice(offset,offset+limit) })
export const EXPERIENCE_GAP_MS = 5 * 60_000

export function usageExperience(e: ExperienceEvidence, q: ExperienceQuery) {
  if (!finite(e.now) || !q.accountID) throw Error("A finite clock and exact accountID are required")
  for (const v of [q.from,q.to]) if (v !== undefined && !finite(v)) throw Error("Invalid timestamp")
  if(q.resetAt!==undefined&&q.resetAt!==null&&!finite(q.resetAt))throw Error("Invalid reset timestamp")
  if (q.from !== undefined && q.to !== undefined && q.from > q.to || q.to !== undefined && q.to > e.now) throw Error("Invalid evidence interval")
  const offset=q.offset??0,limit=q.limit??40,timeZone=q.timeZone??"UTC",view=q.view??"summary",source=q.source??"opencode"
  if (!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100) throw Error("Use offset >= 0 and limit 1..100")
  if (!["summary","timeline","requests"].includes(view)||!["opencode","codex","opencode-host"].includes(source)) throw Error("Invalid evidence view or source")
  new Intl.DateTimeFormat("en",{timeZone}).format(e.now)
  const account=e.accounts.find(a=>a.id===q.accountID)
  if (!account) throw Error("Account not found in cached connections")
  const portfolio=portfolioPacing(e.accounts,e.observations,e.targets,e.controls,e.now).accounts.find(a=>a.accountID===q.accountID)!
  const windowID=q.windowID??portfolio.focus?.windowID??account.windows.find(w=>w.scope==="shared")?.id
  const window=account.windows.find(w=>w.id===windowID)
  if (!window) throw Error("Select an existing account windowID")
  const currentEpoch={regime:accountRegime(account),resetAt:stamp(window.resetAt)}
  const selectedEpoch={regime:q.regime??currentEpoch.regime,resetAt:q.resetAt===undefined?currentEpoch.resetAt:q.resetAt}
  const valid=e.observations.filter(o=>o.accountID===account.id&&o.windowID===window.id&&finite(o.at)&&o.at<=e.now&&finite(o.usedPoints)&&o.usedPoints>=0&&o.usedPoints<=100&&typeof o.regime==="string"&&(o.resetAt===null||finite(o.resetAt)))
  const rows=[...new Map(valid.map(o=>[JSON.stringify([o.accountID,o.windowID,o.regime,o.resetAt,o.at,o.usedPoints,o.replenishing??false,o.precisionPoints,o.reportingDelayMilliseconds]),o])).values()].sort((a,b)=>a.at-b.at||a.usedPoints-b.usedPoints)
  const epochs=new Map<string,Observation[]>()
  for (const o of rows) {const k=epochKey(o),group=epochs.get(k)??[];group.push(o);epochs.set(k,group)}
  const epochRows=epochs.get(epochKey(selectedEpoch))??[]
  const selected=epochRows.filter(o=>(q.from===undefined||o.at>=q.from)&&(q.to===undefined||o.at<=q.to))
  const gaps=selected.flatMap((o,i)=>i&&o.at-selected[i-1].at>EXPERIENCE_GAP_MS?[{from:selected[i-1].at,to:o.at,milliseconds:o.at-selected[i-1].at}]:[])
  const conflicts=selected.filter((o,i)=>i&&o.at===selected[i-1].at&&o.usedPoints!==selected[i-1].usedPoints).length
  const decreases=selected.filter((o,i)=>i&&o.usedPoints<selected[i-1].usedPoints).length
  const epochList=[...epochs.values()].map(g=>({regime:g[0].regime,resetAt:g[0].resetAt,current:epochKey(g[0])===epochKey(currentEpoch),samples:g.length,range:range(g.map(o=>o.at))!})).sort((a,b)=>b.range.to-a.range.to)
  const unique=new Map<string,LedgerRow>()
  let invalidRequests=0
  for (const r of e.requests) {
    if (!r.id||!finite(r.startedAt)||!finite(r.at)||r.startedAt>e.now||r.at>e.now||r.at<r.startedAt||!["running","completed","failed","interrupted","error"].includes(r.state)) {invalidRequests++;continue}
    const key=r.source+":"+r.id,prior=unique.get(key)
    if (!prior || (prior.state==="running"||r.state!=="running")&&(r.recordedAt??r.at)>=(prior.recordedAt??prior.at)) unique.set(key,r)
  }
  const allRequests=[...unique.values()]
  const within=(r:LedgerRow)=>(!q.sessionID||r.sessionID===q.sessionID)&&(q.from===undefined||r.at>=q.from)&&(q.to===undefined||r.startedAt<=q.to)
  const bound=allRequests.filter(r=>r.accountID===account.id&&within(r))
  const activity=bound.filter(r=>r.source===source).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id))
  const terminal=activity.filter(r=>r.state!=="running"),activityRange=range(activity.flatMap(r=>[r.startedAt,r.at]))
  const activeDays=new Set(terminal.map(r=>new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(r.at))).size
  let activeMilliseconds=0,end=-Infinity
  for(const r of [...terminal].sort((a,b)=>a.startedAt-b.startedAt)) {const start=Math.max(r.startedAt,q.from??r.startedAt),finish=Math.min(r.at,q.to??r.at);activeMilliseconds+=Math.max(0,finish-Math.max(start,end));end=Math.max(end,finish)}
  const tokenKeys=["input","cacheRead","cacheWrite","output","reasoning"] as const
  const tokens=Object.fromEntries(tokenKeys.map(k=>[k,{known:terminal.reduce((n,r)=>n+(number(r.tokens?.[k])??0),0),missingRequests:terminal.filter(r=>number(r.tokens?.[k])===null).length}]))
  const pointRows=selected.map((o,i)=>({at:o.at,usedPoints:o.usedPoints,precisionPoints:number(o.precisionPoints),reportingDelayMilliseconds:number(o.reportingDelayMilliseconds),breakBefore:i===0||o.at-selected[i-1].at>EXPERIENCE_GAP_MS||o.usedPoints<selected[i-1].usedPoints||o.at===selected[i-1].at||!!o.replenishing}))
  const requestRows=activity.map(r=>({id:r.id,sessionID:r.sessionID,questID:r.questID??null,source:r.source,accountBinding:"recorded" as const,startedAt:r.startedAt,at:r.at,state:r.state,modelID:r.route.modelID,providerID:r.route.providerID,reasoning:(r.route.reasoning??r.route.variant)??null,harness:r.route.harness??null,
    inputTokens:number(r.tokens?.input),cacheReadTokens:number(r.tokens?.cacheRead),outputIncludingReasoning:r.tokens?outputIncludingReasoning(r):null}))
  const plan=portfolio.pools.find(p=>p.windowID===window.id)!,desiredSlots=portfolio.requestedSlots
  const nextAction=portfolio.state!=="ready"?"hold":desiredSlots===0?"wait-for-controller":activity.some(r=>r.state==="running")?"inspect-live-ownership":"check-admission"
  const collectorAt=number(e.collectorAt),observedAt=stamp(window.observedAt)
  return {
    schema:1,at:e.now,timeZone,accountID:account.id,provider:account.provider,windowID:window.id,label:window.label,
    units:{quota:"percentage points of this pool",activity:"tokens (exclusive categories)",duration:"milliseconds",timestamps:"Unix milliseconds; render in timeZone"},
    summary:`${window.label}: ${window.usedPercent??"unknown"} used points observed; ${terminal.length} terminal and ${activity.length-terminal.length} running request records in ${source}. Next: ${nextAction}.`,
    observedQuota:{usedPoints:number(window.usedPercent),remainingPoints:number(window.remainingPercent),resetAt:currentEpoch.resetAt,regime:currentEpoch.regime,observedAt,ageMilliseconds:age(observedAt,e.now),state:plan.state,reason:plan.reason,precisionPoints:number(window.precisionPoints),reportingDelayMilliseconds:number(window.reportingDelayMilliseconds),attribution:"account-wide; not assigned to this session"},
    sources:{collectorAt,collectorAgeMilliseconds:age(collectorAt,e.now),hostScanAt:number(e.hostScanAt),coverageFrom:number(e.coverageFrom),accountAttemptedAt:stamp(account.attemptedAt),accountNextAttemptAt:stamp(account.nextAttemptAt),accountError:account.error?"Account source reports an error; inspect usage_status":null,diagnosticCount:e.diagnosticCount??0,invalidRequests},
    history:{availableSamples:rows.length,duplicateSamples:valid.length-rows.length,invalidSamples:e.observations.filter(o=>o.accountID===account.id&&o.windowID===window.id).length-valid.length,range:range(rows.map(o=>o.at)),epochCount:epochs.size,epochs:page(epochList,view==="summary"?offset:0,view==="summary"?limit:12),selectedEpoch,current:epochKey(selectedEpoch)===epochKey(currentEpoch),selectedSamples:selected.length,selectedRange:range(selected.map(o=>o.at)),gapThresholdMilliseconds:EXPERIENCE_GAP_MS,gapCount:gaps.length,gapMilliseconds:gaps.reduce((n,g)=>n+g.milliseconds,0),largestGap:gaps.reduce<(typeof gaps)[number]|null>((largest,g)=>!largest||g.milliseconds>largest.milliseconds?g:largest,null),gaps:page(gaps,0,12),conflictingSamples:conflicts,decreases},
    activity:{source,sessionID:q.sessionID??null,range:activityRange,terminalRequests:terminal.length,runningRequests:activity.length-terminal.length,states:{completed:terminal.filter(r=>r.state==="completed").length,failed:terminal.filter(r=>r.state==="failed").length,interrupted:terminal.filter(r=>r.state==="interrupted").length,error:terminal.filter(r=>r.state==="error").length},activeMilliseconds,activeDays,tokens,
      lastRecordAt:activity.length?activity.at(-1)!.at:null,missingAccountBindings:allRequests.filter(r=>!r.accountID&&within(r)).length,missingBindingScope:"all accounts in the requested interval/session; never inferred into this account",
      excludedUnboundSourceRecords:allRequests.filter(r=>r.source===source&&!r.accountID&&within(r)).length,excludedOtherAccountSourceRecords:allRequests.filter(r=>r.source===source&&r.accountID&&r.accountID!==account.id&&within(r)).length,
      routeReceiptAuthority:"unverified; stored account bindings do not prove a real paid request or exclude synthetic validation calls",estimateEligible:false,
      counterGapCount:(e.counterGaps??[]).filter(g=>(!q.sessionID||g.sessionID===q.sessionID)&&(q.from===undefined||g.at>=q.from)&&(q.to===undefined||g.at<=q.to)).length,
      sourceCounts:["opencode","codex","opencode-host"].map(s=>({source:s,records:bound.filter(r=>r.source===s).length,unboundRecords:allRequests.filter(r=>r.source===s&&!r.accountID&&within(r)).length})),
      coverage:"Captured records only; silence is not proof of inactivity. Sources may overlap and are never summed. Running timestamps are last evidence, not a heartbeat or launch receipt. Synthetic status is unknown without an authoritative route receipt; names alone are not a filter."},
    expectedActivity:{state:"unsupported",evidenceHorizon:activityRange,observedDays:activeDays,measuredActiveMilliseconds:activeMilliseconds,predictedActiveHours:null,reason:activeDays<7?"Few observed days and unverified capture continuity cannot establish a recurring schedule":"Capture continuity and future work schedule are unverified; historical activity does not establish future active hours",neededEvidence:["Several representative work and non-work days with verified collector continuity","Recorded account bindings and reconciled terminal counters, with capture overlap resolved","A chronological held-out activity model that reports error and gaps; future workload remains uncertain"]},
    decision:{state:portfolio.state,desiredSlots,ceiling:portfolio.pacing?.ceiling??null,controllerAt:portfolio.pacing?.updatedAt??null,reason:portfolio.pacing?.reason??portfolio.targetBasis,policyTarget:portfolio.target?{deadlineAt:portfolio.target.deadlineAt,reservePoints:portfolio.target.reservePoints,requiredPointsPerMinute:portfolio.focus?.requiredPointsPerMinute??null}:null,
      measuredQuotaRate:{pointsPerMinute:plan.observedPointsPerMinute,interval:plan.rateInterval,basis:"recent elapsed account-meter interval; flat means no reported movement"},learnedEstimate:{state:"unsupported",points:null,reason:"No validated allowance attribution in this projection; token counts are not quota charges"},liveLaunches:null,unknownLaunches:null,launchOwnership:"not observed by this read-only tool",runnable:false,nextAction,admission:"Desired slots are not launch grants; verify reservations, ownership, account holds, billing, exact route and useful authorized work"},
    timeline:view==="timeline"?page(pointRows,offset,limit):null,requests:view==="requests"?page(requestRows,offset,limit):null,
    limitations:["No linear exhaustion scenario is presented as a prediction","Quota gaps preserve unknown timing; a flat meter does not prove zero consumption","Request activity is independent of account quota and may omit external work","Reset timestamps are exact canonical epoch identities; older resets are never joined","No target, controller, account limit, billing policy or live state is changed"]
  }
}
export type UsageExperience = ReturnType<typeof usageExperience>
