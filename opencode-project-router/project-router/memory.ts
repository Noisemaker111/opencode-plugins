import { claimRouterRequest } from '../quest/router-public'
import { targetKey, type Target } from './resolution'
import { RouterError } from './host'
export type Storage={get(key:string):Promise<any>;set(key:string,value:any):Promise<void>}
export class RouterMemory {
 constructor(readonly storage:Storage,readonly claim=claimRouterRequest){}
 private async locked<T>(key:string,action:()=>Promise<T>){let lock:ReturnType<typeof claimRouterRequest>;try{lock=this.claim('memory:'+key)}catch{throw new RouterError('MEMORY_BUSY','Another process is updating project memory; retry this prelaunch operation after it completes')}try{return await action()}finally{lock.release()}}
 async register(targets:Target[]){return this.locked('registry',async()=>{const rows=[...await this.known(),...targets],merged=new Map<string,Target>();for(const row of rows)merged.set(targetKey(row),{...merged.get(targetKey(row)),...Object.fromEntries(Object.entries(row).filter(([,v])=>v!==undefined))} as Target);await this.storage.set('known',[...merged.values()].slice(-500))})}
 async known():Promise<Target[]>{return await this.storage.get('known')??[]}
 async aliases():Promise<Record<string,Target>>{return await this.storage.get('aliases')??{}}
 async alias(name:string,target?:Target){return this.locked('registry',async()=>{const aliases=await this.aliases();if(target)aliases[name.toLowerCase()]=target;else delete aliases[name.toLowerCase()];await this.storage.set('aliases',aliases)})}
}
