import {copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync} from 'node:fs'
import {writeFileDurable} from '../quest/core/durable-file.mjs'
import {LEGACY_SETTINGS_FILES,QUEST_SETTINGS_FILE_NAME} from '../quest/config/quest-settings.mjs'
import {dirname, join} from 'node:path'
import {homedir} from 'node:os'
import {CHANNEL_BRANCH, CHANNELS, CHANNEL_BRIDGE_PORTS, channelName, channelPointerCandidates, channelStateRoot, dataChannel, legacyNames, questWorkspace, resolveChannel} from '../quest/channel.mjs'

export {CHANNELS, CHANNEL_BRIDGE_PORTS, channelName, channelPointerCandidates, channelStateRoot, dataChannel, questWorkspace}
export const RETIRED_CHANNEL_NAMES = Object.fromEntries(CHANNELS.map(name => [name, legacyNames(name)]))
export const isV2Channel = value => channelName(value) === 'v2'
export const isV2Release = release => isV2Channel(release?.channel)
export const isV2ReleaseDirectory = name => ['v2', ...RETIRED_CHANNEL_NAMES.v2].some(prefix => name.startsWith(prefix + '-'))
export const branchNames = channel => [CHANNEL_BRANCH[channel]]

export function gitRefCandidates(ref) {
  for (const channel of CHANNELS) {
    const match = ref.match(new RegExp('^(.*?)(^|/)' + channel + '$'))
    if (match) return branchNames(channel).map(name => match[1] + match[2] + name)
  }
  return [ref]
}

function retiredStateDirectories(registry, name) {
  const retired = RETIRED_CHANNEL_NAMES[name] ?? []
  return [...retired.map(old => join(channelStateRoot(registry), old)), ...[name, ...retired].map(old => join(registry, 'state', old))]
}

const holdsState = path => { try { return readdirSync(path).length > 0 } catch { return false } }

export function channelStateDirectory(registry, name = 'v2') {
  name = dataChannel(registry, name)
  const current = join(channelStateRoot(registry), name)
  if (existsSync(current)) return current
  return retiredStateDirectories(registry, name).find(holdsState) ?? current
}

export const CHANNEL_SITES = {v2: 'https://quest.jonsoc.com', main: 'https://quest.jonsoc.com'}

export function channelBridgePorts(name, environment = {}, registry = join(homedir(), '.config', 'opencode', '.channels')) {
  const ports = CHANNEL_BRIDGE_PORTS[dataChannel(registry, channelName(name))]
  if (!ports) throw Error('Choose v2 or main')
  return Object.fromEntries(Object.entries(ports).map(([key, port]) => [key, String(environment[key] || port)]))
}

export const channelHostPool = (registry, name) => join(registry, 'connector-hosts-' + dataChannel(registry, channelName(name)))
export const channelConnectorStatusFile = (registry, name) => join(registry, 'connector-status-' + dataChannel(registry, channelName(name)) + '.json')
export const channelQuestRegistry = (registry, name) => join(channelStateDirectory(registry, name), 'quests', '.opencode', '.quest-runtime', 'quest-api')

export function activeChannelRelease(registry, name) {
  try {
    const pointer = JSON.parse(readFileSync(channelPointerFile(registry, name), 'utf8'))
    return typeof pointer?.root === 'string' && pointer.root && existsSync(pointer.root) ? pointer : undefined
  } catch { return undefined }
}

export function channelReleaseCompatibility(name, root) {
  if (channelName(name) !== 'main') return undefined
  const frontend = join(root, 'apps', 'quest-web', 'src', 'lib', 'queries.ts')
  const reads = join(root, 'quest', 'read-operations.mjs')
  const readAPI = join(root, 'quest', 'board', 'read-api.ts')
  const apiServer = join(root, 'quest', 'api-server.ts')
  const settings = join(root, 'quest', 'config', 'quest-settings.mjs')
  let frontendText, apiText
  try { frontendText = readFileSync(frontend, 'utf8') } catch {}
  try { apiText = readFileSync(apiServer, 'utf8') } catch {}
  if (!frontendText?.includes("export type Channel = 'v2' | 'main'") || !existsSync(reads) || !existsSync(readAPI) || !apiText?.includes('readOperationFrom(pathname)') || !existsSync(settings)) return 'The main release lacks the current one-address frontend, front-read and settings contract. Prepare a compatible frontend and backend on the existing main branch before selecting it; this does not move main.'
}

export function selectInstalledChannel(registry, typed) {
  const name = channelName(typed)
  if (!name) throw Error('Choose v2 or main')
  const release = activeChannelRelease(registry, name)
  if (!release) throw Error(`No ${name} release is installed on this computer. Prepare an existing ${name} branch release first; selecting it does not move main.`)
  const incompatible = channelReleaseCompatibility(name, release.root)
  if (incompatible) throw Error(incompatible)
  try { if (JSON.parse(readFileSync(join(registry, 'selected.json'), 'utf8'))?.channel === name) return name } catch {}
  mkdirSync(registry, {recursive: true})
  writeFileDurable(join(registry, 'selected.json'), JSON.stringify({channel: name}) + '\n')
  return name
}

