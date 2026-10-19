import { define } from '@opencode-ai/plugin/v2/promise'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { explicitDirectory, routerQuestInventory, routerWorker } from '../quest/router-public'
import { createGoalFacade } from '../quest/goal-public'
import { DiscoveryHost, RouterError, redact } from './host'
import { onlyProjectHolding, resolveTargets, requestedCheckout, verifyTarget, poolTarget, instructions, targetKey, RANKED_REASON, PROJECT_STANDS_OUT, type Target } from './resolution'
import { ABOUT_QUEST_GIVER } from './retrieve'
import { Onboarding } from './onboarding'
import { routeFeedback } from '../quest/route-public'
import {RouterMemory} from './memory'
import { goalCommand } from './goal-command'
import { modelRouterProjects, projectFolderRows, rankTargets, type RankContext } from './model-router'
import { registerModelRouterGenerator } from '../quest/routing/model-router-public'
import { automaticQuestPrompt } from '../quest/giver/giver-instruction'

import { projectAliasInput, projectResolveInput, schema as toolSchema, selectors as toolSelectors } from './tool-schemas.mjs'
import { firstDelivery } from '../scripts/first-delivery'
const string = { type: 'string', minLength: 1, maxLength: 2000 }
const selectors = toolSelectors
const schema = (properties: any, required: string[] = []) => toolSchema(properties, required)
export async function installProjectRouter(ctx: any, discovery = new DiscoveryHost(), dependencies: { modelRouter?: typeof modelRouterProjects } = {}) {
  if (!ctx.tool?.transform || !ctx.session?.create || !ctx.session?.get || !ctx.session?.prompt || !ctx.storage) throw new RouterError('HOST_CAPABILITY_MISSING', 'Project-router requires supported typed tools, session create/get/prompt and plugin storage')
  const memory=new RouterMemory(ctx.storage)
  registerModelRouterGenerator(ctx.generate?.text)
  const worker = (id: string) => routerWorker(id).length > 0
  const goals = createGoalFacade(ctx.session)
  const known = ()=>memory.known()
  const register = (targets:Target[])=>memory.register(targets)
  const modelRouter = dependencies.modelRouter ?? modelRouterProjects
  const discoveryRows = async (): Promise<{directory:string;hostID?:string}[]> => {
    const host = await discovery.projects(), seeds = routerQuestInventory().flatMap(q => q.project?.root ? [{ directory: q.project.root }] : [])
    return [...await known(), ...host.flatMap(h => [h, ...h.sandboxes.map(directory => ({ directory, hostID: h.hostID }))]), ...seeds]
  }
  const verifiedRows = (rows: {directory:string;hostID?:string}[]) => {
    const items: Target[] = [], unavailable: string[] = []
    for (const row of rows) { try { items.push({ ...poolTarget(row.directory), ...(typeof row.hostID === 'string' ? { hostID: row.hostID } : {}) }) } catch { unavailable.push(row.directory) } }
    return { items: [...new Map(items.map(t => [targetKey(t), t])).values()], unavailable }
  }
  const candidatePool = async () => {
    const parent = new Onboarding(typeof ctx.options?.projectParent === 'string' ? ctx.options.projectParent : undefined).parent
    return verifiedRows([...await discoveryRows(), ...projectFolderRows(parent)]).items
  }
  const quiet = (error: unknown) => redact(error instanceof Error ? error.message : String(error), 400)
  const sessionDirectory = async (sessionID: string) => {
    const session = await ctx.session.get({ sessionID }), directory = (session?.data ?? session)?.location?.directory
    return typeof directory === 'string' ? directory : undefined
  }
  const giverProject = async (sessionID: string): Promise<Target | undefined> => {
    try {
      const directory = await sessionDirectory(sessionID)
      if (!directory) return undefined
      const root = poolTarget(directory).root
      return existsSync(join(root, '.git')) ? poolTarget(root) : undefined
    } catch { return undefined }
  }
  const judgeRequest = async (request: string, items: Target[], context: RankContext, sessionID: string) => {
    try {
      const directory = await sessionDirectory(sessionID)
      if (!directory) { console.error('[project-router] no project judgment: the calling session reports no directory'); return undefined }
      return await modelRouter(ctx, directory, request, items, context)
    } catch (error) { console.error('[project-router] no project judgment:', quiet(error)); return undefined }
  }
  const rankedRequest = async (request: string, context: RankContext, extra: Target[]) => {
    try {
      const items = verifiedRows([...(await candidatePool()), ...extra]).items
      return { items, ranked: (await rankTargets(ctx.storage, items, request, context)).map(row => ({ ...row.target, score: Math.round(row.score * 100) / 100 })) }
    } catch (error) { console.error('[project-router] project ranking failed:', quiet(error)); return { items: [] as Target[], ranked: [] as Target[] } }
  }
  const operations: { name: string; description: string; input: any; execute: (input: any, context: any) => Promise<any> }[] = [
    { name: 'project_resolve', description: 'Resolve explicit paths/names/approved aliases. Pass request with the user\'s own words: the answer ranks the known projects by name, README and Quest history and, when the model router answers, carries a probability per ranked project. Pass the directory of the candidate that fits as create\'s projectRoot. Discussion creates no work; nothing here selects or launches.', input: projectResolveInput, execute: async (input, context) => {
      const aliases = await memory.aliases()
      const request = typeof input.request === 'string' ? input.request.trim() : ''
      const ranking = !!request && !input.discussion && !input.selectors?.some((s: string) => s.trim()) && !requestedCheckout(request)
      if (!ranking) return resolveTargets(aliases, await known(), input)
      const home = await giverProject(context.sessionID), registered = await known()
      const holding = onlyProjectHolding(request, registered)
      if (holding) return { state: 'resolved' as const, targets: [holding.target], reason: 'The only known project that holds ' + holding.paths.join(', ') }
      const rank: RankContext = { aliases, pinned: [...(home ? [home] : []), ...registered], ...(home ? { home } : {}) }
      const pool = await rankedRequest(request, rank, rank.pinned!)
      if (home && ABOUT_QUEST_GIVER.test(request) && pool.ranked[0]?.id === home.id) return { state: 'resolved' as const, targets: [home], reason: 'The request is about Quest Giver itself: the project the Quest Giver runs from' }
      const result = resolveTargets(aliases, registered, input, pool.ranked)
      const judged = await judgeRequest(request, pool.items, rank, context.sessionID)
      const top = judged?.candidates.reduce<(typeof judged.candidates)[number] | undefined>((best, row) => !best || row.probability > best.probability ? row : best, undefined)
      if (judged && top && top.probability >= PROJECT_STANDS_OUT) {
        const { probability: _probability, ...target } = top
        return { state: 'resolved' as const, targets: [target], reason: judged.reason, judged: { candidates: judged.candidates, reason: judged.reason, model: judged.model } }
      }
      const next = 'No project stands out yet: ask Jon with 2-4 of these candidates, then call project_resolve with selectors set to the directory he picks and create from that resolved target.'
      if (judged) return { ...result, judged: { candidates: judged.candidates, reason: judged.reason, model: judged.model }, next }
      return { ...result, reason: RANKED_REASON + '; the model router did not answer', next }
    } },
    { name: 'project_alias', description: 'Name a project checkout so project_resolve and ranking find it by that name: alias with directory saves it, alias with forget:true removes it. Aliases are shared by every conversation. Does not start work.', input: projectAliasInput, execute: async (input, context) => {
      if (worker(context.sessionID)) throw new RouterError('WORKER_DELEGATION_DENIED', 'Workers retain their assigned destination')
      const alias = String(input.alias).trim().toLowerCase()
      if (!alias || ['__proto__', 'constructor', 'prototype'].includes(alias)) throw new RouterError('INVALID_ALIAS', 'An alias is an ordinary name')
      if (input.forget === true) {
        if (input.directory !== undefined) throw new RouterError('INVALID_INPUT', 'Forget an alias by name alone; omit directory')
        await memory.alias(alias)
        return { alias, forgotten: true }
      }
      if (typeof input.directory !== 'string' || !input.directory.trim()) throw new RouterError('TARGET_REQUIRED', 'Name the absolute project directory the alias points to')
      const written = input.directory.trim(), target = verifyTarget(explicitDirectory(written) ?? written)
      if (!existsSync(join(target.root, '.git'))) throw new RouterError('PROJECT_NOT_A_CHECKOUT', target.root + ' is not a Git checkout, so no Quest could be created in it. Name the maintained source project.')
      await memory.alias(alias, target)
      await register([target])
      return { alias, target, next: 'project_resolve with selectors ["' + alias + '"] now resolves to ' + target.directory }
    } },
    { name: 'project_clone', description: 'Explicitly authorized safe repo-link onboarding. Reuses verified matching clones; preserves collisions/partial work; no repository scripts. URLs must be credential-free HTTPS/SSH.', input: schema({ url: string, authorized: { type: 'boolean' }, requestKey: string, retry: { type: 'boolean' } }, ['url', 'authorized', 'requestKey']), execute: async (input, context) => {
      if (worker(context.sessionID)) throw new RouterError('WORKER_DELEGATION_DENIED', 'Repo onboarding belongs to the giver')
      const onboarding = new Onboarding(typeof ctx.options?.projectParent === 'string' ? ctx.options.projectParent : undefined)
      const result = await onboarding.clone({ ...input, requestID: context.sessionID + ':' + input.requestKey, known: await known() })
      if (result.state === 'verified' && result.target) { instructions(result.target); await register([result.target]) }
      return result
    } },
    { name: 'project_route_status', description: 'Inspect automatic worker routing with no model argument, diagnose one exact worker selector, or request view:candidates for the configured choices. Chat model changes do not require this check. Does not reserve or launch.', input: schema({ model: string, view: { enum: ['candidates'] } }), execute: async (input, context) => ({ ...await routeFeedback(input.model, true, context?.sessionID, input.view), loadedModule: import.meta.url, hostVersion: ctx.app?.version ?? 'unknown', sourceVersusLoaded: 'This receipt identifies this loaded module only; existing sessions may retain an older generation. Open a fresh verified session after parent promotion.' }) },
    { name: 'project_verify', description: 'Giver binds a configured verification command to an assigned step with action=bind; action=run executes that exact contract in the actual destination/assigned workspace and attaches actual proof. Workers cannot change contracts.', input: schema({questID:string,stepID:string,commandID:string,action:{enum:['bind','run']}},['questID','stepID','commandID']),execute:async(input,context)=>goals.verify(input,{sessionID:context.sessionID,requestID:context.id??context.callID}) },
    { name: 'project_goal', description: 'Explicit canonical Quest goal start/status/pause/cancel/resume in your persistent giver or assigned worker session. Requires authorized step IDs. Restart requires explicit verified resume; never pursue historical backlog.', input: schema({ action: { enum: ['start', 'status', 'pause', 'cancel', 'resume'] }, questID: string, stepIDs: selectors,model:string }, ['action']), execute: async (input, context) => goals.control(input, { sessionID: context.sessionID, requestID: context.id ?? context.callID }) },
  ]
  await ctx.tool.transform((editor: any) => { for (const operation of operations) editor.add({ ...operation, output: { type: 'object', additionalProperties: true }, execute: async (input: any, context: any) => {
    if (!context?.sessionID || !(context.id ?? context.callID)) throw new RouterError('HOST_CONTEXT_REQUIRED', 'Trusted host session and tool call identity required')
    await ctx.session.get({ sessionID: context.sessionID })
    try {
      const result = await operation.execute(input, context)
      const content = JSON.stringify(Array.isArray(result) ? { items: result } : result)
      return { output: JSON.parse(content), content }
    }
    catch (error) { const output = { code: (error as any)?.code ?? 'ROUTER_FAILED', message: redact(error instanceof Error ? error.message : 'Router failed'), action: 'Inspect this bounded result; do not retry unknown launches or substitute routes' }; return { output, content: JSON.stringify(output) } }
  } }) })
  const intakePrompt = (goal: string) => [
    `Jon stated this goal: ${goal}`,
    '',
    'File it as a Quest and start it, in this turn:',
    '  1. Create the Quest with projectRoot: a path he named, or the directory of the candidate',
    '     project_resolve returns for request set to his words. The title names the outcome, not the',
    '     activity, and says what this one owns that a sibling does not. The objective opens with the',
    '     goal itself; his words go after it, not first.',
    '  2. Give it steps that name the work of this task and the result each one is checked against.',
    '     Never Implementation / Verification / Integration.',
    '  3. Run the first step, choosing the route on merit. Ask him with 2-4 project options only when',
    '     no candidate stands out.',
    '',
    'Reply with the Quest id, its title, its steps, and what you dispatched. If the goal is too vague',
    'to write steps for, say exactly what you need to know instead of guessing.',
  ].join(String.fromCharCode(10))

  await ctx.command?.transform((editor: any) => editor.add({ name: 'goal', description: 'State a goal and it becomes a Quest and starts; or start <quest> <step...>, status, pause, cancel, resume', execute: async ({ sessionID, prompt }: any) => {
    const asked = goalCommand(prompt.text)
    if (asked.kind === 'intake') {
      await ctx.session.synthetic({ sessionID, text: intakePrompt(asked.goal), description: 'Goal: ' + asked.goal, metadata: { projectRouterGoal: true } })
      return
    }
    const request = asked.kind === 'status' ? { action: 'status' } : { action: asked.action, questID: asked.questID, stepIDs: asked.stepIDs }
    const result = await goals.control(request as any, { sessionID, requestID: 'goal-command:' + (prompt.id ?? crypto.randomUUID()) })
    await ctx.session.synthetic({ sessionID, text: JSON.stringify(result), metadata: { projectRouterGoal: true } })
  } }))
  await ctx.session.hook?.('prompt',async(event:any)=>{if(!automaticQuestPrompt(event.metadata))await goals.steer(event.sessionID)})
  const abort=new AbortController()
  if(ctx.event?.subscribe)void(async()=>{try{const stream=await ctx.event.subscribe({signal:abort.signal});goals.trigger('live');for await(const event of stream){
    if(!/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type))continue
    const data=event.data??event.properties??{},id=event.id??data.executionID
    if(typeof data.sessionID==='string'&&typeof id==='string'&&firstDelivery('project-router.goals',event)){
      await goals.event(data.sessionID,id,event.type==='session.execution.succeeded')
    }
  }goals.trigger('ended')}catch{goals.trigger('failed')}})()
  return () => {abort.abort();goals.dispose()}
}
export default define({ id: 'project-router', setup: installProjectRouter })
