import { z } from 'zod';

/**
 * W03a execution control contract (sidecar <-> control plane).
 *
 * Every body below is strict: unknown keys are rejected so a sidecar cannot
 * smuggle fence values (session, project, team, creator) into a write. The
 * server always fences against the values it recorded on the attempt.
 */

export const EXECUTION_EVENT_TYPES = ['execution:progress', 'execution:log'] as const;
export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number];

/** Bounds mirror the sidecar's in-memory ring buffer (MAX_EXECUTION_LOG_ENTRIES). */
export const MAX_ATTEMPT_LOG_ENTRIES = 2_000;
export const MAX_LOG_MESSAGE_CHARS = 8_000;
export const MAX_LOG_DETAILS_CHARS = 16_000;
export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_OUTCOME_CHARS = 4_000;
export const MAX_ERROR_MESSAGE_CHARS = 1_000;

export const startAttemptBodySchema = z
  .object({
    taskId: z.string().uuid(),
    /** W17a: start even though blockers are open (otherwise 409 TASK_BLOCKED). */
    allowBlocked: z.boolean().optional(),
  })
  .strict();
export type StartAttemptBody = z.infer<typeof startAttemptBodySchema>;

export const claimAttemptBodySchema = z
  .object({
    /** Provider session the claim binds the task row to (OpenCode `ses_...`). */
    sessionId: z.string().trim().min(1).max(200),
    runner: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1).max(200),
  })
  .strict();
export type ClaimAttemptBody = z.infer<typeof claimAttemptBodySchema>;

const logEntrySchema = z
  .object({
    timestamp: z.string().datetime(),
    type: z.enum(['info', 'agent', 'tool', 'error', 'success']),
    message: z.string().max(MAX_LOG_MESSAGE_CHARS),
    details: z.string().max(MAX_LOG_DETAILS_CHARS).optional(),
  })
  .strict();
export type ExecutionLogEntryBody = z.infer<typeof logEntrySchema>;

const progressPayloadSchema = z
  .object({
    status: z.string().trim().min(1).max(64),
    message: z.string().max(MAX_LOG_MESSAGE_CHARS),
  })
  // Progress events carry small additive fields (elapsedMs, prUrl, ...).
  .catchall(z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]));

const logPayloadSchema = z
  .object({
    // Ignored: the server always stamps the attempt's own task id.
    taskId: z.string().max(200).optional(),
    entry: logEntrySchema,
  })
  .strict();

export const attemptEventsBodySchema = z
  .object({
    events: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ seq: z.number().int().min(1), type: z.literal('execution:progress'), payload: progressPayloadSchema }).strict(),
          z.object({ seq: z.number().int().min(1), type: z.literal('execution:log'), payload: logPayloadSchema }).strict(),
        ]),
      )
      .min(1)
      .max(MAX_EVENTS_PER_BATCH),
  })
  .strict();
export type AttemptEventsBody = z.infer<typeof attemptEventsBodySchema>;

export const attemptLogsBodySchema = z
  .object({
    logs: z.array(logEntrySchema).max(MAX_ATTEMPT_LOG_ENTRIES),
  })
  .strict();
export type AttemptLogsBody = z.infer<typeof attemptLogsBodySchema>;

export const attemptTerminalBodySchema = z
  .object({
    status: z.enum(['done', 'cancelled']),
    executionElapsedMs: z.number().int().min(0).max(2_147_483_647).optional(),
    executionProgress: z.number().int().min(0).max(100).nullable().optional(),
    executionPausedAt: z.string().datetime().nullable().optional(),
    prUrl: z.string().max(2_000).nullable().optional(),
    outcome: z.string().max(MAX_OUTCOME_CHARS).nullable().optional(),
  })
  .strict();
export type AttemptTerminalBody = z.infer<typeof attemptTerminalBodySchema>;

const usageSchema = z
  .object({
    costUsd: z.number().min(0).max(1_000_000).optional(),
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    cachedInputTokens: z.number().int().min(0).optional(),
    cacheWriteTokens: z.number().int().min(0).optional(),
    reasoningTokens: z.number().int().min(0).optional(),
    costBasis: z.string().max(100).optional(),
  })
  .strict();

