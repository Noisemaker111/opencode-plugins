import {activeChannelRelease} from '../../scripts/channel-migrate.mjs'
import {pendingUpdate,reloadAttempting} from '../../scripts/landing-quiet.mjs'
import {channelRegistry,resolveChannel} from '../channel.mjs'
import {liveWorkerRuns} from '../checkouts/folder-owners.mjs'

export const DRAIN_TEXT='An update to the Quest host waits for the running Quest work to finish; no new worker starts until it is applied'

type Probe={channel?:string;repository?:string;pending?:(top:string,channel:string)=>{host?:boolean;first?:string}|undefined;running?:()=>number;attempting?:(top:string,channel:string)=>boolean}

let served:string|undefined|null=null
export function servedRepository(){
 if(served===null)served=activeChannelRelease(channelRegistry(),resolveChannel().name)?.repository
 return served
}

export function updateHold(options:Probe={}):string|undefined {
 const channel=options.channel??resolveChannel().name
 const top=options.repository??activeChannelRelease(channelRegistry(),channel)?.repository
 if(!top)return undefined
 const pending=(options.pending??pendingUpdate)(top,channel)
 if(!pending||pending.host===false)return undefined
 const running=(options.running??(()=>liveWorkerRuns().length))()
 return running||(options.attempting??reloadAttempting)(top,channel)?DRAIN_TEXT:undefined
}
