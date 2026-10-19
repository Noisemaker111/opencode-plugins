import { spawnSync } from "node:child_process"
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { cpus, loadavg } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"

const DEFAULTS = {
  base: "v2",
  remote: "origin",
  gate: { full: ["bun", "run", "check:gate"], affected: ["bun", "run", "check:affected"] },
  state: "land",
  scratch: ".claude/worktrees",
  waitMinutes: 25,
  gateMinutes: 60,
}
const STALE_MILLISECONDS = 60_000
const NETWORK_MILLISECONDS = 600_000

const run = (cwd, program, args, timeout = 60_000, env) => spawnSync(program, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26, timeout, ...(env ? { env } : {}) })
const git = (cwd, args, timeout) => run(cwd, "git", args, timeout)
const text = result => result.status === 0 ? result.stdout.trim() : ""
const lines = value => value.split(/\r?\n/).filter(Boolean)
const tail = result => lines([result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n")).slice(-8).join(" | ")
const short = sha => sha.slice(0, 7)
const listed = files => files.slice(0, 8).join(", ") + (files.length > 8 ? ` and ${files.length - 8} more` : "")
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))

const PHASES = ["queue-wait", "prepare", "merge", "check-affected", "core-suite", "push"]
const SLOWEST = 5
const toSeconds = milliseconds => Math.round(milliseconds / 100) / 10

export function landingTrace(started, clock) {
  let last = started
  const milliseconds = Object.fromEntries(PHASES.map(name => [name, 0]))
  const trace = {
    core: { files: 0, slowest: [] },
    affectedFiles: 0,
    branch: null,
    mark(name) {
      const at = clock()
      milliseconds[name] += at - last
      last = at
      return at
    },
    move(from, to, amount) {
      const moved = Math.min(Math.max(amount, 0), milliseconds[from])
      milliseconds[from] -= moved
      milliseconds[to] += moved
    },
    fields(finished) {
      return {
        total: toSeconds(finished - started),
        phases: Object.fromEntries(PHASES.map(name => [name, toSeconds(milliseconds[name])])),
        core: trace.core,
        affectedFiles: trace.affectedFiles,
      }
    },
  }
  return trace
}

export function machineSnapshot(cores = cpus, load = loadavg, platform = process.platform) {
  const times = cores().map(core => core.times)
  return {
    idle: times.reduce((sum, row) => sum + row.idle, 0),
    total: times.reduce((sum, row) => sum + Object.values(row).reduce((all, value) => all + value, 0), 0),
    load: platform === "win32" ? null : load()[0],
  }
}

export function machineRecord(before, after) {
  const total = after.total - before.total
  return {
    load1Start: before.load,
    load1End: after.load,
    cpuBusyPercent: total > 0 ? Math.round(1000 * (1 - (after.idle - before.idle) / total)) / 10 : null,
  }
}

export function readCoreProfile(file) {
  try {
    const profile = JSON.parse(readFileSync(file, "utf8"))
    const slowest = [...profile.results]
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, SLOWEST)
      .map(row => ({ file: row.name, seconds: Math.round(row.seconds * 10) / 10 }))
    return { seconds: profile.seconds, files: profile.results.length, slowest }
  } catch {
    return { seconds: 0, files: 0, slowest: [] }
  } finally {
    rmSync(file, { force: true })
  }
}

const githubAt = cwd => ({
  view: arg => {
    const found = run(cwd, "gh", ["pr", "view", String(arg), "--json", "number,state,headRefName,baseRefName,isDraft,body,mergeCommit"])
    if (found.status !== 0) throw new Error(`no pull request ${arg}: ${tail(found)}`)
    return JSON.parse(found.stdout)
  },
  close: (number, comment) => run(cwd, "gh", ["pr", "close", String(number), "--comment", comment]),
})

function readConfig(main) {
  const file = join(main, "land.config.json")
  const configured = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
  return { ...DEFAULTS, ...configured, gate: { ...DEFAULTS.gate, ...configured.gate } }
}

export const landingTimeout = root => {
  const { waitMinutes, gateMinutes } = readConfig(root)
  return (waitMinutes + 2 * gateMinutes + 35) * 60_000
}

