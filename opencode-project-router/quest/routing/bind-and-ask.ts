import { redact } from '../privacy'

export type BoundModel = { providerID: string; id: string; variant?: string }
export type BindHost = { create: (input: any) => Promise<any>; get: (input: any) => Promise<any>; generate?: (input: any) => Promise<any>; delete?: (input: any) => Promise<any> }
export type BindAsk = { title: string; agent: string; model: BoundModel; directory: string; label: string; identity: string; prompt: string; failure: (message: string) => Error; bound?: (sessionID: string) => void }

const unwrap = (value: any) => value?.data ?? value

export async function discardSession(host: { delete?: (input: any) => Promise<any> }, sessionID: string) {
  if (typeof host.delete !== 'function') return
  try { await host.delete({ sessionID }) } catch (error) { console.error('[bind-and-ask] session ' + sessionID + ' not deleted:', redact(String(error), 200)) }
}

export async function bindAndAsk(host: BindHost, ask: BindAsk): Promise<{ sessionID: string; text: string }> {
  const { model } = ask
  if (typeof host.generate !== 'function') throw ask.failure('This host offers no session generate, so nothing was sent.')
  const created = unwrap(await host.create({ title: ask.title, agent: ask.agent, model, location: { directory: ask.directory } }))
  if (!created?.id) throw ask.failure('The ' + ask.label + ' session identity was not returned; nothing was sent.')
  try {
    const session = unwrap(await host.get({ sessionID: created.id }))
    if (session?.agent !== ask.agent || session.model?.providerID !== model.providerID || session.model?.id !== model.id || (model.variant !== undefined && session.model?.variant !== model.variant)) throw ask.failure('The ' + ask.label + ' session was not bound to ' + ask.identity + '; nothing was sent.')
    ask.bound?.(created.id)
    const response = unwrap(await host.generate({ sessionID: created.id, prompt: ask.prompt }))
    return { sessionID: created.id as string, text: String(response?.text ?? '').trim() }
  } finally {
    await discardSession(host, created.id)
  }
}
