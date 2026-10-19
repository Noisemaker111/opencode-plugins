import { randomUUID } from 'node:crypto'
import { saveStudioDraft, studioDrafts, StudioError } from './studio-drafts'
import type { QuestStore } from '../store'
import type { CanvasDocument, CanvasEdit, CanvasEditor, CanvasLayer, StudioCanvas, StudioDocument, StudioDraft, StudioTarget } from '../../apps/questgiver/protocol/studio'

const tags = new Set(['div', 'section', 'header', 'footer', 'main', 'nav', 'h1', 'h2', 'h3', 'h4', 'p', 'span', 'button', 'ul', 'li', 'strong', 'em', 'small', 'label'])
const targets = new Set(['quest-card', 'board-row', 'result-card', 'custom'])
const styleName = /^-?[a-z][a-z-]*$/
const unsafeValue = /[<>{};\\]|url\s*\(|expression\s*\(|@import/i
const empty: CanvasDocument = { layers: [], components: [] }

const layerID = () => 'layer-' + randomUUID().slice(0, 8)

function cleanStyle(style: unknown, partial = false): Record<string, string> {
  if (style === undefined) return {}
  if (!style || typeof style !== 'object' || Array.isArray(style)) throw new StudioError('INVALID_CANVAS_STYLE', 'Give styles as CSS property names and values.')
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(style)) {
    if (!styleName.test(name)) throw new StudioError('INVALID_CANVAS_STYLE', `Use a CSS property name instead of ${name}.`)
    if (value === null && partial) { out[name] = ''; continue }
    if (typeof value !== 'string' || value.length > 200 || unsafeValue.test(value)) throw new StudioError('INVALID_CANVAS_STYLE', `Give ${name} a plain CSS value.`)
    out[name] = value
  }
  return out
}

function cleanLayer(value: unknown, seen: Set<string>): CanvasLayer {
  const layer = value as CanvasLayer
  if (!layer || typeof layer !== 'object') throw new StudioError('INVALID_CANVAS_LAYER', 'Each layer needs an id, a name and a tag.')
  if (typeof layer.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(layer.id) || seen.has(layer.id)) throw new StudioError('INVALID_CANVAS_LAYER', 'Give each layer a different id of letters, digits, dashes or underscores.')
  seen.add(layer.id)
  if (typeof layer.name !== 'string' || !layer.name.trim() || layer.name.length > 120) throw new StudioError('INVALID_CANVAS_LAYER', 'Give each layer a short name.')
  if (typeof layer.tag !== 'string' || !tags.has(layer.tag)) throw new StudioError('INVALID_CANVAS_LAYER', `Use one of these layer tags: ${[...tags].join(', ')}.`)
  if (layer.text !== undefined && (typeof layer.text !== 'string' || layer.text.length > 4000)) throw new StudioError('INVALID_CANVAS_LAYER', 'Layer text must be plain text.')
  if (!Array.isArray(layer.children ?? [])) throw new StudioError('INVALID_CANVAS_LAYER', 'Layer children must be a list.')
  return { id: layer.id, name: layer.name.trim(), tag: layer.tag, ...(layer.text !== undefined ? { text: layer.text } : {}), style: cleanStyle(layer.style ?? {}), children: (layer.children ?? []).map(child => cleanLayer(child, seen)) }
}

export function validateCanvasDocument(value: unknown): CanvasDocument {
  const doc = value as CanvasDocument
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.layers) || !Array.isArray(doc.components ?? [])) throw new StudioError('INVALID_CANVAS', 'A canvas has a list of layers and a list of components.')
  const seen = new Set<string>(), names = new Set<string>()
  const layers = doc.layers.map(layer => cleanLayer(layer, seen))
  const components = (doc.components ?? []).map(component => {
    if (!component || typeof component.name !== 'string' || !component.name.trim() || names.has(component.name.trim())) throw new StudioError('INVALID_CANVAS_COMPONENT', 'Give each component a different name.')
    names.add(component.name.trim())
    return { name: component.name.trim(), layer: cleanLayer(component.layer, new Set()) }
  })
  return { layers, components }
}

export function readCanvas(store: QuestStore, id: string): StudioCanvas {
  const quest = store.read(id)
  if (!quest) throw new StudioError('QUEST_NOT_FOUND', 'This Quest is unavailable.', 404)
  const saved = quest.extensions.studioCanvas as StudioCanvas | undefined
  return structuredClone(saved && typeof saved === 'object' && saved.document ? saved : { revision: 0, document: empty })
}

