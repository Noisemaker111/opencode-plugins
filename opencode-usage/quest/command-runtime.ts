import { spawn } from "node:child_process"
import { createWriteStream,mkdirSync } from "node:fs"
import { basename,dirname,join } from "node:path"
import { redact } from './privacy'
import { readDispatchPolicy } from '../models/dispatch-policy'
export type CommandSpec={argv:string[];timeoutMilliseconds:number;description:string}
export function configuredCommand(policyFile:string,projectID:string,commandID:string):CommandSpec {const policy=readDispatchPolicy(policyFile);if(policy.version!==1)throw new Error("Unsupported command policy");const command=policy.commandsByProject?.[projectID]?.[commandID];if(!command||!Array.isArray(command.argv)||!command.argv.length||command.argv.some((x:unknown)=>typeof x!=="string")||!Number.isInteger(command.timeoutMilliseconds)||command.timeoutMilliseconds<=0||typeof command.description!=="string")throw new Error("Command is not configured for this project: "+commandID);return command}
export function runKnownCommand(command:CommandSpec,cwd:string,logFile:string):Promise<{exitCode:number|null;signal:string|null;timedOut:boolean;milliseconds:number;logFile:string;truncated:boolean;output:string;outputTruncated:boolean}> {
 if(!command.argv.length||!Number.isInteger(command.timeoutMilliseconds)||command.timeoutMilliseconds<0)throw new Error("Invalid command: give argv and a timeout of 0 (none) or more milliseconds")
 if(/^opencode(?:2)?(?:\.exe)?$/i.test(basename(command.argv[0]))&&!command.argv.includes("--standalone"))throw new Error("Timed command execution of OpenCode requires an isolated --standalone instance")
 mkdirSync(dirname(logFile),{recursive:true});const output=createWriteStream(logFile,{flags:"wx",mode:0o600}),started=Date.now()
 return new Promise((resolve,reject)=>{let finished=false,timedOut=false,bytes=0,truncated=false;const child=spawn(command.argv[0],command.argv.slice(1),{cwd,windowsHide:true,stdio:["ignore","pipe","pipe"],shell:false})
  const timer=command.timeoutMilliseconds>0?setTimeout(()=>{timedOut=true;child.kill()},command.timeoutMilliseconds):undefined
  let head=Buffer.alloc(0),tail=Buffer.alloc(0),observed=0
  const write=(chunk:Buffer)=>{observed+=chunk.length;const take=Math.min(chunk.length,8192-head.length);if(take)head=Buffer.concat([head,chunk.subarray(0,take)]);tail=Buffer.concat([tail,chunk.subarray(take)]).subarray(-8192);if(bytes>=16*1024*1024){truncated=true;return}const remaining=16*1024*1024-bytes;output.write(chunk.subarray(0,remaining));bytes+=Math.min(chunk.length,remaining);if(chunk.length>remaining)truncated=true}
  child.stdout?.on("data",write);child.stderr?.on("data",write)
  const fail=(error:Error)=>{if(finished)return;finished=true;clearTimeout(timer);child.kill();output.end();reject(error)}
  output.once("error",fail);child.once("error",fail)
   child.once("close",(exitCode,signal)=>{if(finished)return;clearTimeout(timer);output.end(()=>{if(finished)return;finished=true;resolve({exitCode,signal,timedOut,milliseconds:Date.now()-started,logFile,truncated,output:redact(head.toString('utf8')+(observed>16384?'\n[output omitted; durable log retained]\n':'')+tail.toString('utf8'),16500),outputTruncated:observed>16384})})})
 })
}
