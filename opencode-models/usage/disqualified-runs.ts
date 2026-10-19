import {existsSync,mkdirSync,readFileSync} from "node:fs"
import {dirname} from "node:path"
import {writeFileDurable} from "../quest/core/durable-file.mjs"

export type DisqualifiedRun={runID:string;reason:string;at:number}
export const disqualifiedRunsFile=(outcomesFile:string)=>outcomesFile+".disqualified.json"

const valid=(row:DisqualifiedRun)=>!!row&&typeof row.runID==="string"&&row.runID.trim().length>0&&row.runID.length<=2048&&typeof row.reason==="string"&&row.reason.trim().length>0&&row.reason.length<=300&&Number.isFinite(row.at)

export function readDisqualifiedRuns(outcomesFile:string):DisqualifiedRun[]{
 const file=disqualifiedRunsFile(outcomesFile)
 if(!existsSync(file))return []
 const data=JSON.parse(readFileSync(file,"utf8")) as {version:1;runs:DisqualifiedRun[]}
 if(!data||data.version!==1||!Array.isArray(data.runs)||!data.runs.every(valid))throw Error("Unreadable disqualified run record "+file)
 return data.runs
}

export function disqualifyRuns(outcomesFile:string,rows:DisqualifiedRun[]):DisqualifiedRun[]{
 if(!rows.every(valid))throw Error("Each disqualified run needs a run, a reason and a time")
 const kept=readDisqualifiedRuns(outcomesFile)
 for(const row of rows)if(!kept.some(old=>old.runID===row.runID))kept.push(row)
 const file=disqualifiedRunsFile(outcomesFile)
 mkdirSync(dirname(file),{recursive:true})
 writeFileDurable(file,JSON.stringify({version:1,runs:kept}),{mode:0o600})
 return kept
}