export const questChannel = (registry, environment = process.env) => resolveChannel({environment, registry}).name

export const USER_SETTING_FILES = [QUEST_SETTINGS_FILE_NAME, ...LEGACY_SETTINGS_FILES]
const settingsHome = (registry, name) => join(channelStateDirectory(registry, name), 'quests', '.opencode')

export function carryUserSettings(registry, to, {copy = copyFileSync} = {}) {
  const target = channelName(to)
  if (!target) throw Error('Choose v2 or main')
  const carried = []
  for (const file of USER_SETTING_FILES) {
    const destination = join(settingsHome(registry, target), file)
    if (existsSync(destination)) continue
    const from = CHANNELS.filter(name => name !== target).find(name => existsSync(join(settingsHome(registry, name), file)))
    if (!from) continue
    mkdirSync(dirname(destination), {recursive: true})
    copy(join(settingsHome(registry, from), file), destination)
    carried.push({file, from})
  }
  return carried
}

export function questRegistry(registry, environment = process.env) {
  if (environment.QUEST_API_REGISTRY) return environment.QUEST_API_REGISTRY
  if (!environment.QUEST_CHANNEL && environment.OPENCODE_QUEST_ROOT) return join(environment.OPENCODE_QUEST_ROOT, '.opencode', '.quest-runtime', 'quest-api')
  return channelQuestRegistry(registry, questChannel(registry, environment))
}

export const v2StateDirectory = registry => channelStateDirectory(registry, 'v2')


export function channelPointerFile(registry, name = 'v2') {
  const candidates = channelPointerCandidates(registry, name)
  return candidates.find(path => existsSync(path)) ?? candidates[0]
}

export function stateEnvironment(state) {
  return {XDG_STATE_HOME: join(state, 'xdg'), OPENCODE_DB: join(state, 'host.db'), OPENCODE_QUEST_ROOT: join(state, 'quests'),
    OPENCODE_ORCHESTRATION_LEDGER: join(state, 'orchestration.jsonl'), OPENCODE_TELEMETRY_FILE: join(state, 'requests.jsonl')}
}

export const selectedChannelName = questChannel

const isLink = path => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }
const junction = (target, path) => symlinkSync(target, path, 'junction')
function removeLink(path) {
  try { unlinkSync(path) } catch (error) { if (error?.code === 'ENOENT') return; rmdirSync(path) }
}
const realOrUndefined = path => { try { return realpathSync(path) } catch { return undefined } }
const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

export function planChannelMigration(registry, name = 'v2') {
  const steps = []
  const pointer = join(registry, name + '.json')
  const oldPointers = channelPointerCandidates(registry, name).slice(1).filter(path => existsSync(path))
  if (!existsSync(pointer) && oldPointers.length) {
    const [from, ...leftover] = oldPointers
    steps.push({step: 'pointer', from, to: pointer, change: 'write the current pointer and keep the earlier pointer for connectors that are still running'})
    for (const path of leftover) steps.push({step: 'leftover pointer', path, change: 'kept: an older pointer nothing reads for this channel'})
  } else for (const path of oldPointers) steps.push({step: 'leftover pointer', path, change: 'kept: ' + name + '.json is the pointer'})
  const selection = join(registry, 'selected.json')
  try {
    const saved = JSON.parse(readFileSync(selection, 'utf8'))?.channel
    if (saved !== name && channelName(saved) === name) steps.push({step: 'selected channel', path: selection, from: saved, to: name})
  } catch {}
  const target = join(channelStateRoot(registry), name)
  const retired = retiredStateDirectories(registry, name).filter(path => existsSync(path) || isLink(path))
  if (existsSync(target)) {
    for (const path of retired) if (!samePath(realOrUndefined(path), realpathSync(target))) steps.push({step: 'state', path, change: isLink(path) ? 'relink to ' + target : 'conflict: a second state directory exists; nothing moves'})
  } else {
    const source = retired.find(path => existsSync(path))
    if (source) {
      steps.push({step: 'state', from: realpathSync(source), to: target, change: 'move the directory while no process holds it open; while one does, ' + target + ' becomes a link to it where it is'})
      for (const path of retired) steps.push({step: 'state link', path, to: target, change: 'junction to the moved state so older code finds it'})
    }
  }
  const releases = join(registry, 'releases')
  const oldReleases = existsSync(releases) ? readdirSync(releases).filter(entry => (RETIRED_CHANNEL_NAMES[name] ?? []).some(prefix => entry.startsWith(prefix + '-'))) : []
  if (oldReleases.length) steps.push({step: 'release folders', count: oldReleases.length, change: 'kept under their names; the active release runs from one and they retire as usual; new releases are named ' + name + '-*'})
  return steps
}

