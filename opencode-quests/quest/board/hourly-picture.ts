import {readAllQuests} from '../index'
import {readLedger,PASSIVE_LEDGER_FILE,type LedgerRow} from '../../usage/passive-ledger'
import {sessionRoles,hostAgents,whoIs,type BudgetRole} from '../../usage/session-budget'
import {listPriceOf,priceBookFile} from '../../usage/price-book'
import {valueRequest,type RequestRecord} from '../../usage/telemetry'
import {proxyOwners} from '../../usage-service/on-computer'
import type {QuestStore} from '../store'

export const HOURLY_ZONE='America/New_York'
const HOUR=3_600_000
const HOURS_SHOWN=24

const dayKey=new Intl.DateTimeFormat('en-CA',{timeZone:HOURLY_ZONE,year:'numeric',month:'2-digit',day:'2-digit'})
const weekday=new Intl.DateTimeFormat('en-US',{timeZone:HOURLY_ZONE,weekday:'short'})
const dateText=new Intl.DateTimeFormat('en-US',{timeZone:HOURLY_ZONE,month:'short',day:'numeric'})
const hourText=new Intl.DateTimeFormat('en-US',{timeZone:HOURLY_ZONE,hour:'numeric'})

const startOfHour=(at:number)=>Math.floor(at/HOUR)*HOUR
function startOfDay(at:number){
 let start=startOfHour(at)
 const key=dayKey.format(start)
 while(dayKey.format(start-HOUR)===key)start-=HOUR
 return start
}
function startOfWeek(at:number){
 let start=startOfDay(at)
 while(weekday.format(start)!=='Mon')start=startOfDay(start-HOUR)
 return start
}

const two=(value:number)=>Math.round(value*100)/100
const one=(value:number)=>Math.round(value*10)/10
const hourLabel=(start:number)=>dateText.format(start)+', '+hourText.format(start)+' to '+hourText.format(start+HOUR)+' Eastern'
const sinceLabel=(start:number)=>dateText.format(start)+', '+hourText.format(start)+' Eastern'

type Spend={at:number;usd:number|null;worker:boolean}
export type HourlySources={ledgerFile?:string;hostFile?:string;priceFile?:string;owners?:Record<string,string>;now?:()=>number}

function tally(spends:Spend[],landings:number[],from:number,to:number){
 let spendUSD=0,workerUSD=0,unpriced=0,requests=0
 for(const spend of spends){
  if(spend.at<from||spend.at>=to)continue
  requests++
  if(spend.usd===null){unpriced++;continue}
  spendUSD+=spend.usd
  if(spend.worker)workerUSD+=spend.usd
 }
 const prs=landings.filter(at=>at>=from&&at<to).length
 return {prs,spendUSD:two(spendUSD),workerUSD:two(workerUSD),workerSharePercent:spendUSD>0?one(workerUSD/spendUSD*100):null,costPerPrUSD:prs>0?two(spendUSD/prs):null,requests,unpricedRequests:unpriced}
}
type Totals=ReturnType<typeof tally>

function landedTimes(store:Pick<QuestStore,'projectRoot'>){
 const seen=new Set<string>(),times:number[]=[]
 for(const {quest} of readAllQuests(store.projectRoot,{includeArchived:true})){
  if(!quest)continue
  for(const [run,landing] of Object.entries((quest.extensions?.landings??{}) as Record<string,{state?:string;at?:string;head?:string}>)){
   const at=Date.parse(landing?.at??'')
   const key=landing?.head??quest.id+':'+run
   if(landing?.state!=='landed'||!Number.isFinite(at)||seen.has(key))continue
   seen.add(key);times.push(at)
  }
 }
 return times
}

function spendOf(store:Pick<QuestStore,'projectRoot'|'runtime'>,rows:LedgerRow[],sources:HourlySources):Spend[]{
 const known=sessionRoles(store.projectRoot,store.runtime),parents=new Map<string,string>()
 for(const row of rows)if(row.parentID)parents.set(row.sessionID,row.parentID)
 const agents=hostAgents([...new Set(rows.map(row=>row.sessionID))].filter(id=>id.startsWith('ses_')),sources.hostFile)
 const roles=new Map<string,BudgetRole>()
 const file=sources.priceFile??priceBookFile(),owners=sources.owners??proxyOwners()
 return rows.map(row=>{
  if(!roles.has(row.sessionID))roles.set(row.sessionID,whoIs(row,known,parents,agents).role)
  const request:RequestRecord={id:row.id,sessionID:row.sessionID,route:row.route,kind:row.kind,startedAt:row.startedAt,state:row.state as RequestRecord['state'],tokens:row.tokens}
  const listed=listPriceOf(request,file,owners)
  const value=listed?valueRequest({...request,price:listed.price}):undefined
  return {at:row.at,usd:value?.currency==='USD'?value.value:null,worker:roles.get(row.sessionID)==='worker'}
 })
}

const money=(value:number)=>'$'+value.toFixed(2)
const line=(name:string,totals:Totals)=>name+': '+totals.prs+(totals.prs===1?' PR':' PRs')+' landed, '+money(totals.spendUSD)+' spent'+(totals.workerSharePercent===null?'':', workers '+totals.workerSharePercent+'%')+(totals.costPerPrUSD===null?'':', '+money(totals.costPerPrUSD)+' per PR')+'.'

export function hourlyPicture(store:Pick<QuestStore,'projectRoot'|'runtime'>,sources:HourlySources={}){
 const now=(sources.now??Date.now)(),thisHour=startOfHour(now),dayStart=startOfDay(now),weekStart=startOfWeek(now)
 const firstHour=thisHour-(HOURS_SHOWN-1)*HOUR,to=now+1
 const ledger=readLedger({from:Math.min(weekStart,firstHour),to:now},sources.ledgerFile??PASSIVE_LEDGER_FILE)
 const spends=spendOf(store,ledger.rows,sources),landings=landedTimes(store)
 const hours=Array.from({length:HOURS_SHOWN},(_,index)=>{
  const start=firstHour+index*HOUR
  return {start:new Date(start).toISOString(),label:hourLabel(start),current:start===thisHour,...tally(spends,landings,start,Math.min(start+HOUR,to))}
 })
 const day={since:new Date(dayStart).toISOString(),label:'Today since '+sinceLabel(dayStart),...tally(spends,landings,dayStart,to)}
 const week={since:new Date(weekStart).toISOString(),label:'This week since '+sinceLabel(weekStart),...tally(spends,landings,weekStart,to)}
 const current=hours[hours.length-1]
 return {at:now,zone:HOURLY_ZONE,zoneName:'Eastern time',
  text:[line('This hour ('+current.label+')',current),line(day.label,day),line(week.label,week)].join(' '),
  hours,day,week,
  basis:'Hours are Eastern clock hours. Spend is each ledger request priced at catalog rates; a request with no catalog price adds no spend and is counted as unpriced. Worker share is the share of that spend made by worker sessions. PRs landed come from the Quest landing records, one per merged head, by the time the landing was recorded. Cost per landed PR is the spend in the period divided by its PRs.',
  diagnostics:ledger.diagnostics}
}
