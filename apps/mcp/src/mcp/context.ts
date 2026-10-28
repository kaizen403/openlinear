import type { AuthInfo } from '@modelcontextprotocol/server';
import type { PatPrincipal } from '../auth';
import { OpenLinearApi } from '../openlinear/api';
import { type FetchLike, OpenLinearClient } from '../openlinear/client';
import { OpenLinearApiError } from '../openlinear/errors';

export interface RequestScopeOptions {
  apiUrl: string;
  token: string;
  principal: PatPrincipal;
  fetch?: FetchLike;
  /** Keeps background work (usage logging) alive after the response; `ctx.waitUntil` on Workers. */
  waitUntil: (promise: Promise<unknown>) => void;
  /** Called when the API answers 401: drops the cached verification for this token. */
  onUnauthorized: () => void;
  usageLogging: boolean;
  disableUsageLogging: () => void;
  /** Test hooks. */
  apiTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Everything one authenticated HTTP request needs to build its MCP server:
 * the caller's token and identity, and the worker services tools use. It is
 * handed to the SDK's per-request server factory through `authInfo.extra`
 * (the SDK passes `authInfo` through untouched).
 */
export class RequestScope {
  constructor(readonly options: RequestScopeOptions) {}

  get principal(): PatPrincipal {
    return this.options.principal;
  }

  /** A fresh API client for one tool call; all its requests share one `X-Request-Id`. */
  api(requestId: string = crypto.randomUUID()): OpenLinearApi {
    return new OpenLinearApi(
      new OpenLinearClient({
        baseUrl: this.options.apiUrl,
        token: this.options.token,
        fetch: this.options.fetch,
        requestId,
        onUnauthorized: this.options.onUnauthorized,
        timeoutMs: this.options.apiTimeoutMs,
        sleep: this.options.sleep,
      }),
    );
  }

  /** Record one tool call in `/api/mcp/log` without delaying the response. */
  logUsage(toolName: string, success: boolean, errorCode?: string): void {
    if (!this.options.usageLogging) return;
    const api = this.api();
    const task = api.logToolCall({ toolName, success, ...(errorCode ? { error: errorCode } : {}) }).catch((error: unknown) => {
      // A read-only token cannot write usage rows; stop trying for this token.
      if (error instanceof OpenLinearApiError && error.status === 403) this.options.disableUsageLogging();
    });
    this.options.waitUntil(task);
  }

  toAuthInfo(expiresAtSeconds: number): AuthInfo {
    return {
      token: this.options.token,
      clientId: 'openlinear-pat',
      scopes: [],
      expiresAt: expiresAtSeconds,
      extra: { [SCOPE_KEY]: this, userId: this.options.principal.userId },
    };
  }
}

const SCOPE_KEY = 'openlinearRequestScope';

export function scopeFromAuthInfo(authInfo: AuthInfo | undefined): RequestScope | undefined {
  const value = authInfo?.extra?.[SCOPE_KEY];
  return value instanceof RequestScope ? value : undefined;
}
