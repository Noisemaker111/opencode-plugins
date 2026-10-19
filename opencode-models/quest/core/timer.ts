import { Duration, Effect, Clock } from 'effect'

export type Wait=(milliseconds:number,fire:()=>void)=>()=>void
export const timerWait:Wait=(milliseconds,fire)=>{const timer:any=setTimeout(fire,Math.max(0,Math.min(milliseconds,2**31-1)));timer.unref?.();return ()=>clearTimeout(timer)}

const wallNanos=()=>BigInt(Date.now())*1_000_000n
const monotonicNanos=()=>process.hrtime.bigint()

export const timerClock:Clock.Clock={
 currentTimeMillisUnsafe:()=>Date.now(),
 currentTimeMillis:Effect.sync(()=>Date.now()),
 currentTimeNanosUnsafe:()=>wallNanos(),
 currentTimeNanos:Effect.sync(()=>wallNanos()),
 monotonicTimeNanosUnsafe:()=>monotonicNanos(),
 monotonicTimeNanos:Effect.sync(()=>monotonicNanos()),
 sleep:duration=>Effect.callback<void>(resume=>{
  const release=timerWait(Duration.toMillis(duration),()=>resume(Effect.void))
  return Effect.sync(()=>release)
 }),
}
