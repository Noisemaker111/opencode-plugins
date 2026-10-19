import { driveAsync, gitRun } from '../landing/git-steps'
import type { ReviewGap } from './review-record'

export type PatchFile = { path: string; deleted: boolean; removed: string[]; added: string[]; hunks: string[][] }

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[^/]+$/i
const UI_FILE = /^apps\/(quest-web\/src|questgiver\/site\/src)\/.+\.tsx$/
const ROUTE_FILE = /^apps\/quest-web\/src\/routes\//
const OPERATIONS_FILE = /^quest\/operations\.mjs$/
const SETTINGS_FILE = /(^|\/)[^/]*settings[^/]*\.(json|jsonc|ts|mjs)$/i
const CONTROL = /<(Button|button|a|Link|MenuItem|Route|IconButton|select|input|Toggle|Switch|Tab)\b/
const EXPORT = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/
const EXPORT_LIST = /^\s*export\s*(?:type\s*)?\{([^}]*)\}/
const TEST_BLOCK = /^\s*(?:test|it)(?:\.\w+)?\(\s*(['"`])(.+?)\1/
const OPERATION = /^\s*([A-Za-z][\w]*)\s*:\s*operation\(/
const OPTION = /^\s*([A-Za-z][\w]*)\s*:\s*\{\s*type\s*:/
const SETTING = /^\s*["']?([A-Za-z][\w.-]*)["']?\s*:/
const REMOVAL_WORDS = /\b(remov|delet|drop|hid|get rid|retir|deprecat|strip|kill|eliminat)/i

export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = []
  let file: PatchFile | undefined, hunk: string[] | undefined
  for (const line of patch.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (header) { file = { path: header[1], deleted: false, removed: [], added: [], hunks: [] }; files.push(file); hunk = undefined; continue }
    if (!file) continue
    if (line.startsWith('deleted file mode')) { file.deleted = true; continue }
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('@@')) { hunk = []; file.hunks.push(hunk); continue }
    if (!hunk) continue
    hunk.push(line)
    if (line.startsWith('-')) file.removed.push(line.slice(1))
    else if (line.startsWith('+')) file.added.push(line.slice(1))
  }
  return files
}

export function askedToRemove(request: string, thing: string) {
  if (!REMOVAL_WORDS.test(request)) return false
  const text = request.toLowerCase(), words = thing.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2)
  return words.length > 0 && words.some(word => text.includes(word))
}

async function importers(root: string | undefined, name: string, own: string): Promise<string[]> {
  if (!root) return []
  const found = await driveAsync(gitRun(root, ['grep', '-l', '-w', '-e', name, '--', '.']))
  return found.status === 0 ? found.stdout.split(/\r?\n/).filter(path => path && path !== own) : []
}

const wrong = (asked: string, missing: string, action: string): ReviewGap => ({ asked, missing, action, kind: 'wrong', removal: true })
const CONTROL_WORD: Record<string, string> = { Button: 'button', button: 'button', IconButton: 'button', a: 'link', Link: 'link', MenuItem: 'menu item', Route: 'route', select: 'select', input: 'input', Toggle: 'switch', Switch: 'switch', Tab: 'tab' }
export function controlName(line: string): string {
  const tag = CONTROL.exec(line)?.[1] ?? 'control', word = CONTROL_WORD[tag] ?? 'control'
  const named = /\b(?:aria-label|label|title|placeholder|name|path)\s*=\s*(?:\{\s*)?["'`]([^"'`]+)["'`]/.exec(line)?.[1]
    ?? />\s*([^<>{}]*[A-Za-z][^<>{}]*?)\s*</.exec(line)?.[1]
  return named?.trim() ? 'the ' + named.trim().slice(0, 60) + ' ' + word : 'a ' + word
}
const testBlocks = (lines: string[]) => lines.filter(line => TEST_BLOCK.test(line)).length
const vanished = (removed: string[], added: string[], pattern: RegExp) => {
  const kept = new Set(added.flatMap(line => { const match = pattern.exec(line); return match ? [match[match.length - 1]] : [] }))
  return [...new Set(removed.flatMap(line => { const match = pattern.exec(line); return match && !kept.has(match[match.length - 1]) ? [match[match.length - 1]] : [] }))]
}

export async function removalGaps(patch: string, request: string, root?: string): Promise<ReviewGap[]> {
  const files = parsePatch(patch), gaps: ReviewGap[] = []
  const addedEverywhere = files.flatMap(file => file.added)
  const unasked = (thing: string) => !askedToRemove(request, thing)
  for (const file of files) {
    if (file.deleted && unasked(file.path)) {
      const kind = ROUTE_FILE.test(file.path) ? 'route file' : TEST_FILE.test(file.path) ? 'test file' : 'file'
      gaps.push(wrong(file.path, 'the ' + kind + ' ' + file.path + ' was deleted and the message does not ask for that', 'Restore the deleted ' + kind + ' ' + file.path))
    }
    const exported = [...vanished(file.removed, addedEverywhere, EXPORT), ...file.removed.flatMap(line => EXPORT_LIST.exec(line)?.[1].split(',').map(part => part.trim().split(/\s+as\s+/).pop()!.replace(/^type\s+/, '')).filter(Boolean) ?? [])
      .filter(name => !addedEverywhere.some(line => new RegExp('\\b' + name + '\\b').test(line) && /export/.test(line)))]
    for (const name of new Set(exported)) {
      const users = await importers(root, name, file.path)
      if (users.length && unasked(name)) gaps.push(wrong(name, 'the export ' + name + ' was removed from ' + file.path + ' but ' + users.slice(0, 5).join(', ') + ' still use it', 'Restore the export ' + name + ' in ' + file.path))
    }
    if (TEST_FILE.test(file.path) && !file.deleted && testBlocks(file.removed) > testBlocks(file.added)) for (const title of vanished(file.removed, addedEverywhere, TEST_BLOCK)) if (unasked(title))
      gaps.push(wrong(title, 'the test "' + title + '" in ' + file.path + ' was deleted', 'Restore the test "' + title + '" in ' + file.path))
    if (TEST_FILE.test(file.path)) for (const line of file.added) {
      const skipped = /^\s*(?:test|it|describe)\.(?:skip|todo)\(\s*(['"`])(.+?)\1/.exec(line)
      if (skipped && unasked(skipped[2])) gaps.push(wrong(skipped[2], 'the test "' + skipped[2] + '" in ' + file.path + ' is now skipped', 'Run the test "' + skipped[2] + '" in ' + file.path + ' again'))
    }
    if (UI_FILE.test(file.path) && !file.deleted) {
      const added = new Set(file.added.map(line => line.trim()))
      for (const line of file.removed) if (CONTROL.test(line) && !added.has(line.trim()) && !file.added.some(other => other.trim().replace(/\s+/g, ' ') === line.trim().replace(/\s+/g, ' '))) {
        const control = line.trim().slice(0, 120), name = controlName(control)
        if (unasked(control)) gaps.push(wrong(name, name + ' was removed from ' + file.path, 'Restore ' + name + ' in ' + file.path + ' from v2'))
      }
      for (const hunk of file.hunks) hunk.forEach((line, index) => {
        if (!/^\+\s*(<Show\b|\{[^}]*&&\s*\(?\s*$|\{[^}]*\?\s*\(?\s*$)/.test(line)) return
        const next = hunk.slice(index + 1).find(other => !other.startsWith('+') && other.trim())
        if (!next || next.startsWith('-') || !CONTROL.test(next)) return
        const control = next.slice(1).trim().slice(0, 120)
        if (unasked(control)) gaps.push(wrong(control, 'the control `' + control + '` in ' + file.path + ' is now behind a new condition', 'Show the control `' + control + '` in ' + file.path + ' as before'))
      })
    }
    if (OPERATIONS_FILE.test(file.path)) {
      for (const name of vanished(file.removed, addedEverywhere, OPERATION)) if (unasked(name)) gaps.push(wrong(name, 'the operation ' + name + ' was removed from ' + file.path, 'Restore the operation ' + name + ' in ' + file.path))
      for (const name of vanished(file.removed, file.added, OPTION)) if (unasked(name)) gaps.push(wrong(name, 'the option ' + name + ' was removed from ' + file.path, 'Restore the option ' + name + ' in ' + file.path))
    }
    if (SETTINGS_FILE.test(file.path) && !TEST_FILE.test(file.path) && !file.deleted)
      for (const name of vanished(file.removed, file.added, SETTING)) if (unasked(name)) gaps.push(wrong(name, 'the setting ' + name + ' was removed from ' + file.path, 'Restore the setting ' + name + ' in ' + file.path))
  }
  return gaps
}
