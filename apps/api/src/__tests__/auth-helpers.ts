/**
 * Helpers for the W02b auth tests: real `Session` rows (so revocation,
 * rotation and ticket binding behave as in production), PATs, users.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Application } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { JWT_AUDIENCE, JWT_ISSUER } from '@openlinear/api-core';
import { hashToken } from '../services/sessions';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { testJwtSecret } from './test-env';

export interface TestUser {
  id: string;
  username: string;
  email: string | null;
}

export async function makeUser(label: string, suffix: string): Promise<TestUser> {
  return prisma.user.create({
    data: {
      githubId: `${label}-${suffix}`,
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.com`,
    },
    select: { id: true, username: true, email: true },
  });
}

export interface TestSession {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  familyId: string;
}

/** Mirrors `issueSession`: a production-shaped access JWT backed by a Session row. */
export async function createTestSession(user: { id: string; username: string }, familyId?: string): Promise<TestSession> {
  const accessToken = jwt.sign(
    { userId: user.id, username: user.username, typ: 'access' },
    testJwtSecret(),
    { expiresIn: '1h', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, jwtid: randomUUID() },
  );
  const refreshToken = randomBytes(32).toString('base64url');
  const family = familyId ?? randomBytes(16).toString('hex');
  const row = await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(accessToken),
      refreshTokenHash: hashToken(refreshToken),
      familyId: family,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    select: { id: true },
  });
  return { accessToken, refreshToken, sessionId: row.id, familyId: family };
}

export async function createPat(
  userId: string,
  scopes: string[],
  extra: { workspaceId?: string | null; revokedAt?: Date; expiresAt?: Date | null; name?: string } = {},
): Promise<{ token: string; id: string }> {
  const token = generatePersonalAccessToken();
  const row = await prisma.personalAccessToken.create({
    data: {
      userId,
      name: extra.name ?? 'w02b-test',
      tokenHash: hashPersonalAccessToken(token),
      tokenPrefix: token.slice(0, 15),
      scopes,
      workspaceId: extra.workspaceId ?? null,
      revokedAt: extra.revokedAt ?? null,
      expiresAt: extra.expiresAt ?? null,
    },
  });
  return { token, id: row.id };
}

export async function listen(app: Application): Promise<{ server: Server; baseUrl: string }> {
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

export async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  const closing = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closing;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export interface OpenStream {
  status: number;
  /** Raw SSE text received so far. */
  text: () => string;
  /** True once the server ended the response. */
  ended: () => boolean;
  close: () => Promise<void>;
}

/** Open an SSE stream (or return the error response) with a real HTTP client. */
export async function openStream(
  baseUrl: string,
  options: { ticket?: string; bearer?: string; lastEventId?: string },
): Promise<OpenStream> {
  const controller = new AbortController();
  const url = new URL(`${baseUrl}/api/events`);
  if (options.ticket) url.searchParams.set('ticket', options.ticket);
  if (options.lastEventId) url.searchParams.set('lastEventId', options.lastEventId);
  const response = await fetch(url, {
    headers: options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {},
    signal: controller.signal,
  });
  let body = '';
  let ended = false;
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    body = await response.text();
    return { status: response.status, text: () => body, ended: () => true, close: async () => undefined };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let stop = false;
  const pump = (async () => {
    try {
      while (!stop) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      // aborted
    } finally {
      ended = true;
    }
  })();
  return {
    status: response.status,
    text: () => body,
    ended: () => ended,
    close: async () => {
      stop = true;
      controller.abort();
      await pump;
    },
  };
}

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
}

export function parseSseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim() || block.startsWith(':')) continue;
    const frame: SseFrame = {};
    for (const line of block.split('\n')) {
      const index = line.indexOf(': ');
      if (index < 0) continue;
      const key = line.slice(0, index);
      const value = line.slice(index + 2);
      if (key === 'id') frame.id = value;
      else if (key === 'event') frame.event = value;
      else if (key === 'data') frame.data = value;
    }
    frames.push(frame);
  }
  return frames;
}
