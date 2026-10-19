import {existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {processListing} from '../../scripts/process-evidence.mjs'

const SESSION=/^(opencode|claude|codex|windowsterminal|openconsole|wezterm-gui|wezterm|alacritty|code|explorer)(\.exe)?$/i
const SHELL_HOST=/^(conhost|powershell|pwsh|cmd|bash|sh|dash|zsh|fish|mintty|wsl|login|ssh|sshd)(\.exe)?$/i
const PATH_END=/^(?:$|["' ;,=)])/
const REST=/^[^"' ;,=)]+/
const fold=value=>process.platform==='win32'?value.toLowerCase():value
const slashes=value=>String(value??'').replaceAll('\\','/')
const pathKey=path=>fold(slashes(resolve(path)).replace(/\/+$/,''))
const base=name=>String(name??'').split(/[\\/]/).pop()
export const sessionProcess=entry=>SESSION.test(base(entry.name))
export const neverStopped=entry=>SESSION.test(base(entry.name))||SHELL_HOST.test(base(entry.name))

function checkoutUnder(home,segments){
 for(let depth=1;depth<=segments.length;depth++){
  const candidate=join(home,...segments.slice(0,depth))
  if(!existsSync(candidate)||existsSync(join(candidate,'.git')))return candidate
 }
}

function locate(entry,roots){
 let found
 for(const field of [entry.command,entry.image,entry.cwd]){
  if(!field)continue
  const original=slashes(field),text=fold(original)
  for(const root of roots){
   for(let at=text.indexOf(root.key);at>=0;at=text.indexOf(root.key,at+1)){
    const after=at+root.key.length,rest=original.slice(after)
    let checkout
    if(root.home){
     if(rest[0]!=='/')continue
     checkout=checkoutUnder(root.path,(REST.exec(rest.slice(1))?.[0]??'').split('/').filter(Boolean))
    }else if(rest[0]==='/'||PATH_END.test(rest))checkout=root.path
    if(checkout&&(!found||pathKey(checkout).length>pathKey(found).length))found=checkout
   }
  }
 }
 return found
}

export function checkoutTrees(processes,{checkouts=[],homes=[],self=process.pid}={}){
 const roots=[...checkouts.map(path=>({path:resolve(path),key:pathKey(path),home:false})),...homes.map(path=>({path:resolve(path),key:pathKey(path),home:true}))]
 if(!roots.length)return []
 const byPid=new Map(processes.map(entry=>[entry.pid,entry])),children=new Map()
 const parentOf=entry=>{const parent=byPid.get(entry.ppid);return parent&&parent.pid!==entry.pid&&(!entry.createdAt||!parent.createdAt||parent.createdAt<=entry.createdAt)?parent:undefined}
 const ancestors=entry=>{const seen=new Set([entry.pid]),chain=[];for(let next=parentOf(entry);next&&!seen.has(next.pid);next=parentOf(next)){seen.add(next.pid);chain.push(next)}return chain}
 for(const entry of processes){const parent=parentOf(entry);if(parent)(children.get(parent.pid)??children.set(parent.pid,[]).get(parent.pid)).push(entry)}
 const me=byPid.get(self),protectedPids=new Set([self,process.ppid,...(me?ancestors(me).map(entry=>entry.pid):[])])
 const eligible=entry=>!protectedPids.has(entry.pid)&&!neverStopped(entry)
 const member=new Map()
 for(const entry of processes){if(!eligible(entry))continue;const checkout=locate(entry,roots);if(checkout)member.set(entry.pid,checkout)}
 const spread=(entry,checkout)=>{for(const child of children.get(entry.pid)??[])if(eligible(child)&&!member.has(child.pid)){member.set(child.pid,checkout);spread(child,checkout)}}
 for(const [pid,checkout] of [...member])spread(byPid.get(pid),checkout)
 const trees=[]
 for(const [pid,checkout] of member){
  const root=byPid.get(pid),parent=parentOf(root)
  if(parent&&member.get(parent.pid)===checkout)continue
  const ordered=[],walk=entry=>{ordered.push(entry);for(const child of children.get(entry.pid)??[])if(member.get(child.pid)===checkout)walk(child)}
  walk(root)
  const chain=ancestors(root),session=chain.find(sessionProcess)
  const owner=chain.some(entry=>entry.pid===self)?'host':session?'session':'none'
  trees.push({checkout,owner,...(owner==='session'?{session:base(session.name)+' '+session.pid}:{}),processes:ordered.map(({pid,ppid,name,command,createdAt})=>({pid,ppid,name,command,createdAt}))})
 }
 return trees
}

export function stopTrees(trees){
 const stopped=[],failed=[]
 for(const tree of trees)for(const entry of tree.processes){
  try{process.kill(entry.pid);stopped.push({...entry,checkout:tree.checkout})}
  catch(error){if(error?.code!=='ESRCH')failed.push({...entry,checkout:tree.checkout,error:String(error?.code??error?.message??error)})}
 }
 return {stopped,failed}
}

export async function stopCheckoutProcesses({checkouts=[],homes=[],self=process.pid,stop=tree=>tree.owner!=='session',listing=processListing}={}){
 const listed=await listing()
 if(listed.unavailable)return {unavailable:listed.unavailable,stopped:[],failed:[],kept:[]}
 const trees=checkoutTrees(listed.processes,{checkouts,homes,self})
 const chosen=trees.filter(tree=>stop(tree))
 return {...stopTrees(chosen),kept:trees.filter(tree=>!chosen.includes(tree))}
}

export const describeProcess=entry=>base(entry.name)+' '+entry.pid
