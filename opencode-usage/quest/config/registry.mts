type Page = { path: string; note: string; preference: boolean }
export type RoleDef = { label: string; note: string; evaluation?: boolean; effortRequired?: boolean; actor?: string; page?: Page }

export const ROLE_DEFS = {
  giver: { label: 'Quest Giver', note: 'Plans Quests and dispatches workers. You talk to it directly. Applies to the next Quest Giver conversation.' },
  worker: { label: 'Worker', note: 'Does each step. Unset, routing picks per step.', effortRequired: true },
  'model-router': {
    label: 'Model router', note: 'Ranks routes and infers work type and depth.', evaluation: true,
    page: { path: '/s/quest/api/model-router', note: "Picks each worker's model and project.", preference: true },
  },
  'permission-jev': {
    label: 'Permission (Jev)', note: 'Decides worker permission requests.', evaluation: true, actor: 'jev',
    page: { path: '/s/quest/api/permission-jev', note: "Workers read any file or folder on this machine without an ask; secret files are always refused. Jev allows or rejects every other worker request once, and the worker is told why; if Jev gives no decision, the request stays pending and is asked again, and nothing is granted or refused for a Jev failure. Protected or forced pushes, deploys and deletes outside the checkout are always refused. Nothing waits for you. With no model of its own it uses the model router's.", preference: false },
  },
} as const satisfies Record<string, RoleDef>

export type RoleName = keyof typeof ROLE_DEFS
export type PageRoleName = { [role in RoleName]: (typeof ROLE_DEFS)[role] extends { page: Page } ? role : never }[RoleName]

