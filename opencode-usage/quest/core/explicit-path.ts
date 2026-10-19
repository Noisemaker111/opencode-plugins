import { readdirSync, statSync, type Dirent } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const ESCAPES: Record<number, string> = { 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r' }
function alternatives(ch: string): string[] {
  const code = ch.charCodeAt(0)
  const octal = code <= 0o377 ? [code.toString(8), code.toString(8).padStart(2, '0'), code.toString(8).padStart(3, '0')] : []
  if (ESCAPES[code]) return [...new Set([ESCAPES[code], ...octal])]
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return [...new Set(octal)]
  if (code >= 0xa0 && code <= 0xff) return [...new Set([ch, ...octal])]
  return [ch]
}
const separator = (ch: string | undefined) => ch === '\\' || ch === '/'
const fold = (text: string) => process.platform === 'win32' ? text.toLowerCase() : text

function consume(text: string, at: number, name: string): number[] {
  const ends: number[] = []
  const step = (i: number, j: number) => {
    if (j === name.length) { ends.push(i); return }
    if (i >= text.length || separator(text[i])) return
    for (const option of alternatives(text[i])) if (fold(name.slice(j, j + option.length)) === fold(option)) step(i + 1, j + option.length)
  }
  step(at, 0)
  return [...new Set(ends)]
}

function directories(path: string): string[] {
  let entries: Dirent[]
  try { entries = readdirSync(path, { withFileTypes: true }) } catch { return [] }
  return entries.filter(entry => {
    if (entry.isDirectory()) return true
    if (!entry.isSymbolicLink()) return false
    try { return statSync(join(path, entry.name)).isDirectory() } catch { return false }
  }).map(entry => entry.name)
}

type Match = { path: string; end: number }
function walk(root: string, text: string, at: number, accept: (end: number) => boolean): Match[] {
  const found: Match[] = []
  const visit = (dir: string, i: number, depth: number) => {
    while (separator(text[i])) i++
    if (depth && accept(i)) found.push({ path: dir, end: i })
    if (i >= text.length) return
    for (const name of directories(dir)) for (const end of consume(text, i, name)) visit(join(dir, name), end, depth + 1)
  }
  visit(root, at, 0)
  return found
}

function best(matches: Match[]): Match | undefined {
  const longest = Math.max(-1, ...matches.map(m => m.end))
  const top = [...new Map(matches.filter(m => m.end === longest).map(m => [fold(m.path), m])).values()]
  return top.length === 1 ? top[0] : undefined
}

const DRIVE = /^([A-Za-z]):/
export function explicitDirectory(selector: string): string | undefined {
  const text = selector.trim()
  if (isAbsolute(text)) { try { if (statSync(text).isDirectory()) return text } catch {} }
  const drive = DRIVE.exec(text)
  if (!drive) return undefined
  return best(walk(drive[1] + ':\\', text, 2, end => end >= text.length))?.path
}

const boundary = (text: string, end: number) => end >= text.length || /[\s,;:)\]}>"'`!?]/.test(text[end]) || (text[end] === '.' && (end + 1 >= text.length || /\s/.test(text[end + 1])))
export function namedDirectories(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/(?<![A-Za-z0-9])([A-Za-z]):/g)) {
    const hit = best(walk(match[1] + ':\\', text, match.index! + 2, end => boundary(text, end)))
    if (hit && !found.some(path => fold(path) === fold(hit.path))) found.push(hit.path)
  }
  return found
}
