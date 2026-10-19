import { UsageError, type Backend, type Capabilities, type ConnectStart, type ConnectStatus, type Disconnected } from "./backend"
import type { ReadAccount } from "./views"

export type Reply = { status: number; body: unknown }
export type Call = (method: "GET" | "POST", path: string, body?: unknown) => Promise<Reply>

export const computerPaths = {
  providers: "/connect/providers",
  start: "/connect/start",
  status: "/connect/status",
  key: "/connect/key",
  disconnect: "/disconnect",
  accounts: "/accounts",
}

const failed = (reply: Reply): never => {
  const body = (reply.body ?? {}) as { code?: unknown; message?: unknown }
  const code = typeof body.code === "string" && /^[A-Z_]+$/.test(body.code) ? body.code : "USAGE_UNAVAILABLE"
  const message = typeof body.message === "string" ? body.message : `The computer answered HTTP ${reply.status}.`
  throw new UsageError(code, message)
}

export function remoteBackend(call: Call, origin: string): Backend {
  const ok = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const reply = await call(method, path, body)
    if (reply.status < 200 || reply.status >= 300) return failed(reply)
    return reply.body as T
  }
  return {
    async capabilities(): Promise<Capabilities> {
      const reply = await call("GET", computerPaths.providers).catch(() => undefined)
      if (!reply || reply.status >= 500) {
        const reported = (reply?.body as { message?: unknown } | undefined)?.message
        throw new UsageError("HOST_UNREACHABLE", reply?.status === 503 && typeof reported === "string" ? reported : "The linked computer is not reachable, so no Usage tools are listed. Try again when it is online.")
      }
      const body = (reply.body ?? {}) as Partial<Capabilities>
      const names = (value: unknown) => Array.isArray(value) && value.every(name => typeof name === "string") ? value as string[] : undefined
      const read = names(body.read), operations = names(body.operations)
      if (reply.status !== 200 || !read || !operations) throw new UsageError("HOST_TOO_OLD", "The computer's Usage service is too old to say which tools it supports, so none are listed. It updates itself after the next landing.")
      return { release: typeof body.release === "string" ? body.release : null, generation: typeof body.generation === "string" ? body.generation : null, ...(typeof body.timeZone === "string" ? { timeZone: body.timeZone } : {}), read, operations, connect: Array.isArray(body.connect) ? body.connect : [] }
    },
    accounts: async () => {
      const body = await ok<ReadAccount[] | { accounts?: ReadAccount[] }>("GET", computerPaths.accounts)
      return Array.isArray(body) ? body : body.accounts ?? []
    },
    async connectStart(provider, options) {
      const start = await ok<ConnectStart>("POST", computerPaths.start, { provider, ...(options?.another ? { another: true } : {}) })
      const { formPath, ...rest } = start
      return formPath ? { ...rest, url: origin + formPath } : start
    },
    connectStatus: id => ok<ConnectStatus>("GET", `${computerPaths.status}?id=${encodeURIComponent(id)}`),
    disconnect: account => ok<Disconnected>("POST", computerPaths.disconnect, { account }),
  }
}
