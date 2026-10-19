import { readSettings, type SettingsSection } from "../config/quest-settings.mjs"

export const HYGIENE_KINDS = ["done elsewhere", "duplicate", "superseded", "stale", "needs a look"] as const
export type HygieneKind = (typeof HYGIENE_KINDS)[number]
export const ARCHIVING: readonly HygieneKind[] = ["done elsewhere", "duplicate", "superseded"]
export const HYGIENE_SOURCE = "quest:hygiene"
export const DAY_MS = 86_400_000
export const NEW_QUEST_MS = DAY_MS

export type HygieneSettings = { version: 1; staleDays: number; supersedeDays: number; apply: HygieneKind[] }
export const DEFAULT_HYGIENE: HygieneSettings = { version: 1, staleDays: 7, supersedeDays: 7, apply: [...HYGIENE_KINDS] }

const whole = (value: unknown) => Number.isInteger(value) && (value as number) >= 0
const valid = (value: Record<string, unknown>) =>
  Object.keys(value).every(key => ["version", "staleDays", "supersedeDays", "apply"].includes(key))
  && value.version === 1 && whole(value.staleDays) && whole(value.supersedeDays)
  && Array.isArray(value.apply) && value.apply.every(kind => (HYGIENE_KINDS as readonly unknown[]).includes(kind))

const HYGIENE_SECTION: SettingsSection<HygieneSettings> = {
  name: "hygiene",
  check(saved) {
    const value = saved === undefined ? DEFAULT_HYGIENE : { ...DEFAULT_HYGIENE, ...(saved as Record<string, unknown>) }
    if (!valid(value as Record<string, unknown>)) throw new Error("Quest hygiene settings: staleDays and supersedeDays are whole numbers of days, apply lists kinds from " + HYGIENE_KINDS.join(", "))
    return value as HygieneSettings
  },
}

export function hygieneSettings(file?: string): HygieneSettings {
  return readSettings(HYGIENE_SECTION, file)
}
