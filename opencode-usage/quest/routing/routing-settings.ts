import { migrateRoutingSettings, routingSettingsProblem, unservedPatternProblem, unsetRoutingSettings, type RoutingSettings, type ServedCheck } from '../../models/routing-settings'
import { questSettingsFile, readSettings, writeSettings, type SettingsSection } from '../config/quest-settings.mjs'

export type { RoutingSettings }
const ROUTING_SECTION: SettingsSection<RoutingSettings> = {
  name: 'routing',
  check(saved) {
    if (saved === undefined) return unsetRoutingSettings()
    const value = migrateRoutingSettings(saved)
    const problem = routingSettingsProblem(value)
    if (problem) throw Error('Invalid routing settings: ' + problem + '; repair the saved choice, nothing was substituted')
    return value as RoutingSettings
  },
}
export function routingSettings(file = questSettingsFile()): RoutingSettings {
  return readSettings(ROUTING_SECTION, file)
}
const savedOrNothing = (file: string) => { try { return routingSettings(file) } catch { return undefined } }
export function setRoutingSettings(value: unknown, check: Omit<ServedCheck, 'saved'>, file = questSettingsFile()): RoutingSettings {
  const migrated = migrateRoutingSettings(value)
  const problem = routingSettingsProblem(migrated)
  if (problem) throw Error(problem)
  const unserved = unservedPatternProblem(migrated as RoutingSettings, { ...check, saved: savedOrNothing(file) })
  if (unserved) throw Error(unserved)
  const clean = migrated as RoutingSettings
  const saved: RoutingSettings = { ...clean, depths: Object.fromEntries(Object.entries(clean.depths).map(([depth, setting]) => [depth, { ...setting, exclude: setting.exclude.map(pattern => pattern.trim()) }])) as RoutingSettings['depths'] }
  return writeSettings(ROUTING_SECTION, saved, file)
}
