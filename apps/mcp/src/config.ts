/**
 * Worker configuration. Every value comes from `wrangler.toml` `[vars]` (or
 * `.dev.vars` locally); nothing here is secret, because the only credential
 * the worker handles is the caller's own personal access token.
 */
export interface Env {
  /** Base URL of the OpenLinear REST API. */
  OPENLINEAR_API_URL?: string;
  /**
   * Comma-separated browser Origin hostnames allowed to call `/mcp`
   * (for example `inspector.example.com`). Requests that carry any other
   * `Origin` header get 403 (DNS-rebinding / cross-site guard). Requests
   * without an `Origin` header (every non-browser MCP client) are unaffected.
   */
  MCP_ALLOWED_ORIGINS?: string;
  /**
   * Comma-separated OAuth 2.1 authorization-server issuer URLs advertised in
   * the protected-resource metadata. Leave empty until OpenLinear runs an
   * authorization server; personal access tokens never need it.
   */
  MCP_AUTHORIZATION_SERVERS?: string;
  /** Documentation URL advertised in protected-resource metadata and in 401 bodies. */
  MCP_DOCS_URL?: string;
}

export interface WorkerConfig {
  apiUrl: string;
  allowedOrigins: string[];
  authorizationServers: string[];
  docsUrl: string;
}

export const DEFAULT_API_URL = 'https://api.openlinear.tech';
export const DEFAULT_DOCS_URL = 'https://docs.openlinear.tech/integrations/mcp';

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function httpUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return parsed.toString().replace(/\/$/, '');
}

/** Parse and validate the worker configuration; throws on a malformed value. */
export function readConfig(env: Env): WorkerConfig {
  return {
    apiUrl: httpUrl(env.OPENLINEAR_API_URL?.trim() || DEFAULT_API_URL, 'OPENLINEAR_API_URL'),
    allowedOrigins: list(env.MCP_ALLOWED_ORIGINS).map((origin) => origin.toLowerCase()),
    authorizationServers: list(env.MCP_AUTHORIZATION_SERVERS).map((issuer) =>
      httpUrl(issuer, 'MCP_AUTHORIZATION_SERVERS'),
    ),
    docsUrl: httpUrl(env.MCP_DOCS_URL?.trim() || DEFAULT_DOCS_URL, 'MCP_DOCS_URL'),
  };
}
