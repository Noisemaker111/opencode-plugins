import type { HousekeepingAction } from "./landing/landing-step"
import type { ActorName } from "./config/registry.mts"
export const QUEST_SCHEMA = "opencode.quest/v1" as const
export const QUEST_STATES = ["Working", "Waiting", "Needs attention", "Ready to complete", "Complete", "Archived"] as const
export type QuestState = typeof QUEST_STATES[number]
export type TerminalSessionState = "completed" | "failed" | "cancelled" | "missing" | "stale"
export type SessionState = "planned" | "executing" | "waiting" | "blocked" | TerminalSessionState

export type QuestRelationship = {
  parents: string[]; subquests: string[]; dependencies: string[]; supersedes: string[]
  supersededBy?: string; duplicateOf?: string; mergedFrom: string[]; splitFrom?: string
}
export type Deliverable = { id: string; title: string; status: "pending" | "working" | "blocked" | "done"; evidence?: string[] }
export type AcceptanceCriterion = { id: string; text: string; satisfied: boolean; evidence?: string[] }
export type SessionDependency = {
  sessionID: string; file: string; reason: string
  status: "blocked" | "resuming" | "resumed" | "failed"
  resumeKey: string; resumeCount: number; resumedAt?: string; resumeLeaseExpiresAt?: string
}
export type QuestSession = {
  sessionRef?: string; sessionTitle?: string; requestKey?: string
  callID: string; taskID?: string; sessionID?: string; parentID?: string; role: string; model?: string; harness?: string; branch?: string; worktree?: string
  agentRole?: string; providerID?: string; modelID?: string; runtime?: "native"; openCodeSessionId?: string; runtimeSessionId?: string; runID?: string; task?: string
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max"
  generation?: string
  fast?: boolean
  scope?: Record<string, unknown>; dependency?: SessionDependency
  parentSessionID?: string; openCodeSessionID?: string; harnessSessionID?: string; taskDescription?: string
  state: SessionState; evidence: string[]; deliverables: string[]; attempt: number; resumedFrom?: string; resumeRoot?: string
  updatedAt: string; startedAt?: string; lastHeartbeatAt?: string; leaseExpiresAt?: string; commandSummary?: string; result?: string; routingNote?:string; expectedFinishMs?: number
  quotaExhausted?: boolean
  refusalReplied?: boolean
  awaiting?: { requestID: string; ask: string; reason?: string; at: string }
  permissionDecisions?: Array<{requestID:string;requestKey?:string;request?:{id:string;sessionID:string;action:string;resources:string[];save?:string[];source?:Record<string,unknown>;metadata?:Record<string,unknown>;message?:string};reply:"once"|"reject";state:"sending"|"acknowledged"|"unknown";actor:ActorName;model?:string;jevCall?:{sessionID:string};reason:string;at:string}>
}
export type FileClaim = { sessionID?: string; repo: string; worktree?: string; include: string[]; exclude: string[]; state: "active" | "released" }
export type QuestStageStatus = "pending" | "working" | "blocked" | "done"
export type NeedsJon = "sign-in" | "spend" | "main-release" | "destructive" | "choice"
export const NEEDS_JON_RENAMED: Record<string, NeedsJon> = { "stable-release": "main-release" }
export type QuestTodo = { id: string; title: string; status: QuestStageStatus; evidence?: string[] }
export type QuestProof = {
  id: string; kind: "command" | "run" | "judgment"; at: string; attempt: number
  result?: "passed" | "failed"; command?: string; artifact?: string; verified?: boolean
  verdict?: "PASS" | "FAIL"; reason?: string; rewindTo?: string
}
export type StepBlocker = { kind: "environment" | "dependency" | "permission" | "work" | "unknown"; owner: string; requires: string }
export type BlockerResolution = { evidence: string }
export type QuestStage = {
  blocker?: StepBlocker
  resolution?: BlockerResolution
  id: string; title: string; commandID?: string; note?: string; noteAt?: string; detail?: string; status: QuestStageStatus; needs: string[]; todos: QuestTodo[]
  depth?: "routine" | "standard" | "deep" | "frontier"
  workType?: string
  attempts?: number | string[]
  needsJon?: NeedsJon
  deferred?: { at: string; until: "parent-done" | "jon" }
  housekeeping?: HousekeepingAction
  result?: QuestResult
  claim: { repos: string[]; include: string[]; exclude: string[] }
  proofs: QuestProof[]; attempt: number
}
export type QuestSetback = { stageID: string; proofID: string; verdict: "FAIL"; reason: string; attempt: number; at: string; rewindTo?: string }
export type QuestArtifactRef = {
  name: string
  path?: string
  uri?: string
  label?: string
  revision?: number
  at?: string
  digest?: string
  verified: boolean
}
export type Evidence = {
  commits: Array<{ repo: string; hash: string; worktreeHead?: string; verified: boolean }>
  tests: Array<{ command: string; result: "passed" | "failed"; at: string; summary?: string; stepID?: string; runID?: string; artifact?: string; exitCode?: number; reportedState?: "pending" | "working" | "blocked" | "done" }>
  builds: Array<{ name: string; result: "passed" | "failed"; at: string }>
  artifacts: QuestArtifactRef[]
  publish: Array<{ target: string; result: "succeeded" | "failed" | "credentials-limitation"; at: string }>
  review?: { verdict: "BLOCK" | "CONCERNS" | "CLEAN"; at: string; evidence?: string }
}
export type MigrationRecord = { sourcePath: string; line: number; start: number; end: number; raw: string; sha256: string; disposition: string }
export type QuestHistory = { eventID: string; at: string; type: string; lifecycleEpoch: number; summary: string }
export type CompletionPolicy = {
  requireSessions: boolean; requireCommits: boolean; requireTests: boolean; requireReview: boolean
  requireArtifacts: boolean; requirePublish: boolean; requireWorktreeEquality: boolean
}

