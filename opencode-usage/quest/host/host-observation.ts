type State = { activity?:{active:Record<string,unknown>;checkedAt:string}; listeners?:Set<(event:any)=>void>; connected: boolean; connectedAt?: number; sessions: Map<string, { active: boolean; at: string }>; permission?: any; catalog?: any; integration?: any; toolWaits?:Map<string,Set<AbortController>>; toolLocks?:Map<string,Set<{release():void}>> }
const KEY = Symbol.for('opencode-config.quest.host-observations')
const registry = globalThis as typeof globalThis & { [KEY]?: WeakMap<object, State> }
const hosts = registry[KEY] ??= new WeakMap<object, State>()
export function registerHostObservation(host: object, permission?: any, catalog?: any, integration?:any) {
 let state = hosts.get(host)
 if (!state) { state = { connected: false, sessions: new Map() }; hosts.set(host, state) }
 if (permission) state.permission = permission
 if (catalog) state.catalog = catalog
 if (integration) state.integration = integration
 return state
}
export async function hostModelIdentities(host:object):Promise<string[]> {
 const state=hosts.get(host)
 return availableModelIdentities(state?.catalog,state?.integration)
}
export async function hostBenchmarkModels(host:object):Promise<import('../../usage/capability-api').CapabilityModel[]> {
 const catalog=hosts.get(host)?.catalog
 if(typeof catalog?.model?.list!=='function')throw Error('Connected host model catalog is unavailable; benchmark coverage cannot be inventoried')
 const result=await catalog.model.list(),models=result?.data??result
 if(!Array.isArray(models))throw Error('Connected host returned an invalid model catalog')
 return models.filter(model=>typeof model?.providerID==='string'&&typeof model?.id==='string')
}
export async function availableModelIdentities(catalog:any,integration:any):Promise<string[]> {
 if(typeof catalog?.model?.list!=='function'||typeof catalog?.provider?.list!=='function'||typeof integration?.list!=='function')throw Error('Connected host model catalog is unavailable; no helper dispatched')
 const results=await Promise.allSettled([catalog.model.list(),catalog.provider.list(),integration.list()])
 const [models,providers,integrations]=results.map(result=>{if(result.status==='rejected')throw result.reason;return result.value?.data??result.value})
 if(![models,providers,integrations].every(Array.isArray))throw Error('Connected host returned an invalid model catalog; no helper dispatched')
 const byProvider=new Map(providers.map(p=>[p.id,p])),byIntegration=new Map(integrations.map(i=>[i.id,i]))
 return [...new Set<string>(models.filter(m=>{
  if(typeof m.providerID!=='string'||typeof m.id!=='string')return false
  const provider:any=byProvider.get(m.providerID);if(!provider)return false
  const auth:any=byIntegration.get(provider.integrationID??provider.id)
  return !auth&&provider.integrationID===undefined||!!auth?.connections?.length||!!m.settings?.apiKey||!!provider.settings?.apiKey
 }).map(m=>m.providerID+'/'+m.id))].sort()
}
export function connectHostObservation(host: object, permission?: any) {
 const state = registerHostObservation(host, permission)
 state.connected = true
 state.connectedAt = Date.now()
 state.sessions.clear()
 notify(state, { type: HOST_CONNECTED })
}
export function disconnectHostObservation(host: object) {
 const state = hosts.get(host)
 if (state) { state.connected = false; state.sessions.clear();state.activity=undefined;for(const waits of state.toolWaits?.values()??[])for(const wait of waits)wait.abort(new Error('Host connection lost while waiting for workspace access')) }
}
export function workspaceWaitSignal(host:object,sessionID:string) {
 const state=hosts.get(host)
 if(!state?.connected)throw Error('Cannot wait for workspace access without a connected host; retry after the host reconnects')
 const controller=new AbortController(),waits=(state.toolWaits??=new Map()).get(sessionID)??new Set<AbortController>()
 state.toolWaits.set(sessionID,waits);waits.add(controller)
 return {signal:controller.signal,dispose(){waits.delete(controller);if(!waits.size)state.toolWaits?.delete(sessionID)}}
}
export function holdWorkspaceLock(host:object,sessionID:string,lock:{release():void}) {
 const state=registerHostObservation(host),locks=(state.toolLocks??=new Map()).get(sessionID)??new Set<{release():void}>()
 state.toolLocks.set(sessionID,locks);locks.add(lock)
 return ()=>{locks.delete(lock);if(!locks.size&&state.toolLocks?.get(sessionID)===locks)state.toolLocks.delete(sessionID);lock.release()}
}
export const releaseWorkspaceLocks=(host:object,sessionID:string)=>releaseHeld(hosts.get(host),sessionID)
function releaseHeld(state:State|undefined,sessionID:string) {
 const locks=state?.toolLocks?.get(sessionID)
 if(!locks)return 0
 state!.toolLocks!.delete(sessionID)
 for(const lock of locks)try{lock.release()}catch(error){console.error('[quests] workspace lock release failed',error)}
 return locks.size
}
export const HOST_CONNECTED = 'quest.host.connected'
export function onHostEvent(host:object,listener:(event:any)=>void){
 const state=registerHostObservation(host),listeners=state.listeners??=new Set()
 listeners.add(listener);return ()=>{listeners.delete(listener)}
}
function notify(state:State|undefined,event:any){for(const listener of state?.listeners??[])try{listener(event)}catch(error){console.error('[quests] host event listener failed',error)}}
export function recordHostObservation(host: object, event: any) {
 const state = hosts.get(host)
 try { observe(state, event) } finally { notify(state, event) }
}
function observe(state: State | undefined, event: any) {
 const id = event?.data?.sessionID
 if (!state?.connected || !id) return
  if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)||event.type==='session.status'&&event.data.status?.type==='idle')for(const wait of state.toolWaits?.get(id)??[])wait.abort(new Error('Worker execution ended while waiting for workspace access'))
 if (/^session\.execution\.(failed|interrupted)$/.test(event.type)) releaseHeld(state, id)
 if (event.type === 'session.execution.started') state.sessions.set(id, { active: true, at: new Date().toISOString() })
 else if (event.type === 'session.status') {
  const status = event.data.status?.type
  if (status === 'running' || status === 'idle') state.sessions.set(id, { active: status === 'running', at: new Date().toISOString() })
  else state.sessions.delete(id)
 } else if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) state.sessions.set(id, { active: false, at: new Date().toISOString() })
}
export function hostExecution(host: object, id: string) {
 const state = hosts.get(host)
 return state?.connected ? state.sessions.get(id)?.active : undefined
}
export function hostSettledIdleSince(host: object, id: string, since: string) {
 const state = hosts.get(host)
 if (!state?.connected) return false
 const at = Date.parse(since), seen = state.sessions.get(id)
 if (seen) return !seen.active && Date.parse(seen.at) > at
 return state.connectedAt !== undefined && state.connectedAt > at
}
export async function hostPermissions(host: object, id: string) {
 const state = hosts.get(host)
 return state?.permission?.list ? await state.permission.list({ sessionID: id }) : []
}

export function hostPermissionDomain(host:object){return hosts.get(host)?.permission}
export function recordHostActivity(host:object,active:unknown){
 if(!active||typeof active!=='object'||Array.isArray(active))return
 registerHostObservation(host).activity={active:{...active as Record<string,unknown>},checkedAt:new Date().toISOString()}
}
export async function hostConfirmsRunning(host:any,sessionID:string,inspect:<T>(operation:(signal:AbortSignal)=>Promise<T>)=>Promise<T>):Promise<boolean>{
 if(typeof host?.active==='function')try{
  const answer=await inspect(signal=>host.active({signal})),active=(answer as any)?.data??answer
  if(active&&typeof active==='object'&&!Array.isArray(active)){recordHostActivity(host,active);return Object.hasOwn(active,sessionID)}
 }catch{}
 return hostExecution(host,sessionID)===true
}
export const hostActivity=(host:object)=>hosts.get(host)?.activity
export function hostSessionSeen(host:object,id:string){
 const state=hosts.get(host)
 return state?.connected?state.sessions.get(id):undefined
}
