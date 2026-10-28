import { StringDecoder } from 'node:string_decoder';

/** Largest single JSONL line accepted from a runner (tool results can be large). */
export const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;

export type JsonLine =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid_json' | 'too_long'; sample: string };

/** First characters of a rejected line, for a diagnostic. Never the whole line. */
export function lineSample(raw: string, max = 160): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Splits a byte stream into JSON lines. Blank lines are skipped; a line that
 * is not JSON, or that exceeds `maxBytes`, is reported instead of thrown so a
 * single bad line never ends the stream.
 */
export class JsonLineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private discarding = false;

  constructor(
    private readonly onLine: (line: JsonLine) => void,
    private readonly maxBytes = MAX_JSONL_LINE_BYTES,
  ) {}

  push(chunk: Buffer | string): void {
    this.consume(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
  }

  end(): void {
    this.consume(this.decoder.end());
    if (this.discarding) {
      this.discarding = false;
      this.buffer = '';
      return;
    }
    if (this.buffer.trim()) this.emit(this.buffer);
    this.buffer = '';
  }

  private consume(text: string): void {
    let rest = text;
    for (;;) {
      const newline = rest.indexOf('\n');
      if (newline === -1) break;
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (this.discarding) {
        this.discarding = false;
        this.buffer = '';
        continue;
      }
      const line = this.buffer + piece;
      this.buffer = '';
      if (line.trim()) this.emit(line);
    }
    if (this.discarding) return;
    this.buffer += rest;
    if (Buffer.byteLength(this.buffer) > this.maxBytes) {
      this.onLine({ ok: false, reason: 'too_long', sample: lineSample(this.buffer) });
      this.buffer = '';
      this.discarding = true;
    }
  }

  private emit(raw: string): void {
    if (Buffer.byteLength(raw) > this.maxBytes) {
      this.onLine({ ok: false, reason: 'too_long', sample: lineSample(raw) });
      return;
    }
    try {
      this.onLine({ ok: true, value: JSON.parse(raw) as unknown });
    } catch {
      this.onLine({ ok: false, reason: 'invalid_json', sample: lineSample(raw) });
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