export const attemptRunBodySchema = z
  .object({
    status: z.enum(['succeeded', 'failed', 'cancelled']),
    usage: usageSchema.optional(),
    prUrl: z.string().max(2_000).nullable().optional(),
    errorMessage: z.string().max(MAX_ERROR_MESSAGE_CHARS).nullable().optional(),
  })
  .strict();
export type AttemptRunBody = z.infer<typeof attemptRunBodySchema>;

/** A cancellation acknowledgement is a positive provider stop receipt only. */
export const attemptCancellationAckBodySchema = z
  .object({
    stopConfirmed: z.literal(true),
  })
  .strict();
export type AttemptCancellationAckBody = z.infer<typeof attemptCancellationAckBodySchema>;

/**
 * W10a: the git effect the credential is for — `fetch` (clone/fetch),
 * `push`, or `pull_request` (PR API) — so the narrowest token is issued.
 * `{ purpose }` is the pre-W10a body that shipped sidecars still send:
 * `clone` maps to `fetch`, `publish` (one token for push and PR) to
 * `pull_request`.
 */
export const attemptGitCredentialBodySchema = z.union([
  z.object({ effect: z.enum(['fetch', 'push', 'pull_request']) }).strict(),
  z.object({ purpose: z.enum(['clone', 'publish']) }).strict(),
]);
export type AttemptGitCredentialBody = z.infer<typeof attemptGitCredentialBodySchema>;

/**
 * W11a verification evidence. Bounds mirror the sidecar (execution-core
 * VERIFICATION_LIMITS: ≤ 20 checks, a redacted ≤ 4 KiB log tail per check);
 * no local paths are accepted. `publication` must be what the policy decides
 * for the status (checked by the service and a DB constraint).
 */
const sha = z.string().regex(/^[0-9a-f]{40,64}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const isoDate = z.string().datetime({ offset: true });
export const MAX_VERIFICATION_CHECKS = 20;

export const verificationCheckEvidenceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    name: z.string().min(1).max(120),
    required: z.boolean(),
    status: z.enum(['passed', 'failed', 'timed_out', 'error', 'skipped']),
    exitCode: z.number().int().min(-1024).max(1024).nullable(),
    signal: z.string().max(32).nullable(),
    durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
    network: z.enum(['none', 'egress']),
    command: z.string().max(512),
    logSha256: hex64.nullable(),
    logBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    logTruncated: z.boolean(),
    logTail: z.string().max(8_192),
    detail: z.string().max(1_000).nullable(),
  })
  .strict();

export const attemptVerificationBodySchema = z
  .object({
    runId: z.string().min(1).max(128),
    commitSha: sha,
    baseSha: sha.nullable(),
    checksHash: hex64,
    policy: z.enum(['require-pass', 'warn', 'off']),
    status: z.enum(['passed', 'failed', 'error', 'skipped']),
    publication: z.enum(['allowed', 'blocked']),
    source: z.enum(['project', 'repository', 'auto-detect', 'none']),
    runner: z.string().min(1).max(64),
    environment: z
      .object({
        sandboxMode: z.enum(['enforce', 'trusted-host', 'none']),
        provider: z.string().max(64).nullable(),
        providerVersion: z.string().max(128).nullable(),
        policyHashes: z.array(hex64).max(MAX_VERIFICATION_CHECKS),
        platform: z.string().max(32),
        arch: z.string().max(32),
        checkout: z.literal('pristine-clone'),
      })
      .strict(),
    checks: z.array(verificationCheckEvidenceSchema).max(MAX_VERIFICATION_CHECKS),
    warnings: z.array(z.string().max(500)).max(20),
    detail: z.string().max(1_000).nullable(),
    startedAt: isoDate,
    finishedAt: isoDate,
  })
  .strict();
export type AttemptVerificationBody = z.infer<typeof attemptVerificationBodySchema>;

export const attemptCloseBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type AttemptCloseBody = z.infer<typeof attemptCloseBodySchema>;

/** Bodiless POSTs: absent or `{}`; any field is rejected. */
export const emptyBodySchema = z.object({}).strict().optional();
