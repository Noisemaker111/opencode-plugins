import JSON5 from 'json5'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

export const COMPUTER_USE_LINE='If a computer-use tool is available, use it for browser or desktop work; if none is available or it fails, use other means or report that you cannot.'

const CONFIG=process.env.OPENCODE_CONFIG_FILE??join(import.meta.dir,'..','..','opencode.jsonc')

export function enabledMCPServers(file=CONFIG):string[] {
 const servers=(JSON5.parse(readFileSync(file,'utf8'))?.mcp?.servers??{}) as Record<string,{disabled?:boolean}|undefined>
 return Object.keys(servers).filter(name=>servers[name]?.disabled!==true)
}

export function unpermittedComputerTool(id:string,computerUse:readonly string[],enabled:readonly string[]) {
 return enabled.find(name=>!computerUse.includes(name)&&id.startsWith(name+'_'))
}
