import { StudioError } from './studio-drafts'
import { readCanvas, saveCanvas, validateCanvasDocument } from './studio-canvas'
import type { QuestStore } from '../store'
import type { CanvasDocument, CanvasEditor, CanvasLayer, StudioCanvas } from '../../apps/questgiver/protocol/studio'

export const PEN_VERSION = '2.20'
const layerKind = 'quest-canvas'
const componentKind = 'quest-canvas-component'
const componentPrefix = 'component_'
const textTags = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'span', 'strong', 'em', 'small', 'label'])
const boxStyles = ['background-color', 'border', 'border-radius', 'padding']
const plainPenNodes = new Set(['frame', 'group', 'rectangle', 'ellipse', 'text', 'ref'])

type PenNode = { id: string; type: string; name?: string; x?: number; y?: number; width?: unknown; height?: unknown; children?: PenNode[]; [key: string]: unknown }
export type PenDocument = { version: string; variables?: Record<string, { type: string; value: unknown }>; children: PenNode[] }
export type PenImport = { document: CanvasDocument; skipped: string[] }

const pixels = (value: string | undefined) => { const match = /^(-?\d+(?:\.\d+)?)px$/.exec((value ?? '').trim()); return match ? Number(match[1]) : undefined }
const hex = (value: string | undefined) => {
  if (!value) return undefined
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim())) return value.trim()
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(value.trim())
  if (!rgb) return undefined
  const part = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return '#' + part(+rgb[1]) + part(+rgb[2]) + part(+rgb[3]) + (rgb[4] !== undefined && +rgb[4] < 1 ? part(+rgb[4] * 255) : '')
}
const paddingOf = (value: string | undefined) => {
  const parts = (value ?? '').trim().split(/\s+/).map(pixels)
  if (!value || parts.some(part => part === undefined)) return undefined
  const [a, b = a, c = a, d = b] = parts as number[]
  return a === b && b === c && c === d ? a : a === c && b === d ? [a, b] : [a, b, c, d]
}
const justify: Record<string, string> = { 'flex-start': 'start', start: 'start', center: 'center', 'flex-end': 'end', end: 'end', 'space-between': 'space_between', 'space-around': 'space_around' }
const align: Record<string, string> = { 'flex-start': 'start', start: 'start', center: 'center', 'flex-end': 'end', end: 'end' }
const cssJustify: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', space_between: 'space-between', space_around: 'space-around' }
const cssAlign: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end' }

function layout(style: Record<string, string>) {
  const out: Record<string, unknown> = {}
  if (style.display === 'flex' || style.display === 'inline-flex') {
    out.layout = style['flex-direction']?.startsWith('column') ? 'vertical' : 'horizontal'
    const gap = pixels(style.gap); if (gap !== undefined) out.gap = gap
    if (justify[style['justify-content']]) out.justifyContent = justify[style['justify-content']]
    if (align[style['align-items']]) out.alignItems = align[style['align-items']]
  } else out.layout = 'none'
  const padding = paddingOf(style.padding); if (padding !== undefined) out.padding = padding
  return out
}

function textProps(style: Record<string, string>) {
  const out: Record<string, unknown> = {}
  const fill = hex(style.color); if (fill) out.fill = fill
  const size = pixels(style['font-size']); if (size !== undefined) out.fontSize = size
  if (style['font-weight']) out.fontWeight = style['font-weight']
  if (['left', 'center', 'right', 'justify'].includes(style['text-align'])) out.textAlign = style['text-align']
  return out
}

