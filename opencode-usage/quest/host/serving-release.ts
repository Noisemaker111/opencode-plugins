import {basename,dirname,isAbsolute} from 'node:path'
import {physicalDirectory,physicalDirectoryIfPresent} from '../core/project'

const present=(directory:unknown)=>typeof directory==='string'&&isAbsolute(directory)?physicalDirectoryIfPresent(directory):undefined
const pathKey=(directory:string)=>process.platform==='win32'?directory.toLowerCase():directory

export const servingReleaseRoot=(environment:NodeJS.ProcessEnv=process.env)=>present(environment.OPENCODE_CONFIG_DIR)

export function presentOrServingRelease(recorded:unknown,environment:NodeJS.ProcessEnv=process.env):string|undefined{
 if(typeof recorded!=='string'||!recorded)return undefined
 return present(recorded)??servingReleaseRoot(environment)
}

export function leftServingRelease(recorded:unknown,environment:NodeJS.ProcessEnv=process.env):boolean{
 const serving=servingReleaseRoot(environment),folder=present(recorded)
 if(!serving||!folder||pathKey(folder)===pathKey(serving))return false
 const releases=dirname(serving)
 return basename(releases)==='releases'&&pathKey(dirname(folder))===pathKey(releases)
}

export function giverFolder(session:any,environment:NodeJS.ProcessEnv=process.env):string{
 const recorded=session?.location?.directory
 return presentOrServingRelease(recorded,environment)??physicalDirectory(recorded)
}
