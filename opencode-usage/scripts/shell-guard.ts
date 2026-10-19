import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { configuredShellName, isPosixShell } from "../quest/permissions/shell-guidance"

export type ShellViolation = { rule: string; message: string }

const unixBinary = /(?<![\w-])(head|tail|cat|grep|ls|rm|cp|mv)(?=\s|$)/

export type ShellKind = "posix" | "powershell"

export function hostShellKind(environment = process.env, platform = process.platform): ShellKind {
  return platform !== "win32" || isPosixShell(configuredShellName(environment)) ? "posix" : "powershell"
}

export function shellViolations(command: string, shell: ShellKind = hostShellKind()): ShellViolation[] {
  const text = String(command ?? "")
  const violations: ShellViolation[] = []
  const add = (rule: string, message: string) => violations.push({ rule, message })

  if (shell === "powershell") {
    if (unixBinary.test(text)) add("unix-binary", "Use PowerShell or rg instead of Unix binaries.")
    if (/(?:\\[^\r\n;&|]*)&&|&&[^\r\n;&|]*\\/i.test(text)) add("backslash-chain", "Use PowerShell ';' instead of &&.")
    if (/\bcd\s+[^\r\n;&|]*&&/i.test(text)) add("cd-chain", "Use Set-Location and ';' instead of cd ... &&.")
  }
  if (/\bgit\s+ls-tree\b/i.test(text) && !/(?:^|\s)(?:-r|--recursive)(?:\s|$)/i.test(text)) {
    add("ls-tree-object", "Use git show for commit history or add -r/--recursive.")
  }
  if (/(?:^|\s)--?[\w-]+[= ]\/dev\/null\b/.test(text)) {
    add("devnull-argument", `/dev/null becomes the reserved file "nul" when passed as an argument on Windows, and it breaks every later git commit. Write to a temp file, or drop the flag.`)
  }
  const harm = destructiveGitHarm(text)
  if (harm) add("destructive-git", `Refused: ${harm}`)
  return violations
}

