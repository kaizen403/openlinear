import type { VerificationManifest, VerificationResult } from '@openlinear/execution-core';
import { z } from 'zod';

/**
 * Durable run records (W05a/W06a). Every JSON column of the journal is
 * validated with these schemas when read, so a corrupted or foreign row is
 * reported instead of driving an effect.
 */

export const runRepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  fullName: z.string(),
  cloneUrl: z.string(),
  defaultBranch: z.string(),
});
export type RunRepository = z.infer<typeof runRepositorySchema>;

export const followUpCommentSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  side: z.enum(['old', 'new']).optional(),
  body: z.string(),
});

/**
 * W07a: a follow-up turn's request, journaled with the run's acceptance
 * (durable before the route answers). The prompt is rebuilt from it
 * deterministically (`buildFollowUpPrompt`).
 */
export const runFollowUpSchema = z.object({
  /** The finished run whose worktree (and, where possible, session) this turn continues. */
  parentRunId: z.string(),
  message: z.string(),
  comments: z.array(followUpCommentSchema),
});
export type RunFollowUp = z.infer<typeof runFollowUpSchema>;

/** The immutable task snapshot the control plane issued with the attempt. No secrets. */
export const runSnapshotSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  model: z.string().nullable(),
  agent: z.string().nullable(),
  labels: z.array(z.string()),
  projectId: z.string().nullable(),
  teamId: z.string().nullable(),
  creatorId: z.string().nullable(),
  localPath: z.string().nullable(),
  repository: runRepositorySchema.nullable(),
  /** W07a: present when this run is a follow-up turn. */
  followUp: runFollowUpSchema.optional(),
  /**
   * W11a: the project's verification settings as the control plane issued
   * them with the attempt (raw; validated when the manifest is resolved).
   * Absent = none configured (or an older control plane).
   */
  verificationSettings: z.unknown().optional(),
  /**
   * W15a: the user's per-run budgets as issued with the attempt (absent = no
   * limit). Journaled with the run, so a recovered run keeps its budget.
   */
  budgets: z.object({
    maxUsd: z.number().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  }).optional(),
  /**
   * FE-04: the user's approval mode as issued with the attempt; "ask" =
   * permission requests wait for the person who started the run (absent =
   * answered by the service policy).
   */
  approvalMode: z.enum(['auto', 'ask']).optional(),
  /**
   * W19b: the project's knowledge (written or approved by people) as issued
   * with the attempt; given to the agent in the first prompt. Ids and
   * versions record which revisions the run used.
   */
  knowledge: z.array(z.object({
    id: z.string(),
    version: z.number().int().min(1),
    kind: z.enum(['note', 'convention', 'procedure']),
    title: z.string().max(200),
    body: z.string().max(4_000),
  })).max(50).optional(),
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

export const runWorkspaceSchema = z.object({
  worktreePath: z.string(),
  branch: z.string(),
  baseRef: z.string().nullable(),
  /** False for a project's localPath: never released or deleted by the run. */
  owned: z.boolean(),
  /** Provider handle fields needed to release an owned checkout. */
  handle: z.object({ runId: z.string(), mirrorPath: z.string(), dissociated: z.boolean() }).nullable(),
  /**
   * W07a: a follow-up adopted this workspace from an earlier run (whose
   * work it holds): never released by this run, whatever fails.
   */
  continuedFrom: z.string().optional(),
  /**
   * W11a: the commit the workspace was created at, before the agent ran.
   * Repository check definitions are read from this commit, never from the
   * agent's working tree. A follow-up keeps its parent's base commit.
   */
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/).nullable().optional(),
  /** W08a: the local folder had uncommitted changes, which the isolated checkout does not include. */
  sourceDirty: z.boolean().optional(),
});
export type RunWorkspace = z.infer<typeof runWorkspaceSchema>;

/**
 * Where the agent runtime for this run listens. `authorization` is the
 * per-attempt server password (W09a enforce mode); the journal file is
 * private (0600, sandbox-denied app data), like the capability.
 */
export const runtimeEndpointSchema = z.object({
  kind: z.enum(['opencode', 'claude-code', 'codex', 'fake']),
  baseUrl: z.string(),
  directory: z.string(),
  authorization: z.string().nullable(),
  sandboxMode: z.enum(['enforce', 'trusted-host', 'none']),
  /**
   * W07a, process runtimes (Claude Code, Codex): identity of the runtime's
   * process-group leader, so a restarted sidecar can stop an orphan without
   * ever signalling a recycled pid. The process started inside
   * [launchedAt, spawnedBy].
   */
  process: z.object({
    pid: z.number().int().positive().nullable(),
    launchedAt: z.number().nullable(),
    spawnedBy: z.number(),
  }).nullable().optional(),
  /** W07a: this turn continued an earlier runner session (follow-up resume). */
  resumedSessionId: z.string().nullable().optional(),
});
export type RuntimeEndpoint = z.infer<typeof runtimeEndpointSchema>;

export const runTerminalSchema = z.object({
  state: z.enum(['succeeded', 'failed', 'cancelled', 'recovery_required', 'abandoned']),
  reason: z.string(),
  outcome: z.string().nullable(),
  prUrl: z.string().nullable(),
  /** Whether the task row was claimed (in_progress) by this attempt. */
  claimed: z.boolean(),
});
export type RunTerminal = z.infer<typeof runTerminalSchema>;

export const runCountersSchema = z.object({
  promptSent: z.boolean(),
  filesChanged: z.number().int().min(0),
  toolsExecuted: z.number().int().min(0),
  agentRunId: z.string().nullable(),
  droppedEvents: z.number().int().min(0),
});
export type RunCounters = z.infer<typeof runCountersSchema>;

