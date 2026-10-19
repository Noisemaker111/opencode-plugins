export type GiverBindingStatus={recovering:boolean;error?:string}
export type GiverBinding={bind:()=>Promise<boolean>;status:()=>GiverBindingStatus;dispose:()=>void}

export function giverBinding(attempt:()=>Promise<unknown>,bound:()=>boolean):GiverBinding{
 let running:Promise<boolean>|undefined,error:string|undefined
 const bind=()=>{
  if(running)return running
  if(bound()){error=undefined;return Promise.resolve(true)}
  const attempted:Promise<boolean>=attempt().then(()=>{error=undefined;return true},failure=>{error=failure instanceof Error?failure.message||failure.name:String(failure);console.error('[quests] Quest Giver not bound yet:',error);return false}).finally(()=>{if(running===attempted)running=undefined})
  running=attempted
  return attempted
 }
 return {bind,status:()=>({recovering:!!running||!bound(),...(error?{error}:{})}),dispose:()=>{}}
}
