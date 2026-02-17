import express, { Router, Response } from 'express';
import OpenAI from 'openai';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router: Router = Router();

router.use(express.raw({
  type: ['audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg'],
  limit: '10mb',
}));

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.body || (Buffer.isBuffer(req.body) && req.body.length === 0)) {
      res.status(400).json({ error: 'No audio data provided' });
      return;
    }

    const apiKey = process.env.BRAINSTORM_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: 'AI provider not configured' });
      return;
    }

    const client = new OpenAI({
      apiKey,
      ...(process.env.BRAINSTORM_BASE_URL && { baseURL: process.env.BRAINSTORM_BASE_URL }),
    });

    const contentType = req.headers['content-type'] || 'audio/mp4';
    const ext = contentType.split('/')[1] || 'mp4';
    const file = await OpenAI.toFile(req.body, `audio.${ext}`, { type: contentType });

    const transcription = await client.audio.transcriptions.create({
      model: 'whisper-1',
      file,
    });

    res.json({ text: transcription.text });
  } catch (error) {
    console.error('[Transcribe] Error:', error);
    const message = error instanceof Error ? error.message : 'Transcription failed';
    res.status(500).json({ error: message });
  }
});

export default router;