export function environment(cwd, overrides = {}) {
  const common = text(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
  if (!common) throw new Error(`${cwd} is not inside a git checkout`)
  const main = dirname(common)
  const config = { ...readConfig(main), ...overrides }
  return { ...config, main, state: join(common, config.state), github: githubAt(cwd), log: console.log, ...overrides }
}

export function tryQueueLock(common) {
  return tryLock(join(common, readConfig(dirname(common)).state))
}

const ticketFile = (state, id, pr) => join(state, "queue", (pr === undefined ? id : "pr-" + pr) + ".json")
const recordFile = state => join(state, "record.jsonl")
const passesFile = state => join(state, "passes.json")

export function enqueue(state, arg, now = Date.now(), change) {
  const pr = change?.number
  const waiting = queued(state).find(ticket => ticket.arg === arg || pr !== undefined && (ticket.pr === pr || ticket.arg === String(pr) || ticket.arg === change.headRefName))
  if (waiting) return waiting.id
  const id = String(now).padStart(15, "0") + "-" + randomBytes(4).toString("hex")
  mkdirSync(join(state, "queue"), { recursive: true })
  const pending = join(state, "queue", id + ".tmp")
  writeFileSync(pending, JSON.stringify({ id, arg, ...(pr !== undefined ? { pr } : {}) }) + "\n")
  try {
    linkSync(pending, ticketFile(state, id, pr))
    return id
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    try { return JSON.parse(readFileSync(ticketFile(state, id, pr), "utf8")).id }
    catch (error) { if (error.code !== "ENOENT") throw error; return enqueue(state, arg, now, change) }
  } finally { unlinkSync(pending) }
}

export function queued(state) {
  let names = []
  try { names = readdirSync(join(state, "queue")) } catch { return [] }
  return names.filter(name => name.endsWith(".json")).flatMap(name => {
    try { return [JSON.parse(readFileSync(join(state, "queue", name), "utf8"))] }
    catch (error) { if (error.code === "ENOENT") return []; throw error }
  }).sort((a, b) => a.id.localeCompare(b.id))
}

const RECORD_ROWS = 2000

function writeRecord(state, row) {
  const kept = lines(existsSync(recordFile(state)) ? readFileSync(recordFile(state), "utf8") : "").slice(-(RECORD_ROWS - 1))
  writeAtomic(recordFile(state), [...kept, JSON.stringify(row)].join("\n") + "\n")
}

export function recorded(state) {
  let text
  try { text = readFileSync(recordFile(state), "utf8") } catch { return [] }
  return lines(text).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
}

const position = (state, id) => {
  const at = queued(state).findIndex(ticket => ticket.id === id)
  return at < 0 ? 0 : at + 1
}

const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" } }

function startedAt(pid) {
  const query = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", windowsHide: true, timeout: 15_000 })
    : spawnSync("ps", ["-o", "lstart=", "-p", String(Number(pid))], { encoding: "utf8", timeout: 15_000 })
  return query.stdout?.trim() || undefined
}

const ownerText = path => { try { return readFileSync(join(path, "owner.json"), "utf8") } catch { return undefined } }

function ownerGone(path, text) {
  let owner
  try { owner = JSON.parse(text) } catch {}
  try {
    if (!owner) return Date.now() - statSync(path).mtimeMs > STALE_MILLISECONDS
    if (!alive(owner.pid)) return true
    const now = owner.started ? startedAt(owner.pid) : undefined
    return now !== undefined && now !== owner.started
  } catch { return false }
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = file + "." + randomBytes(4).toString("hex") + ".tmp"
  writeFileSync(temporary, text)
  try { renameSync(temporary, file) } finally { rmSync(temporary, { force: true }) }
}

function markLanding(state, arg) {
  const file = join(state, "queue.lock", "owner.json")
  try { writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), landing: arg })) } catch {}
}

function queueHolder(state) {
  try {
    const owner = JSON.parse(readFileSync(join(state, "queue.lock", "owner.json"), "utf8"))
    const held = Date.now() - Date.parse(owner.at)
    return `; the queue lock is held by pid ${owner.pid}${owner.landing ? " landing " + owner.landing : ""} for ${held < 120_000 ? Math.round(held / 1000) + " s" : Math.round(held / 60_000) + " min"}`
  } catch { return "" }
}

function tryLock(state) {
  const path = join(state, "queue.lock")
  mkdirSync(state, { recursive: true })
  try {
    mkdirSync(path)
    writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), started: startedAt(process.pid) }))
    return () => rmSync(path, { recursive: true, force: true })
  } catch (error) {
    if (error.code !== "EEXIST") throw error
  }
  const text = ownerText(path)
  if (!ownerGone(path, text)) return undefined
  if (ownerText(path) === text) rmSync(path, { recursive: true, force: true })
  return tryLock(state)
}