const GIT_HARM = {
  reset: "git reset --hard throws away uncommitted work. Use git stash, or git restore <your file>.",
  clean: "git clean deletes untracked files. Leave them, or remove the one file you made, by name.",
  push: "a force push rewrites the remote branch. Push without --force, or push a new branch name.",
  tree: "checkout or restore on the whole tree throws away every local change. Restore the one file you changed: git restore <your file>.",
  forcedCheckout: "a forced checkout throws away local changes. Use git stash, then git switch <branch>.",
  branch: "git branch -D deletes a branch even with unmerged work. Use git branch -d, which refuses unmerged work.",
  stash: "stash drop and clear delete saved work. Use git stash list, then git stash pop.",
  worktree: "a forced worktree remove deletes uncommitted files. Use git worktree remove without --force; git refuses a dirty tree.",
  history: "this erases history git keeps for recovery. Let git gc run on its default schedule.",
  dotGit: "deleting .git destroys the repository. Remove a worktree with git worktree remove instead.",
  merge: "gh pr merge lands a pull request outside the queue, and the base can move under its gate. Run bun run land <pr number>; authors never merge.",
  basePush: "a push to v2 lands outside the queue. Push your own branch with git push -u origin <branch>, then run bun run land <pr number>; authors never merge.",
  baseRebase: "a rebase onto v2 rewrites your branch under its gate. Fix a conflict with git merge origin/v2 on your branch, then run bun run land <pr number>; authors never rebase onto v2.",
}
const BASE_REF = /^(?:refs\/heads\/|origin\/|refs\/remotes\/origin\/)?v2$/i
const BASE_DESTINATION = /(?:^|:)(?:refs\/heads\/)?v2$/i
const GH_PR_MERGE = /(?:^|[\s;&|(`'"])gh(?:\.exe)?\s+pr\s+merge(?=\s|$)/i
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"])
const WHOLE_TREE = new Set([".", "./", ":/", ":(top)", "*", "-A", "--all"])
const FORCE_FLAG = /^--force|^-[a-z]*f[a-z]*$/i
const FORCE_PUSH_FLAG = /^--force|^--mirror$|^\+|^-[a-z]*f[a-z]*$/i
const DELETE_VERBS = new Set(["rm", "rmdir", "del", "erase", "rd", "ri", "remove-item"])
const DOT_GIT = /(^|[\\/])\.git([\\/*]|$)/i
const SEGMENT_BREAK = /&&|\|\||[;&|\r\n]/

function gitHarm([sub = "", ...args]: string[]): string | undefined {
  const forced = (flag: string) => FORCE_FLAG.test(flag)
  switch (sub.toLowerCase()) {
    case "reset": return args.includes("--hard") ? GIT_HARM.reset : undefined
    case "clean": return GIT_HARM.clean
    case "push": return args.some(arg => FORCE_PUSH_FLAG.test(arg)) ? GIT_HARM.push : args.some(arg => BASE_DESTINATION.test(arg)) ? GIT_HARM.basePush : undefined
    case "rebase": return args.some(arg => BASE_REF.test(arg)) ? GIT_HARM.baseRebase : undefined
    case "checkout": return args.some(arg => arg === "-f" || arg === "--force") ? GIT_HARM.forcedCheckout : args.some(arg => WHOLE_TREE.has(arg)) ? GIT_HARM.tree : undefined
    case "restore": return args.some(arg => WHOLE_TREE.has(arg)) ? GIT_HARM.tree : undefined
    case "branch": return args.some(arg => /^-[a-zA-Z]*D/.test(arg)) || (args.includes("--delete") && args.some(forced)) ? GIT_HARM.branch : undefined
    case "stash": return args[0] === "drop" || args[0] === "clear" ? GIT_HARM.stash : undefined
    case "worktree": return args[0] === "remove" && args.some(forced) ? GIT_HARM.worktree : undefined
    case "gc": return args.includes("--prune=now") || (args.includes("--prune") && args.includes("now")) ? GIT_HARM.history : undefined
    case "reflog": return args[0] === "expire" ? GIT_HARM.history : undefined
    case "prune": return args.includes("--expire=now") || (args.includes("--expire") && args.includes("now")) ? GIT_HARM.history : undefined
    default: return undefined
  }
}

function gitInvocations(tokens: string[]): string[][] {
  return tokens.flatMap((token, index) => {
    if (!/^git(\.exe)?$/i.test(token)) return []
    let at = index + 1
    while (at < tokens.length && tokens[at].startsWith("-")) at += GIT_VALUE_OPTIONS.has(tokens[at]) ? 2 : 1
    return [tokens.slice(at)]
  })
}

function deletesDotGit(tokens: string[]): boolean {
  const verb = tokens.findIndex(token => DELETE_VERBS.has(token.toLowerCase()))
  return verb >= 0 && tokens.slice(verb + 1).some(token => DOT_GIT.test(token))
}

function quotedWords(segment: string): string[] {
  const words: string[] = []
  let current: string | undefined, quote: string | undefined
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = undefined
      else current = (current ?? "") + char
      continue
    }
    if (char === '"' || char === "'") { quote = char; current ??= ""; continue }
    if (/\s/.test(char)) { if (current !== undefined) words.push(current); current = undefined; continue }
    current = (current ?? "") + char
  }
  if (current !== undefined) words.push(current)
  return words
}

function tokenHarm(tokens: string[]): string | undefined {
  for (const args of gitInvocations(tokens)) {
    const harm = gitHarm(args)
    if (harm) return harm
  }
  return deletesDotGit(tokens) ? GIT_HARM.dotGit : undefined
}

export function destructiveGitHarm(command: string): string | undefined {
  const text = String(command ?? "")
  if (GH_PR_MERGE.test(text)) return GIT_HARM.merge
  const quoted = text.split(SEGMENT_BREAK).map(quotedWords)
  const plain = text.replace(/["'`()[\]{},]/g, " ").split(SEGMENT_BREAK).map(part => part.split(/\s+/).filter(Boolean))
  for (const tokens of [...quoted, ...plain]) {
    const harm = tokenHarm(tokens)
    if (harm) return harm
  }
  return undefined
}

