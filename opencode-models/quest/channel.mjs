import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

export const WORK_BRANCH = 'v2'
export const RELEASE_BRANCH = 'main'
export const CHANNELS = [WORK_BRANCH, RELEASE_BRANCH]
export const CHANNEL_BRANCH = {[WORK_BRANCH]: WORK_BRANCH, [RELEASE_BRANCH]: RELEASE_BRANCH}
export const LEGACY_CHANNEL_NAMES = {beta: WORK_BRANCH, latest: WORK_BRANCH, dev: WORK_BRANCH, stable: RELEASE_BRANCH}
export const SITE_ADDRESS = 'quest.jonsoc.com'
export const CONNECTOR_NAME = 'QuestGiver'
export const CHANNEL_BRIDGE_PORTS = {[WORK_BRANCH]: {CLAUDE_CODE_BRIDGE_PORT: 3012, JEV_BRIDGE_PORT: 3013}, [RELEASE_BRANCH]: {CLAUDE_CODE_BRIDGE_PORT: 3022, JEV_BRIDGE_PORT: 3023}}
export const LANDING_PUSH = new RegExp(String.raw`\bgit\b[^\n;&|]*?\spush\b[^\n;&|]*\b(${WORK_BRANCH}|${RELEASE_BRANCH})\b`)
export const landsWork = command => /\bgh\s+pr\s+merge\b/.test(command) || LANDING_PUSH.test(command)

export const channelName = value => CHANNELS.includes(value) ? value : Object.hasOwn(LEGACY_CHANNEL_NAMES, value) ? LEGACY_CHANNEL_NAMES[value] : undefined
export const legacyNames = channel => Object.keys(LEGACY_CHANNEL_NAMES).filter(name => LEGACY_CHANNEL_NAMES[name] === channel)

const readJSON = file => { let text; try { text = readFileSync(file, 'utf8') } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error } return JSON.parse(text) }

export const channelRegistry = (home = homedir()) => join(home, '.config', 'opencode', '.channels')

export function channelStateRoot(registry) {
  const normalized = registry.replaceAll('\\', '/').replace(/\/+$/, '')
  const suffix = '/.config/opencode/.channels'
  if (normalized.toLowerCase().endsWith(suffix)) return join(registry, '..', '..', '..', '.local', 'state', 'questgiver', 'channels')
  return registry.replace(/[\\/]+$/, '') + '-state'
}

export function questWorkspace(registry) {
  const value = readJSON(join(registry, 'workspace.json'))
  if (!value) return undefined
  const stateChannel = channelName(value.stateChannel)
  if (channelName(value.channel) !== WORK_BRANCH || !CHANNELS.includes(stateChannel)) throw Error('Quest workspace must select v2 and an existing data channel')
  return {channel: WORK_BRANCH, stateChannel}
}

export const dataChannel = (registry, channel) => channel === WORK_BRANCH ? questWorkspace(registry)?.stateChannel ?? channel : channel

export function resolveChannel({environment = process.env, home = homedir(), registry = channelRegistry(home)} = {}) {
  const name = [environment.QUEST_CHANNEL, environment.OPENCODE_RELEASE_CHANNEL, environment.QUESTGIVER_OC_CHANNEL].map(channelName).find(Boolean)
    ?? channelName(readJSON(join(registry, 'selected.json'))?.channel) ?? WORK_BRANCH
  const data = dataChannel(registry, name)
  return {
    name,
    branch: name,
    stateDir: join(channelStateRoot(registry), data),
    pointerFile: join(registry, name + '.json'),
    hostPool: join(registry, 'connector-hosts-' + data),
    statusFile: join(registry, 'connector-status-' + data + '.json'),
    bridgePorts: CHANNEL_BRIDGE_PORTS[name],
    installName: CONNECTOR_NAME,
  }
}

export const channelPointerCandidates = (registry, name = WORK_BRANCH) => [name, ...legacyNames(name)].map(old => join(registry, old + '.json'))