const readPasses = file => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return {} } }

function recordPass(file, tree, pass) {
  const passes = readPasses(file)
  passes[tree] = pass
  writeAtomic(file, JSON.stringify(passes, null, 1) + "\n")
}

const numbered = arg => /^\d+$/.test(String(arg))
const named = pr => numbered(pr) ? "PR " + pr : String(pr)
const landed = (pr, commit, verdict) => ({ outcome: "landed", pr, commit, verdict, line: `landed ${short(commit)} (${named(pr)})` })
const sentBack = (pr, reason, detail = "", outcome = "sent-back") => ({ outcome, pr, verdict: [reason, detail].filter(Boolean).join("\n"), line: [`sent back (${named(pr)}): ${reason}`, detail].filter(Boolean).join("\n") })
const errored = (pr, message) => ({ ...sentBack(pr, message), outcome: "error" })

const FAILURE_LINES = 30

export function failureDetail(output) {
  const names = [...output.matchAll(/^failed: (.+)$/gm), ...output.matchAll(/^Bun crashed .* in: (.+)$/gm)]
    .flatMap(match => match[1].split(", ")).map(name => name.trim()).filter(Boolean)
  const blocks = output.split(/^===== /m).slice(1)
  const detail = [...new Set(names)].flatMap(name => {
    const block = blocks.find(text => text.startsWith(name + ": "))
    const body = block ? lines(block.slice(block.indexOf("\n") + 1)) : []
    return [`--- ${name}`, ...(body.length ? body : lines(output)).slice(-FAILURE_LINES)]
  })
  const flaky = [...output.matchAll(/^flaky: (.+?)(?: \(|$)/gm)].flatMap(match => match[1].split(", ")).map(name => name.trim()).filter(Boolean)
  return { names: [...new Set(names)], flaky: [...new Set(flaky)], detail: (detail.length ? detail : lines(output).slice(-FAILURE_LINES)).join("\n") }
}

const gateOutput = gated => `${gated.stdout ?? ""}\n${gated.stderr ?? ""}`

function refresh(env, branch) {
  const { main, remote, base: target } = env
  const fetched = git(main, ["fetch", "--quiet", remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], NETWORK_MILLISECONDS)
  if (fetched.status !== 0) return { error: `cannot fetch ${branch} from ${remote}: ${tail(fetched)}` }
  return { baseSha: text(git(main, ["rev-parse", `refs/remotes/${remote}/${target}`])), head: text(git(main, ["rev-parse", `refs/remotes/${remote}/${branch}`])) }
}

function closeIfOpen(github, pr, commit, target) {
  let state = ""
  try { state = github.view(String(pr)).state } catch {}
  if (state !== "MERGED") github.close(pr, `Landed on ${target} as ${short(commit)}.`)
}

function removeScratch(main, scratch) {
  if (git(main, ["worktree", "remove", scratch]).status === 0) return
  rmSync(scratch, { recursive: true, force: true })
  git(main, ["worktree", "prune"])
}

function attempt(scratch, job, retry) {
  const { pr, branch, env, trace, profile } = job
  const { remote, base: target } = env
  const fresh = refresh(env, branch)
  if (fresh.error) return { result: sentBack(pr, fresh.error) }
  const { baseSha, head } = fresh
  if (git(env.main, ["merge-base", "--is-ancestor", head, baseSha]).status === 0) return { result: landed(pr, baseSha, `${named(pr)}'s commits are already on ${target}`) }
  git(scratch, ["checkout", "--quiet", "--detach", baseSha])
  const forward = git(scratch, ["merge-base", "--is-ancestor", baseSha, head]).status === 0
  const merged = git(scratch, forward ? ["merge", "--ff-only", head] : ["merge", "--no-ff", "--no-edit", "-m", `Land ${branch}${named(pr) === branch ? "" : " (" + named(pr) + ")"}`, head])
  trace.mark("merge")
  if (merged.status !== 0) {
    const files = lines(text(git(scratch, ["diff", "--name-only", "--diff-filter=U"])))
    git(scratch, ["merge", "--abort"])
    if (!files.length) return { result: sentBack(pr, `git could not merge ${branch} onto ${target}: ${tail(merged)}`) }
    return { result: sentBack(pr, `${branch} conflicts with ${target} at ${short(baseSha)} in ${listed(files)}; merge ${remote}/${target} into ${branch}, fix those files, push, then land ${pr} again`) }
  }
  const changes = lines(text(git(scratch, ["diff", "--name-status", baseSha, "HEAD"]))).map(row => row.split("\t"))
  trace.affectedFiles = changes.length
  if (!changes.length) return { result: sentBack(pr, `it changes nothing on top of ${target}`) }
  const removed = changes.filter(parts => parts[0].startsWith("D")).length
  const tree = text(git(scratch, ["rev-parse", "HEAD^{tree}"]))
  const passes = passesFile(env.state)
  const reused = Boolean(readPasses(passes)[tree])
  let seconds = 0
  let flakyPassed = []
  if (!reused) {
    const begun = trace.mark("merge")
    const gated = run(scratch, env.gate.full[0], env.gate.full.slice(1), env.gateMinutes * 60_000, { ...process.env, QUESTGIVER_CHECK_PROFILE: profile })
    const ended = trace.mark("check-affected")
    const coreRun = readCoreProfile(profile)
    trace.move("check-affected", "core-suite", coreRun.seconds * 1000)
    trace.core = { files: coreRun.files, slowest: coreRun.slowest }
    seconds = Math.round((ended - begun) / 1000)
    if (gated.status !== 0) {
      const { names, flaky, detail } = failureDetail(gateOutput(gated))
      if (!(flaky.length > 0 && names.every(name => flaky.includes(name)))) {
        const reason = `the full gate fails on ${target} with ${branch} merged in${names.length ? "; failing: " + listed(names) : ""}${flaky.length ? "; flaky (passed alone): " + listed(flaky) : ""}${gated.error ? " (" + gated.error.message + ")" : ""}`
        return { result: sentBack(pr, reason, detail) }
      }
      flakyPassed = flaky
    }
    recordPass(passes, tree, { revision: text(git(scratch, ["rev-parse", "HEAD"])), branch, at: new Date().toISOString(), seconds })
  }
  const pushed = git(scratch, ["push", "--porcelain", remote, `HEAD:refs/heads/${target}`], NETWORK_MILLISECONDS)
  if (pushed.status !== 0) return /\[rejected\].*\((?:fetch first|non-fast-forward)\)/.test(pushed.stdout)
    ? { raced: true }
    : { result: sentBack(pr, `Git refused to push ${target}: ${tail(pushed)}`) }
  const commit = text(git(scratch, ["rev-parse", "HEAD"]))
  if (numbered(pr)) closeIfOpen(env.github, pr, commit, target)
  const gateNote = reused ? "reused the pass recorded for this tree" : `passed in ${seconds} s${flakyPassed.length ? "; flaky, passed alone: " + listed(flakyPassed) : ""}`
  return { result: landed(pr, commit, `${named(pr)} on ${target}: ${changes.length} file(s)${removed ? `, ${removed} removed` : ""}; gate ${gateNote}${retry ? `; ${target} moved during the full gate, so the change was merged onto it once more and gated there` : ""}`) }
}

function landInScratch(scratch, job) {
  const first = attempt(scratch, job, false)
  if (!first.raced) return first.result
  const second = attempt(scratch, job, true)
  if (second.raced) return sentBack(job.pr, `${job.env.base} moved again while the full gate ran; land ${job.pr} again`)
  return second.result
}

function changeFor(env, arg) {
  try { return env.github.view(arg) }
  catch (error) { if (numbered(arg) || !/no pull request/.test(error.message)) throw error }
  return { number: String(arg), state: "OPEN", baseRefName: env.base, headRefName: String(arg), isDraft: false }
}

export function landOne(ticket, env, trace) {
  const { main, base: target } = env
  let change
  try { change = changeFor(env, ticket.arg) } catch (error) { return sentBack(ticket.arg, error.message) }
  const { number: pr, state, baseRefName, headRefName: branch, isDraft, mergeCommit } = change
  trace.branch = branch
  if (state === "MERGED") return landed(pr, mergeCommit?.oid ?? "", `${named(pr)} was already merged`)
  if (state !== "OPEN") return sentBack(pr, `it is ${state.toLowerCase()}, not open`)
  if (baseRefName !== target) return sentBack(pr, `it targets ${baseRefName}, not ${target}`)
  if (isDraft) return sentBack(pr, "it is a draft")
  const fresh = refresh(env, branch)
  if (fresh.error) return sentBack(pr, fresh.error)
  const scratch = join(main, env.scratch, `land-${String(pr).replace(/[^\w.-]+/g, "-")}-${randomBytes(3).toString("hex")}`)
  mkdirSync(dirname(scratch), { recursive: true })
  const made = git(main, ["worktree", "add", "--detach", scratch, fresh.baseSha])
  if (made.status !== 0) return sentBack(pr, `cannot make a scratch checkout: ${tail(made)}`)
  trace.mark("prepare")
  const profile = join(env.state, "core-" + randomBytes(3).toString("hex") + ".json")
  try { return landInScratch(scratch, { pr, branch, env, trace, profile }) }
  finally { removeScratch(main, scratch) }
}

const BATCH_LIMIT = 8

function landBatch(tickets, env, trace) {
  const { main, remote, base: target } = env
  const jobs = []
  for (const ticket of tickets) {
    let change
    try { change = changeFor(env, ticket.arg) } catch { return undefined }
    const { number: pr, state, baseRefName, headRefName: branch, isDraft } = change
    if (state !== "OPEN" || baseRefName !== target || isDraft) return undefined
    jobs.push({ ticket, pr, branch })
  }
  const fetched = git(main, ["fetch", "--quiet", remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`, ...jobs.map(job => `+refs/heads/${job.branch}:refs/remotes/${remote}/${job.branch}`)], NETWORK_MILLISECONDS)
  if (fetched.status !== 0) return undefined
  const baseSha = text(git(main, ["rev-parse", `refs/remotes/${remote}/${target}`]))
  const scratch = join(main, env.scratch, `land-batch-${randomBytes(3).toString("hex")}`)
  mkdirSync(dirname(scratch), { recursive: true })
  if (!baseSha || git(main, ["worktree", "add", "--detach", scratch, baseSha]).status !== 0) return undefined
  trace.mark("prepare")
  const profile = join(env.state, "core-" + randomBytes(3).toString("hex") + ".json")
  try {
    for (const job of jobs) {
      const head = text(git(main, ["rev-parse", `refs/remotes/${remote}/${job.branch}`]))
      if (!head || git(main, ["merge-base", "--is-ancestor", head, baseSha]).status === 0) return undefined
      const merged = git(scratch, ["merge", "--no-ff", "--no-edit", "-m", `Land ${job.branch}${named(job.pr) === job.branch ? "" : " (" + named(job.pr) + ")"}`, head])
      if (merged.status !== 0) { git(scratch, ["merge", "--abort"]); return undefined }
    }
    trace.mark("merge")
    trace.affectedFiles = lines(text(git(scratch, ["diff", "--name-only", baseSha, "HEAD"]))).length
    const tree = text(git(scratch, ["rev-parse", "HEAD^{tree}"]))
    const passes = passesFile(env.state)
    const reused = Boolean(readPasses(passes)[tree])
    let seconds = 0
    if (!reused) {
      const begun = trace.mark("merge")
      const gated = run(scratch, env.gate.full[0], env.gate.full.slice(1), env.gateMinutes * 60_000, { ...process.env, QUESTGIVER_CHECK_PROFILE: profile })
      const ended = trace.mark("check-affected")
      const coreRun = readCoreProfile(profile)
      trace.move("check-affected", "core-suite", coreRun.seconds * 1000)
      trace.core = { files: coreRun.files, slowest: coreRun.slowest }
      seconds = Math.round((ended - begun) / 1000)
      if (gated.status !== 0) return undefined
      recordPass(passes, tree, { revision: text(git(scratch, ["rev-parse", "HEAD"])), branch: jobs.map(job => job.branch).join(", "), at: new Date().toISOString(), seconds })
    }
    if (git(scratch, ["push", "--porcelain", remote, `HEAD:refs/heads/${target}`], NETWORK_MILLISECONDS).status !== 0) return undefined
    const commit = text(git(scratch, ["rev-parse", "HEAD"]))
    const gateNote = reused ? "reused the pass recorded for this tree" : `passed in ${seconds} s`
    return jobs.map(job => {
      if (numbered(job.pr)) closeIfOpen(env.github, job.pr, commit, target)
      return { ticket: job.ticket, branch: job.branch, result: landed(job.pr, commit, `${named(job.pr)} on ${target} in one gate with ${jobs.length - 1} other change(s); gate ${gateNote}`) }
    })
  } finally { removeScratch(main, scratch) }
}

export async function updateAfterLanding(main, line, { quiet = () => import("./landing-quiet.mjs"), drift = () => import("./version-drift.mjs") } = {}) {
  let reload
  try {
    const { markLanded, reloadIfIdle } = await quiet()
    const { top, classified } = await markLanded(main, line)
    await classified
    reload = reloadIfIdle(top)
  } catch (error) { console.error("update not marked: " + (error instanceof Error ? error.message : String(error))) }
  await drift().then(({ startDriftCheck }) => startDriftCheck()).catch(() => undefined)
  return reload
}

export function drain(env, through, deadline = Infinity) {
  const { clock = Date.now } = env
  const landedLines = []
  let batching = true
  for (let next = queued(env.state)[0]; next; next = queued(env.state)[0]) {
    const batch = queued(env.state).slice(0, BATCH_LIMIT)
    if (batching && batch.length > 1) {
      const trace = landingTrace(Number(next.id.slice(0, 15)), clock)
      const before = machineSnapshot()
      markLanding(env.state, batch.map(ticket => ticket.arg).join(", "))
      trace.mark("queue-wait")
      let rows
      try { rows = landBatch(batch, env, trace) } catch { rows = undefined }
      if (rows) {
        const finished = trace.mark("push")
        const machine = machineRecord(before, machineSnapshot())
        for (const { ticket, branch, result } of rows) {
          const attempt = recorded(env.state).filter(row => String(row.pr ?? row.arg) === String(result.pr)).length + 1
          writeRecord(env.state, { ticket: ticket.id, arg: ticket.arg, at: new Date(finished).toISOString(), ...result, branch, attempt, ...trace.fields(finished), total: toSeconds(finished - Number(ticket.id.slice(0, 15))), batch: rows.length, machine })
          unlinkSync(ticketFile(env.state, ticket.id, ticket.pr))
          landedLines.push(result.line)
        }
        if (rows.some(row => row.ticket.id === through) || Date.now() >= deadline) break
        continue
      }
      batching = false
    }
    const trace = landingTrace(Number(next.id.slice(0, 15)), clock)
    const before = machineSnapshot()
    markLanding(env.state, next.arg)
    trace.mark("queue-wait")
    let result
    try { result = landOne(next, env, trace) } catch (error) { result = errored(next.arg, error instanceof Error ? error.message : String(error)) }
    const finished = result.outcome === "landed" ? trace.mark("push") : clock()
    const attempt = recorded(env.state).filter(row => String(row.pr ?? row.arg) === String(result.pr)).length + 1
    writeRecord(env.state, { ticket: next.id, arg: next.arg, at: new Date(finished).toISOString(), ...result, branch: trace.branch, attempt, ...trace.fields(finished), machine: machineRecord(before, machineSnapshot()) })
    unlinkSync(ticketFile(env.state, next.id, next.pr))
    if (result.outcome === "landed" && !/already merged/.test(result.verdict ?? "")) landedLines.push(result.line)
    if (next.id === through || Date.now() >= deadline) break
  }
  return landedLines
}

export async function landQueued(arg, env) {
  const { clock = Date.now } = env
  let change
  try { change = env.github.view(arg) } catch {}
  const id = enqueue(env.state, arg, clock(), change)
  const deadline = Date.now() + env.waitMinutes * 60_000
  let announced = false
  const waiting = () => `waiting (position ${position(env.state, id)})${queueHolder(env.state)}`
  for (;;) {
    const done = recorded(env.state).findLast(row => row.ticket === id)
    if (done) return done.line
    const release = tryLock(env.state)
    if (release) {
      let landedLines = []
      try { landedLines = drain(env, id, deadline) } finally { release() }
      for (const line of landedLines) await env.afterLanding?.(line)
      const done = recorded(env.state).findLast(row => row.ticket === id)
      if (done) return done.line
      if (Date.now() >= deadline) return waiting()
      continue
    }
    if (Date.now() >= deadline) return waiting()
    if (!announced) { env.log(waiting().replace(/^waiting/, "queued")); announced = true }
    await sleep(1000)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = process.argv[2]
  if (!arg) {
    console.error("usage: node scripts/land.mjs <pull request number or branch> | --check")
    process.exit(2)
  }
  if (arg === "--check") {
    const env = environment(process.cwd())
    const checked = run(process.cwd(), env.gate.affected[0], env.gate.affected.slice(1), env.gateMinutes * 60_000)
    process.exitCode = checked.status ?? 1
  } else {
    const env = environment(process.cwd())
    env.afterLanding = line => updateAfterLanding(env.main, line)
    const line = await landQueued(arg, env)
    console.log(line)
    process.exitCode = /^(landed|waiting)\b/.test(line) ? 0 : 1
  }
}
