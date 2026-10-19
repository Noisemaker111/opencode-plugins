import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
export const windowsShellGuidance = 'Windows shell: PowerShell, possibly Windows PowerShell 5.1, so chain with `;` and `if ($?)`, never `&&` or `||`. ls, cat, head, tail, grep, rm, cp and mv are refused: use Get-ChildItem, Get-Content, Select-Object, rg, Remove-Item, Copy-Item, Move-Item. Wildcards are not expanded for native commands: give rg a folder and `-g "*.ts"`, not `src/*.ts`. rg exits 1 when nothing matches. Use forward-slash paths. Inspect with rg and read only relevant spans. Run package scripts with the package directory as cwd and confirm the intended script ran. Batch independent reads; keep dependent commands sequential and check their exit status. Preserve literal text when quoting. Send verbose build/install output to an evidence log and return its summary or failure. Keep long-running commands in the host-managed session and inspect completion; do not repeatedly poll. Never delete or move a computed directory before checking its resolved target.'

export const gitBashGuidance = 'Windows shell: Git Bash (bash). Chain with `&&` and `||`; ls, cat, grep, rm, cp, mv and wildcards work. Never run `powershell` or `pwsh`: they do not start on this machine and the call never returns. Use forward slashes or quote Windows paths.'

export function configuredShell(environment = process.env) {
  const directory = environment.OPENCODE_CONFIG_DIR
  if (!directory) return undefined
  try {
    const text = readFileSync(join(directory, 'opencode.jsonc'), 'utf8')
    return text.match(/"shell"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\\\/g, '\\')
  } catch { return undefined }
}

export function configuredShellName(environment = process.env) {
  const shell = configuredShell(environment)
  return shell ? basename(shell.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase() : undefined
}

export const isPosixShell = (shell: string | undefined) => shell === 'bash' || shell === 'sh' || shell === 'zsh'

const GIT_BASH = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe']

export function gitBashPath(environment = process.env) {
  const shell = configuredShell(environment)
  if (shell && isAbsolute(shell) && existsSync(shell)) return shell
  const found = typeof Bun !== 'undefined' ? Bun.which(shell ?? 'bash') : null
  if (found && !/[\\/]system32[\\/]/i.test(found)) return found
  return GIT_BASH.find(path => existsSync(path)) ?? 'bash'
}

export const windowsGuidance = (shell = configuredShellName()) => shell === 'bash' ? gitBashGuidance : windowsShellGuidance

export const unlimitedCommandGuidance = 'Commands run until they finish: there is no time limit unless you pass a timeout, so pushes with hooks, full test suites, smoke runs and builds run to completion. Pass a timeout only to cut a command short on purpose.'

const SHELL = /^(shell|bash|powershell|pwsh|terminal|exec_command)$/

export function removeDefaultTimeout(event: any) {
  if (!SHELL.test(String(event?.tool ?? event?.name ?? ''))) return
  const input = event?.input ?? event?.args
  if (input && typeof input === 'object' && input.timeout === undefined) input.timeout = 0
}

export async function installShellGuidance(ctx: any) {
  const guidance = process.platform === 'win32' ? [windowsGuidance(), unlimitedCommandGuidance] : [unlimitedCommandGuidance]
  const describe = (tool: any) => {
    const missing = guidance.filter(text => !tool.description?.includes(text))
    if (missing.length) tool.description = [...missing, tool.description ?? ''].join('\n')
  }
  await ctx.tool?.transform?.((draft: any) => {
    for (const { id } of draft.list()) if (SHELL.test(id)) draft.update(id, describe)
  })
  await ctx.tool?.hook?.('execute.before', (event: any) => removeDefaultTimeout(event))
  await ctx.session?.hook?.('context', (event: any) => {
    for (const [name, tool] of Object.entries(event.tools ?? {}) as [string, any][]) {
      if (SHELL.test(name)) describe(tool)
    }
  })
}
