import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export function resolveHostExecutable(env = process.env, platform = process.platform) {
  const explicit = [env.OPENCODE_PROJECT_ROUTER_CLI, env.OPENCODE2_EXE].filter(Boolean)
  if (explicit.length === 2 && resolve(explicit[0]).toLowerCase() !== resolve(explicit[1]).toLowerCase())
    throw Error('Conflicting OPENCODE_PROJECT_ROUTER_CLI and OPENCODE2_EXE; select one verified host')
  if (explicit.length) return explicit[0]
  if (platform !== 'win32') return 'opencode2'
  const npm = join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm')
  const selected = []
  for (const name of ['opencode2.ps1', 'opencode2.cmd']) {
    const shim = join(npm, name)
    if (!existsSync(shim)) continue
    const namespaces = [...new Set(readFileSync(shim, 'utf8').match(/@opencode(?:-ai)?[\\/]cli[\\/]bin[\\/]opencode(?:2)?\.exe/g) ?? [])]
    if (namespaces.length !== 1) throw Error('Cannot resolve native opencode2 from ' + shim + '; set OPENCODE2_EXE to the verified executable')
    const exe = join(npm, 'node_modules', ...namespaces[0].split(/[\\/]/))
    if (!existsSync(exe)) throw Error('Selected opencode2 executable is missing: ' + exe)
    selected.push(exe)
  }
  if(new Set(selected.map(p=>p.toLowerCase())).size>1)throw Error('Installed opencode2 PowerShell and CMD launchers disagree; repair installation or set an explicit verified host')
  if(selected.length)return selected[0]
  throw Error('No installed opencode2 npm shim found; set OPENCODE2_EXE to the verified native executable')
}

export function inspectHostExecutable() {
 const executable=resolveHostExecutable()
 const version=execFileSync(executable,['--version'],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']}).trim()
 if(!/^opencode(?:2)? v2\./.test(version))throw Error('Expected OpenCode2 at '+executable+'; received '+version)
 return {executable,version}
}
