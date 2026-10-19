import type { ServedModelsDraft } from "./served-models"

type ListDomain = { list: () => Promise<unknown> }
type ModelEditor = ServedModelsDraft["model"] & { readonly provider: ServedModelsDraft["provider"] }
type ModelDomain = ListDomain & { transform?: (callback: (editor: ModelEditor) => void) => Promise<unknown>; reload?: () => Promise<unknown> }
export type HostCatalog = { model: ListDomain; provider: ListDomain; transform?: (callback: (draft: ServedModelsDraft) => void) => Promise<unknown>; reload?: () => Promise<unknown> }
export type CatalogHost = { catalog?: HostCatalog; model?: ModelDomain; provider?: ListDomain }

export function hostCatalog(ctx: CatalogHost): HostCatalog | undefined {
  if (ctx.catalog) return ctx.catalog
  const model = ctx.model, provider = ctx.provider
  if (!model || !provider) return undefined
  return {
    model, provider,
    ...(model.transform ? { transform: (callback: (draft: ServedModelsDraft) => void) => model.transform!(editor => callback({ provider: editor.provider, model: editor })) } : {}),
    ...(model.reload ? { reload: () => model.reload!() } : {}),
  }
}