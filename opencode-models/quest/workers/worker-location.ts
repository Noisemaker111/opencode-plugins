import {blockQuestWorker,locationPlugins,onLocationSettled,unblockQuestWorker,type LocationPlugins} from '../../scripts/server-plugin-lifecycle'
import {Duration,Effect} from 'effect'
const REQUIRED=['quests','quests#tools','quests#host-events']
export const TOOLS_READY={settleMs:15_000,rechecks:2,recheckMs:2_000}
export type ToolsReadiness=Partial<typeof TOOLS_READY>
export function workerToolsUnavailable(directory:string,state:LocationPlugins|undefined=locationPlugins(directory)):string|undefined{
 if(!state?.settled)return undefined
 const failed=REQUIRED.flatMap(id=>id in state.failed?[id+': '+state.failed[id]]:[])
 if(!failed.length&&state.loaded.includes('quests'))return undefined
 return 'The worker location '+directory+' has no Quest tools: quest_report and permission (Jev) are not loaded there ('+(failed.join('; ')||'the quests plugin did not load')+').'
}
const waitSettle=(directory:string,timeoutMs:number):Effect.Effect<void>=>{
 if(locationPlugins(directory)?.settled)return Effect.void
 return Effect.callback<void>((resume,signal)=>{
  const stop=onLocationSettled(directory,()=>resume(Effect.void))
  signal.addEventListener('abort',()=>stop(),{once:true})
 }).pipe(
  Effect.timeout(Duration.millis(timeoutMs)),
  Effect.catch(()=>Effect.void)
 )
}
export function watchWorkerLocation(directory:string,sessionID:string,late:(reason:string)=>void){
 let reason:string|undefined,dispatching=true
 const loading=locationPlugins(directory)?.loading===true
 const judge=(state:LocationPlugins)=>{
  stop();reason=workerToolsUnavailable(directory,state);if(!reason)return
  blockQuestWorker(sessionID,reason);if(!dispatching)late(reason)
 }
 const stop=onLocationSettled(directory,judge),now=locationPlugins(directory)
 if(now?.settled)judge(now)
 return {
  get reason(){return reason},
  dispatched(){dispatching=false},
  stop,
  async ready(options:ToolsReadiness={}):Promise<string|undefined>{
   const {settleMs,rechecks,recheckMs}={...TOOLS_READY,...options}
   return Effect.runPromise(Effect.gen(function*(){
    if(loading&&!locationPlugins(directory)?.settled)yield* waitSettle(directory,settleMs)
    for(let again=0;locationPlugins(directory)?.settled&&workerToolsUnavailable(directory)&&again<rechecks;again++){
     yield* Effect.sleep(Duration.millis(recheckMs))
     yield* waitSettle(directory,settleMs)
    }
    const state=locationPlugins(directory)
    if(state?.settled){
     const current=workerToolsUnavailable(directory,state)
     if(!current&&reason){reason=undefined;unblockQuestWorker(sessionID)}
     else if(current)reason=current
    }
    return reason
   }))
  },
 }
}
