import { spawn, type ChildProcess } from "node:child_process"
import { connect } from "node:net"
import { closeSync, existsSync, openSync, readFileSync, watch } from "node:fs"
import { dirname, join } from "node:path"
import { brokerConfigFile, verifyOAuthProxy } from "../models/subscription-policy"

export const brokerExecutable = () =>
  process.env.OPENCODE_CLIPROXY_EXE ?? join(process.env.LOCALAPPDATA ?? "", "CLIProxyAPI", "cli-proxy-api.exe")

export async function brokerAnswers(origin: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch) {
  try {
    const response = await fetchImpl(origin + "/v1/models", { headers: apiKey ? { authorization: "Bearer " + apiKey } : {}, signal: AbortSignal.timeout(3_000) })
    return response.ok
  } catch { return false }
}

export function brokerListeningOn(origin: string, timeoutMs = 1_000) {
  const { hostname, port } = new URL(origin)
  return new Promise<boolean>(resolve => {
    const socket = connect({ host: hostname, port: Number(port) || 80 })
    const done = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

export function startBroker(config = brokerConfigFile(), executable = brokerExecutable()) {
  verifyOAuthProxy(config)
  if (!existsSync(executable)) throw new Error("CLIProxyAPI is not installed at " + executable)
  const output = brokerOutputFile(config), fd = openSync(output, "w")
  try {
    const child = spawn(executable, ["-config", config], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true })
    child.unref()
    return { child, output }
  } finally { closeSync(fd) }
}

const ACCOUNTS_LOADED = /server clients and configuration updated: [1-9]\d* clients/

export function brokerAccountsLoaded(output: string) {
  try { return ACCOUNTS_LOADED.test(readFileSync(output, "utf8")) } catch { return false }
}

export const brokerOutputFile = (config = brokerConfigFile()) => join(dirname(config), "broker.out.log")

export function brokerListening(child: ChildProcess | undefined, output: string, timeoutMs = 15_000) {
  return new Promise<boolean>(resolve => {
    if (brokerAccountsLoaded(output)) return resolve(true)
    if (!existsSync(output)) return resolve(false)
    const watcher = watch(output, () => { if (brokerAccountsLoaded(output)) done(true) })
    const timer = setTimeout(() => done(false), timeoutMs)
    const exited = () => done(false)
    function done(value: boolean) { watcher.close(); clearTimeout(timer); child?.off("exit", exited); resolve(value) }
    child?.once("exit", exited)
    if (brokerAccountsLoaded(output)) done(true)
  })
}

const SETTLED_MS = 10_000

export function brokerKeeper(config = brokerConfigFile()) {
  let owned: ChildProcess | undefined
  let pending: Promise<void> | undefined
  const ensure = (): Promise<void> => pending ??= (async () => {
    if (owned && owned.exitCode === null) return
    const { origin, apiKey } = verifyOAuthProxy(config)
    if (await brokerListeningOn(origin) || await brokerAnswers(origin, apiKey)) {
      if (!await brokerListening(owned, brokerOutputFile(config))) console.warn("[cliproxyapi] broker answers at " + origin + " but has not reported its accounts loaded; see " + brokerOutputFile(config))
      return
    }
    console.warn("[cliproxyapi] broker is not answering at " + origin + "; starting it with " + config)
    const { child, output } = startBroker(config), started = Date.now()
    owned = child
    child.once("exit", code => {
      if (owned === child) owned = undefined
      if (Date.now() - started < SETTLED_MS) return
      console.warn("[cliproxyapi] broker exited (" + code + "); starting it again")
      void ensure().catch(error => console.error("[cliproxyapi] broker cannot be started:", error))
    })
    if (!await brokerListening(child, output) && !await brokerAnswers(origin, apiKey)) console.error("[cliproxyapi] broker did not start; see " + output)
  })().finally(() => { pending = undefined })
  return { ensure, origin: () => verifyOAuthProxy(config).origin }
}
