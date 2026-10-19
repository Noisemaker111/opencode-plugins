import { randomInt } from "node:crypto"

export const REFERENCE_SLUG_LENGTH = 40

export function shortSlug(slug: string): string {
  if (slug.length <= REFERENCE_SLUG_LENGTH) return slug
  const cut = slug.slice(0, REFERENCE_SLUG_LENGTH + 1), word = cut.lastIndexOf("-")
  return (word > 0 ? cut.slice(0, word) : cut.slice(0, REFERENCE_SLUG_LENGTH)).replace(/-+$/, "")
}

export function generateReadableReference(title: string, fallback = "quest"): string {
  const slug = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  return shortSlug(slug(title) || slug(fallback) || "quest") + "-" + Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("")
}
export function isReadableReference(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{6}$/.test(value)
}

export function isSafeReference(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) }
