export const hostCapabilities = ({ commit, generation }, read, operations) => ({
  release: commit ?? generation ?? null,
  generation: generation ?? null,
  read,
  operations,
})

const names = value => Array.isArray(value) && value.every(name => typeof name === 'string') ? value : undefined
const text = value => typeof value === 'string' ? value : null

export function readCapabilities(value) {
  const read = names(value?.read), operations = names(value?.operations)
  return read && operations ? { release: text(value.release), generation: text(value.generation), read, operations } : undefined
}

export const hostSupports = (capabilities, name) => capabilities.read.includes(name) || capabilities.operations.includes(name)

export const shortRelease = release => release ? release.slice(0, 7) : 'unknown'

export const unavailableOnHost = (name, capabilities, wants) =>
  `${name} is not available on the running host (release ${shortRelease(capabilities.release)}${wants ? ', wants ' + shortRelease(wants) : ''}). Update the host to use it.`