export type QuestResult = { summary: string; howToUse: string; where: string }
export type QuestDelivered = { at: string; where: string }

export type QuestRequest = { messageID: string; text: string; at: string; unattributed?: true; context?: true; origin?: import('./core/history-origin').HistoryOrigin }

export type Quest = {
  contractVersion?: 2; description?: string; reward?: string; request?: QuestRequest[]
  project?: { id: string; root: string }
  archive?: { at: string; reason?: string; accepted: boolean; automatic?: boolean; kind?: string }
  result?: QuestResult; delivered?: QuestDelivered
  schema: typeof QUEST_SCHEMA; id: string; ref?: string; revision: number; lifecycleEpoch: number; createdAt: string; updatedAt: string
  title: string; objective: string; kind: "feature" | "fix" | "investigation" | "migration" | "multi-session" | "legacy"
  priority: "low" | "normal" | "high" | "urgent"; state: QuestState; reason: string; nextAction: string
  executingCount: number; executionChangedAt?: string; owner?: string; integrationOwner?: string; requestFingerprint?: string
  scope: { blastRadius: string; risk: "low" | "medium" | "high"; repos: string[]; include: string[]; exclude: string[] }
  relationships: QuestRelationship; deliverables: Deliverable[]; acceptanceCriteria: AcceptanceCriterion[]; usageInstructions: string[]
  stages: QuestStage[]; setbacks: QuestSetback[]
  sessions: QuestSession[]; claims: FileClaim[]; evidence: Evidence; unresolvedWork: string[]
  completionPolicy: CompletionPolicy; missingRequirements: string[]; notificationCursor?: string
  migration: { source?: string; previewedAt?: string; appliedAt?: string; records: MigrationRecord[]; legacyAttestation?: string }
  eventCursors: Record<string, number>; appliedEventIDs: string[]; history: QuestHistory[]; earlierCount?: number; earlierSessions?: number; abandoned?: boolean
  extensions: Record<string, unknown>
}

export type QuestEventType =
  | "created" | "patched" | "session-planned" | "session-claimed" | "session-bound" | "session-state" | "session-removed" | "deliverable-state" | "stage-state" | "proof-added" | "evidence-added"
  | "complete" | "archive" | "reopen" | "abandon" | "delete" | "snapshot"

export type QuestEvent = {
  origin?: import('./core/history-origin').HistoryOrigin
  v: 1; eventID: string; questID: string; type: QuestEventType; at: string; source: string; sourceSequence: number
  expectedRevision?: number; causationID: string; lifecycleEpoch: number; payload: Record<string, unknown>
}

export type ParsedQuest = { quest?: Quest; body: string; rawFrontmatter: string; raw: string; readonly: boolean; errors: string[]; humanHash: string }

export const DEFAULT_COMPLETION_POLICY: CompletionPolicy = {
  requireSessions: true, requireCommits: false, requireTests: true, requireReview: false,
  requireArtifacts: false, requirePublish: false, requireWorktreeEquality: false,
}
