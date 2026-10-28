import { execFile } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCredentialEnv } from './git-credentials';

/**
 * W10a, real git: the URL-scoped header from createGitCredentialEnv reaches
 * the repository it was issued for and nothing else. A loopback HTTP server
 * records the headers of every request git makes (and answers 401, so git
 * stops after the discovery request); git runs with a minimal environment so
 * no user/system config or credential helper can interfere.
 */

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
}

let server: Server;
let base = '';
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    res.writeHead(401, { 'www-authenticate': 'Basic realm="test"' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function lsRemote(url: string, extraEnv: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'credential.helper=', '-c', 'protocol.http.allow=always', 'ls-remote', '--', url], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: '/nonexistent-openlinear-test-home',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/bin/false',
        ...extraEnv,
      },
      timeout: 15_000,
    }, () => resolve());
  });
}

describe('W10a header credentials with real git', () => {
  it('sends the Authorization header to the scoped repository only', async () => {
    const token = 'ghs_realgit_scoped_token_0123456789';
    const scoped = `${base}/acme/repo.git`;
    const env = createGitCredentialEnv(token, scoped);
    const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

    seen.length = 0;
    await lsRemote(scoped, env);
    const toScoped = seen.filter((request) => request.path.startsWith('/acme/repo.git/'));
    expect(toScoped.length).toBeGreaterThan(0);
    expect(toScoped[0]?.headers.authorization).toBe(expected);

    seen.length = 0;
    await lsRemote(`${base}/other/repo.git`, env);
    const toOther = seen.filter((request) => request.path.startsWith('/other/repo.git/'));
    expect(toOther.length).toBeGreaterThan(0);
    expect(toOther.every((request) => request.headers.authorization === undefined)).toBe(true);
  });

  it('sends nothing when no credential env is given', async () => {
    seen.length = 0;
    await lsRemote(`${base}/acme/repo.git`, createGitCredentialEnv(null, `${base}/acme/repo.git`));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((request) => request.headers.authorization === undefined)).toBe(true);
  });
});