function toPen(layer: CanvasLayer, top: boolean): PenNode {
  const style = layer.style
  const position: Record<string, number> = {}
  const x = pixels(style.left), y = pixels(style.top)
  if (x !== undefined) position.x = x
  if (y !== undefined) position.y = y
  const size: Record<string, number> = {}
  const width = pixels(style.width), height = pixels(style.height)
  if (width !== undefined) size.width = width
  if (height !== undefined) size.height = height
  const metadata = { type: layerKind, tag: layer.tag, style }
  const absolute = !top && style.position === 'absolute' ? { layoutPosition: 'absolute' } : {}
  const box = boxStyles.some(name => style[name])
  if (layer.text !== undefined && !layer.children.length && textTags.has(layer.tag) && !box)
    return { id: layer.id, type: 'text', name: layer.name, ...position, ...size, ...absolute, ...(width !== undefined ? { textGrowth: height !== undefined ? 'fixed-width-height' : 'fixed-width' } : {}), content: layer.text, ...textProps(style), metadata }
  const children = layer.children.map(child => toPen(child, false))
  if (layer.text !== undefined) children.unshift({ id: layer.id + '_text', type: 'text', name: 'Text', content: layer.text, ...textProps(style), metadata: { type: layerKind, tag: 'span', style: {}, ownText: true } })
  const fill = hex(style['background-color'])
  const radius = pixels(style['border-radius'])
  return { id: layer.id, type: 'frame', name: layer.name, ...position, ...size, ...absolute, ...layout(style), ...(fill ? { fill } : {}), ...(radius !== undefined ? { cornerRadius: radius } : {}), children, metadata }
}

export function canvasToPen(doc: CanvasDocument): PenDocument {
  const right = Math.max(0, ...doc.layers.map(layer => (pixels(layer.style.left) ?? 0) + (pixels(layer.style.width) ?? 0))) + 200
  let y = 0
  const prefixed = (node: PenNode): PenNode => ({ ...node, id: componentPrefix + node.id, ...(node.children ? { children: node.children.map(prefixed) } : {}) })
  const components = doc.components.map(component => {
    const node = prefixed(toPen(component.layer, true))
    const placed = { ...node, reusable: true, x: right, y, metadata: { ...(node.metadata as object), type: componentKind, component: component.name } } as PenNode
    y += (pixels(component.layer.style.height) ?? 200) + 80
    return placed
  })
  return { version: PEN_VERSION, children: [...doc.layers.map(layer => toPen(layer, true)), ...components] }
}

type Reading = { variables: PenDocument['variables']; nodes: Map<string, PenNode>; skipped: string[]; ids: Set<string> }

function resolve(value: unknown, reading: Reading): unknown {
  if (typeof value !== 'string' || !value.startsWith('$')) return value
  const variable = reading.variables?.[value.slice(1)]
  if (!variable) return undefined
  return Array.isArray(variable.value) ? (variable.value[0] as { value?: unknown } | undefined)?.value : variable.value
}

function color(value: unknown, reading: Reading): string | undefined {
  const fill = Array.isArray(value) ? value[value.length - 1] : value
  const raw = resolve(typeof fill === 'object' && fill && (fill as { type?: string }).type === 'color' ? (fill as { color: unknown }).color : fill, reading)
  return typeof raw === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw) ? raw : undefined
}

const number = (value: unknown, reading: Reading) => { const raw = resolve(value, reading); return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined }

function uniqueID(raw: string, reading: Reading) {
  const base = (raw.replace(/[^A-Za-z0-9_-]/g, '_') || 'layer').slice(0, 56)
  let id = base, n = 1
  while (reading.ids.has(id)) id = `${base}_${++n}`
  reading.ids.add(id)
  return id
}

function expand(node: PenNode, reading: Reading): PenNode {
  if (node.type !== 'ref') return node
  const source = reading.nodes.get(String(node.ref))
  if (!source) { reading.skipped.push(`${node.name ?? node.id}: the component it copies is not in this file`); return { ...node, type: 'skip' } }
  const { ref: _ref, descendants: _descendants, reusable: _reusable, type: _type, ...overrides } = node
  return { ...expand(source, reading), ...overrides, metadata: overrides.metadata ?? source.metadata } as PenNode
}

