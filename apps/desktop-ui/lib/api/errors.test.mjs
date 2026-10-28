import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ApiError, AuthExpiredError, NetworkError } = await import('./fetch.ts')
const {
  API_ERROR_COPY,
  describeApiError,
  formatApiError,
  getApiErrorCode,
  isApiErrorCode,
  toastApiError,
} = await import('./errors.ts')
const { toast } = await import('sonner')

const REQUIRED_CODES = [
  'INVALID_RUNNER',
  'RUNNER_NOT_SUPPORTED',
  'TASK_SELECTION_CHANGED',
  'BATCH_SELECTION_CHANGED',
  'TASK_ARCHIVED',
  'TASK_ALREADY_RUNNING',
  'PAT_WORKSPACE_RESTRICTED',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'VALIDATION_ERROR',
  'OWNERSHIP_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'SANDBOX_UNAVAILABLE',
  'BATCH_REQUIRES_API_PERSISTENCE',
  // v2 run engine, W10a credentials, W11a verification
  'RUN_ACTIVE',
  'RUN_ENGINE_STOPPED',
  'RUN_JOURNAL_LOCKED',
  'FOLLOW_UP_UNSUPPORTED',
  'FOLLOW_UP_RUN_MISMATCH',
  'AGENT_MAY_BE_RUNNING',
  'TASK_FENCE_REJECTED',
  'CLOUD_API_UNREACHABLE',
  'GITHUB_APP_REQUIRED',
  'GITHUB_APP_UNAVAILABLE',
  'GITHUB_APP_TOKEN_REJECTED',
  'GIT_CREDENTIAL_UNUSABLE',
  'VERIFICATION_REQUIRED',
  'BATCH_MODE_UNAVAILABLE',
  // W17 dependencies, FE-06 redirect, FE-04 approvals, FE-03 trust grants
  'TASK_BLOCKED',
  'REDIRECT_PENDING',
  'APPROVAL_NOT_FOUND',
  'APPROVAL_CHANGED',
  'APPROVAL_FORBIDDEN',
  'TRUST_GRANT_NOT_NEEDED',
  'TRUST_GRANT_NOT_APPLICABLE',
  'TRUST_GRANT_EXISTS',
  'TRUST_GRANT_LIMIT',
  'TRUST_GRANT_NOT_FOUND',
  'SANDBOX_CHECK_PENDING',
  // W20 recurring issues
  'SCHEDULE_QUOTA_EXCEEDED',
  'SCHEDULE_NOT_FOUND',
  // FE-14 outbound webhooks
  'WEBHOOK_URL_INVALID',
  'WEBHOOK_LIMIT_EXCEEDED',
  'WEBHOOK_NOT_FOUND',
  'WEBHOOK_DELIVERY_NOT_FOUND',
  'WEBHOOK_DISABLED',
  'WEBHOOK_DELIVERY_IN_FLIGHT',
  // W19b project knowledge
  'KNOWLEDGE_PEOPLE_ONLY',
  'KNOWLEDGE_VERSION_CONFLICT',
  'KNOWLEDGE_SEALED_SOURCE',
  'KNOWLEDGE_QUOTA_EXCEEDED',
  // W19a agent reviews
  'REVIEW_RUNNING',
  'REVIEW_RUN_ACTIVE',
  'REVIEW_NOTHING_TO_REVIEW',
  'REVIEW_WORKSPACE_GONE',
  'REVIEW_RUNNER_UNAVAILABLE',
  'REVIEW_UNSUPPORTED',
  'REVIEW_NOT_RUNNING',
]