export const emptyCounters = (): RunCounters => ({
  promptSent: false,
  filesChanged: 0,
  toolsExecuted: 0,
  agentRunId: null,
  droppedEvents: 0,
});

/** Latest per-message totals (OpenCode reports totals, not deltas). */
export const runUsageSchema = z.object({
  messages: z.record(z.object({
    cost: z.number(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  })),
});
export type RunUsage = z.infer<typeof runUsageSchema>;

export function sumUsage(usage: RunUsage | null): {
  costUsd: number; inputTokens: number; outputTokens: number; reasoningTokens: number; cachedInputTokens: number; cacheWriteTokens: number;
} {
  const total = { costUsd: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  for (const message of Object.values(usage?.messages ?? {})) {
    total.costUsd += message.cost;
    total.inputTokens += message.input;
    total.outputTokens += message.output;
    total.reasoningTokens += message.reasoning;
    total.cachedInputTokens += message.cacheRead;
    total.cacheWriteTokens += message.cacheWrite;
  }
  return total;
}

// ---------------------------------------------------------------------------
// W11a verification (manifest sealed before the prompt; result per commit)
// ---------------------------------------------------------------------------

const sha = z.string().regex(/^[0-9a-f]{40,64}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const verificationNetworkSchema = z.union([
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('egress'), hosts: z.array(z.string()), registries: z.boolean() }),
]);

export const verificationCheckSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  argv: z.array(z.string()).min(1),
  cwd: z.string(),
  timeoutMs: z.number().int().positive(),
  network: verificationNetworkSchema,
  required: z.boolean(),
});

export const verificationManifestSchema: z.ZodType<VerificationManifest> = z.object({
  schemaVersion: z.literal(1),
  policy: z.enum(['require-pass', 'warn', 'off']),
  policySource: z.enum(['project', 'default']),
  source: z.enum(['project', 'repository', 'auto-detect', 'none']),
  checks: z.array(verificationCheckSpecSchema),
  checksHash: hex64,
  baseCommit: sha.nullable(),
  inputs: z.array(z.object({
    kind: z.enum(['project', 'repository', 'auto-detect']),
    status: z.enum(['used', 'ignored', 'absent', 'invalid', 'disabled', 'unavailable']),
    sha256: z.string().nullable(),
    ref: z.string().nullable(),
    detail: z.string().nullable(),
  })),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
  capturedAt: z.string(),
});

export const verificationCheckResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  required: z.boolean(),
  status: z.enum(['passed', 'failed', 'timed_out', 'error', 'skipped']),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number().int().min(0),
  timedOut: z.boolean(),
  network: z.enum(['none', 'egress']),
  command: z.string(),
  log: z.object({
    sha256: hex64.nullable(),
    bytes: z.number().int().min(0),
    truncated: z.boolean(),
    tail: z.string(),
    artifact: z.string().nullable(),
  }),
  detail: z.string().nullable(),
});

export const verificationResultSchema: z.ZodType<VerificationResult> = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['passed', 'failed', 'error', 'skipped']),
  commitSha: sha,
  baseCommit: sha.nullable(),
  checksHash: hex64,
  policy: z.enum(['require-pass', 'warn', 'off']),
  source: z.enum(['project', 'repository', 'auto-detect', 'none']),
  runner: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  checks: z.array(verificationCheckResultSchema),
  environment: z.object({
    sandboxMode: z.enum(['enforce', 'trusted-host', 'none']),
    provider: z.string().nullable(),
    providerVersion: z.string().nullable(),
    policyHashes: z.array(z.string()),
    platform: z.string(),
    arch: z.string(),
    checkout: z.literal('pristine-clone'),
  }),
  detail: z.string().nullable(),
  warnings: z.array(z.string()),
});

/** `run_attempts.verification_json`: the sealed manifest (written before the prompt). */
export const runVerificationSchema = z.object({ manifest: verificationManifestSchema });
export type RunVerification = z.infer<typeof runVerificationSchema>;

// ---------------------------------------------------------------------------
// W16a environment setup (steps run in the worktree before the agent starts)
// ---------------------------------------------------------------------------

/**
 * One setup step's journal record, carried by the run's `progress` events
 * (`payload.setupRecord`; the relay forwards only the scalar fields beside
 * it, never the local log path). `start` is journaled before the step runs,
 * `end` with its result after; a `start` without an `end` is a step the
 * sidecar died in. `stepHash` identifies what the step does (command,
 * directory, network): a passed `end` makes the step "done in this
 * worktree" for the run and the follow-ups that continue it.
 */
export const setupStepRecordSchema = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('start'),
    setupHash: hex64,
    stepHash: hex64,
    index: z.number().int().min(0),
    total: z.number().int().min(1),
    step: verificationCheckSpecSchema,
  }),
  z.object({
    phase: z.literal('end'),
    setupHash: hex64,
    stepHash: hex64,
    index: z.number().int().min(0),
    total: z.number().int().min(1),
    result: verificationCheckResultSchema,
    sandbox: z.object({
      mode: z.enum(['enforce', 'trusted-host', 'none']),
      provider: z.string().nullable(),
      providerVersion: z.string().nullable(),
      policyHash: z.string().nullable(),
    }).nullable(),
    /** The run whose recorded pass made running the step again unnecessary (null = it ran here). */
    reusedFrom: z.string().nullable(),
  }),
]);
export type SetupStepRecord = z.infer<typeof setupStepRecordSchema>;
