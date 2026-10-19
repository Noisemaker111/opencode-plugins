export type StudioTarget = 'quest-card' | 'board-row' | 'result-card' | 'custom'
export type StudioFile = { path: string; content: string }
export type StudioDocument = { renderer: string; entry: string; files: StudioFile[] }
export type StudioPromotion = { state: 'preparing' | 'failed' | 'done'; revision: number; branch: string; checkout?: string; url?: string; error?: string }
export type StudioDraft = { target: StudioTarget; revision: number; updatedAt: string; document: StudioDocument; promotion?: StudioPromotion }
export type StudioDrafts = { drafts: StudioDraft[] }
export type SaveStudioDraft = { id: string; target: StudioTarget; expectedRevision: number; document: StudioDocument }
export type PromoteStudioDraft = { id: string; target: StudioTarget; revision: number; confirmed: true }

export type CanvasLayer = { id: string; name: string; tag: string; text?: string; style: Record<string, string>; children: CanvasLayer[] }
export type CanvasComponent = { name: string; layer: CanvasLayer }
export type CanvasDocument = { layers: CanvasLayer[]; components: CanvasComponent[] }
export type CanvasEditor = 'Jon' | 'worker'
export type StudioCanvas = { revision: number; updatedAt?: string; updatedBy?: CanvasEditor; session?: string; document: CanvasDocument }
export type SaveStudioCanvas = { id: string; expectedRevision: number; document: CanvasDocument }
export type CanvasEdit =
  | { op: 'move'; id: string; x: number; y: number }
  | { op: 'resize'; id: string; width: number; height: number }
  | { op: 'restyle'; id: string; style: Record<string, string | null> }
  | { op: 'text'; id: string; text: string }
  | { op: 'rename'; id: string; name: string }
  | { op: 'add'; parent?: string; layer: { id?: string; name: string; tag?: string; text?: string; style?: Record<string, string> } }
  | { op: 'remove'; id: string }
  | { op: 'component'; id: string; name: string }
  | { op: 'insert'; component: string; parent?: string; x?: number; y?: number }
export type CodeFromCanvas = { id: string; target: StudioTarget; layer?: string }

export type StudioVariationState = 'queued' | 'running' | 'ready' | 'failed' | 'picked' | 'discarded'
export type StudioVariation = { id: string; prompt: string; route?: string; runID?: string; state: StudioVariationState; updatedAt: string; note?: string; document?: StudioDocument }
export type StudioRenderer = 'html' | 'react' | 'rust' | 'go' | '7dtd'
export type StudioVariationOrigin = { set: string; variations: string[] }
export type StudioVariationSet = {
  id: string; thing: string; count: number; createdAt: string; askToPick?: boolean; askedAt?: string; variations: StudioVariation[]
  renderer?: StudioRenderer; direction?: string; questID?: string; questRef?: string; from?: StudioVariationOrigin; startError?: string
}
export type StudioVariations = { sets: StudioVariationSet[] }
export type AskToPick = { id: string; set: string; ask: boolean }
export type StartVariations = { id: string; thing: string; count: number; renderer: StudioRenderer; direction?: string; askToPick?: boolean }
export type DecideVariation = { id: string; set: string; variation: string; decision: 'picked' | 'discarded' | null }
export type IterateVariations = { id: string; set: string; variations: string[]; count: number; direction?: string; askToPick?: boolean }
