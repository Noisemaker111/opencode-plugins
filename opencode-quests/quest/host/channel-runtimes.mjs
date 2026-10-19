import {existsSync} from 'node:fs'
import {homedir} from 'node:os'
import {join,resolve} from 'node:path'
import {CHANNELS,channelName} from '../channel.mjs'
import {channelStateDirectory,channelStateRoot} from '../../scripts/channel-migrate.mjs'

const key=path=>{const full=resolve(path).replaceAll('\\','/');return process.platform==='win32'?full.toLowerCase():full}

export const channelRegistry=(home=homedir())=>join(home,'.config','opencode','.channels')
export const sharedStateDirectory=(home=homedir())=>join(home,'.local','state','questgiver','shared')
export const currentChannel=(environment=process.env)=>channelName(environment.OPENCODE_RELEASE_CHANNEL)

function relocated(channel,state){
 return {channel,state,questRuntime:join(state,'quests','.opencode','.quest-runtime'),telemetry:join(state,'requests.jsonl')}
}
export function channelRuntimes(home=homedir()){
 const registry=channelRegistry(home)
 const runtimes=CHANNELS.flatMap(channel=>{
  const state=channelStateDirectory(registry,channel),moved=relocated(channel,state)
  if(existsSync(moved.questRuntime))return [moved]
  return existsSync(state)?[moved]:[]
 })
 for(const channel of CHANNELS){
  const previous=relocated(channel,join(channelStateRoot(registry),channel))
  if(existsSync(previous.questRuntime))runtimes.push(previous)
 }
 return runtimes.filter((runtime,index)=>runtimes.findIndex(other=>key(other.questRuntime)===key(runtime.questRuntime))===index)
}

export function runtimeChannel(questRuntime,runtimes=channelRuntimes()){
 return runtimes.find(runtime=>key(runtime.questRuntime)===key(questRuntime))
}

export function peerRuntimes(questRuntime,runtimes=channelRuntimes()){
 const own=runtimeChannel(questRuntime,runtimes)
 return own?runtimes.filter(runtime=>runtime!==own):[]
}
