import type { Quest } from '../types'

const named = (model: string) => {
  const bare = model.trim().toLowerCase().replace(/^route:/, '')
  const identity = bare.split('#')[0]
  return [bare, identity.includes('/') ? identity.slice(identity.indexOf('/') + 1) : identity].filter(Boolean)
}
export function requestNamesModel(quest: Pick<Quest, 'request'>, model: string) {
  const words = (quest.request ?? []).filter(row => !row.unattributed && !row.context).map(row => row.text.toLowerCase())
  return named(model).some(name => words.some(text => text.includes(name)))
}
