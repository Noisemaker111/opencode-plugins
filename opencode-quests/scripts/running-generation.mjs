import { basename, dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const generated = basename(dirname(root)) === 'generations'

export const runningGeneration = () => generated ? basename(root) : process.env.OPENCODE_PLUGIN_GENERATION ?? null
export const generationKey = name => Symbol.for(generated ? name + '@' + root : name)
export const generationFiles = () => generated ? root : undefined