function persist(store: QuestStore, id: string, expectedRevision: number, document: CanvasDocument, updatedBy: CanvasEditor, session?: string): StudioCanvas {
  const quest = store.read(id)
  if (!quest) throw new StudioError('QUEST_NOT_FOUND', 'This Quest is unavailable.', 404)
  const prior = readCanvas(store, id)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== prior.revision)
    throw new StudioError('STUDIO_CANVAS_CONFLICT', 'The canvas changed in another place. Reopen it to see the latest layers, then edit again.', 409)
  if (JSON.stringify(prior.document) === JSON.stringify(document)) return prior
  const canvas: StudioCanvas = { revision: prior.revision + 1, updatedAt: new Date().toISOString(), updatedBy, ...(session ? { session } : {}), document }
  store.apply(quest.id, 'patched', { extensions: { ...quest.extensions, studioCanvas: canvas } }, 'studio', { expectedRevision: quest.revision })
  return structuredClone(canvas)
}

export function saveCanvas(store: QuestStore, input: { id: string; expectedRevision: number; document: unknown }, updatedBy: CanvasEditor = 'Jon', session?: string) {
  return persist(store, input.id, input.expectedRevision, validateCanvasDocument(input.document), updatedBy, session)
}

function locate(layers: CanvasLayer[], id: string, parent?: CanvasLayer): { layer: CanvasLayer; siblings: CanvasLayer[]; parent?: CanvasLayer } | undefined {
  for (const layer of layers) {
    if (layer.id === id) return { layer, siblings: layers, parent }
    const found = locate(layer.children, id, layer)
    if (found) return found
  }
}

function need(doc: CanvasDocument, id: unknown) {
  const found = typeof id === 'string' ? locate(doc.layers, id) : undefined
  if (!found) throw new StudioError('CANVAS_LAYER_NOT_FOUND', `No layer has the id ${String(id)}. Read the canvas to see its layers.`, 404)
  return found
}

const px = (value: unknown, name: string, min = -100000) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > 100000) throw new StudioError('INVALID_CANVAS_EDIT', `Give ${name} as a number of pixels.`)
  return Math.round(value) + 'px'
}

function fresh(layer: CanvasLayer): CanvasLayer {
  return { ...structuredClone(layer), id: layerID(), children: layer.children.map(fresh) }
}

function placed(layer: CanvasLayer, x?: number, y?: number) {
  if (x !== undefined) layer.style = { ...layer.style, position: 'absolute', left: px(x, 'x') }
  if (y !== undefined) layer.style = { ...layer.style, position: 'absolute', top: px(y, 'y') }
  return layer
}

export function applyCanvasEdit(doc: CanvasDocument, edit: CanvasEdit): CanvasDocument {
  const next = structuredClone(doc)
  switch (edit?.op) {
    case 'move': { const { layer } = need(next, edit.id); layer.style = { ...layer.style, position: 'absolute', left: px(edit.x, 'x'), top: px(edit.y, 'y') }; break }
    case 'resize': { const { layer } = need(next, edit.id); layer.style = { ...layer.style, width: px(edit.width, 'width', 1), height: px(edit.height, 'height', 1) }; break }
    case 'restyle': {
      const { layer } = need(next, edit.id), changes = cleanStyle(edit.style, true)
      const style = { ...layer.style }
      for (const [name, value] of Object.entries(changes)) if (value === '') delete style[name]; else style[name] = value
      layer.style = style; break
    }
    case 'text': { const { layer } = need(next, edit.id); if (typeof edit.text !== 'string') throw new StudioError('INVALID_CANVAS_EDIT', 'Give the layer text.'); layer.text = edit.text; break }
    case 'rename': { const { layer } = need(next, edit.id); if (typeof edit.name !== 'string' || !edit.name.trim()) throw new StudioError('INVALID_CANVAS_EDIT', 'Give the layer a name.'); layer.name = edit.name.trim(); break }
    case 'add': {
      const input = edit.layer
      if (!input || typeof input !== 'object') throw new StudioError('INVALID_CANVAS_EDIT', 'Describe the new layer.')
      const layer = { id: input.id ?? layerID(), name: input.name, tag: input.tag ?? 'div', ...(input.text !== undefined ? { text: input.text } : {}), style: input.style ?? {}, children: [] }
      ;(edit.parent ? need(next, edit.parent).layer.children : next.layers).push(layer)
      break
    }
    case 'remove': { const { layer, siblings } = need(next, edit.id); siblings.splice(siblings.indexOf(layer), 1); break }
    case 'component': {
      const { layer } = need(next, edit.id)
      if (typeof edit.name !== 'string' || !edit.name.trim()) throw new StudioError('INVALID_CANVAS_EDIT', 'Give the component a name.')
      next.components = [...next.components.filter(item => item.name !== edit.name.trim()), { name: edit.name.trim(), layer: structuredClone(layer) }]
      break
    }
    case 'insert': {
      const component = next.components.find(item => item.name === edit.component)
      if (!component) throw new StudioError('CANVAS_COMPONENT_NOT_FOUND', `No component is named ${String(edit.component)}.`, 404)
      ;(edit.parent ? need(next, edit.parent).layer.children : next.layers).push(placed(fresh(component.layer), edit.x, edit.y))
      break
    }
    default: throw new StudioError('INVALID_CANVAS_EDIT', 'Use move, resize, restyle, text, rename, add, remove, component or insert.')
  }
  return validateCanvasDocument(next)
}

