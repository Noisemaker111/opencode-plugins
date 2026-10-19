import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const linkStateDirectory = (environment = process.env, home = homedir()) =>
  environment.QUESTGIVER_STATE ?? join(home, '.local/state', 'questgiver')

export const linkHolderFile = (state = linkStateDirectory()) => join(state, 'link-holder.json')

export const connectorStartFile = file => join(dirname(file), 'start.vbs')

export const signInLauncherFile = (environment = process.env, home = homedir()) =>
  join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'QuestGiver.vbs')

export function signInStartCurrent(file, target = signInLauncherFile()) {
  try { return readFileSync(target).equals(readFileSync(connectorStartFile(file))) } catch { return false }
}

export const linkProblem = (file, holder = liveLinkHolder, startsAtSignIn = signInStartCurrent) =>
  holder() === undefined ? 'no connector process holds the link' : startsAtSignIn(file) ? undefined : 'this computer does not start the connector when you sign in'

export function ensureSignInStart(file, target = signInLauncherFile()) {
  try {
    if (signInStartCurrent(file, target)) return true
    const source = connectorStartFile(file)
    if (!existsSync(source)) return false
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    return true
  } catch { return false }
}

export function liveLinkHolder(file = linkHolderFile()) {
  if (!existsSync(file)) return undefined
  let held
  try { held = JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
  const pid = held?.pid
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try { process.kill(pid, 0); return pid } catch (error) { return error?.code === 'EPERM' ? pid : undefined }
}
