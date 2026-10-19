import { createHash } from "node:crypto"
import type { Tokens } from "./telemetry"

export type PartKind = "system" | "tool" | "message" | "output" | "reasoning"
export type CompositionPart = { kind: PartKind; label: string; chars?: number; tokens: number; cached: boolean; count?: number }
export type Composition = { basis: string; parts: CompositionPart[] }
export type BodyPart = { kind: "system" | "tool" | "message"; text: string }
export type CountedPart = { kind: BodyPart["kind"]; tokens: number }

const SECTION = /^# Your Model|Here is some useful information about the environment|<env>|^Today's date|\{"total":\d+,"shown":|^The Code Mode tool catalog|^No Code Mode tools are currently available|^Skills provide specialized instructions|When you create a worktree|^Instructions from: [^\n]*|^Quest operations, called inside|^Recoverable task checkpoint/gm
export function systemSections(part: unknown): { label: string; text: string }[] {
  const text = typeof part === "string" ? part : Array.isArray(part) ? part.map((p: any) => typeof p === "string" ? p : p?.text ?? "").join("\n") : JSON.stringify(part) ?? ""
  const cuts: { at: number; label: string }[] = []
  for (const match of text.matchAll(SECTION)) {
    const head = match[0]
    const label = head.startsWith("Instructions from: ") ? "instructions " + head.slice(19).replace(/^.*[\\/]/, "").trim() : head.startsWith("{") || head.includes("Code Mode tool") ? "tool catalog" : head.startsWith("Today's date") ? "date" : head.startsWith("Skills provide") ? "skills" : head.startsWith("<env>") ? "env" : head.startsWith("# Your Model") ? "model" : head.startsWith("Here is") ? "environment" : head.startsWith("When you") ? "worktree note" : head.startsWith("Quest operations") ? "quest brief" : "checkpoint"
    cuts.push({ at: match.index!, label })
  }
  if (!cuts.length || cuts[0].at > 0) cuts.unshift({ at: 0, label: "prompt" })
  return cuts.map((cut, i) => ({ label: cut.label, text: text.slice(cut.at, cuts[i + 1]?.at ?? text.length) }))
}

const str = (value: unknown) => typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? ""
const toolName = (tool: any) => String(tool?.name ?? tool?.function?.name ?? tool?.type ?? "?")
function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return str(content)
  return content.map((block: any) => typeof block === "string" ? block : typeof block?.text === "string" ? block.text : typeof block?.content === "string" ? block.content : Array.isArray(block?.content) ? contentText(block.content) : "").join("\n")
}
const isImage = (block: any) => ["image", "image_url", "input_image"].includes(block?.type)

export function bodyParts(body: any): BodyPart[] {
  const parts: BodyPart[] = []
  const system = (value: unknown) => { for (const section of systemSections(value)) parts.push({ kind: "system", text: section.text }) }
  const tools = () => { for (const tool of Array.isArray(body?.tools) ? body.tools : []) parts.push({ kind: "tool", text: str(tool) }) }
  const call = (name: string, args: unknown) => parts.push({ kind: "message", text: name + str(args) })
  const result = (output: unknown) => parts.push({ kind: "message", text: contentText(output) })
  const blocks = (content: unknown) => {
    if (!Array.isArray(content)) { parts.push({ kind: "message", text: contentText(content) }); return }
    for (const block of content) {
      const type = block?.type
      if (type === "tool_use" || type === "server_tool_use") call(String(block.name ?? "?"), block.input)
      else if (type === "tool_result") result(block.content)
      else if (type === "thinking" || type === "redacted_thinking") parts.push({ kind: "message", text: str(block.thinking) })
      else if (isImage(block)) parts.push({ kind: "message", text: "" })
      else parts.push({ kind: "message", text: typeof block === "string" ? block : str(block?.text ?? block?.content ?? "") })
    }
  }
  const message = (item: any) => {
    const role = String(item?.role ?? "")
    if (role === "system" || role === "developer") { system(item.content); return }
    if (role === "assistant" && Array.isArray(item.tool_calls)) {
      if (item.content) blocks(item.content)
      if (typeof item.reasoning_content === "string" && item.reasoning_content) parts.push({ kind: "message", text: item.reasoning_content })
      for (const c of item.tool_calls) call(String(c?.function?.name ?? c?.name ?? "?"), c?.function?.arguments ?? c?.arguments)
      return
    }
    if (role === "tool") { result(item.content); return }
    blocks(item.content)
  }
  const inputItem = (item: any) => {
    const type = item?.type
    if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") call(String(item.name ?? type), item.arguments ?? item.input ?? item.action)
    else if (type === "function_call_output" || type === "custom_tool_call_output" || type === "local_shell_call_output") result(item.output)
    else if (type === "reasoning") parts.push({ kind: "message", text: [...(item.summary ?? []), ...(item.content ?? [])].map((s: any) => s?.text ?? "").join("\n") })
    else if (item?.role) message(item)
    else parts.push({ kind: "message", text: str(item) })
  }
  if (body?.system !== undefined) {
    tools()
    for (const each of Array.isArray(body.system) ? body.system : [body.system]) system(typeof each?.text === "string" ? each.text : each)
    for (const item of Array.isArray(body.messages) ? body.messages : []) message(item)
    return parts
  }
  const conversation: any[] = [...(Array.isArray(body?.messages) ? body.messages : []), ...(Array.isArray(body?.input) ? body.input : typeof body?.input === "string" ? [{ role: "user", content: body.input }] : [])]
  if (body?.instructions !== undefined) system(body.instructions)
  let lead = 0
  while (lead < conversation.length && (conversation[lead]?.role === "system" || conversation[lead]?.role === "developer")) message(conversation[lead++])
  tools()
  for (const item of conversation.slice(lead)) inputItem(item)
  return parts
}

