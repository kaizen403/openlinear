import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const { mockCreate, mockToFile } = vi.hoisted(() => ({
  mockCreate: vi.fn(async () => ({ text: 'Hello world' })),
  mockToFile: vi.fn(async () => 'mock-file'),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (_req: any, _res: any, next: any) => {
    _req.userId = 'test-user-id';
    _req.username = 'testuser';
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  AuthRequest: {} as any,
}));

vi.mock('openai', () => {
  class MockOpenAI {
    audio = {
      transcriptions: {
        create: mockCreate,
      },
    };
  }
  (MockOpenAI as any).toFile = mockToFile;
  return { default: MockOpenAI, OpenAI: MockOpenAI };
});

import { createApp } from '../app';

describe('Transcribe API', () => {
  const app = createApp();
  let savedApiKey: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env.BRAINSTORM_API_KEY;
    process.env.BRAINSTORM_API_KEY = 'test-key-123';
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ text: 'Hello world' });
    mockToFile.mockResolvedValue('mock-file');
  });

  afterEach(() => {
    if (savedApiKey !== undefined) {
      process.env.BRAINSTORM_API_KEY = savedApiKey;
    } else {
      delete process.env.BRAINSTORM_API_KEY;
    }
  });

  describe('POST /api/transcribe', () => {
    it('transcribes audio successfully', async () => {
      const audioBuffer = Buffer.from('fake-audio-data');

      const res = await request(app)
        .post('/api/transcribe')
        .set('Content-Type', 'audio/mp4')
        .send(audioBuffer);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ text: 'Hello world' });
      expect(mockToFile).toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith({
        model: 'whisper-1',
        file: 'mock-file',
      });
    });

    it('returns 400 when no audio data provided', async () => {
      const res = await request(app)
        .post('/api/transcribe')
        .set('Content-Type', 'audio/mp4')
        .send(Buffer.alloc(0));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No audio data provided');
    });

    it('returns 503 when BRAINSTORM_API_KEY is not set', async () => {
      delete process.env.BRAINSTORM_API_KEY;

      const audioBuffer = Buffer.from('fake-audio-data');
      const res = await request(app)
        .post('/api/transcribe')
        .set('Content-Type', 'audio/mp4')
        .send(audioBuffer);

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('AI provider not configured');
    });

    it('returns 500 when OpenAI transcription fails', async () => {
      mockCreate.mockRejectedValue(new Error('OpenAI API error'));

      const audioBuffer = Buffer.from('fake-audio-data');
      const res = await request(app)
        .post('/api/transcribe')
        .set('Content-Type', 'audio/mp4')
        .send(audioBuffer);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('OpenAI API error');
    });

    it('handles webm audio content type', async () => {
      const audioBuffer = Buffer.from('fake-webm-data');

      const res = await request(app)
        .post('/api/transcribe')
        .set('Content-Type', 'audio/webm')
        .send(audioBuffer);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ text: 'Hello world' });
    });
  });
});
