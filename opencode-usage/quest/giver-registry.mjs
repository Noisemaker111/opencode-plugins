import {existsSync,mkdirSync,renameSync} from 'node:fs'
import {writeFileDurable,readJsonRecord} from './core/durable-file.mjs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
export const giverFile=runtime=>join(runtime,'user-giver.json')
export function readUserGiver(runtime){const file=giverFile(runtime);const row=readJsonRecord(file);if(!row)return;if(row.version!==1||!['bound','launching','unknown'].includes(row.state)||row.state==='bound'&&!/^ses_[A-Za-z0-9_-]+$/.test(row.sessionID??''))throw Error('User giver registration is invalid; inspect it without creating another giver');return row}
export function saveUserGiver(runtime,row){mkdirSync(runtime,{recursive:true});const file=giverFile(runtime);writeFileDurable(file,JSON.stringify({...row,version:1,updatedAt:new Date().toISOString()}))}
export function releaseUserGiver(runtime){
 const file=giverFile(runtime)
 if(!existsSync(file))return
 const row=readJsonRecord(file)
 const previous=file+'.released-'+Date.now()+'-'+randomUUID()+'.json'
 renameSync(file,previous)
 return row?.sessionID
}