describe('describeApiError', () => {
  beforeEach(() => vi.clearAllMocks())

  it('explains refused webhook URLs and limits (FE-14)', () => {
    const privateUrl = describeApiError(new ApiError(400, 'The URL points at a private, loopback, link-local or reserved address', 'WEBHOOK_URL_INVALID', { field: 'url', reason: 'forbidden_address' }))
    expect(privateUrl.message).toBe('The URL points at a private, loopback, link-local or reserved address')
    expect(privateUrl.hint).toMatch(/public HTTPS addresses/)
    expect(describeApiError(new ApiError(400, '', 'WEBHOOK_URL_INVALID', { reason: 'https_required' })).hint).toMatch(/public https:\/\/ URL/)
    expect(describeApiError(new ApiError(400, '', 'WEBHOOK_URL_INVALID', { reason: 'slack_url_required', format: 'slack' })).hint).toMatch(/Incoming Webhook/)
    expect(describeApiError(new ApiError(400, '', 'WEBHOOK_URL_INVALID', { reason: 'discord_url_required', format: 'discord' })).hint).toMatch(/Integrations → Webhooks/)
    expect(describeApiError(new ApiError(409, 'x', 'WEBHOOK_LIMIT_EXCEEDED', { limit: 10, scope: 'project' })).message).toBe('This project already has 10 webhooks.')
    expect(describeApiError(new ApiError(409, 'x', 'WEBHOOK_DELIVERY_IN_FLIGHT', {}))).toMatchObject({ retryable: true, retryAfterMs: 5000 })
  })

  it('names the schedule limit that was reached (W20)', () => {
    expect(describeApiError(new ApiError(409, 'x', 'SCHEDULE_QUOTA_EXCEEDED', { kind: 'active', limit: 25 }))).toMatchObject({
      message: 'This project already has 25 active schedules.', hint: 'Pause or delete one, then try again.', retryable: false,
    })
    expect(describeApiError(new ApiError(409, 'x', 'SCHEDULE_QUOTA_EXCEEDED', { kind: 'total', limit: 50 })).message).toBe('This project already has 50 schedules.')
  })

  it('covers every code the board, task and execution surfaces must handle', () => {
    for (const code of REQUIRED_CODES) {
      expect(API_ERROR_COPY[code], code).toBeTypeOf('function')
      const described = describeApiError(new ApiError(409, `server says ${code}`, code))
      expect(described.code).toBe(code)
      expect(described.message.length, code).toBeGreaterThan(0)
    }
  })

  it('gives actionable copy instead of the raw server text for known codes', () => {
    const archived = describeApiError(new ApiError(409, 'Archived tasks cannot execute', 'TASK_ARCHIVED'))
    expect(archived.message).toBe("Archived tasks can't be executed.")
    expect(archived.hint).toMatch(/Restore the task/)

    const changed = describeApiError(new ApiError(409, 'Selected tasks changed before admission completed', 'BATCH_SELECTION_CHANGED'))
    expect(changed.hint).toMatch(/start the batch again/)

    const restricted = describeApiError(new ApiError(403, 'x', 'PAT_WORKSPACE_RESTRICTED'))
    expect(restricted.message).toMatch(/different workspace/)
  })

  it('v2 engine copy is specific: an expired workspace, the journal owner, the GitHub App install', () => {
    const expired = describeApiError(new ApiError(409, "The previous run's workspace expired and was cleaned up", 'FOLLOW_UP_UNSUPPORTED', { reason: 'workspace_expired' }))
    expect(expired.message).toMatch(/workspace was cleaned up/)
    // W12: Continue named a run that isn't this device's latest one.
    const mismatch = describeApiError(new ApiError(409, 'The run to continue is not the latest run of this task on this device', 'FOLLOW_UP_RUN_MISMATCH', { expected: 'run-a', latest: 'run-b' }))
    expect(mismatch).toMatchObject({ message: 'This run was started on another device, or a newer run exists here.', retryable: false })
    expect(mismatch.hint).toMatch(/Open the latest run, or start a new one/)
    expect(describeApiError(new ApiError(503, 'x', 'RUN_JOURNAL_LOCKED')).hint).toMatch(/Only one may own the run journal/)
    expect(describeApiError(new ApiError(403, 'x', 'GITHUB_APP_REQUIRED', { installUrl: 'https://github.com/apps/x/installations/new' })).hint).toMatch(/Install the app/)
    expect(describeApiError(new ApiError(403, 'x', 'GITHUB_APP_REQUIRED', {})).hint).toMatch(/Ask a workspace admin/)
  })

  it('names the runner and the supported runners from details', () => {
    const unsupported = describeApiError(new ApiError(400, 'The current execution engine does not support codex', 'RUNNER_NOT_SUPPORTED', {
      runner: 'codex',
      supportedRunners: ['opencode'],
    }))
    expect(unsupported.message).toBe("Codex can't execute tasks yet.")
    expect(unsupported.hint).toContain('OpenCode')

    const invalid = describeApiError(new ApiError(400, 'The selected agent runner is unknown', 'INVALID_RUNNER', { runner: 'gpt-x' }))
    expect(invalid.message).toContain('"gpt-x"')
  })

  it('marks IDEMPOTENCY_IN_PROGRESS retryable with the server Retry-After', () => {
    const described = describeApiError(new ApiError(409, 'still processing', 'IDEMPOTENCY_IN_PROGRESS', { retryAfterSeconds: 2 }))
    expect(described.retryable).toBe(true)
    expect(described.retryAfterMs).toBe(2000)
    expect(described.hint).toMatch(/Wait 2 seconds/)
  })

  it('does not mark IDEMPOTENCY_CONFLICT retryable', () => {
    const described = describeApiError(new ApiError(409, 'used with a different request', 'IDEMPOTENCY_CONFLICT', { operation: 'tasks.create' }))
    expect(described.retryable).toBe(false)
    expect(described.message).toMatch(/different details/)
  })

  it('distinguishes ownership 404 from 403', () => {
    const missing = describeApiError(new ApiError(404, 'Resource not found', 'OWNERSHIP_REQUIRED', { resourceType: 'task', resourceId: 't1' }))
    expect(missing.message).toBe('This task no longer exists or you no longer have access to it.')
    const forbidden = describeApiError(new ApiError(403, 'Required role is missing', 'OWNERSHIP_REQUIRED', { resourceType: 'project' }))
    expect(forbidden.message).toBe("You don't have permission to change this project.")
  })

  it('surfaces the first field error for validation failures', () => {
    const described = describeApiError(new ApiError(400, 'Validation failed', 'VALIDATION_ERROR', {
      formErrors: [],
      fieldErrors: { title: ['Title is required'] },
    }))
    expect(described.message).toBe('title: Title is required')
  })

  it('reads the rate-limit window', () => {
    const described = describeApiError(new ApiError(429, 'Too many requests', 'RATE_LIMITED', { scope: 'api', retryAfterSeconds: 60 }))
    expect(described.hint).toBe('Wait 60 seconds and try again.')
    expect(described.retryAfterMs).toBe(60_000)
  })

  it('keeps the server message for forward-compatible codes and adds a next step', () => {
    const sandbox = describeApiError(new ApiError(503, 'No sandbox provider passed preflight on darwin', 'SANDBOX_UNAVAILABLE'))
    expect(sandbox.message).toBe('No sandbox provider passed preflight on darwin')
    expect(sandbox.hint).toMatch(/blocked instead of running unprotected/)
    const persistence = describeApiError(new ApiError(409, '', 'BATCH_REQUIRES_API_PERSISTENCE'))
    expect(persistence.message).toMatch(/Batch execution isn't available/)
    expect(persistence.hint).toMatch(/one at a time/)
  })

  it('falls back to the server message for unknown codes', () => {
    const described = describeApiError(new ApiError(409, 'Plan revision 4 is stale', 'PLAN_REVISION_STALE'))
    expect(described).toMatchObject({ code: 'PLAN_REVISION_STALE', message: 'Plan revision 4 is stale', retryable: false })
    expect(described.hint).toBeUndefined()
  })

  it('falls back to the server message when the envelope has no code', () => {
    const described = describeApiError(new ApiError(400, 'Parallel limit reached (3 tasks max)'))
    expect(described).toMatchObject({ code: null, status: 400, message: 'Parallel limit reached (3 tasks max)' })
    const gateway = describeApiError(new ApiError(503, 'Service Unavailable'))
    expect(gateway.retryable).toBe(true)
  })

  it('maps client-side failures', () => {
    expect(describeApiError(new NetworkError('offline'))).toMatchObject({ code: 'NETWORK_ERROR', retryable: true })
    expect(describeApiError(new AuthExpiredError())).toMatchObject({ code: 'AUTH_EXPIRED', status: 401 })
    expect(describeApiError(new Error('boom')).message).toBe('boom')
    expect(describeApiError('weird', 'Fallback').message).toBe('Fallback')
  })

  it('exposes code helpers', () => {
    const error = new ApiError(409, 'x', 'TASK_ALREADY_RUNNING')
    expect(getApiErrorCode(error)).toBe('TASK_ALREADY_RUNNING')
    expect(isApiErrorCode(error, 'TASK_ARCHIVED', 'TASK_ALREADY_RUNNING')).toBe(true)
    expect(isApiErrorCode(new Error('x'), 'TASK_ALREADY_RUNNING')).toBe(false)
    expect(formatApiError(error)).toBe('This task is already running. Wait for the current run to finish, or stop it before starting another.')
  })
})

describe('toastApiError', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the mapped message with the hint as description', () => {
    toastApiError(new ApiError(409, 'Archived tasks cannot execute', 'TASK_ARCHIVED'))
    expect(toast.error).toHaveBeenCalledWith("Archived tasks can't be executed.", {
      description: 'Restore the task from Archived, then run it again.',
    })
  })

  it('moves the mapped message into the description when a title is given, and forwards actions', () => {
    const onClick = vi.fn()
    toastApiError(new ApiError(503, 'Cancellation could not be confirmed', 'CANCEL_INCOMPLETE'), {
      title: "Couldn't stop the batch",
      action: { label: 'Retry stop', onClick },
    })
    expect(toast.error).toHaveBeenCalledWith("Couldn't stop the batch", expect.objectContaining({
      description: expect.stringContaining('Cancellation could not be confirmed'),
      action: { label: 'Retry stop', onClick },
    }))
  })
})
