import "./host-hooks"
import {getUsagePacing} from "./portfolio-pacing"
import { accountRegime } from "./calibration-store"
import { setUsageTarget } from "./usage-target"
import { getAccountUsage } from "../usage-service/on-computer"
import { getUsageStatus, getUsageDetail, formatUsageStatus, formatUsageDetail, USAGE_DETAIL_VIEWS, USAGE_VIEW_CONTRACT, type UsageDetailQuery, type UsageDetailView } from "./status-api"
import type { ExperienceQuery } from "./experience"
import { getUsageExperience } from "./experience-api"
import { workerTime, formatWorkerTime, type WorkerTimeQuery } from "./worker-time"
import { compactUsage } from "./compact-answers"
import { answerText, FULL_INPUT } from "../quest/interfaces/answer-shape"
import { budgetPicture, formatBudget } from "./session-budget"
import { fixedPrefixPicture, formatFixedPrefix, type FixedPrefixQuery } from "./fixed-prefix"
import { QuestStore } from "../quest/store"
import { questRoot } from "../quest/root.mts"

export type UsageOperation = {
  name: string
  description: string
  input: Record<string, any>
  output: Record<string, any>
  execute: (input: any, context?: { sessionID?: string }) => Promise<{ output: any; content: string }>
}

function operations(): UsageOperation[] {
    const result: UsageOperation[] = []
    const draft = { add: (operation: UsageOperation) => result.push(operation) }
      draft.add({name:"usage_experience",description:"Read-only usage evidence: observed quota, independent request activity, coverage/gaps/reset epochs, source freshness and next safe action. Exact cached accountID required. Summary is compact; timeline and requests are bounded chronological pages. Optional resetAt plus regime selects a historical quota epoch; timezone is explicit IANA (default UTC). Sources may overlap; missing account bindings are never inferred. Desired slots are not runnable grants. No refresh, target/policy writes, forecasts or launches.",input:{type:"object",additionalProperties:false,required:["accountID"],properties:{accountID:{type:"string",minLength:1,maxLength:200},windowID:{type:"string",minLength:1,maxLength:200},resetAt:{type:"number"},regime:{type:"string",maxLength:200},view:{type:"string",enum:["summary","timeline","requests"]},source:{type:"string",enum:["opencode","codex","opencode-host"]},sessionID:{type:"string",maxLength:200},from:{type:"number"},to:{type:"number"},offset:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:100},timeZone:{type:"string",maxLength:100}}},output:{type:"object",additionalProperties:true},execute:async(input:ExperienceQuery)=>{const json=JSON.stringify(getUsageExperience(input));return {output:JSON.parse(json),content:json}}})
      draft.add({name:"usage_pacing",description:"Compact scheduler-facing burn status across subscriptions: separate balances/resets, required versus measured pace, desired slots and blocking constraints. Use this for ongoing Quest pacing; each account also shows every channel (beta and stable) on this computer: its in-flight runs, reserved points and requests this window, all counted against the same account windows. usage_status supplies detailed token accounting. Does not launch work or enable a target.",input:{type:"object",additionalProperties:false,properties:{refresh:{type:"boolean"},accountID:{type:"string"}}},output:{type:"object",additionalProperties:true},execute:async(input:{refresh?:boolean;accountID?:string})=>{const result=await getUsagePacing(input);if(input.accountID&&!result.accounts.length)throw Error("Account not found in current connections");const json=JSON.stringify(result);return {output:JSON.parse(json),content:json}}})
      draft.add({name:"usage_target",description:"Save or clear an account's burn deadline and reserve. Shared across sessions and reloaded automatically by passive usage planning. Optional pacing explicitly permits bounded concurrent subscription work for authorized Quest runs, even without per-task calibration; it creates no work and preserves existing exclusive holds.",input:{type:"object",additionalProperties:false,required:["accountID","deadlineAt"],properties:{accountID:{type:"string",minLength:1},followResets:{type:"boolean",description:"Explicitly renew pacing after each fresh reset of this same account, plan and pool. Requires questPacing and deadlineAt equal to the current observed reset."},deadlineAt:{type:["number","null"],description:"Future Unix milliseconds; null clears the target."},reservePoints:{type:"number",minimum:0,maximum:100},questPacing:{type:"object",additionalProperties:false,required:["windowID","maxConcurrent"],properties:{windowID:{type:"string",minLength:1},maxConcurrent:{type:"integer",minimum:1,maximum:16}}}}},output:{type:"object",additionalProperties:true},execute:async(input:{accountID:string;deadlineAt:number|null;reservePoints?:number;followResets?:boolean;questPacing?:{windowID:string;maxConcurrent:number}})=>{const accounts=await getAccountUsage();const account=accounts.accounts.find(a=>a.id===input.accountID);if(!account)throw Error("Account not found in current connections");const window=input.questPacing?account.windows.find(w=>w.id===input.questPacing!.windowID):undefined;if(input.questPacing&&(!window||window.scope!=="shared"||!window.resetAt||Date.parse(window.resetAt)<=Date.now()))throw Error("Pacing requires a current shared account pool");const target=setUsageTarget(input.accountID,input.deadlineAt,input.reservePoints,undefined,Date.now(),input.questPacing?{...input.questPacing,regime:accountRegime(account),resetAt:Date.parse(window!.resetAt!)}:undefined,input.followResets);return {output:{target},content:JSON.stringify({target})}}})
      draft.add({
        name: "usage_status",
        output: { type: "object", additionalProperties: true },
        description: "Preferred global API for accounts, plans, quotas and resets. Call directly from tools/code mode in any project; no shell or config-repo cwd needed. Reuses logins and a shared cache. Use format=json; stale/unknown values are explicit. The default answer is a digest whose size does not depend on how much history the machine holds: every discovered account with its plan, scoped quota windows, used/remaining percentages, absolute resets, freshness and errors; pacing with separate per-account balances, required versus measured rate and requested slots; this conversation's own request and token counters; and collector freshness. History lives behind view: requests, sessions, timeline, pools (allowance calibration and chronologically tested residuals against a 0.01 percentage-point target, needs accountID), models, workloads (supply exact routes, explicit serviceTier and per-request token mixes; session counts alone are insufficient), harvest (local Codex rollout counters, supplemental, never added to OpenCode totals). Each view returns one page sized by offset/limit and reports total and nextOffset. Published credits are not included-plan percentages. Check all shared/model pools and refresh as work proceeds; never use Spark reset as an Astra reset.",
        input: {
          type: "object",
          properties: {
            view: { type: "string", enum: [...USAGE_DETAIL_VIEWS], description: "Ask for one detail page instead of the digest. Omit for the digest." },
            allSessions: {type:"boolean",description:"Count every captured session instead of defaulting to this conversation."},
            deadlineAt: {type:"number",description:"Optional future Unix-millisecond target; takes precedence over the saved account target. Planning stops at the earlier of this deadline and each pool reset."},
            reservePoints: { type: "number", minimum: 0, maximum: 100, description: "Percentage points to leave unused in each pool; default 0." },
            workloads: { type: "array", maxItems: 20, description: "Independent workload alternatives for view=workloads, not a combined dispatch plan.", items: {
              type: "object", additionalProperties: false, required: ["label","accountID","route","requests","tokens"], properties: {
                label: { type: "string", minLength: 1 }, accountID: { type: "string", minLength: 1 }, requests: { type: "integer", minimum: 1, maximum: 1000000 },
                route: { type: "object", additionalProperties: false, required: ["providerID","modelID"], properties: {
                  providerID: {type:"string"}, modelID: {type:"string"}, reasoning: {type:"string"}, variant: {type:"string"}, harness: {type:"string"}, serviceTier: {type:"string"}
                } },
                tokens: { type: "object", additionalProperties: false, required: ["input","cacheRead","outputIncludingReasoning"], properties: {
                  input: {type:"number",minimum:0,maximum:1e9}, cacheRead: {type:"number",minimum:0,maximum:1e9}, outputIncludingReasoning: {type:"number",minimum:0,maximum:1e9}
                } }
              }
            } },
            refresh: { type: "boolean", description: "Ask the providers now instead of reading the shared cache, respecting in-flight work and provider backoff." },
            format: { type: "string", enum: ["text", "json"], description: "JSON returns account IDs, plan tiers, scoped windows, reset timestamps, freshness and errors." },
            accountID: { type: "string", description: "Optional exact account ID from a previous result." },
            sessionID: { type: "string" }, questID: { type: "string" }, includeWorkers: { type: "boolean" },
            source: { type: "string", enum: ["opencode", "opencode-host", "codex"], description: "Capture source; default opencode. Sources can describe the same request and are never added together." },
            providerID: { type: "string" }, modelID: { type: "string" },
            from: { type: "number", description: "Start time in Unix milliseconds." }, to: { type: "number", description: "End time in Unix milliseconds." },
            offset: { type: "integer", minimum: 0, description: "First row of the requested view's page." }, limit: { type: "integer", minimum: 1, maximum: 100, description: "Rows in the requested view's page; default 25." },
          },
          required: [], additionalProperties: false,
        },
        execute: async (input: UsageDetailQuery & { format?: string; view?: UsageDetailView }, context?: { sessionID?: string }) => {
          const query = { ...input, sessionID: input.allSessions ? undefined : input.sessionID ?? context?.sessionID }
          const result = input.view ? await getUsageDetail({ ...query, view: input.view }) : await getUsageStatus(query)
          if (input.accountID && !input.view && !(result as any).accounts.length) throw new Error("Account not found in current connections.")
          const json = JSON.stringify(result)
          return { output: JSON.parse(json), content: input.format === "json" ? json : input.view ? formatUsageDetail(result as any) : formatUsageStatus(result as any) }
        },
      })
      draft.add({ name: "usage_worker_time", description: "Where each worker run's time went, and the same aggregated by route, by work type and by role (worker, or bench for a finished run run again on another route): wall time from the run's start to its end; model time with first-token and generation time from the request ledger; tool time by kind (read, search, shell, edit, mcp, other) from the host's record of the worker session's tool calls; the unattributed rest; tokens by kind, request count and cost. Runs come from the Quest outcome ledger. Read-only.",
        input: { type: "object", additionalProperties: false, properties: { runID: { type: "string", minLength: 1 }, sessionID: { type: "string", minLength: 1 }, from: { type: "number", description: "Runs started at or after this Unix millisecond time." }, to: { type: "number", description: "Runs started at or before this Unix millisecond time." }, format: { type: "string", enum: ["text", "json"] } } },
        output: { type: "object", additionalProperties: true },
        execute: async (input: WorkerTimeQuery) => { const result = workerTime(input); const json = JSON.stringify(result); return { output: JSON.parse(json), content: input.format === "json" ? json : formatWorkerTime(result) } } })
      draft.add({ name: "usage_budget", description: "What used the budget: each account's share of its weekly allowance (100% is the whole 7-day window, the 5-hour window beside it) by role (front, Quest Giver, worker, bench, Claude Code, Codex) and by session, to two decimals, with tokens by kind, the measured tokens per percent and its confidence. answer holds one plain sentence per account to tell the user. Read-only.",
        input: { type: "object", additionalProperties: false, properties: { format: { type: "string", enum: ["text", "json"] } } },
        output: { type: "object", additionalProperties: true },
        execute: async (input: { format?: string }) => { const store = new QuestStore(questRoot()); const result = budgetPicture({ projectRoot: store.projectRoot, runtime: store.runtime }); const json = JSON.stringify(result); return { output: JSON.parse(json), content: input.format === "json" ? json : formatBudget(result) } } })
      draft.add({ name: "usage_fixed_prefix", description: "The fixed starting context per role (Quest Giver, worker, bench, Claude Code, Codex, other) from the usage ledger: the system sections and tool definitions each session sends before any chat, their token sizes, how many distinct versions each section has across the role's sessions (more than one cannot be cache-read across sessions), which sections are identical across roles, and the cache write and cache read of each role's first requests and of all its requests. Defaults to the last 24 hours. Read-only.",
        input: { type: "object", additionalProperties: false, properties: { from: { type: "number", description: "Unix milliseconds; default 24 hours ago." }, to: { type: "number", description: "Unix milliseconds; default now." }, format: { type: "string", enum: ["text", "json"] } } },
        output: { type: "object", additionalProperties: true },
        execute: async (input: FixedPrefixQuery & { format?: string }) => { const store = new QuestStore(questRoot()); const result = fixedPrefixPicture({ projectRoot: store.projectRoot, runtime: store.runtime }, input); const json = JSON.stringify(result); return { output: JSON.parse(json), content: input.format === "json" ? json : formatFixedPrefix(result) } } })
    const status = result.find(operation => operation.name === "usage_status")!
    const paging = { offset: status.input.properties.offset, limit: status.input.properties.limit }
    const small = (operation: UsageOperation, ownPaging = false) => {
      const execute = operation.execute
      operation.input = { ...operation.input, properties: { ...operation.input.properties, ...(ownPaging ? paging : {}), full: FULL_INPUT } }
      operation.execute = async (input = {}, context) => {
        const { full, ...query } = input
        const own = ownPaging ? Object.fromEntries(Object.entries(query).filter(([key]) => key !== "offset" && key !== "limit")) : query
        const answer = await execute(own, context)
        if (full === true) return answer
        const compact = compactUsage(operation.name, query, answer.output)
        return compact ? { output: compact, content: query.format === "json" ? JSON.stringify(compact) : answerText(compact) } : answer
      }
    }
    small(status)
    small(result.find(operation => operation.name === "usage_pacing")!, true)
    small(result.find(operation => operation.name === "usage_worker_time")!)
    for (const view of USAGE_DETAIL_VIEWS) {
      const { answers, inputs, required = [] } = USAGE_VIEW_CONTRACT[view]
      const properties = Object.fromEntries([...inputs, "format", "full"].map(name => [name, status.input.properties[name]]))
      result.push({ ...status, name: `usage_${view}`, description: answers + " Same as usage_status with view=" + view + ".",
        input: { ...status.input, properties, required }, execute: (input, context) => status.execute({ ...input, view }, context) })
    }
    result.push({ name: "usage_accounts", description: "Read connected accounts, plans, quota windows and freshness from the shared account usage API.",
      input: { type: "object", additionalProperties: false, properties: { refresh: status.input.properties.refresh } },
      output: { type: "object", additionalProperties: true },
      execute: async input => { const output = await getAccountUsage(input); return { output, content: JSON.stringify(output) } } })
    small(result.at(-1)!, true)
    result.push({ name: "usage_capabilities", description: "Describe the Usage operation catalog and its input/output schemas. This describes API capabilities, not model routing eligibility.",
      input: { type: "object", additionalProperties: false, properties: {} }, output: { type: "object", additionalProperties: true },
      execute: async () => { const output = { operations: result.map(({ execute, ...operation }) => operation) }; return { output, content: JSON.stringify(output) } } })
    return result
}

export const usageOperations = operations()