function fromPen(input: PenNode, reading: Reading, top: boolean, parentLayout: string): CanvasLayer | undefined {
  const node = expand(input, reading)
  if (!plainPenNodes.has(node.type)) {
    if (node.type !== 'skip') reading.skipped.push(`${node.name ?? node.id} (${node.type})`)
    return undefined
  }
  const meta = node.metadata as { type?: string; tag?: string; style?: Record<string, string>; ownText?: boolean } | undefined
  const ours = meta?.type === layerKind || meta?.type === componentKind
  const style: Record<string, string> = ours && meta?.style ? { ...meta.style } : {}
  const set = (name: string, value: string | undefined) => { if (value === undefined) return; style[name] = value }
  const absolute = top || parentLayout === 'none' || node.layoutPosition === 'absolute'
  if (absolute && (typeof node.x === 'number' || typeof node.y === 'number')) {
    set('position', 'absolute')
    if (typeof node.x === 'number') set('left', Math.round(node.x) + 'px')
    if (typeof node.y === 'number') set('top', Math.round(node.y) + 'px')
  }
  const width = number(node.width, reading), height = number(node.height, reading)
  if (width !== undefined) set('width', Math.round(width) + 'px')
  if (height !== undefined) set('height', Math.round(height) + 'px')
  if (node.width === 'fill_container' || String(node.width).startsWith('fill_container')) { set('align-self', 'stretch'); if (parentLayout === 'horizontal') set('flex', '1') }
  const opacity = number(node.opacity, reading); if (opacity !== undefined) set('opacity', String(opacity))
  const id = uniqueID(node.id, reading)
  const name = String(node.name ?? node.id).slice(0, 120) || id
  if (node.type === 'text') {
    set('color', color(node.fill, reading))
    const size = number(node.fontSize, reading); if (size !== undefined) set('font-size', size + 'px')
    const weight = resolve(node.fontWeight, reading); if (typeof weight === 'string' || typeof weight === 'number') set('font-weight', String(weight))
    if (typeof node.textAlign === 'string') set('text-align', node.textAlign)
    const content = resolve(node.content, reading)
    return { id, name, tag: ours && meta?.tag ? meta.tag : 'p', text: typeof content === 'string' ? content : '', style, children: [] }
  }
  if (node.type === 'frame' || node.type === 'group') {
    const kind = node.type === 'group' ? 'none' : typeof node.layout === 'string' ? node.layout : 'horizontal'
    if (kind === 'none') { if (!ours) delete style.display } else {
      set('display', 'flex'); set('flex-direction', kind === 'vertical' ? 'column' : 'row')
      const gap = number(node.gap, reading); if (gap !== undefined) set('gap', gap + 'px')
      set('justify-content', cssJustify[String(node.justifyContent)])
      set('align-items', cssAlign[String(node.alignItems)])
    }
    const padding = Array.isArray(node.padding) ? node.padding.map(part => number(part, reading)) : [number(node.padding, reading)]
    if (padding.every(part => part !== undefined) && node.padding !== undefined) set('padding', padding.map(part => part + 'px').join(' '))
  }
  set('background-color', color(node.fill, reading))
  const radius = number(node.cornerRadius, reading)
  if (node.type === 'ellipse') set('border-radius', '50%'); else if (radius !== undefined) set('border-radius', radius + 'px')
  const childLayout = node.type === 'frame' ? (typeof node.layout === 'string' ? node.layout : 'horizontal') : 'none'
  let text: string | undefined
  const children: CanvasLayer[] = []
  for (const child of node.children ?? []) {
    const childMeta = child.metadata as { ownText?: boolean } | undefined
    if (childMeta?.ownText && child.type === 'text') { const content = resolve(child.content, reading); text = typeof content === 'string' ? content : ''; continue }
    const layer = fromPen(child, reading, false, childLayout)
    if (layer) children.push(layer)
  }
  return { id, name, tag: ours && meta?.tag ? meta.tag : 'div', ...(text !== undefined ? { text } : {}), style, children }
}

function collect(nodes: PenNode[], into: Map<string, PenNode>) {
  for (const node of nodes) { if (typeof node?.id === 'string') into.set(node.id, node); if (Array.isArray(node?.children)) collect(node.children, into) }
}

