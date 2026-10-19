import { UsageError } from "./backend"
import type { LocalBackend } from "./local"
import { redact } from "./redact"
import { computerPaths, type Reply } from "./remote"
import type { UsageProvider } from "./types"
import { catalogEntry } from "./providers"

const MAX_BODY_BYTES = 4096

const refuse = (status: number, code: string, message: string): Reply => ({ status, body: { code, message } })

function parse(text: string): Record<string, unknown> | undefined {
  if (text.length > MAX_BODY_BYTES) return undefined
  try {
    const value = JSON.parse(text || "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  } catch { return undefined }
}

export async function computerRoute(backend: LocalBackend, method: string, path: string, bodyText: string): Promise<Reply> {
  const [route, query = ""] = path.split("?")
  try {
    if (route === computerPaths.providers && method === "GET") return { status: 200, body: await backend.capabilities() }
    if (route === computerPaths.status && method === "GET") {
      const id = new URLSearchParams(query).get("id")
      if (!id) return refuse(400, "INVALID_INPUT", "id is required.")
      return { status: 200, body: await backend.connectStatus(id) }
    }
    if (method !== "POST") return refuse(405, "METHOD_NOT_ALLOWED", "Use POST for this.")
    const body = parse(bodyText)
    if (!body) return refuse(400, "INVALID_INPUT", "Send one small JSON object.")
    if (route === computerPaths.start) {
      const provider = body.provider
      if (typeof provider !== "string" || !catalogEntry(provider)) return refuse(400, "INVALID_INPUT", "provider must be a known provider.")
      return { status: 200, body: await backend.connectStart(provider as UsageProvider, { another: body.another === true }) }
    }
    if (route === computerPaths.key) {
      if (typeof body.id !== "string" || typeof body.key !== "string") return refuse(400, "INVALID_INPUT", "id and key are required.")
      return { status: 200, body: await backend.submitKey(body.id, body.key) }
    }
    if (route === computerPaths.disconnect) {
      if (typeof body.account !== "string" || !body.account.trim()) return refuse(400, "INVALID_INPUT", "account is required.")
      return { status: 200, body: await backend.disconnect(body.account.trim()) }
    }
    return refuse(404, "NOT_FOUND", "Unknown connect route.")
  } catch (error) {
    if (error instanceof UsageError) return refuse(error.code.startsWith("UNKNOWN") || error.code === "AMBIGUOUS_ACCOUNT" ? 404 : 400, error.code, redact(error.message))
    return refuse(500, "USAGE_UNAVAILABLE", "Usage could not do that on this computer.")
  }
}