const DESKTOP_INPUT: [rule: string, pattern: RegExp][] = [
  ["cua-driver", /\bcua[-_]driver\b/i],
  ["sendkeys", /\bSendKeys\b|\.AppActivate\s*\(/i],
  ["win32-input", /^(?=[\s\S]*\b(?:keybd_event|SendInput|mouse_event)\b)(?=[\s\S]*\b(?:ctypes|windll|Add-Type|DllImport|user32)\b)/i],
  ["input-automation", /\b(?:import|from)\s+(?:pyautogui|pywinauto)\b|-m\s+(?:pyautogui|pywinauto)\b|\bAutoHotkey\w*(?:\.exe)?\b|\.ahk\b/i],
]
const READ_ONLY = /^\s*(?:&\s*)?(?:rg|grep|findstr|git|Select-String|sls|Get-Content|gc|cat|type|more|ls|dir|Get-ChildItem|gci|Get-Item|Test-Path)(?:\.exe)?(?=\s|$)/i
const TEST_RUNNER = /(?:^|[\s;&|])(?:pytest|py\.test|python(?:\.exe)?\s+-m\s+pytest|bun\s+test|bun\s+run\s+(?:test|check:[\w-]+)|npm\s+(?:run\s+)?test|node\s+--test)(?=\s|$)/i
const SCRIPT = /"([^"\r\n]+\.(?:py|pyw|ps1|psm1|js|mjs|cjs|ts|mts|vbs|ahk))"|'([^'\r\n]+\.(?:py|pyw|ps1|psm1|js|mjs|cjs|ts|mts|vbs|ahk))'|([^\s"'`;|&()<>]+\.(?:py|pyw|ps1|psm1|js|mjs|cjs|ts|mts|vbs|ahk))(?![\w.])/gi
const SCRIPT_READ_BYTES = 1024 * 1024

function desktopHits(text: string, where: string): ShellViolation[] {
  return DESKTOP_INPUT.filter(([, pattern]) => pattern.test(text)).map(([rule]) => ({
    rule: "desktop-input",
    message: `Refused: ${where} drives the desktop directly (${rule}). Quest workers use a computer-use tool for browser and desktop work when one is configured.`,
  }))
}

export function desktopInputViolations(command: string, cwd?: string): ShellViolation[] {
  const text = String(command ?? "")
  if (READ_ONLY.test(text)) return []
  const hits = desktopHits(text, "this command")
  if (TEST_RUNNER.test(text)) return hits
  for (const match of text.matchAll(SCRIPT)) {
    const path = resolve(cwd ?? process.cwd(), match[1] ?? match[2] ?? match[3])
    try {
      if (!statSync(path).isFile() || statSync(path).size > SCRIPT_READ_BYTES) continue
      hits.push(...desktopHits(readFileSync(path, "utf8"), path))
    } catch {}
  }
  return hits
}

export const RESERVED_NAMES = /^(nul|con|prn|aux|com[1-9]|lpt[1-9])(\.|$)/i

const TEMP_ROOTS = ["\\appdata\\local\\temp\\", "\\windows\\temp\\", "/tmp/", "/var/tmp/"]

function normalize(p: string): string {
  return String(p ?? "").replace(/\//g, "\\").toLowerCase()
}

export function isTempPath(path: string): boolean {
  const p = normalize(path)
  return TEMP_ROOTS.some((root) => p.includes(normalize(root)))
}

export function workspaceViolations(cwd: string | undefined): ShellViolation[] {
  if (!cwd || !isTempPath(cwd)) return []
  return [{
    rule: "temp-workspace",
    message: `Working directory is a temp path (${cwd}). Real work is staged in the repo (gitignored) so it stays traceable — see AGENTS.md.`,
  }]
}

const TEMP_WRITE = /\b(git\s+(clone|init|worktree\s+add)|npm\s+(i|install|ci)|pnpm\s+(i|install)|bun\s+(install|add)|cargo\s+build|dotnet\s+build|msbuild|make|cmake|tsc\s+--?\w*out|New-Item|Copy-Item|Move-Item|mkdir)\b/i

export function assertSafeShell(command: string, cwd?: string, shell: ShellKind = hostShellKind()): void {
  const hits = [...shellViolations(command, shell), ...workspaceViolations(cwd)]
  const text = String(command ?? "")
  if (!hits.some((h) => h.rule === "temp-workspace") && TEMP_WRITE.test(text)) {
    const target = text.match(/[A-Za-z]:[\\/][^\s"']*|\/(?:var\/)?tmp\/[^\s"']*/g)?.find(isTempPath)
    if (target) {
      hits.push({
        rule: "temp-write",
        message: `Refusing to build or write into a temp path (${target}). Stage it in the repo instead — see AGENTS.md.`,
      })
    }
  }
  if (hits.length) throw new Error(`[shell-guard] ${hits.map((h) => h.message).join("; ")}`)
}