export const ROLES = Object.keys(ROLE_DEFS) as RoleName[]
const roleDef = (role: RoleName): RoleDef => ROLE_DEFS[role]
export const EVALUATION_ROLES = ROLES.filter(role => roleDef(role).evaluation)
export const EFFORT_REQUIRED_ROLES = ROLES.filter(role => roleDef(role).effortRequired)
export const PAGE_ROLES = ROLES.filter((role): role is PageRoleName => 'page' in ROLE_DEFS[role])
export const RETIRED_NAMES: Record<string, string | null> = {
  scout: null, advisor: null, helper: null, errand: null, efficiency: null, reviewer: null,
  allower: 'permission-jev', judge: 'model-router',
}
export const currentName = (name: string): string | null => Object.hasOwn(RETIRED_NAMES, name) ? RETIRED_NAMES[name] : name
const NON_ROLE_ACTORS = ['user', 'rule', 'fast'] as const
type RoleActor = { [role in RoleName]: (typeof ROLE_DEFS)[role] extends { actor: infer actor } ? actor : never }[RoleName]
export type ActorName = (typeof NON_ROLE_ACTORS)[number] | RoleActor
export const ACTORS = [...NON_ROLE_ACTORS, ...ROLES.flatMap(role => roleDef(role).actor ?? [])] as ActorName[]
export const currentActor = (name: string): ActorName | null => {
  if ((ACTORS as string[]).includes(name)) return name as ActorName
  const role = currentName(name)
  const actor = role === null ? undefined : (ROLE_DEFS as Record<string, RoleDef>)[role]?.actor
  return (actor ?? null) as ActorName | null
}

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE'
export const QUEST_ROUTES = {
  web: { method: 'GET', path: '/web' },
  health: { method: 'GET', path: '/health', outside: true },
  capabilities: { method: 'GET', path: '/capabilities', outside: true },
  events: { method: 'GET', path: '/events', outside: true },
  contract: { method: 'GET', path: '/contract' },
  giverSettings: { method: 'GET', path: '/api/giver/settings' },
  saveGiverSettings: { method: 'PUT', path: '/api/giver/settings' },
  questCategories: { method: 'GET', path: '/api/quest-categories' },
  saveQuestCategory: { method: 'PUT', path: '/api/quest-categories' },
  questLimits: { method: 'GET', path: '/api/quest-limits' },
  saveQuestLimits: { method: 'PUT', path: '/api/quest-limits' },
  questMode: { method: 'GET', path: '/api/quest-mode' },
  saveQuestMode: { method: 'PUT', path: '/api/quest-mode' },
  permissionSecretFiles: { method: 'GET', path: '/api/permission-secret-files' },
  approvedCommands: { method: 'GET', path: '/api/approved-commands' },
  removeApprovedCommand: { method: 'DELETE', path: '/api/approved-commands' },
  modelRouterHealth: { method: 'GET', path: '/api/model-router-health' },
  modelRouter: { method: 'GET', path: '/api/model-router' },
  saveModelRouter: { method: 'PUT', path: '/api/model-router' },
  permissionJev: { method: 'GET', path: '/api/permission-jev' },
  savePermissionJev: { method: 'PUT', path: '/api/permission-jev' },
  newGiver: { method: 'POST', path: '/api/giver/new' },
  recoverGiver: { method: 'POST', path: '/api/giver/recover' },
  giverModel: { method: 'POST', path: '/api/giver/model' },
  webQuests: { method: 'GET', path: '/api/web/quests' },
  webUsage: { method: 'GET', path: '/api/web/usage' },
  studioDrafts: { method: 'GET', path: '/api/studio/drafts' },
  saveStudioDraft: { method: 'PUT', path: '/api/studio/drafts' },
  promoteStudioDraft: { method: 'POST', path: '/api/studio/promote' },
  studioVariations: { method: 'GET', path: '/api/studio/variations' },
  startStudioVariations: { method: 'POST', path: '/api/studio/variations' },
  askStudioVariations: { method: 'PUT', path: '/api/studio/variations/ask' },
  decideStudioVariation: { method: 'POST', path: '/api/studio/variations/decide' },
  iterateStudioVariations: { method: 'POST', path: '/api/studio/variations/iterate' },
  studioCanvas: { method: 'GET', path: '/api/studio/canvas' },
  saveStudioCanvas: { method: 'PUT', path: '/api/studio/canvas' },
  studioCanvasCode: { method: 'POST', path: '/api/studio/canvas/code' },
  studioCanvasPen: { method: 'GET', path: '/api/studio/canvas/pen' },
  importStudioCanvasPen: { method: 'POST', path: '/api/studio/canvas/pen' },
} satisfies Record<string, { method: Method; path: string; outside?: boolean }>

export type QuestRouteName = keyof typeof QUEST_ROUTES
const ROUTE_NAMES = Object.keys(QUEST_ROUTES) as QuestRouteName[]
export const matchQuestRoute = (method: string, pathname: string) => ROUTE_NAMES.find(name => QUEST_ROUTES[name].method === method && QUEST_ROUTES[name].path === pathname)
export const OPERATION_PATH = '/api'
export const operationPath = (name: string) => OPERATION_PATH + '/' + name
export const operationFrom = (pathname: string) => new RegExp('^' + OPERATION_PATH + '/([A-Za-z_]+)$').exec(pathname)?.[1]
export const READ_PATH = '/read'
export const readOperationPath = (name: string) => READ_PATH + '/' + name
export const readOperationFrom = (pathname: string) => new RegExp('^' + READ_PATH + '/([a-z_]+)$').exec(pathname)?.[1]
export const QUEST_MCP_PATH = '/mcp'
export const mcpSessionPath = (id: string) => QUEST_MCP_PATH + '/session/' + id
export const mcpSessionFrom = (pathname: string) => new RegExp('^' + QUEST_MCP_PATH + '/session/([a-f0-9-]+)$').exec(pathname)?.[1]
const questRoute: (name: QuestRouteName) => { method: Method; path: string; outside?: boolean } = name => QUEST_ROUTES[name]
export const outsidePath = (pathname: string) => pathname.startsWith(READ_PATH + '/') || ROUTE_NAMES.some(name => questRoute(name).outside && questRoute(name).path === pathname)
