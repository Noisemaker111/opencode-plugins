import {QuestError} from '../api'
import {answerQuestion,type Question,type PictureSources} from './pictures'
import {readOperations} from '../read-operations.mjs'
import {operationValidator} from '../interfaces/operation-validation.mjs'
import {latencyPicture,latencyWindow} from '../../usage/latency'
import {fixedPrefixPicture,formatFixedPrefix,DEFAULT_FIXED_PREFIX_WINDOW} from '../../usage/fixed-prefix'
import {processesPicture} from './processes-picture'
import {historyPicture,ratesPicture,summaryPicture} from './worker-readouts'
import type {QuestStore} from '../store'
import {runSpeedPicture,runTelemetryPicture} from '../runs/run-telemetry'
import {hygieneReadout} from '../hygiene/readout'
import {leaderboardPicture} from '../routing/leaderboard-read'
import {benchmarksPicture,type BenchmarkStatus} from '../routing/benchmarks-read'
import {freeModelsLive,freeModelsPaths} from '../routing/free-models-read'

const validators=new Map(Object.entries(readOperations).map(([name,op]:[string,any])=>[name,operationValidator(op.input)]))

export function createReadAPI(store:QuestStore,sources:PictureSources={}){
 return {
  operations:readOperations,
  call(name:string,input:unknown){
   const validate=validators.get(name)
   if(!validate)throw new QuestError('UNKNOWN_OPERATION','Unknown read operation: '+name+'. The read API offers '+Object.keys(readOperations).join(', '))
   const problem=validate(input??{})
   if(problem)throw new QuestError('INVALID_INPUT',name+': '+problem)
   if(name==='telemetry'&&!(input as {quest?:string}).quest)return runSpeedPicture(store,(sources.now??Date.now)())
   if(name==='telemetry'){const id=String((input as {quest:string}).quest),quest=store.read(id);if(!quest)throw new QuestError('INVALID_INPUT','No Quest matches '+id);return runTelemetryPicture(store,quest,(sources.now??Date.now)(),{trace:(input as {trace?:boolean}).trace===true})}
   if(name==='hygiene')return hygieneReadout(store,(sources.now??Date.now)())
   if(name==='leaderboard'){try{return leaderboardPicture((sources.now??Date.now)(),undefined,(input as {benchmark?:string}).benchmark)}catch(error){throw new QuestError('INVALID_INPUT','leaderboard: '+(error instanceof Error?error.message:String(error)))}}
   if(name==='benchmarks'){const i=(input??{}) as {benchmark?:string;status?:BenchmarkStatus;limit?:number};try{return benchmarksPicture((sources.now??Date.now)(),undefined,i.benchmark,{status:i.status,limit:i.limit})}catch(error){throw new QuestError('INVALID_INPUT','benchmarks: '+(error instanceof Error?error.message:String(error)))}}
   if(name==='free'){
    const at=(sources.now??Date.now)()
    try{
     const deps:{fetch?:typeof globalThis.fetch;key?:string}={}
     if(sources.freeFetch)deps.fetch=sources.freeFetch
     if(sources.freeKey!==undefined)deps.key=sources.freeKey
     return freeModelsLive(at,sources.freePaths??freeModelsPaths(),{all:(input as {all?:boolean}).all===true},deps)
    }catch(error){throw new QuestError('INVALID_INPUT','free: '+(error instanceof Error?error.message:String(error)))}
   }
   if(name==='processes'){try{return processesPicture(input as {window?:string},{now:sources.now})}catch(error){throw new QuestError('INVALID_INPUT','processes: '+(error instanceof Error?error.message:String(error)))}}
   if(name==='prefix'){
    try{
     const at=(sources.now??Date.now)(),window=latencyWindow((input as {window?:string}).window??DEFAULT_FIXED_PREFIX_WINDOW)
     const picture=fixedPrefixPicture({projectRoot:store.projectRoot,runtime:store.runtime,ledgerFile:sources.ledgerFile,hostFile:sources.hostFile,now:()=>at},{from:at-window.milliseconds,to:at})
     return {...picture,window:window.label,text:formatFixedPrefix(picture)}
    }catch(error){throw new QuestError('INVALID_INPUT','prefix: '+(error instanceof Error?error.message:String(error)))}
   }
   if(name==='history'||name==='rates'||name==='summary'){
    const from={now:sources.now,hostFile:sources.hostFile}
    try{return name==='history'?historyPicture(input as {session:string;window?:string},store,from):name==='rates'?ratesPicture(input as {window?:string},from):summaryPicture(store,from)}
    catch(error){throw new QuestError('INVALID_INPUT',name+': '+(error instanceof Error?error.message:String(error)))}
   }
   if(name==='latency')return latencyPicture(input as {window?:string},{telemetryFile:sources.telemetryFile,now:sources.now}).catch(error=>{throw new QuestError('INVALID_INPUT','latency: '+(error instanceof Error?error.message:String(error)))})
   return answerQuestion(store,name as Question,sources)
  },
 }
}