type Counter = (text: string) => number
let tokenizer: Promise<Counter> | undefined
export function o200k(): Promise<Counter> {
  return tokenizer ??= import("gpt-tokenizer/encoding/o200k_base").then(m => (text: string) => m.countTokens(text), error => {
    console.warn("[usage] o200k tokenizer unavailable; requests are recorded without composition")
    throw error
  })
}
const counted = new Map<string, number>()
export function countParts(parts: BodyPart[], count: Counter): CountedPart[] {
  return parts.map(part => {
    let tokens = 0
    if (part.text) {
      const key = part.text.length < 64 ? part.text : createHash("sha1").update(part.text).digest("base64")
      tokens = counted.get(key) ?? count(part.text)
      counted.set(key, tokens)
    }
    return { kind: part.kind, tokens }
  })
}

export const BASIS = "o200k, scaled to provider total"
export const partCount = (composition: Composition) => composition.parts.reduce((n, part) => n + (part.count ?? 1), 0)
export function composeRequest(parts: CountedPart[], tokens: Tokens, outputTotal?: number): Composition {
  const totals = new Map<string, CompositionPart>()
  const add = (kind: PartKind, amount: number, cached: boolean) => {
    const key = kind + (cached ? " cached" : "")
    const row = totals.get(key)
    if (row) { row.tokens += amount; row.count = (row.count ?? 1) + 1 }
    else totals.set(key, { kind, label: kind, tokens: amount, cached, count: 1 })
  }
  const prompt = tokens.input !== null && tokens.cacheRead !== null && tokens.cacheWrite !== null ? tokens.input + tokens.cacheRead + tokens.cacheWrite : null
  if (prompt === null) {
    for (const p of parts) add(p.kind, p.tokens, false)
  } else {
    const raw = parts.reduce((n, p) => n + p.tokens, 0)
    const rows = raw > 0 ? parts : [...parts.map(p => ({ ...p, tokens: 0 })), { kind: "message" as const, tokens: 1 }]
    const denominator = raw > 0 ? raw : 1
    const exact = rows.map(p => p.tokens * prompt / denominator), scaled = exact.map(Math.floor)
    let rest = prompt - scaled.reduce((n, v) => n + v, 0)
    for (const i of exact.map((v, i) => i).sort((a, b) => (exact[b] - scaled[b]) - (exact[a] - scaled[a]) || a - b)) { if (rest <= 0) break; scaled[i]++; rest-- }
    let cache = tokens.cacheRead ?? 0
    rows.forEach((p, i) => {
      const n = scaled[i], hit = Math.min(cache, n)
      cache -= hit
      if (hit > 0 && hit < n) { add(p.kind, hit, true); add(p.kind, n - hit, false) }
      else add(p.kind, n, hit > 0)
    })
  }
  if (tokens.output !== null) add("output", tokens.output, false)
  else if (outputTotal !== undefined) add("output", outputTotal, false)
  if (tokens.reasoning) add("reasoning", tokens.reasoning, false)
  return { basis: prompt === null ? "o200k, unscaled: the provider reported no prompt total" : BASIS, parts: [...totals.values()] }
}
