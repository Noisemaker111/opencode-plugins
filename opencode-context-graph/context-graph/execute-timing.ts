import type { InnerCallRecord } from "./execute-attribution"

type OpenCall = { tool: string; start: number }
type Frame = { opened: number; calls: InnerCallRecord[]; open: OpenCall[] }

const MAX_FRAMES = 64

export class ExecuteTiming {
  private readonly frames = new Map<string, Frame>()

  private key(sessionID: string, id: string) { return sessionID + " " + id }

  before(sessionID: string, id: string, tool: string, now = Date.now()) {
    const key = this.key(sessionID, id)
    if (tool === "execute") {
      if (this.frames.size >= MAX_FRAMES) {
        const oldest = [...this.frames.entries()].sort((a, b) => a[1].opened - b[1].opened)[0]
        if (oldest) this.frames.delete(oldest[0])
      }
      this.frames.set(key, { opened: now, calls: [], open: [] })
      return
    }
    this.frames.get(key)?.open.push({ tool, start: now })
  }

  after(sessionID: string, id: string, tool: string, status: string, now = Date.now()): InnerCallRecord[] | undefined {
    const key = this.key(sessionID, id)
    const frame = this.frames.get(key)
    if (!frame) return undefined
    if (tool === "execute") {
      this.frames.delete(key)
      const interrupted = frame.open.map(call => ({ tool: call.tool, start: call.start, end: now, status: "interrupted" as const }))
      return [...frame.calls, ...interrupted].sort((a, b) => a.start - b.start)
    }
    const index = frame.open.findIndex(call => call.tool === tool)
    if (index < 0) return undefined
    const [call] = frame.open.splice(index, 1)
    frame.calls.push({ tool, start: call.start, end: now, status: status === "error" ? "error" : "completed" })
    return undefined
  }
}

export async function installExecuteTiming(ctx: any): Promise<ExecuteTiming | undefined> {
  if (typeof ctx?.tool?.hook !== "function") return undefined
  const timing = new ExecuteTiming()
  await ctx.tool.hook("execute.before", (event: any) => {
    const id = event?.id ?? event?.callID
    if (event?.sessionID && id && typeof event.tool === "string") timing.before(event.sessionID, id, event.tool)
  })
  await ctx.tool.hook("execute.after", (event: any) => {
    const id = event?.id ?? event?.callID
    if (!event?.sessionID || !id || typeof event.tool !== "string") return
    const spans = timing.after(event.sessionID, id, event.tool, String(event.status ?? ""))
    if (!spans?.length || !event.result) return
    event.result.metadata = { ...(event.result.metadata ?? {}), innerCalls: spans }
  })
  return timing
}
