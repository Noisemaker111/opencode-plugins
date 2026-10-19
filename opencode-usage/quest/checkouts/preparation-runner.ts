import {spawn} from 'node:child_process'
import {bootstrapStepTimeout,bootstrapWorkspacePath,describeBootstrapStep,type BootstrapStep} from './workspace-bootstrap'

export type StepTiming={stage:string;start:number;end:number}
type Result={index:number;start:number;end:number;status:number|null;stderr:string;error?:string}

const clean=(path:string)=>path.replaceAll('\\','/').replace(/^(\.\/)+/,'').replace(/\/+$/,'')
const within=(a:string,b:string)=>b===''||a===b||a.startsWith(b+'/')

export function preparationOrder(steps:BootstrapStep[]):number[][] {
  return steps.map((step,index)=>{
    const earlier=[...Array(index).keys()]
    if(!step.kind)return earlier
    const folder=clean(step.cwd??'')
    return earlier.filter(at=>{
      const other=steps[at]!
      if(!other.kind)return true
      if(step.kind!=='install'||other.kind!=='submodule')return false
      const paths=(other.paths??[]).map(clean)
      return !paths.length||paths.some(path=>within(folder,path)||(!!step.workspaces&&within(path,folder)))
    })
  })
}

const failure=(step:BootstrapStep,result:Result)=>new Error('Workspace preparation failed at '+describeBootstrapStep(step)+'; workspace retained: '+(result.error??(result.stderr.trim()||'exit '+result.status)))

export async function runPreparationSteps(path:string,steps:BootstrapStep[]):Promise<StepTiming[]> {
  const results=await schedule(path,steps,preparationOrder(steps))
  const timings=results.map(result=>({stage:steps[result.index]!.description,start:result.start,end:result.end}))
  const failed=results.find(result=>result.status!==0)
  if(failed)throw Object.assign(failure(steps[failed.index]!,failed),{timings})
  return timings
}

function schedule(path:string,steps:BootstrapStep[],order:number[][]):Promise<Result[]> {
  const results:Result[]=[],started=new Set<number>(),finished=new Set<number>()
  let running=0,failed=false
  return new Promise<Result[]>(settle=>{
    const launch=()=>{
      if(!failed)for(const [index,waits] of order.entries()){
        if(started.has(index)||!waits.every(at=>finished.has(at)))continue
        started.add(index);running++
        const step=steps[index]!,start=Date.now()
        let stderr='',done=false
        const end=(status:number|null,error?:string)=>{
          if(done)return;done=true;clearTimeout(timer);running--
          results.push({index,start,end:Date.now(),status,stderr,...(error?{error}:{})})
          if(status===0)finished.add(index);else failed=true
          launch()
        }
        let child:ReturnType<typeof spawn>
        try{child=spawn(step.argv[0]!,step.argv.slice(1),{cwd:bootstrapWorkspacePath(path,step),env:process.env,windowsHide:true,stdio:['ignore','ignore','pipe']})}
        catch(error){running--;results.push({index,start,end:Date.now(),status:null,stderr:'',error:error instanceof Error?error.message:String(error)});failed=true;break}
        child.stderr?.on('data',chunk=>{stderr+=chunk})
        const timer=setTimeout(()=>{child.kill();end(null,'timed out after '+bootstrapStepTimeout(step)/1000+' s')},bootstrapStepTimeout(step))
        child.once('error',error=>end(null,error.message))
        child.once('close',code=>end(code))
      }
      if(!running)settle(results.sort((a,b)=>a.index-b.index))
    }
    launch()
  })
}