export function parsePen(text: string): PenDocument {
  let value: unknown
  try { value = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) } catch { throw new StudioError('INVALID_PEN_FILE', 'This .pen file is not plain JSON. Open it in pen.dev and save it again, or use the pencil MCP to read its frames.') }
  const doc = value as PenDocument
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.children)) throw new StudioError('INVALID_PEN_FILE', 'A .pen file has a version and a list of children.')
  return doc
}

export function penToCanvas(pen: PenDocument): PenImport {
  if (!pen || !Array.isArray(pen.children)) throw new StudioError('INVALID_PEN_FILE', 'A .pen file has a version and a list of children.')
  const reading: Reading = { variables: pen.variables, nodes: new Map(), skipped: [], ids: new Set() }
  collect(pen.children, reading.nodes)
  const layers: CanvasLayer[] = [], components: CanvasDocument['components'] = []
  const unprefixed = (node: PenNode): PenNode => ({ ...node, id: node.id.startsWith(componentPrefix) ? node.id.slice(componentPrefix.length) : node.id, ...(Array.isArray(node.children) ? { children: node.children.map(unprefixed) } : {}) })
  for (const node of pen.children) {
    const meta = node.metadata as { type?: string; component?: string; style?: Record<string, string> } | undefined
    if (meta?.type === componentKind) {
      const own: Reading = { ...reading, ids: new Set() }
      const layer = fromPen(unprefixed(node), own, true, 'none')
      if (!layer) continue
      const { position: _p, left: _l, top: _t, ...style } = layer.style
      for (const name of ['position', 'left', 'top']) if (meta.style?.[name] !== undefined) style[name] = meta.style[name]
      const name = String(meta.component ?? node.name ?? node.id)
      if (!components.some(item => item.name === name)) components.push({ name, layer: { ...layer, style } })
      continue
    }
    const layer = fromPen(node, reading, true, 'none')
    if (!layer) continue
    if (node.reusable) {
      const name = String(node.name ?? node.id)
      const { position: _p, left: _l, top: _t, ...style } = layer.style
      if (!components.some(item => item.name === name)) components.push({ name, layer: { ...layer, style } })
    }
    layers.push(layer)
  }
  return { document: validateCanvasDocument({ layers, components }), skipped: reading.skipped }
}

export function canvasAsPen(store: QuestStore, id: string): { revision: number; pen: PenDocument } {
  const canvas = readCanvas(store, id)
  return { revision: canvas.revision, pen: canvasToPen(canvas.document) }
}

export function canvasFromPen(store: QuestStore, input: { id: string; expectedRevision?: number; pen: unknown; mode?: 'replace' | 'add' }, updatedBy: CanvasEditor, session?: string): StudioCanvas & { skipped: string[] } {
  const pen = typeof input.pen === 'string' ? parsePen(input.pen) : input.pen as PenDocument
  const imported = penToCanvas(pen)
  const prior = readCanvas(store, input.id)
  let document = imported.document
  if (input.mode === 'add') {
    const taken = new Set<string>()
    const mark = (layers: CanvasLayer[]) => { for (const layer of layers) { taken.add(layer.id); mark(layer.children) } }
    mark(prior.document.layers)
    for (const component of prior.document.components) mark([component.layer])
    const rename = (layer: CanvasLayer): CanvasLayer => { let id = layer.id, n = 1; while (taken.has(id)) id = `${layer.id}_${++n}`; taken.add(id); return { ...layer, id, children: layer.children.map(rename) } }
    const names = new Set(prior.document.components.map(component => component.name))
    document = validateCanvasDocument({
      layers: [...prior.document.layers, ...document.layers.map(rename)],
      components: [...prior.document.components, ...document.components.filter(component => !names.has(component.name)).map(component => ({ ...component, layer: rename(component.layer) }))],
    })
  }
  const saved = saveCanvas(store, { id: input.id, expectedRevision: input.expectedRevision ?? prior.revision, document }, updatedBy, session)
  return { ...saved, skipped: imported.skipped }
}
