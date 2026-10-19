const READ_ONLY_GIT = new Set(['log', 'show', 'diff', 'grep', 'blame', 'ls-files', 'ls-tree', 'rev-list', 'rev-parse', 'show-ref', 'merge-base', 'cat-file', 'shortlog', 'describe', 'name-rev'])
const CHAINING = /[;&|<>`$()\r\n]/
const WRITES_OR_RUNS = /^(?:--output\b|-O|--open-files-in-pager\b|--ext-diff\b|--textconv\b)/

export function readOnlyGit(command: unknown): boolean {
  if (typeof command !== 'string' || CHAINING.test(command)) return false
  const [program, subcommand, ...args] = command.trim().split(/\s+/)
  return program === 'git' && READ_ONLY_GIT.has(subcommand ?? '') && !args.some(arg => WRITES_OR_RUNS.test(arg))
}
