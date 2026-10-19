import {closeSync,copyFileSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs'
import {createHash,randomBytes} from 'node:crypto'
import {dirname,join,resolve} from 'node:path'

export const WINDOWS_PATH_LIMIT=250
export function assertWindowsPathFits(path,platform=process.platform){
 if(platform!=='win32')return path
 const length=resolve(path).length
 if(length>WINDOWS_PATH_LIMIT)throw Error(`Path is ${length} characters, over the ${WINDOWS_PATH_LIMIT} character Windows limit: ${path}`)
 return path
}

const retryable=new Set(['EACCES','EBUSY','EPERM'])
const pauses=[0,25,50,100,200,400]
const pause=milliseconds=>{if(milliseconds)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,milliseconds)}

function flushDirectory(directory,fsync){
 if(process.platform==='win32')return
 let fd
 try{fd=openSync(directory,'r');fsync(fd)}catch{}finally{if(fd!==undefined)closeSync(fd)}
}

export function writeFileDurable(path,contents,options={}){
 const fsync=options.fsync??fsyncSync,move=options.rename??renameSync,wait=options.wait??pause
 const directory=dirname(path)
 assertWindowsPathFits(path)
 mkdirSync(directory,{recursive:true})
 const temporary=options.temporary??join(directory,'.'+randomBytes(4).toString('hex')+'.tmp')
 const fd=openSync(temporary,options.flag??'w',options.mode)
 let moved=false
 try{
  try{writeFileSync(fd,contents,options.encoding?{encoding:options.encoding}:undefined);fsync(fd)}finally{closeSync(fd)}
  for(let attempt=0;attempt<pauses.length;attempt++){
   wait(pauses[attempt])
   try{move(temporary,path);moved=true;break}
   catch(error){if(!retryable.has(error?.code??'')||attempt===pauses.length-1)throw error}
  }
 }finally{if(!moved)try{unlinkSync(temporary)}catch{}}
 flushDirectory(directory,fsync)
}

export const zeroFilled=text=>text.length>0&&!/[^\0]/.test(text)

const reported=new Set()
export function reportUnreadableRecord(path,reason,options={}){
 let stamp=''
 try{const stat=statSync(path);stamp=stat.size+'-'+Math.trunc(stat.mtimeMs)}catch{}
 const key=path+'|'+stamp
 if(reported.has(key))return
 reported.add(key)
 let kept=''
 if(options.preserve&&stamp){const copy=path+'.unreadable-'+stamp;try{copyFileSync(path,copy);kept='; its bytes are kept at '+copy}catch{}}
 console.error(`[records] ${path} is unreadable (${reason}); treating it as missing${kept}`)
}

export function parseJsonRecord(path,text){
 if(!text.length||zeroFilled(text)){reportUnreadableRecord(path,text.length?`${text.length} zero bytes`:'empty');return undefined}
 try{return JSON.parse(text)}
 catch(error){reportUnreadableRecord(path,error instanceof Error?error.message:String(error),{preserve:true});return undefined}
}

export function readJsonRecord(path){
 let text
 try{text=readFileSync(path,'utf8')}
 catch(error){if(error?.code==='ENOENT')return undefined;throw error}
 return parseJsonRecord(path,text)
}

export function readJsonSettings(path){
 let text
 try{text=readFileSync(path,'utf8')}
 catch(error){if(error?.code==='ENOENT')return undefined;throw error}
 if(!text.length||zeroFilled(text)){reportUnreadableRecord(path,text.length?`${text.length} zero bytes`:'empty');return undefined}
 return JSON.parse(text)
}

export const RUN_FILE_STEM_LENGTH=47
export function runFileStem(runID){
 const id=String(runID)
 if(id.length<=RUN_FILE_STEM_LENGTH)return id
 const head=id.slice(0,41),word=head.lastIndexOf('-'),slug=(word>0?head.slice(0,word):head.slice(0,40)).replace(/-+$/,'')
 return slug+'-'+createHash('sha256').update(id).digest('hex').slice(0,8)+'-'+id.slice(-6)
}
export function runFileCandidates(directory,runID,extension='.json'){
 const stem=runFileStem(runID)
 return stem===runID?[join(directory,stem+extension)]:[join(directory,stem+extension),join(directory,runID+extension)]
}
