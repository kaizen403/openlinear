import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';

describe('Repos API auth', () => {
  const app = createApp();

  it('requires auth for public repository reads', async () => {
    const publicRes = await request(app).get('/api/repos/public');
    const activeRes = await request(app).get('/api/repos/active/public');

    expect(publicRes.status).toBe(401);
    expect(activeRes.status).toBe(401);
  });

  it('requires auth for public repository writes', async () => {
    const addRes = await request(app)
      .post('/api/repos/url')
      .send({ url: 'https://github.com/openai/openai-node' });
    const activateRes = await request(app).post('/api/repos/repo-id/activate/public');

    expect(addRes.status).toBe(401);
    expect(activateRes.status).toBe(401);
  });
});
