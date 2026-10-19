import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {pendingUpdate,reloadAttempting} from '../../scripts/landing-quiet.mjs'
import {workerHolder,workerReceipts} from '../../scripts/host-busy.mjs'
import {reloadDirectory} from '../../scripts/fresh-services.mjs'
import {WORK_BRANCH} from '../channel.mjs'
import {servedRepository} from './update-drain'

export type UpdateStatus={running:string|null;head:string|null;state:'current'|'waiting'|'switching'|'web update'|'behind v2'|'unknown';workers:number;text:string}

const HEAD_TTL_MS=20_000
const heads=new Map<string,{at:number;sha:string|null}>()
const short=(sha:string|null)=>sha?sha.slice(0,8):'unknown'

function headOf(repository:string,now:number){
 const cached=heads.get(repository)
 if(cached&&now-cached.at<HEAD_TTL_MS)return cached.sha
 let sha:string|null=null
 try{sha=execFileSync('git',['-C',repository,'rev-parse','origin/'+WORK_BRANCH],{encoding:'utf8',timeout:3000,windowsHide:true}).trim()||null}catch{}
 heads.set(repository,{at:now,sha})
 return sha
}

function runningCommit(root:string){
 try{return JSON.parse(readFileSync(join(root,'.deployment-source.json'),'utf8')).commit??null}catch{return null}
}

const sameCommit=(a:string|null,b:string|null)=>!!a&&!!b&&(a.startsWith(b)||b.startsWith(a))

export function reloadSettledAt(repository:string,head:string|null){
 if(!head)return false
 try{const last=JSON.parse(readFileSync(join(reloadDirectory(repository),'last.json'),'utf8'));return last?.outcome==='succeeded'&&typeof last.landedSha==='string'&&sameCommit(last.landedSha,head)}catch{return false}
}

export function updateStatus(options:{now?:number;root?:string;repository?:string;workers?:()=>number;holder?:()=>string|undefined}={}):UpdateStatus {
 const now=options.now??Date.now()
 const repository=options.repository??servedRepository()
 const root=options.root??dirname(dirname(dirname(fileURLToPath(import.meta.url))))
 const running=runningCommit(root),head=repository?headOf(repository,now):null
 const workers=(options.workers??(()=>workerReceipts().length))()
 const pending=repository?pendingUpdate(repository):undefined
 let state:UpdateStatus['state']
 if(!running||!head)state='unknown'
 else if(pending&&reloadAttempting(repository!))state='switching'
 else if(pending&&pending.host!==false)state='waiting'
 else if(pending)state='web update'
 else state=sameCommit(running,head)||!!repository&&reloadSettledAt(repository,head)?'current':'behind v2'
 const minutes=pending?Math.max(0,Math.round((now-Date.parse(pending.first))/60_000)):0
 const holder=state==='waiting'?(options.holder??(()=>workerHolder()))():undefined
 const label=state!=='waiting'?state:holder?`host update waiting on ${holder} (${minutes} min)`:'host update pending, starts when no Quest work runs'
 return {running,head,state,workers,text:'running '+short(running)+' / v2 head '+short(head)+': '+label}
}
