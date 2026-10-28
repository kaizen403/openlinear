import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors requireAuth's observable contract: no proof of identity, no
// response at all (the fix for C6a F13 — this route previously had no auth).
vi.mock('../auth/principal', () => ({
  requireSidecarAuth: (req, res, next) => {
    const userId = req.get('x-user-id');
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.userId = userId;
    next();
  },
}));

const { default: transcribeRouter } = await import('./transcribe');
const AUTH_HEADERS = { 'x-user-id': 'user-1' };

const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]);
const WAV_MAGIC = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WAVE', 'ascii'),
  Buffer.from([0, 0]),
]);
const OGG_MAGIC = Buffer.from('OggS  extra bytes', 'ascii');
const MP3_ID3_MAGIC = Buffer.from('ID3 rest of frame', 'ascii');

function makeApp() {
  const app = express();
  app.use('/', transcribeRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ error: 'internal error' });
  });
  return app;
}

async function postAudio(app, { headers = {}, contentType, body } = {}) {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const reqHeaders = { ...headers };
      if (contentType) reqHeaders['content-type'] = contentType;
      if (body) reqHeaders['content-length'] = Buffer.byteLength(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/',
        method: 'POST',
        headers: reqHeaders,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('POST /api/transcribe', () => {
  const ORIGINAL_ENV = { ...process.env };
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.CARTESIA_API_KEY = 'test-key';
    delete process.env.CARTESIA_STT_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it('rejects an unauthenticated request before reading any audio', async () => {
    const app = makeApp();
    await expect(postAudio(app, { contentType: 'audio/webm', body: WEBM_MAGIC })).resolves.toEqual({
      status: 401,
      body: { error: 'Authentication required' },
    });
  });

  it('returns 503 when no Cartesia API key is configured', async () => {
    delete process.env.CARTESIA_API_KEY;
    const app = makeApp();

    await expect(postAudio(app, {
      headers: AUTH_HEADERS,
      contentType: 'audio/webm',
      body: WEBM_MAGIC,
    })).resolves.toEqual({
      status: 503,
      body: { error: 'Transcription service not configured' },
    });
  });

  it('rejects a disallowed content type with 415', async () => {
    const app = makeApp();

    await expect(postAudio(app, {
      headers: AUTH_HEADERS,
      contentType: 'application/octet-stream',
      body: Buffer.from('whatever'),
    })).resolves.toEqual({
      status: 415,
      body: { error: 'Unsupported audio content type' },
    });
  });

  it('rejects a body whose bytes do not match its declared content type', async () => {
    const app = makeApp();

    await expect(postAudio(app, {
      headers: AUTH_HEADERS,
      contentType: 'audio/webm',
      body: Buffer.from('not actually webm'),
    })).resolves.toEqual({
      status: 400,
      body: { error: 'Audio data does not match its declared content type' },
    });
  });

  it('rejects an empty body', async () => {
    const app = makeApp();

    await expect(postAudio(app, {
      headers: AUTH_HEADERS,
      contentType: 'audio/webm',
      body: Buffer.alloc(0),
    })).resolves.toEqual({
      status: 400,
      body: { error: 'No audio data received' },
    });
  });

  it.each([
    ['audio/webm', WEBM_MAGIC],
    ['audio/wav', WAV_MAGIC],
    ['audio/ogg', OGG_MAGIC],
    ['audio/mpeg', MP3_ID3_MAGIC],
  ])('accepts valid %s audio and forwards it to Cartesia', async (contentType, buf) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: '  hello world  ' }),
    });
    globalThis.fetch = fetchMock;
    const app = makeApp();

    await expect(postAudio(app, { headers: AUTH_HEADERS, contentType, body: buf })).resolves.toEqual({
      status: 200,
      body: {
        text: 'hello world',
        usage: {
          surface: 'transcription',
          provider: 'cartesia',
          model: 'ink-whisper',
          status: 'succeeded',
          audioBytes: buf.length,
          audioSeconds: null,
          latencyMs: expect.any(Number),
          costUsd: null,
          costBasis: 'unknown',
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cartesia.ai/stt',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('reports the audio duration Cartesia returns, and an unknown (null) cost', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hi', duration: 3.25 }),
    });
    const app = makeApp();

    const result = await postAudio(app, { headers: AUTH_HEADERS, contentType: 'audio/webm', body: WEBM_MAGIC });

    expect(result.status).toBe(200);
    expect(result.body.usage).toMatchObject({ audioSeconds: 3.25, audioBytes: WEBM_MAGIC.length, costUsd: null, costBasis: 'unknown' });
  });

  it('returns a generic 502 and never leaks upstream error detail when Cartesia rejects the request', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'super secret upstream diagnostic detail',
    });
    const app = makeApp();

    const result = await postAudio(app, { headers: AUTH_HEADERS, contentType: 'audio/webm', body: WEBM_MAGIC });

    expect(result).toEqual({ status: 502, body: { error: 'Transcription failed' } });
    expect(JSON.stringify(result.body)).not.toContain('super secret upstream diagnostic detail');
  });

  it('returns a generic 502 and never leaks the raw error message when the outbound request throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET: /var/secrets/leaked-path'));
    const app = makeApp();

    const result = await postAudio(app, { headers: AUTH_HEADERS, contentType: 'audio/webm', body: WEBM_MAGIC });

    expect(result).toEqual({ status: 502, body: { error: 'Transcription failed' } });
    expect(JSON.stringify(result.body)).not.toContain('leaked-path');
  });

  it('ignores a CARTESIA_STT_URL override that is not https + allowlisted, falling back to the pinned default', async () => {
    process.env.CARTESIA_STT_URL = 'http://evil.example.com/steal';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'ok' }) });
    globalThis.fetch = fetchMock;
    const app = makeApp();

    await postAudio(app, { headers: AUTH_HEADERS, contentType: 'audio/webm', body: WEBM_MAGIC });

    expect(fetchMock).toHaveBeenCalledWith('https://api.cartesia.ai/stt', expect.any(Object));
  });

  it('accepts a well-formed https CARTESIA_STT_URL override on the allowlisted host', async () => {
    process.env.CARTESIA_STT_URL = 'https://api.cartesia.ai/v2/stt';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'ok' }) });
    globalThis.fetch = fetchMock;
    const app = makeApp();

    await postAudio(app, { headers: AUTH_HEADERS, contentType: 'audio/webm', body: WEBM_MAGIC });

    expect(fetchMock).toHaveBeenCalledWith('https://api.cartesia.ai/v2/stt', expect.any(Object));
  });
});
