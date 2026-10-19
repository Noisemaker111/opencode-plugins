import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { QuestError } from '../api'
import { questMemberships } from '../permissions/shared-guard'
import { QuestWorkspaces } from '../workspaces'
import { readCanvas, editCanvas, canvasToDraft, canvasCode } from './studio-canvas'
import { canvasAsPen, canvasFromPen } from './studio-pen'
import type { QuestStore } from '../store'

const text = { type: 'string', minLength: 1 }
const style = { type: 'object', additionalProperties: { type: ['string', 'null'] } }
const edit = {
  type: 'object', required: ['op'], additionalProperties: false,
  properties: {
    op: { enum: ['move', 'resize', 'restyle', 'text', 'rename', 'add', 'remove', 'component', 'insert'] },
    id: text, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
    style, text: { type: 'string' }, name: text, parent: text, component: text,
    layer: { type: 'object', additionalProperties: false, required: ['name'], properties: { id: text, name: text, tag: text, text: { type: 'string' }, style } },
  },
}
const result = (value: unknown) => { const content = JSON.stringify(value); return { content, output: JSON.parse(content) } }

function member(store: QuestStore, sessionID: string | undefined, questID: string) {
  if (!sessionID) throw new QuestError('HOST_CONTEXT_REQUIRED', 'A session is required to use the Design Studio canvas.')
  const quest = store.read(questID)
  if (!quest) throw new QuestError('QUEST_NOT_FOUND', 'This Quest is unavailable.')
  const owns = quest.integrationOwner === sessionID || questMemberships(store, sessionID).some(entry => entry.quest.id === quest.id)
  if (!owns) throw new QuestError('OWNER_REQUIRED', 'Only a worker or the Quest Giver on this Quest can use its canvas.')
  return quest
}

function penPath(store: QuestStore, sessionID: string, questID: string, file: string) {
  if (!file.toLowerCase().endsWith('.pen')) throw new QuestError('INVALID_INPUT', 'Give a path that ends in .pen.')
  const run = questMemberships(store, sessionID).find(entry => entry.quest.id === questID)?.run
  const workspace = run?.runID ? new QuestWorkspaces(store.runtime).get(run.runID) : undefined
  if (!workspace || workspace.removed || !existsSync(workspace.path)) throw new QuestError('PEN_CHECKOUT_UNKNOWN', 'Your checkout could not be found, so no .pen file was read or written. Use penFile only from a worker run with a checkout, or omit it to pass the .pen JSON inline.')
  const checkout = resolve(workspace.path), target = resolve(checkout, file), rel = relative(checkout, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new QuestError('PEN_OUTSIDE_CHECKOUT', `The file ${target} is outside your checkout ${checkout}; nothing was read or written.`)
  return target
}

export function canvasTool(store: QuestStore) {
  return {
    name: 'quest_canvas',
    description: 'Read and edit the shared Design Studio canvas of your Quest, the same canvas the user edits in Quest Web. read returns its layers and components with ids. edit applies move, resize, restyle, text, rename, add, remove, component (save a layer as a component) and insert (place a component) to layers by id and saves them for the user to see. code turns the canvas, or one layer, into HTML and CSS and saves it as the Quest draft of a target, which the user promotes to a pull request. pen-export writes the canvas as a pen.dev .pen document (to penFile in your checkout, or inline) so the pencil MCP or the pen CLI can open, edit, screenshot or export it; pen-import reads a .pen document (from penFile or inline pen) back onto the canvas, replacing it or, with mode add, adding its frames.',
    input: {
      type: 'object', additionalProperties: false, required: ['action', 'questID'],
      properties: {
        action: { enum: ['read', 'edit', 'code', 'pen-export', 'pen-import'] },
        questID: text,
        expectedRevision: { type: 'integer', minimum: 0 },
        edits: { type: 'array', minItems: 1, items: edit },
        target: { enum: ['quest-card', 'board-row', 'result-card', 'custom'] },
        layer: text,
        penFile: { type: 'string', minLength: 5, description: 'A .pen path inside your checkout.' },
        pen: { type: 'object', description: 'A .pen document given inline for pen-import.' },
        mode: { enum: ['replace', 'add'] },
      },
    },
    output: { type: 'object', additionalProperties: true },
    execute: async (input: any, ctx: any) => {
      const quest = member(store, ctx?.sessionID, input.questID)
      if (input.action === 'read') return result(readCanvas(store, quest.id))
      if (input.action === 'edit') return result(editCanvas(store, { id: quest.id, expectedRevision: input.expectedRevision, edits: input.edits }, 'worker', ctx.sessionID))
      if (input.action === 'code') {
        if (!input.target) return result({ preview: canvasCode(readCanvas(store, quest.id).document, quest.title, input.layer) })
        return result(canvasToDraft(store, { id: quest.id, target: input.target, layer: input.layer }))
      }
      if (input.action === 'pen-export') {
        const exported = canvasAsPen(store, quest.id)
        if (!input.penFile) return result(exported)
        const file = penPath(store, ctx.sessionID, quest.id, input.penFile)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(exported.pen, null, 2) + '\n')
        return result({ revision: exported.revision, penFile: file, layers: exported.pen.children.length })
      }
      if (input.action === 'pen-import') {
        if (!input.penFile && !input.pen) throw new QuestError('INVALID_INPUT', 'Give penFile or pen to import.')
        const pen = input.penFile ? readFileSync(penPath(store, ctx.sessionID, quest.id, input.penFile), 'utf8') : input.pen
        return result(canvasFromPen(store, { id: quest.id, expectedRevision: input.expectedRevision, pen, mode: input.mode }, 'worker', ctx.sessionID))
      }
      throw new QuestError('INVALID_INPUT', 'Use read, edit, code, pen-export or pen-import.')
    },
  }
}
