import { Router, Request, Response } from 'express';
import type { Router as IRouter } from 'express';
import { logger } from '@openlinear/api/logger';

const router: IRouter = Router();

const CARTESIA_STT_URL = process.env.CARTESIA_STT_URL || 'https://api.cartesia.ai/stt';

router.post('/', async (req: Request, res: Response) => {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'Transcription service not configured' });
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  const audioBuffer = Buffer.concat(chunks);

  if (audioBuffer.length === 0) {
    res.status(400).json({ error: 'No audio data received' });
    return;
  }

  try {
    const blob = new Blob([audioBuffer], { type: 'audio/webm' });
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', 'ink-whisper');
    form.append('language', 'en');

    const response = await fetch(CARTESIA_STT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Cartesia-Version': '2026-03-01',
      },
      body: form,
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, errBody }, '[transcribe] Cartesia error');
      res.status(502).json({ error: 'Transcription failed' });
      return;
    }

    const data = await response.json() as { text?: string };
    res.json({ text: data.text?.trim() || '' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Transcription failed';
    logger.error({ err }, '[transcribe] error');
    res.status(502).json({ error: message });
  }
});

export default router;
