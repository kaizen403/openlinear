import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const queryRawMock = vi.hoisted(() => vi.fn());

vi.mock('@openlinear/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openlinear/db')>();
  return {
    ...actual,
    prisma: {
      $queryRaw: queryRawMock,
    },
  };
});

import { createApp } from '../app';

describe('GET /health', () => {
  const app = createApp();

  beforeEach(() => {
    queryRawMock.mockReset();
    queryRawMock.mockResolvedValue([{ ok: 1 }]);
  });

  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('ok');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('clients');
    expect(queryRawMock).toHaveBeenCalledOnce();
  });

  it('returns 503 when the database check fails', async () => {
    queryRawMock.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.database).toBe('error');
  });
});
