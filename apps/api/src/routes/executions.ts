import express, { Router, type Response } from 'express';
import { createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { validateBody, type ValidatedRequest } from '../middleware/validate';
import {
  requireExecutionCapability,
  type CapabilityRequest,
  type ExecutionCapabilityContext,
} from '../middleware/execution-capability';
import { buildErrorEnvelope } from '../lib/http';
import { HttpError } from '../errors';
import {
  acknowledgeAttemptCancellation,
  claimExecutionAttempt,
  closeExecutionAttempt,
  describeTaskAccess,
  finalizeAttemptRun,
  heartbeatExecutionAttempt,
  issueAttemptGitCredential,
  persistAttemptLogs,
  readPersistedTaskLogs,
  recordAttemptEvents,
  refreshTaskPullRequest,
  renewExecutionCapability,
  requestTaskCancellation,
  startExecutionAttempt,
  writeAttemptTerminal,
} from '../services/execution-control';
import { listTaskVerifications, recordAttemptVerification } from '../services/execution-verification';
import {
  attemptCancellationAckBodySchema,
  attemptCloseBodySchema,
  attemptEventsBodySchema,
  attemptGitCredentialBodySchema,
  attemptLogsBodySchema,
  attemptRunBodySchema,
  attemptTerminalBodySchema,
  attemptVerificationBodySchema,
  claimAttemptBodySchema,
  emptyBodySchema,
  startAttemptBodySchema,
  type AttemptCloseBody,
  type AttemptEventsBody,
  type AttemptGitCredentialBody,
  type AttemptLogsBody,
  type AttemptRunBody,
  type AttemptTerminalBody,
  type AttemptVerificationBody,
  type ClaimAttemptBody,
  type StartAttemptBody,
} from '../schemas/executions';

/**
 * W03a execution control plane for the API-only sidecar.
 *
 * Mounted before the app-wide 256 KB JSON parser: each route parses its own
 * body, after authentication, so only an attempt's capability can submit the
 * larger bounded log snapshot. Attempt callbacks are exempt from the per-IP
 * default limiter (a busy run shares the user's IP) and use a per-attempt
 * limiter instead.
 */
const router: Router = Router();

const smallJson = express.json({ limit: '256kb' });
const logSnapshotJson = express.json({ limit: '4mb' });

const attemptLimiter = rateLimit({
  windowMs: 60_000,
  limit: 1_200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => {
    const header = req.headers.authorization ?? '';
    return `attempt:${createHash('sha256').update(header).digest('hex').slice(0, 32)}`;
  },
  handler: (_req, res) => {
    res.status(429).json(buildErrorEnvelope('RATE_LIMITED', 'Too many execution callbacks', {
      details: { scope: 'execution-attempt', retryAfterSeconds: 60 },
    }));
  },
});

function capabilityOf(req: CapabilityRequest): ExecutionCapabilityContext {
  if (!req.executionCapability) throw new HttpError(401, 'CAPABILITY_REQUIRED', 'An execution capability is required');
  return req.executionCapability;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

// --- User-authenticated (session JWT or PAT) ------------------------------

/** Principal validation for the sidecar's local authentication middleware. */
router.get('/principal', requireAuth, (req: AuthRequest, res: Response) => {
  noStore(res);
  res.json({
    userId: req.userId!,
    username: req.username ?? null,
    authSource: req.authSource === 'pat' ? 'pat' : 'session',
    scopes: req.patScopes ?? [],
    workspaceId: req.patWorkspaceId ?? null,
  });
});

/** W11a: the task's verification evidence, newest first (review checks panel). */
router.get('/tasks/:taskId/verifications', requireAuth, async (req: AuthRequest, res: Response) => {
  noStore(res);
  res.json(await listTaskVerifications({ userId: req.userId!, taskId: req.params.taskId as string }));
});

router.get('/tasks/:taskId/access', requireAuth, async (req: AuthRequest, res: Response) => {
  noStore(res);
  res.json(await describeTaskAccess({
    userId: req.userId!,
    taskId: req.params.taskId as string,
    authSource: req.authSource,
    patScopes: req.patScopes,
  }));
});

router.get('/tasks/:taskId/logs', requireAuth, async (req: AuthRequest, res: Response) => {
  noStore(res);
  res.json({ logs: await readPersistedTaskLogs(req.userId!, req.params.taskId as string) });
});

router.post(
  '/tasks/:taskId/cancellation',
  requireAuth(['tasks:write']),
  smallJson,
  validateBody(emptyBodySchema),
  async (req: AuthRequest, res: Response) => {
    res.status(202).json(await requestTaskCancellation(req.userId!, req.params.taskId as string));
  },
);

router.post(
  '/tasks/:taskId/refresh-pr',
  requireAuth(['tasks:write']),
  smallJson,
  validateBody(emptyBodySchema),
  async (req: AuthRequest, res: Response) => {
    res.json(await refreshTaskPullRequest({
      userId: req.userId!,
      taskId: req.params.taskId as string,
      principal: req.tenancy,
      workspaceBoundPat: req.authSource === 'pat' && Boolean(req.patWorkspaceId),
    }));
  },
);

router.post(
  '/attempts',
  requireAuth(['tasks:write']),
  smallJson,
  validateBody(startAttemptBodySchema),
  async (req: AuthRequest & ValidatedRequest<StartAttemptBody>, res: Response) => {
    noStore(res);
    const started = await startExecutionAttempt({
      userId: req.userId!,
      taskId: req.validBody!.taskId,
      principal: req.tenancy,
      sessionId: req.sessionId ?? null,
      allowBlocked: req.validBody!.allowBlocked,
    });
    res.status(201).json(started);
  },
);

// --- Attempt callbacks (run-scoped capability only) ------------------------

router.post(
  '/attempts/:attemptId/claim',
  attemptLimiter,
  requireExecutionCapability('execution:status'),
  smallJson,
  validateBody(claimAttemptBodySchema),
  async (req: CapabilityRequest & ValidatedRequest<ClaimAttemptBody>, res: Response) => {
    res.json(await claimExecutionAttempt(capabilityOf(req), req.validBody!));
  },
);

router.post(
  '/attempts/:attemptId/events',
  attemptLimiter,
  requireExecutionCapability('execution:progress'),
  smallJson,
  validateBody(attemptEventsBodySchema),
  async (req: CapabilityRequest & ValidatedRequest<AttemptEventsBody>, res: Response) => {
    res.json(await recordAttemptEvents(capabilityOf(req), req.validBody!));
  },
);

router.post(
  '/attempts/:attemptId/heartbeat',
  attemptLimiter,
  requireExecutionCapability('execution:status'),
  smallJson,
  validateBody(emptyBodySchema),
  async (req: CapabilityRequest, res: Response) => {
    res.json(await heartbeatExecutionAttempt(capabilityOf(req)));
  },
);

router.post(
  '/attempts/:attemptId/logs',
  attemptLimiter,
  requireExecutionCapability('execution:logs'),
  logSnapshotJson,
  validateBody(attemptLogsBodySchema),
  async (req: CapabilityRequest & ValidatedRequest<AttemptLogsBody>, res: Response) => {
    res.json(await persistAttemptLogs(capabilityOf(req), req.validBody!));
  },
);

router.post(
  '/attempts/:attemptId/terminal',
  attemptLimiter,
  requireExecutionCapability('execution:terminal'),
  smallJson,
  validateBody(attemptTerminalBodySchema),
  async (req: CapabilityRequest & ValidatedRequest<AttemptTerminalBody>, res: Response) => {
    res.json(await writeAttemptTerminal(capabilityOf(req), req.validBody!));
  },
);

router.post(
  '/attempts/:attemptId/run',
  attemptLimiter,
  requireExecutionCapability('execution:terminal'),
  smallJson,
  validateBody(attemptRunBodySchema),
  async (req: CapabilityRequest & ValidatedRequest<AttemptRunBody>, res: Response) => {
    res.json(await finalizeAttemptRun(capabilityOf(req), req.validBody!));
  },
);

router.post(
  '/attempts/:attemptId/cancellation',
  attemptLimiter,
  requireExecutionCapability('execution:status'),
  smallJson,
  validateBody(attemptCancellationAckBodySchema),
  async (req: CapabilityRequest, res: Response) => {
    res.json(await acknowledgeAttemptCancellation(capabilityOf(req)));
  },
);

router.post(
  '/attempts/:attemptId/git-credential',
  attemptLimiter,
  requireExecutionCapability('execution:git-credential'),
  smallJson,
  validateBody(attemptGitCredentialBodySchema),
  async (req: CapabilityRequest & ValidatedRequest<AttemptGitCredentialBody>, res: Response) => {
    noStore(res);
    res.json(await issueAttemptGitCredential(capabilityOf(req), req.validBody!));
  },
);

/** W11a: verification evidence for the attempt's commit (idempotent per commit + checks hash). */
router.post(
  '/attempts/:attemptId/verification',
  attemptLimiter,
  requireExecutionCapability('execution:verification'),
  smallJson,
  validateBody(attemptVerificationBodySchema),
  async (req: CapabilityRequest & ValidatedRequest<AttemptVerificationBody>, res: Response) => {
    res.json(await recordAttemptVerification(capabilityOf(req), req.validBody!));
  },
);

/** W05a: rotate the capability of a long-running attempt while its lease is fresh. */
router.post(
  '/attempts/:attemptId/renew',
  attemptLimiter,
  requireExecutionCapability('execution:status'),
  smallJson,
  validateBody(emptyBodySchema),
  async (req: CapabilityRequest, res: Response) => {
    noStore(res);
    res.json(await renewExecutionCapability(capabilityOf(req)));
  },
);

router.post(
  '/attempts/:attemptId/close',
  attemptLimiter,
  requireExecutionCapability('execution:terminal'),
  smallJson,
  validateBody(attemptCloseBodySchema),
  async (req: CapabilityRequest & ValidatedRequest<AttemptCloseBody>, res: Response) => {
    res.json(await closeExecutionAttempt(capabilityOf(req), req.validBody!));
  },
);

export default router;
