import express, { NextFunction, Router, Response } from 'express';
import { ElevenLabsClient, ElevenLabsError } from '@elevenlabs/elevenlabs-js';
import { requireAuth, AuthRequest } from '@openlinear/api/middleware';
import { HttpError } from '@openlinear/api/errors';

const router: Router = Router();

const SUPPORTED_AUDIO_TYPES = [
  'audio/mp4',
  'audio/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/x-m4a',
  'audio/aac',
  'audio/flac',
  'video/webm',
];

router.use(express.raw({
  type: SUPPORTED_AUDIO_TYPES,
  limit: parseUploadLimit(),
}));

function parseUploadLimit(): string {
  const raw = process.env.ELEVENLABS_STT_MAX_UPLOAD_MB;
  const parsed = raw ? Number.parseInt(raw, 10) : 25;
  const megabytes = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 25;
  return `${megabytes}mb`;
}

function parseTimeoutSeconds(): number {
  const raw = process.env.ELEVENLABS_STT_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : 30_000;
  return Math.max(1, Math.ceil((Number.isFinite(parsed) ? parsed : 30_000) / 1000));
}

function parseModelId(): 'scribe_v1' | 'scribe_v2' {
  return process.env.ELEVENLABS_STT_MODEL_ID === 'scribe_v1' ? 'scribe_v1' : 'scribe_v2';
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase();
  switch (normalized) {
    case 'audio/webm':
    case 'video/webm':
      return 'webm';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
      return 'wav';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/aac':
      return 'aac';
    case 'audio/flac':
      return 'flac';
    case 'audio/mp4':
    default:
      return 'mp4';
  }
}

function extractTranscriptText(
  response: Awaited<ReturnType<ElevenLabsClient['speechToText']['convert']>>,
): string {
  if ('text' in response && typeof response.text === 'string') {
    return response.text;
  }
  if ('transcripts' in response && Array.isArray(response.transcripts)) {
    return response.transcripts
      .map((transcript) => transcript.text)
      .filter((text) => text.trim().length > 0)
      .join('\n');
  }
  return '';
}

router.post('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new HttpError(400, 'AUDIO_REQUIRED', 'No audio data provided');
    }

    const apiKey = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVENLABS_STT_API_KEY;
    if (!apiKey) {
      throw new HttpError(503, 'ELEVENLABS_NOT_CONFIGURED', 'ElevenLabs speech-to-text is not configured');
    }

    const contentTypeHeader = req.headers['content-type'];
    const contentType = Array.isArray(contentTypeHeader)
      ? contentTypeHeader[0] ?? 'audio/webm'
      : contentTypeHeader ?? 'audio/webm';
    const extension = extensionForContentType(contentType);

    const client = new ElevenLabsClient({
      apiKey,
      timeoutInSeconds: parseTimeoutSeconds(),
      maxRetries: 1,
    });

    const modelId = parseModelId();
    const transcription = await client.speechToText.convert({
      modelId,
      file: {
        data: req.body,
        filename: `openlinear-voice.${extension}`,
        contentType,
        contentLength: req.body.length,
      },
      tagAudioEvents: false,
      diarize: false,
      ...(modelId === 'scribe_v2' ? { noVerbatim: true } : {}),
    });

    res.json({ text: extractTranscriptText(transcription).trim() });
  } catch (error) {
    if (error instanceof ElevenLabsError) {
      const statusCode = error.statusCode ?? 502;
      next(new HttpError(
        statusCode >= 400 && statusCode < 500 ? statusCode : 502,
        'ELEVENLABS_TRANSCRIPTION_FAILED',
        error.message || 'ElevenLabs transcription failed',
      ));
      return;
    }
    next(error);
  }
});

export default router;