export function migrateChannelNames(registry, name = 'v2', {rename = renameSync, link = junction} = {}) {
  const pointer = join(registry, name + '.json')
  const oldPointer = channelPointerCandidates(registry, name).slice(1).find(path => existsSync(path))
  const done = []
  if (!existsSync(pointer) && oldPointer) {
    const content = JSON.parse(readFileSync(oldPointer, 'utf8'))
    writeFileDurable(pointer, JSON.stringify({...content, channel: name, previous: content.previous ? {...content.previous, channel: name} : undefined}, null, 2) + '\n')
    done.push({step: 'pointer', from: oldPointer, to: pointer})
  }
  const selection = join(registry, 'selected.json')
  try {
    const saved = JSON.parse(readFileSync(selection, 'utf8'))?.channel
    if (saved !== name && channelName(saved) === name) {
      writeFileDurable(selection, JSON.stringify({channel: name}) + '\n')
      done.push({step: 'selected channel', from: saved, to: name})
    }
  } catch {}
  const state = relocateChannelState(registry, name, {rename, link})
  if (!state.pending) return {done, state}
  const target = join(channelStateRoot(registry), name)
  mkdirSync(dirname(target), {recursive: true})
  link(realpathSync(state.state), target)
  return {done, state: {...state, state: target, pending: false, linkedInPlace: realpathSync(state.state)}}
}

export function relocateChannelState(registry, name = 'v2', {rename = renameSync, link = junction} = {}) {
  const relocated = join(channelStateRoot(registry), name)
  const legacy = retiredStateDirectories(registry, name).filter(path => existsSync(path) || isLink(path))
  const linkLegacy = () => {
    const linked = []
    for (const path of legacy) {
      if (samePath(realOrUndefined(path), realpathSync(relocated))) continue
      if (isLink(path)) {
        removeLink(path)
      } else if (existsSync(path)) return {conflict: path}
      mkdirSync(dirname(path), {recursive: true})
      link(relocated, path)
      linked.push(path)
    }
    return {linked}
  }
  if (existsSync(relocated)) {
    const {conflict, linked} = linkLegacy()
    return conflict ? {state: relocated, moved: false, pending: false, conflict} : {state: relocated, moved: false, pending: false, linked}
  }
  const source = legacy.find(path => existsSync(path))
  if (!source) return {state: relocated, moved: false, pending: false}
  const real = realpathSync(source)
  mkdirSync(dirname(relocated), {recursive: true})
  try {
    rename(real, relocated)
  } catch (error) {
    if (!['EBUSY', 'EPERM', 'EACCES', 'EXDEV'].includes(error?.code)) throw error
    return {state: source, moved: false, pending: true, reason: error.code === 'EXDEV' ? 'the new location is on another volume' : 'a process holds the state open'}
  }
  const {conflict, linked} = linkLegacy()
  return conflict ? {state: relocated, moved: true, pending: false, conflict} : {state: relocated, moved: true, pending: false, linked}
}

function adoptPath(registry, from, to, rename, link) {
  const source = join(registry, from), target = join(registry, to)
  if (!existsSync(source)) return []
  const directory=lstatSync(source).isDirectory()
  if(existsSync(target)){
    if(!directory||samePath(realOrUndefined(source),realOrUndefined(target)))return []
    if(readdirSync(source).length)return [{step:'kept',path:source,reason:'Both connector pools contain data; neither was changed'}]
    rmdirSync(source)
    link(target,source)
    return [{step:'state link',path:source,to:target}]
  }
  try { rename(source, target) } catch (error) { return [{step: 'kept', path: source, reason: error?.code ?? String(error)}] }
  if(directory)link(target,source)
  return [{step: 'rename', from: source, to: target}]
}

const LEGACY_CONNECTOR_PATHS = [
  ['connector-hosts', 'connector-hosts-v2'],
  ...CHANNELS.flatMap(name => legacyNames(name).map(old => [`connector-hosts-${old}`, `connector-hosts-${name}`])),
  ['connector-status.json', 'connector-status-v2.json'],
  ...CHANNELS.flatMap(name => legacyNames(name).map(old => [`connector-status-${old}.json`, `connector-status-${name}.json`])),
]

export function adoptChannelNames(registry, options = {}) {
  const done = []
  for (const name of CHANNELS) done.push(...migrateChannelNames(registry, name, options).done)
  const rename = options.rename ?? renameSync
  const link = options.link ?? junction
  for (const [from, to] of LEGACY_CONNECTOR_PATHS) done.push(...adoptPath(registry, from, to, rename, link))
  const workspaceFile = join(registry, 'workspace.json')
  if (existsSync(workspaceFile)) {
    const workspace = JSON.parse(readFileSync(workspaceFile, 'utf8'))
    const canonical = {...workspace, channel: channelName(workspace.channel) ?? workspace.channel, stateChannel: channelName(workspace.stateChannel) ?? workspace.stateChannel}
    if (JSON.stringify(canonical) !== JSON.stringify(workspace)) {
      writeFileDurable(workspaceFile, JSON.stringify(canonical) + '\n')
      done.push({step: 'workspace', path: workspaceFile})
    }
  }
  return done
}
