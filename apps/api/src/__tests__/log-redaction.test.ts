/**
 * W02b log redaction: the HTTP logger configuration used by `createApp()`
 * keeps credentials out of log lines — query-string secrets (also inside the
 * logged URL), credential headers, redirect locations, credential-bearing
 * body fields, and token-shaped values anywhere in a line.
 */
import { Writable } from 'node:stream';
import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { describe, expect, it } from 'vitest';
import { startTestServer } from './http';
import { LOG_REDACT_PATHS, httpLogRedaction, redactUrlSecrets, scrubSecrets } from '../logger';

const PAT = `ol_pat_${'a1'.repeat(16)}`;
const TICKET = 'ol_sse_TicketValue_0123456789abcdef';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1MSJ9.c2lnbmF0dXJlLXZhbHVl';
const REFRESH = 'refresh-RANDOMVALUE-0123456789';
const OAUTH_CODE = 'oauth-code-VALUE-123';
const OAUTH_STATE = 'oauth-state-VALUE-456';
const PASSWORD = 'pa55word-VALUE';
const CLIENT_SECRET = 'client-secret-VALUE';
const SECRETS = [PAT, TICKET, JWT, REFRESH, OAUTH_CODE, OAUTH_STATE, PASSWORD, CLIENT_SECRET];

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const base = pino({ redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' }, hooks: { streamWrite: scrubSecrets } }, stream);
  return { base, lines };
}

describe('W02b log redaction', () => {
  it('keeps secrets out of HTTP request logs', async () => {
    const { base, lines } = capture();
    const app = express();
    app.use(pinoHttp({ logger: base, ...httpLogRedaction() }));
    app.use(express.json());
    app.post('/api/echo', (req, res) => {
      req.log.info({ body: req.body }, 'handler saw body');
      res.json({ ok: true });
    });
    app.get('/api/redirect', (_req, res) => {
      res.redirect(`http://localhost:3000/auth/session?token=${encodeURIComponent(JWT)}`);
    });

    const server = await startTestServer(app);
    try {
      await server.client()
        .post(`/api/echo?ticket=${TICKET}&token=${JWT}&code=${OAUTH_CODE}&state=${OAUTH_STATE}&refreshToken=${REFRESH}&lastEventId=42`)
        .set('Authorization', `Bearer ${PAT}`)
        .set('Cookie', `ol_refresh=${REFRESH}`)
        .send({ name: 'visible-name', password: PASSWORD, refreshToken: REFRESH, clientSecret: CLIENT_SECRET, tempToken: TICKET });
      await server.client().get('/api/redirect').redirects(0);
    } finally {
      await server.close();
    }

    const output = lines.join('');
    expect(output.length).toBeGreaterThan(0);
    for (const secret of SECRETS) {
      expect(output, `log output leaked ${secret}`).not.toContain(secret);
    }
    // Non-secret context survives.
    expect(output).toContain('lastEventId=42');
    expect(output).toContain('visible-name');
    expect(output).toContain('/api/echo?');
  });

  it('masks credential-shaped values in any field or message', () => {
    const { base, lines } = capture();
    base.warn({ detail: `upstream said ${PAT} and ${JWT}` }, `token ${TICKET} rejected`);
    const output = lines.join('');
    for (const secret of [PAT, JWT, TICKET]) expect(output).not.toContain(secret);
    expect(output).toContain('ol_pat_[REDACTED]');
  });

  it('redacts only sensitive query parameters of a URL', () => {
    expect(redactUrlSecrets('/api/events?ticket=abc&lastEventId=7')).toBe('/api/events?ticket=[REDACTED]&lastEventId=7');
    expect(redactUrlSecrets('/cb?Code=x&STATE=y#frag')).toBe('/cb?Code=[REDACTED]&STATE=[REDACTED]#frag');
    expect(redactUrlSecrets('/plain/path')).toBe('/plain/path');
  });
});
