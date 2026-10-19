import { execFile, spawn, spawnSync } from "node:child_process"
import { appendFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitCommonDirectory } from "../checkouts/cleanup-git.mjs"

const tracedGitCalls=new Set<string>()
const traceOperations=new Set(["rev-parse","worktree","symbolic-ref","config","var","status","diff","log","ls-files","merge-base","add","commit","merge","checkout","reset","read-tree","write-tree","update-index","apply"])
export function traceGitCall(operation:string) {
  if(!traceOperations.has(operation))return
  try{
    const base=join(tmpdir(),"questgiver-git-trace-"+process.pid)
    if(!existsSync(base+".enabled"))return
    const frames=(new Error().stack??"").split("\n").filter(line=>/^\s*at\s/.test(line))
    const key=JSON.stringify([operation,frames])
    if(tracedGitCalls.has(key))return
    appendFileSync(base+".jsonl",JSON.stringify({pid:process.pid,operation,frames})+"\n",{mode:0o600})
    tracedGitCalls.add(key)
  }catch{}
}

export type GitCall = { cwd: string; args: string[]; timeout?: number; maxBuffer?: number; program?: string; shell?: boolean; env?: Record<string, string> }
export type GitResult = { status: number | null; stdout: string; stderr: string; error?: Error; signal?: string | null; timedOut?: boolean }
export type GitTogether = { together: GitSteps<unknown>[] }
export type GitStep = GitCall | GitTogether
export type GitSteps<T> = Generator<GitStep, T, any>
type Outcomes<S extends readonly GitSteps<unknown>[]> = { -readonly [K in keyof S]: S[K] extends GitSteps<infer T> ? T : never }
const GIT_BUFFER = 16 * 1024 * 1024
export function* gitRun(cwd: string, args: string[], timeout?: number): GitSteps<GitResult> { return yield { cwd, args, timeout } }
export function* commandRun(cwd: string, argv: string[], timeout?: number, shell = false): GitSteps<GitResult> { return yield { cwd, args: argv.slice(1), program: argv[0], timeout, shell } }
const repositoryDirectory = (cwd: string) => { try { return gitCommonDirectory(cwd) } catch { return join(cwd, ".git") } }
export function* refRun(cwd: string, args: string[], timeout?: number): GitSteps<GitResult> { return yield* commandRun(process.cwd(), ["git", "--git-dir=" + repositoryDirectory(cwd), ...args], timeout) }
export function gitOutput(result: GitResult, args: string[]): string {
  if (result.status !== 0) throw new Error("Git " + args[0] + " failed: " + (result.stderr || result.error?.message || "unknown error").trim())
  return result.stdout
}
export function* gitOut(cwd: string, args: string[], timeout?: number): GitSteps<string> { return gitOutput(yield { cwd, args, ...(timeout ? { timeout } : {}) }, args) }
export function* together<const S extends readonly GitSteps<unknown>[]>(...steps: S): GitSteps<Outcomes<S>> { return yield { together: [...steps] } }
export function* attempt<T>(steps: GitSteps<T>): GitSteps<{ value: T } | { error: unknown }> {
  try { return { value: yield* steps } } catch (error) { return { error } }
}
export const taken = <T,>(outcome: { value: T } | { error: unknown }): T => { if ("error" in outcome) throw outcome.error; return outcome.value }
const firstFailure = (outcomes: ({ value: unknown } | { error: unknown })[]) => outcomes.find((outcome): outcome is { error: unknown } => "error" in outcome)
export function driveSync<T>(steps: GitSteps<T>): T {
  let next = steps.next()
  while (!next.done) {
    const step = next.value
    if ("together" in step) {
      const outcomes = step.together.map(each => { try { return { value: driveSync(each) } } catch (error) { return { error } } })
      const failed = firstFailure(outcomes)
      next = failed ? steps.throw(failed.error) : steps.next(outcomes.map(outcome => (outcome as { value: unknown }).value))
      continue
    }
    const { cwd, args, timeout, maxBuffer, program, shell, env } = step
    if (!program) traceGitCall(args[0])
    const out = spawnSync(program ?? "git", program ? args : ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: maxBuffer ?? GIT_BUFFER, ...(program ? { cwd, shell } : {}), ...(timeout ? { timeout } : {}), ...(env ? { env: { ...process.env, ...env } } : {}) })
    next = steps.next({ status: out.status, stdout: out.stdout ?? "", stderr: out.stderr ?? "", error: out.error, signal: out.signal, timedOut: (out.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" })
  }
  return next.value
}
export async function driveAsync<T>(steps: GitSteps<T>): Promise<T> {
  let next = steps.next()
  while (!next.done) {
    const step = next.value
    if ("together" in step) {
      const outcomes = await Promise.all(step.together.map(each => driveAsync(each).then(value => ({ value }), (error: unknown) => ({ error }))))
      const failed = firstFailure(outcomes)
      next = failed ? steps.throw(failed.error) : steps.next(outcomes.map(outcome => (outcome as { value: unknown }).value))
      continue
    }
    const { cwd, args, timeout, maxBuffer, program, shell, env } = step
    if (!program) traceGitCall(args[0])
    const result = await new Promise<GitResult>(done => execFile(program ?? "git", program ? args : ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: maxBuffer ?? GIT_BUFFER, ...(program ? { cwd, shell } : {}), ...(timeout ? { timeout } : {}), ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null
      const exit = typeof failure?.code === "number" ? failure.code as unknown as number : failure ? null : 0
      done({ status: exit, stdout: stdout ?? "", stderr: stderr ?? "", error: failure && exit === null ? failure : undefined, signal: failure?.signal ?? null, timedOut: !!timeout && failure?.killed === true })
    }))
    next = steps.next(result)
  }
  return next.value
}
export type FedResult<T extends string | Buffer> = { status: number | null; stdout: T; stderr: string; error?: Error }
export function gitFed(cwd: string, args: string[], options: { input?: string | Buffer; env?: Record<string, string>; binary: true; maxBuffer?: number }): Promise<FedResult<Buffer>>
export function gitFed(cwd: string, args: string[], options?: { input?: string | Buffer; env?: Record<string, string>; binary?: false; maxBuffer?: number }): Promise<FedResult<string>>
export function gitFed(cwd: string, args: string[], options: { input?: string | Buffer; env?: Record<string, string>; binary?: boolean; maxBuffer?: number } = {}): Promise<FedResult<string | Buffer>> {
  traceGitCall(args[0])
  const limit = options.maxBuffer ?? GIT_BUFFER
  return new Promise(done => {
    const child = spawn("git", ["-C", cwd, ...args], { windowsHide: true, env: options.env ? { ...process.env, ...options.env } : process.env, stdio: ["pipe", "pipe", "pipe"] })
    const out: Buffer[] = [], err: Buffer[] = []
    let size = 0, failure: Error | undefined
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > limit) { failure = new Error("Git " + args[0] + " output exceeded " + limit + " bytes"); child.kill() } else out.push(chunk) })
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
    child.stdin.on("error", () => {})
    child.once("error", error => { failure = error })
    child.once("close", code => {
      const stdout = Buffer.concat(out)
      done({ status: failure ? null : code, stdout: options.binary ? stdout : stdout.toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), ...(failure ? { error: failure } : {}) })
    })
    child.stdin.end(options.input ?? "")
  })
}
