import { now, recordSpan } from '../scripts/plugin-spans'

export async function pluginStartup<T>(plugin:string,stage:string,operation:()=>Promise<T>,location?:string):Promise<T> {
 const started=performance.now(),start=now()
 console.error(`[plugin-startup] ${plugin}/${stage} begin`)
 try{const value=await operation();console.error(`[plugin-startup] ${plugin}/${stage} end ${Math.round(performance.now()-started)}ms`);recordSpan({plugin,name:'startup',op:stage,location,start,end:now()});return value}
 catch(error){console.error(`[plugin-startup] ${plugin}/${stage} failed ${Math.round(performance.now()-started)}ms`);recordSpan({plugin,name:'startup',op:stage,location,start,end:now(),error:String(error instanceof Error?error.message:error).slice(0,200)});throw error}
}
