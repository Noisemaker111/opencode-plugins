import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { QuestError } from '../api'
import { questMemberships } from '../permissions/shared-guard'
import { QuestWorkspaces } from '../workspaces'
import { saveVariation, variationBrief } from './studio-variations'
import type { QuestStore } from '../store'
import type { StudioDocument } from '../../apps/questgiver/protocol/studio'

const text = { type: 'string', minLength: 1 }
const result = (value: unknown) => { const content = JSON.stringify(value); return { content, output: JSON.parse(content) } }

function assignment(store: QuestStore, sessionID: string | undefined) {
  if (!sessionID) throw new QuestError('HOST_CONTEXT_REQUIRED', 'A worker session is required to save a Design Studio variation.')
  const member = questMemberships(store, sessionID).find(entry => !entry.archived && entry.quest.extensions.studioVariationOf)
  if (!member) throw new QuestError('NOT_A_VARIATION_WORKER', 'Only a worker of a Design Studio variation Quest can use quest_variation.')
  return { quest: store.read(member.quest.id) ?? member.quest, run: member.run }
}

function checkoutFiles(store: QuestStore, runID: string | undefined, files: string[]) {
  const workspace = runID ? new QuestWorkspaces(store.runtime).get(runID) : undefined
  if (!workspace || workspace.removed || !existsSync(workspace.path)) throw new QuestError('VARIATION_CHECKOUT_UNKNOWN', 'Your checkout could not be found. Pass the preview files inline with document instead.')
  const checkout = resolve(workspace.path)
  return files.map(file => {
    const target = resolve(checkout, file), rel = relative(checkout, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new QuestError('VARIATION_OUTSIDE_CHECKOUT', `The file ${target} is outside your checkout ${checkout}; nothing was saved.`)
    if (!existsSync(target) || !statSync(target).isFile()) throw new QuestError('VARIATION_FILE_MISSING', `The file ${target} does not exist; nothing was saved.`)
    const binary = /\.(png|jpe?g|gif|webp)$/i.test(file)
    const content = binary ? 'data:image/' + file.split('.').pop()!.toLowerCase().replace('jpg', 'jpeg') + ';base64,' + readFileSync(target).toString('base64') : readFileSync(target, 'utf8')
    return { path: rel.replaceAll('\\', '/'), content }
  })
}

export function variationTool(store: QuestStore) {
  return {
    name: 'quest_variation',
    description: 'For a worker of a Design Studio variation Quest. read returns the thing to vary, its renderer (html, react, rust, go or 7dtd), the user\'s direction and any source variations to merge or iterate on. save stores your step\'s preview so the user sees it in the Variation Studio grid: give document {renderer, entry, files} inline, or files (paths in your checkout) with entry. The entry must be HTML; React, Rust, Go and 7 Days to Die mod UIs save an exported HTML view or an HTML page that shows a screenshot. A .png, .jpg, .gif or .webp file is saved as a data URL so the entry HTML can show it.',
    input: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { enum: ['read', 'save'] },
        stepID: { ...text, description: 'Your variation step, such as variation-3. Required for save.' },
        document: { type: 'object', description: 'The preview: renderer, entry and files [{path, content}].' },
        files: { type: 'array', minItems: 1, items: text, description: 'Paths in your checkout to save as the preview files.' },
        entry: { ...text, description: 'With files: the HTML file the user sees.' },
        note: { type: 'string', description: 'One short sentence on what makes this variation different.' },
      },
    },
    output: { type: 'object', additionalProperties: true },
    execute: async (input: any, ctx: any) => {
      const { quest, run } = assignment(store, ctx?.sessionID)
      if (input.action === 'read') return result({ ...variationBrief(store, quest).view, steps: run.deliverables })
      if (input.action !== 'save') throw new QuestError('INVALID_INPUT', 'Use read or save.')
      if (typeof input.stepID !== 'string' || !run.deliverables.includes(input.stepID)) throw new QuestError('INVALID_INPUT', 'Give stepID as one of your own steps: ' + run.deliverables.join(', ') + '.')
      const { set } = variationBrief(store, quest)
      const document: StudioDocument = input.document ?? (() => {
        if (!Array.isArray(input.files) || typeof input.entry !== 'string') throw new QuestError('INVALID_INPUT', 'Give document, or files with entry.')
        return { renderer: set.renderer ?? 'html', entry: input.entry, files: checkoutFiles(store, run.runID ?? run.callID, input.files) }
      })()
      if (!/\.html?$/i.test(document?.entry ?? '')) throw new QuestError('INVALID_INPUT', 'The entry file must be HTML so the grid can show it.')
      return result(saveVariation(store, quest, input.stepID, document, input.note))
    },
  }
}
