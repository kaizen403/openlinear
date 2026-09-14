export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
  [key: string]: unknown;
}

export function buildErrorEnvelope(
  code: string,
  message: string,
  options: { details?: unknown; requestId?: string; extras?: Record<string, unknown> } = {},
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(options.details !== undefined ? { details: options.details } : {}),
    },
    code,
    message,
    ...(options.details !== undefined ? { details: options.details } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.extras ?? {}),
  };
}
