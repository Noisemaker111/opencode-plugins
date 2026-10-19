import { readFileSync, statfsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const GIB = 1024 ** 3
const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export function loadSettings(root = codeRoot) {
  const settings = JSON.parse(readFileSync(join(root, "disk-guard.json"), "utf8"))
  if (typeof settings.drive !== "string" || !(settings.alertBelowGiB > 0)) throw Error("disk-guard.json needs drive and a positive alertBelowGiB")
  return settings
}

export function freeSpace(drive) {
  const stats = statfsSync(drive + "\\")
  const block = Number(stats.bsize)
  return { free: Number(stats.bavail) * block, total: Number(stats.blocks) * block }
}

export function diskAlert({ settings = loadSettings(), measure = () => freeSpace(settings.drive) } = {}) {
  let measured
  try { measured = measure() } catch { return undefined }
  const free = measured.free / GIB
  if (free >= settings.alertBelowGiB) return undefined
  return { key: "disk-low", text: settings.drive + " has " + free.toFixed(1) + " GiB free of " + Math.round(measured.total / GIB) + " GiB, under the " + settings.alertBelowGiB + " GiB warning line." }
}
