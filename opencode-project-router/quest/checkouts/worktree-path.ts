import {createHash} from 'node:crypto'
import {join,resolve} from 'node:path'

export function boundedWorktreePath(home:string,runID:string,channel?:string,platform=process.platform):string {
 const parent=resolve(home,...(channel?[channel]:[]))
 const available=platform==='win32'?Math.min(255,259-join(parent,'.git').length-1):255
 if(runID.length<=available)return join(parent,runID)
 const suffix=createHash('sha256').update(runID).digest('hex').slice(0,10)+'-'+runID.slice(-6)
 if(available<suffix.length+2)throw Error('Worktree home is too long for a readable Windows checkout; configure a shorter quest.worktreeRoot: '+parent)
 const title=runID.slice(0,available-suffix.length-1).replace(/-+$/,'')
 return join(parent,title+'-'+suffix)
}
