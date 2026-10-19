type Entry = { finish?: () => void; consumed?: Set<string> }
const symbol = Symbol.for('opencode.quest.goal-terminal-ownership.v1')
const entries: Map<string, Entry> = (globalThis as any)[symbol] ??= new Map()
const key = (runtime: string, sessionID: string) => runtime + ':' + sessionID
export function retainGoalTerminal(runtime: string, sessionID: string) { if (!entries.has(key(runtime, sessionID))) entries.set(key(runtime, sessionID), {}) }
export function deferGoalTerminal(runtime: string, sessionID: string, finish: () => void, eventID?:string) {
  const entry = entries.get(key(runtime, sessionID)); if (!entry) return false
  if(eventID&&entry.consumed?.has(eventID))return true
  entry.finish ??= finish; return true
}
export function finishGoalTerminal(runtime: string, sessionID: string) {
  const entry = entries.get(key(runtime, sessionID)); entries.delete(key(runtime, sessionID)); entry?.finish?.()
}
export function consumeGoalTerminal(runtime: string, sessionID: string,eventID?:string) { const entry = entries.get(key(runtime, sessionID)); if (entry) {delete entry.finish;if(eventID){entry.consumed??=new Set();entry.consumed.add(eventID)}} }
