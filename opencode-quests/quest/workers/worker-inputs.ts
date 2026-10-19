import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Quest } from '../types'

const RELATIVE_FILE = /(?<![\w./\\:-])((?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]+)(?![\w\\/-])/g
const WINDOWS_FILE = /(?<![\w])([A-Za-z]:[\\/](?:[\w .-]+[\\/])*[\w.-]+\.[A-Za-z0-9]+)(?![\w\\/-])/g
const BASH_FILE = /(?<![\w./-])\/([A-Za-z])\/((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)(?![\w/-])/g
const OTHER_CHECKOUTS = /^(?:\.claude|\.worktrees|\.git|node_modules)(?:[\\/]|$)/i
const fold = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path

export function assignmentText(quest: Quest, stepIDs: string[], task?: string): string {
  const steps = quest.stages.filter(step => stepIDs.includes(step.id))
  return [...(quest.request ?? []).map(row => row.text), quest.objective, quest.description, task, ...steps.flatMap(step => [step.title, step.detail, step.note])].filter(Boolean).join('\n')
}

export function namedInputFiles(text: string, root: string): string[] {
  const candidates = [
    ...[...text.matchAll(RELATIVE_FILE)].map(match => match[1]),
    ...[...text.matchAll(WINDOWS_FILE)].map(match => match[1]),
    ...[...text.matchAll(BASH_FILE)].map(match => match[1] + ':/' + match[2]),
  ]
  const found = new Map<string, string>()
  for (const candidate of candidates) {
    const absolute = isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate) ? resolve(candidate) : resolve(root, candidate)
    const inside = relative(resolve(root), absolute)
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || OTHER_CHECKOUTS.test(inside)) continue
    if (!statSync(absolute, { throwIfNoEntry: false })?.isFile()) continue
    found.set(fold(inside), inside.split(sep).join('/'))
  }
  return [...found.values()]
}

function ignoredInCheckout(checkout: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set()
  const result = spawnSync('git', ['-C', checkout, 'check-ignore', '--stdin', '-z'], { input: paths.join('\0') + '\0', encoding: 'utf8', windowsHide: true })
  return new Set(result.status === 0 ? result.stdout.split('\0').filter(Boolean).map(fold) : [])
}

export function placeInputFiles(input: { root: string; checkout: string; text: string }): string[] {
  if (fold(resolve(input.root)) === fold(resolve(input.checkout))) return []
  const named = namedInputFiles(input.text, input.root)
  const ignored = ignoredInCheckout(input.checkout, named)
  return named.filter(path => {
    const target = join(input.checkout, path)
    if (!ignored.has(fold(path))) return false
    if (existsSync(target)) return true
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(input.root, path), target)
    return true
  })
}

export function inputFilesInstruction(paths: string[]): string {
  return paths.length ? 'Input files are in this checkout: ' + paths.join(', ') + '. Read them here, with paths relative to this checkout.' : ''
}
