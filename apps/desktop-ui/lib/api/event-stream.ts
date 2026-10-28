/**
 * Server-sent event streams over `fetch`.
 *
 * Native `EventSource` cannot send an Authorization header (the local sidecar
 * stream requires one), cannot be told which `Last-Event-ID` to resume from
 * after we rebuild the URL with a fresh ticket, and is absent from the unit
 * test environment. This module reads `text/event-stream` bodies directly:
 *
 * - `SseParser` implements the WHATWG event-stream format (fields, comments,
 *   multi-line data, CR/LF/CRLF, the persistent last-event-id buffer).
 * - `EventStreamConnection` owns one stream: it asks `prepare(cursor)` for the
 *   URL and headers on every attempt (minting a new ticket each time), keeps
 *   its own resume cursor, and reconnects with capped exponential backoff.
 * - `RecentEventIds` drops events already delivered on the same stream (a
 *   replay after reconnect can resend them), keyed by (stream, event id) —
 *   never by payload text or timestamps.
 */

export type EventStreamName = 'cloud' | 'local';

export interface ParsedSseEvent {
  /** `event:` field; `message` when absent. */
  type: string;
  data: string;
  /** The `id:` field sent with this event, if any. */
  id: string | null;
  /** The stream's last-event-id buffer after this event (the resume cursor). */
  lastEventId: string | null;
}

export class SseParser {
  private buffer = '';
  private pendingCR = false;
  private dataLines: string[] = [];
  private eventType = '';
  private eventId: string | null = null;
  private lastEventIdBuffer: string | null = null;
  /** Milliseconds from the last `retry:` field, if any. */
  retryMs: number | null = null;

  /** Feed a decoded chunk; returns the events it completed. */
  push(chunk: string): ParsedSseEvent[] {
    const events: ParsedSseEvent[] = [];
    let text = chunk;
    if (this.pendingCR) {
      // A CR at the end of the previous chunk already ended its line.
      if (text.startsWith('\n')) text = text.slice(1);
      this.pendingCR = false;
    }
    this.buffer += text;

    let start = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      const line = this.buffer.slice(start, i);
      if (ch === '\r') {
        if (i + 1 < this.buffer.length) {
          if (this.buffer[i + 1] === '\n') i += 1;
        } else {
          this.pendingCR = true;
        }
      }
      start = i + 1;
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  private processLine(line: string): ParsedSseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\u0000')) {
          this.eventId = value;
          this.lastEventIdBuffer = value;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break;
    }
    return null;
  }

  private dispatch(): ParsedSseEvent | null {
    const hasData = this.dataLines.length > 0;
    const event: ParsedSseEvent = {
      type: this.eventType || 'message',
      data: this.dataLines.join('\n'),
      id: this.eventId,
      lastEventId: this.lastEventIdBuffer,
    };
    this.dataLines = [];
    this.eventType = '';
    this.eventId = null;
    return hasData ? event : null;
  }
}

export interface StreamMessage extends ParsedSseEvent {
  stream: EventStreamName;
}

export type EventStreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface EventStreamRequest {
  url: string;
  headers?: Record<string, string>;
}

export interface EventStreamOptions {
  name: EventStreamName;
  /**
   * Build the request for one connection attempt. `cursor` is the last
   * resumable event id this stream has seen (or null). Return null to skip
   * this attempt (signed out, ticket unavailable); a retry is scheduled.
   */
  prepare: (cursor: string | null) => Promise<EventStreamRequest | null>;
  /** Called on a 401/403 response, e.g. to refresh the access token. */
  onUnauthorized?: () => Promise<unknown>;
  /** Which event ids may be used as a resume cursor (default: any). */
  isCursor?: (id: string) => boolean;
  onMessage: (message: StreamMessage) => void;
  onStateChange?: (state: EventStreamState) => void;
  fetchImpl?: typeof fetch;
  /** Delay before reconnect attempt `attempt` (1-based). */
  backoffMs?: (attempt: number) => number;
}

export const SSE_MAX_BACKOFF_MS = 30_000;

export function defaultBackoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = 1000 * 2 ** Math.min(attempt - 1, 5);
  return Math.min(SSE_MAX_BACKOFF_MS, exp + random() * 1000);
}

export class EventStreamConnection {
  private stopped = true;
  private attempts = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentCursor: string | null = null;
  private currentState: EventStreamState = 'idle';
  private generation = 0;

  constructor(private readonly options: EventStreamOptions) {}

  get cursor(): string | null {
    return this.currentCursor;
  }

  get state(): EventStreamState {
    return this.currentState;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    void this.connect(++this.generation);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.setState('closed');
  }

  private setState(state: EventStreamState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.options.onStateChange?.(state);
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private scheduleReconnect(generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.attempts += 1;
    this.setState('reconnecting');
    const delay = (this.options.backoffMs ?? defaultBackoffMs)(this.attempts);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.isCurrent(generation)) void this.connect(generation);
    }, delay);
  }

  private async connect(generation: number): Promise<void> {
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');

    let request: EventStreamRequest | null = null;
    try {
      request = await this.options.prepare(this.currentCursor);
    } catch {
      request = null;
    }
    if (!this.isCurrent(generation)) return;
    if (!request) {
      this.scheduleReconnect(generation);
      return;
    }

    const controller = new AbortController();
    this.controller = controller;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...request.headers },
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    if (!this.isCurrent(generation)) {
      controller.abort();
      return;
    }

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      await this.options.onUnauthorized?.().catch(() => undefined);
      this.scheduleReconnect(generation);
      return;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      this.scheduleReconnect(generation);
      return;
    }

    this.attempts = 0;
    this.setState('open');
    await this.read(response.body, generation);
    if (this.isCurrent(generation)) this.scheduleReconnect(generation);
  }

  private async read(body: ReadableStream<Uint8Array>, generation: number): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const isCursor = this.options.isCursor ?? (() => true);
    try {
      while (this.isCurrent(generation)) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          if (!this.isCurrent(generation)) return;
          if (event.id && isCursor(event.id)) this.currentCursor = event.id;
          this.options.onMessage({ ...event, stream: this.options.name });
        }
      }
    } catch {
      // Network drop or abort; the caller decides whether to reconnect.
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Remembers the most recent event ids per stream so a replayed event is
 * delivered once. Bounded: the oldest ids are forgotten first.
 */
export class RecentEventIds {
  private readonly seen = new Map<EventStreamName, Set<string>>();

  constructor(private readonly capacity = 2_000) {}

  /** True the first time (stream, id) is offered; false for a repeat. */
  firstSighting(stream: EventStreamName, id: string): boolean {
    let ids = this.seen.get(stream);
    if (!ids) {
      ids = new Set();
      this.seen.set(stream, ids);
    }
    if (ids.has(id)) return false;
    ids.add(id);
    if (ids.size > this.capacity) {
      const oldest = ids.values().next().value;
      if (oldest !== undefined) ids.delete(oldest);
    }
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}
