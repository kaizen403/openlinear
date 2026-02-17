import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../middleware/auth', () => ({
  requireAuth: (_req: any, _res: any, next: any) => {
    _req.userId = 'test-user-id';
    _req.username = 'testuser';
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  AuthRequest: {} as any,
}));

vi.mock('../services/brainstorm', () => ({
  checkBrainstormAvailability: vi.fn(() => ({
    available: true,
    provider: 'openai',
    webSearchAvailable: true,
  })),
  generateQuestions: vi.fn(async () => [
    'What framework do you prefer?',
    'What is the target audience?',
    'What is the timeline?',
  ]),
  generateTasks: vi.fn(async function* () {
    yield { title: 'Set up project', description: 'Initialize the project structure', priority: 'high' };
    yield { title: 'Create components', description: 'Build the UI components', priority: 'medium' };
  }),
}));

import { createApp } from '../app';
import { checkBrainstormAvailability, generateQuestions } from '../services/brainstorm';

describe('Brainstorm API', () => {
  const app = createApp();

  beforeEach(() => {
    process.env.BRAINSTORM_API_KEY = 'test-key-123';
    process.env.BRAINSTORM_PROVIDER = 'openai';
    vi.clearAllMocks();
    vi.mocked(checkBrainstormAvailability).mockReturnValue({
      available: true,
      provider: 'openai',
      webSearchAvailable: true,
    });
    vi.mocked(generateQuestions).mockResolvedValue([
      'What framework do you prefer?',
      'What is the target audience?',
      'What is the timeline?',
    ]);
  });

  describe('GET /api/brainstorm/availability', () => {
    it('returns availability with webSearchAvailable field', async () => {
      const res = await request(app).get('/api/brainstorm/availability');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('available', true);
      expect(res.body).toHaveProperty('provider', 'openai');
      expect(res.body).toHaveProperty('webSearchAvailable', true);
    });

    it('returns webSearchAvailable: false for non-openai provider', async () => {
      vi.mocked(checkBrainstormAvailability).mockReturnValue({
        available: true,
        provider: 'anthropic',
        webSearchAvailable: false,
      });

      const res = await request(app).get('/api/brainstorm/availability');
      expect(res.status).toBe(200);
      expect(res.body.webSearchAvailable).toBe(false);
    });
  });

  describe('POST /api/brainstorm/questions', () => {
    it('returns questions with webSearch: true', async () => {
      const res = await request(app)
        .post('/api/brainstorm/questions')
        .send({ prompt: 'Build a todo app', webSearch: true });

      expect(res.status).toBe(200);
      expect(res.body.questions).toBeInstanceOf(Array);
      expect(res.body.questions).toHaveLength(3);
      expect(generateQuestions).toHaveBeenCalledWith('Build a todo app', true);
    });

    it('returns questions with webSearch: false', async () => {
      const res = await request(app)
        .post('/api/brainstorm/questions')
        .send({ prompt: 'Build a todo app', webSearch: false });

      expect(res.status).toBe(200);
      expect(res.body.questions).toBeInstanceOf(Array);
      expect(generateQuestions).toHaveBeenCalledWith('Build a todo app', false);
    });

    it('returns questions without webSearch field (backward compat, defaults to false)', async () => {
      const res = await request(app)
        .post('/api/brainstorm/questions')
        .send({ prompt: 'Build a todo app' });

      expect(res.status).toBe(200);
      expect(res.body.questions).toBeInstanceOf(Array);
      expect(generateQuestions).toHaveBeenCalledWith('Build a todo app', false);
    });

    it('returns 400 with empty prompt', async () => {
      const res = await request(app)
        .post('/api/brainstorm/questions')
        .send({ prompt: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 with missing prompt', async () => {
      const res = await request(app)
        .post('/api/brainstorm/questions')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 503 when brainstorm is unavailable', async () => {
      vi.mocked(checkBrainstormAvailability).mockReturnValue({
        available: false,
        provider: '',
        webSearchAvailable: false,
        error: 'BRAINSTORM_API_KEY not configured',
      });

      const res = await request(app)
        .post('/api/brainstorm/questions')
        .send({ prompt: 'Build a todo app' });

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('No AI provider configured');
    });
  });

  describe('POST /api/brainstorm/generate', () => {
    it('streams NDJSON tasks with valid body', async () => {
      const res = await request(app)
        .post('/api/brainstorm/generate')
        .send({
          prompt: 'Build a todo app',
          answers: [{ question: 'What framework?', answer: 'React' }],
          webSearch: false,
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/x-ndjson');

      const lines = res.text.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(2);

      const task1 = JSON.parse(lines[0]);
      expect(task1).toHaveProperty('title', 'Set up project');
      expect(task1).toHaveProperty('description');
      expect(task1).toHaveProperty('priority', 'high');

      const task2 = JSON.parse(lines[1]);
      expect(task2).toHaveProperty('title', 'Create components');
      expect(task2).toHaveProperty('priority', 'medium');
    });

    it('accepts webSearch: true in generate body', async () => {
      const { generateTasks } = await import('../services/brainstorm');

      const res = await request(app)
        .post('/api/brainstorm/generate')
        .send({
          prompt: 'Build a todo app',
          answers: [{ question: 'What framework?', answer: 'React' }],
          webSearch: true,
        });

      expect(res.status).toBe(200);
      expect(generateTasks).toHaveBeenCalledWith(
        'Build a todo app',
        [{ question: 'What framework?', answer: 'React' }],
        true,
      );
    });

    it('returns 400 with missing prompt', async () => {
      const res = await request(app)
        .post('/api/brainstorm/generate')
        .send({ answers: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 with missing answers', async () => {
      const res = await request(app)
        .post('/api/brainstorm/generate')
        .send({ prompt: 'Build a todo app' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 503 when brainstorm is unavailable', async () => {
      vi.mocked(checkBrainstormAvailability).mockReturnValue({
        available: false,
        provider: '',
        webSearchAvailable: false,
      });

      const res = await request(app)
        .post('/api/brainstorm/generate')
        .send({
          prompt: 'Build a todo app',
          answers: [{ question: 'Q?', answer: 'A' }],
        });

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('No AI provider configured');
    });
  });
});
