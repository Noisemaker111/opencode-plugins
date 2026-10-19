import { AsyncLocalStorage } from 'node:async_hooks'

export type HistoryOrigin = { from: string; sessionID?: string; requestID?: string; directory?: string }
const origins = new AsyncLocalStorage<HistoryOrigin>()
export const historyOrigin = () => origins.getStore()
export const withHistoryOrigin = <T>(origin: HistoryOrigin, run: () => T): T => origins.run(origin, run)

export async function installHistoryOrigin(session: { hook?: Function }, isWorker: (id: string) => boolean) {
  if (typeof session.hook !== 'function') throw Error('The host cannot save where prompts came from.')
  return session.hook('prompt', (event: any) => {
    if (event.metadata?.questHistoryOrigin) return
    const runtime = isWorker(event.sessionID) || ['questWorkerReturn', 'questWorkerPermission', 'questAttention', 'questHandoff', 'projectRouterGoal', 'projectRouterReturn'].some(key => event.metadata?.[key] === true)
    event.metadata = { ...event.metadata, questHistoryOrigin: { from: runtime ? 'runtime' : 'terminal' } }
  })
}
