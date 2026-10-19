import { QuestStore } from '../store'
import { questRoot } from '../root.mts'
export { askModelRouter, registerModelRouterGenerator } from './model-router'
export type { ModelRouterHost, ModelRouterOption, ModelRouterQuestion, Judgment } from './model-router'
export function modelRouterRuntime() { return new QuestStore(questRoot()).runtime }
