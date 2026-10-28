/**
 * Loopback stand-in for an OpenAI-compatible chat-completions provider.
 *
 * Tests script one response per request (JSON error, SSE stream, dropped
 * socket) and inspect every request body the client sent. It binds an
 * ephemeral port on 127.0.0.1 and never reaches the network, so no test makes
 * a paid or real provider call.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  body: unknown;
}

export type FakeResponse =
  | { kind: 'json'; status: number; body: unknown; headers?: Record<string, string> }
  | {
      kind: 'sse';
      /** Each entry is one `data:` payload; objects are JSON-encoded. */
      frames: Array<string | Record<string, unknown>>;
      headers?: Record<string, string>;
      /** Use CRLF line endings, as some proxies do. */
      crlf?: boolean;
      /** Write the stream in small fragments so frames straddle reads. */
      fragment?: boolean;
      /** Omit the blank line after the last frame (exercises the final-buffer flush). */
      unterminatedLastFrame?: boolean;
      /** Close the connection after the frames without `[DONE]`. */
      omitDone?: boolean;
    }
  | { kind: 'destroy' }
  | { kind: 'hang' };

export type FakeResponder = FakeResponse | ((request: RecordedRequest, index: number) => FakeResponse);

export interface FakeLLMProvider {
  baseUrl: string;
  requests: RecordedRequest[];
  enqueue(...responses: FakeResponder[]): void;
  /** Used when the queue is empty. */
  setFallback(responder: FakeResponder | null): void;
  /** Drop scripted responses and recorded requests (call between tests). */
  reset(): void;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeSse(res: http.ServerResponse, response: Extract<FakeResponse, { kind: 'sse' }>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', ...(response.headers ?? {}) });
  const newline = response.crlf ? '\r\n' : '\n';
  const payloads = response.frames.map((frame) => (typeof frame === 'string' ? frame : JSON.stringify(frame)));
  if (!response.omitDone) payloads.push('[DONE]');
  let text = payloads
    .map((payload, index) => {
      const last = index === payloads.length - 1;
      return `data: ${payload}${newline}${last && response.unterminatedLastFrame ? '' : newline}`;
    })
    .join('');
  if (!response.fragment) {
    res.end(text);
    return;
  }
  const pieces: string[] = [];
  while (text.length > 0) {
    pieces.push(text.slice(0, 7));
    text = text.slice(7);
  }
  for (const piece of pieces) res.write(piece);
  res.end();
}

export async function startFakeLLMProvider(): Promise<FakeLLMProvider> {
  const requests: RecordedRequest[] = [];
  const queue: FakeResponder[] = [];
  let fallback: FakeResponder | null = null;
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        body = null;
      }
      const recorded: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, rawBody, body };
      const index = requests.length;
      requests.push(recorded);

      const next = queue.shift() ?? fallback;
      if (!next) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fake provider has no scripted response' } }));
        return;
      }
      const response = typeof next === 'function' ? next(recorded, index) : next;
      switch (response.kind) {
        case 'json':
          res.writeHead(response.status, { 'content-type': 'application/json', ...(response.headers ?? {}) });
          res.end(JSON.stringify(response.body));
          return;
        case 'sse':
          writeSse(res, response);
          return;
        case 'destroy':
          req.socket.destroy();
          return;
        case 'hang':
          return;
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    enqueue: (...responses) => {
      queue.push(...responses);
    },
    setFallback: (responder) => {
      fallback = responder;
    },
    reset: () => {
      queue.length = 0;
      fallback = null;
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

// ─── Frame builders (OpenAI chat.completion.chunk shape) ──────────────────────

export function textFrame(content: string, id = 'chatcmpl-fake'): Record<string, unknown> {
  return { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

export function toolCallFrame(
  index: number,
  call: { id?: string; name?: string; arguments?: string },
): Record<string, unknown> {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index,
          ...(call.id ? { id: call.id, type: 'function' } : {}),
          function: { ...(call.name ? { name: call.name } : {}), arguments: call.arguments ?? '' },
        }],
      },
      finish_reason: null,
    }],
  };
}

export function finishFrame(reason: string, usage?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    ...(usage ? { usage } : {}),
  };
}

/** The trailing usage-only chunk `stream_options.include_usage` produces. */
export function usageFrame(usage: Record<string, unknown>): Record<string, unknown> {
  return { id: 'chatcmpl-fake', object: 'chat.completion.chunk', choices: [], usage };
}

export function textStream(content: string, usage?: Record<string, unknown>): FakeResponse {
  return {
    kind: 'sse',
    frames: [textFrame(content), finishFrame('stop'), ...(usage ? [usageFrame(usage)] : [])],
  };
}

export function requestMessages(request: RecordedRequest): unknown[] {
  return isRecord(request.body) && Array.isArray(request.body.messages) ? request.body.messages : [];
}
