import { expect } from 'vitest';
import type { ToolCallOutcome } from './harness';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Assert a successful tool call whose text block is the serialized structured content. */
export function ok(outcome: ToolCallOutcome): Record<string, unknown> {
  if (outcome.isError) throw new Error(`tool returned an error: ${outcome.text}`);
  expect(isObject(outcome.structured)).toBe(true);
  expect(JSON.parse(outcome.text)).toEqual(outcome.structured);
  return isObject(outcome.structured) ? outcome.structured : {};
}

export function field(value: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof key === 'number') current = Array.isArray(current) ? current[key] : undefined;
    else current = isObject(current) ? current[key] : undefined;
  }
  return current;
}

export function str(value: unknown, ...path: Array<string | number>): string {
  const found = field(value, ...path);
  if (typeof found !== 'string') throw new Error(`expected a string at ${path.join('.')}, got ${JSON.stringify(found)}`);
  return found;
}

export function list(value: unknown, ...path: Array<string | number>): unknown[] {
  const found = field(value, ...path);
  if (!Array.isArray(found)) throw new Error(`expected an array at ${path.join('.')}, got ${JSON.stringify(found)}`);
  return found;
}

/** POST one JSON-RPC message the way a 2025-era client does, and decode JSON or SSE answers. */
export async function rpc(
  url: string,
  message: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: unknown; raw: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(message),
  });
  const raw = await response.text();
  let body: unknown;
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = raw
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6));
    body = data.length > 0 ? JSON.parse(data[data.length - 1] ?? 'null') : undefined;
  } else {
    body = raw ? JSON.parse(raw) : undefined;
  }
  return { status: response.status, headers: response.headers, body, raw };
}

export function initializeMessage(protocolVersion: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-http', version: '0.0.0' } },
  };
}
