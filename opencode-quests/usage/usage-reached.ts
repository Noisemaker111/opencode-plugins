
export const USAGE_REACHED = "Usage reached"

const USAGE_RE = new RegExp(
  [
    /\d+\s*-?\s*(hour|day|week|month)ly?\s+usage\s+limit/.source,
    /(5-hour|weekly|7-day|monthly|daily)\s+usage\s+limit/.source,
    /usage\s+limit\s+(reached|exceeded|hit)/.source,
    /(hit|reached|exceeded|past|over)\s+(your|the|its)?\s*\w*\s*usage\s+limit/.source,
    /usage\s+balance\s+exhausted/.source,
    /quota\s+(exceeded|reached|exhausted)/.source,
    /out\s+of\s+(quota|credits?)/.source,
    /insufficient\s+(quota|credits?|balance|funds)/.source,
    /resource.?exhausted/.source,
    /billing\s+(hard\s+)?limit/.source,
    /credit\s+balance\s+is\s+too\s+low/.source,
  ].join("|"),
  "i",
)

const PROVIDER_RE = /\b(apierror|provider (error|returned)|returned error|upstream error|internal server error|"?status(Code)?"?\s*[:=]\s*"?5\d\d"?)\b/i

const KNOWN_PROVIDERS = [
  "opencode-go",
  "grok-sub",
  "claude-code",
  "openrouter",
  "openai",
  "anthropic",
  "cursor",
  "opencode",
  "xai",
]

export type FailureKind = "usage" | "provider"
export type ProviderFailure = {
  kind: FailureKind
  providerID?: string
  modelID?: string
  detail: string
}

function excerpt(blob: string, index: number): string {
  const start = Math.max(0, index - 40)
  return blob.slice(start, start + 400).replace(/\s+/g, " ").trim()
}

export function providerModelFromBlob(blob: string): { providerID?: string; modelID?: string } {
  const providerID =
    /"providerID"\s*:\s*"([^"]+)"/i.exec(blob)?.[1] ??
    KNOWN_PROVIDERS.find((id) => new RegExp(`\\b${id.replace(/[-/]/g, "[-/]")}\\b`, "i").test(blob))
  const modelID =
    /"modelID"\s*:\s*"([^"]+)"/i.exec(blob)?.[1] ??
    /"model"\s*:\s*"([^"]+)"/i.exec(blob)?.[1] ??
    (providerID ? new RegExp(`${providerID}/([\\w.:-]+)`, "i").exec(blob)?.[1] : undefined)
  return { providerID, modelID }
}

export function detectProviderFailure(blob: string): ProviderFailure | undefined {
  if (!blob) return
  const usage = USAGE_RE.exec(blob)
  if (usage) return { kind: "usage", ...providerModelFromBlob(blob), detail: excerpt(blob, usage.index) }

  const generic =
    /\bHTTP\s+(401|402|403|429)\b|"?(status|statusCode|code)"?\s*[:=]\s*"?(401|402|403|429)\b|rate.?limit|too many requests|over capacity/i.exec(blob) ??
    PROVIDER_RE.exec(blob) ??
    /opencode-go[\s\S]{0,200}(apierror|provider (error|returned)|returned error)/i.exec(blob) ??
    /(apierror|provider (error|returned)|returned error)[\s\S]{0,200}opencode-go/i.exec(blob)
  if (generic) return { kind: "provider", ...providerModelFromBlob(blob), detail: excerpt(blob, generic.index) }
  return
}

export function failureTarget(failure: Pick<ProviderFailure, "providerID" | "modelID">): string {
  if (failure.providerID && failure.modelID) return `${failure.providerID}/${failure.modelID}`
  return failure.providerID ?? failure.modelID ?? "the current model"
}

export function usageReachedMessage(
  failure: Pick<ProviderFailure, "providerID" | "modelID">,
  fallback?: { providerID: string; modelID: string },
): string {
  const spent = failureTarget(failure)
  return fallback
    ? `${USAGE_REACHED} — ${spent}. Falling over to ${fallback.providerID}/${fallback.modelID}.`
    : `${USAGE_REACHED} — ${spent}. Inspect the actual quota and reset evidence. No fallback has been authorized or performed.`
}

export function providerFailureMessage(
  failure: Pick<ProviderFailure, "providerID" | "modelID">,
  fallback?: { providerID: string; modelID: string },
): string {
  const failed = failureTarget(failure)
  return fallback
    ? `Provider unavailable — ${failed}. Falling over to ${fallback.providerID}/${fallback.modelID}.`
    : `Provider unavailable — ${failed}. Inspect the actual request error and retry guidance; quota exhaustion is not established.`
}

export function failureMessage(
  failure: ProviderFailure,
  fallback?: { providerID: string; modelID: string },
): string {
  return failure.kind === "usage" ? usageReachedMessage(failure, fallback) : providerFailureMessage(failure, fallback)
}

export function isUsageReached(blob: string): boolean {
  return detectProviderFailure(blob)?.kind === "usage"
}