export function editCanvas(store: QuestStore, input: { id: string; expectedRevision?: number; edits: CanvasEdit[] }, updatedBy: CanvasEditor, session?: string): StudioCanvas {
  if (!Array.isArray(input.edits) || !input.edits.length) throw new StudioError('INVALID_CANVAS_EDIT', 'Give at least one canvas edit.')
  const prior = readCanvas(store, input.id)
  const expected = input.expectedRevision ?? prior.revision
  let doc = prior.document
  for (const edit of input.edits) doc = applyCanvasEdit(doc, edit)
  return persist(store, input.id, expected, doc, updatedBy, session)
}

const escape = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!)
const className = (layer: CanvasLayer) => 'c-' + layer.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + layer.id.replace(/[^A-Za-z0-9_-]/g, '').slice(-8)

function markup(layer: CanvasLayer, depth: number): string {
  const pad = '  '.repeat(depth)
  const inner = [layer.text !== undefined ? pad + '  ' + escape(layer.text) : '', ...layer.children.map(child => markup(child, depth + 1))].filter(Boolean).join('\n')
  return `${pad}<${layer.tag} class="${className(layer)}" data-layer="${escape(layer.name)}">${inner ? '\n' + inner + '\n' + pad : ''}</${layer.tag}>`
}

function rules(layer: CanvasLayer): string[] {
  const own = Object.entries(layer.style)
  return [...(own.length ? [`.${className(layer)} {\n${own.map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}`] : []), ...layer.children.flatMap(rules)]
}

function extent(layers: CanvasLayer[], axis: 'left' | 'top', size: 'width' | 'height') {
  return Math.max(0, ...layers.map(layer => (parseFloat(layer.style[axis] ?? '0') || 0) + (parseFloat(layer.style[size] ?? '0') || 0)))
}

export function canvasCode(doc: CanvasDocument, title: string, only?: string): StudioDocument {
  const layers = only ? [need(doc, only).layer] : doc.layers
  if (!layers.length) throw new StudioError('CANVAS_EMPTY', 'Add a layer to the canvas before turning it into code.')
  const width = extent(layers, 'left', 'width'), height = extent(layers, 'top', 'height')
  const body = `<div class="canvas-frame">\n${layers.map(layer => markup(layer, 1)).join('\n')}\n</div>`
  const css = [`body { margin: 0; font: 14px/1.5 system-ui, sans-serif; }`, `.canvas-frame { position: relative;${width ? ` width: ${width}px;` : ''}${height ? ` min-height: ${height}px;` : ''} }`, ...layers.flatMap(rules)].join('\n\n') + '\n'
  return {
    renderer: 'html', entry: 'index.html', files: [
      { path: 'index.html', content: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${escape(title)}</title>\n<link rel="stylesheet" href="style.css">\n<script src="script.js" defer></script>\n</head>\n<body>\n${body}\n</body>\n</html>\n` },
      { path: 'style.css', content: css },
      { path: 'script.js', content: '' },
      { path: 'canvas.json', content: JSON.stringify({ layers, components: doc.components }, null, 2) + '\n' },
    ],
  }
}

export function canvasToDraft(store: QuestStore, input: { id: string; target: StudioTarget; layer?: string }): StudioDraft {
  if (typeof input.target !== 'string' || !targets.has(input.target)) throw new StudioError('INVALID_STUDIO_TARGET', 'Choose a starting target.')
  const quest = store.read(input.id)
  if (!quest) throw new StudioError('QUEST_NOT_FOUND', 'This Quest is unavailable.', 404)
  const document = canvasCode(readCanvas(store, input.id).document, quest.title, input.layer)
  const prior = studioDrafts(store, input.id).drafts.find(draft => draft.target === input.target)
  return saveStudioDraft(store, { id: input.id, target: input.target, expectedRevision: prior?.revision ?? 0, document })
}
