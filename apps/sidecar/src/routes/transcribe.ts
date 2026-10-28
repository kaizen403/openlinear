import express, { Router, Response } from 'express';
import type { Router as IRouter } from 'express';
import { type AuthedRequest as AuthRequest, requireSidecarAuth as requireAuth } from '../auth/principal';
import { logger } from '../lib/logger';

const router: IRouter = Router();

const ALLOWED_CONTENT_TYPES = ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg'];
const MAX_UPLOAD_SIZE = '10mb';
const OUTBOUND_TIMEOUT_MS = 30_000;

// Pinned default. `CARTESIA_STT_URL` may still override it for self-hosted
// proxies, but only to another https URL on an allowlisted host — otherwise
// a poisoned environment could redirect the API key and raw audio anywhere
// (C6a F13).
const DEFAULT_CARTESIA_STT_URL = 'https://api.cartesia.ai/stt';
const ALLOWED_CARTESIA_HOSTS = new Set(['api.cartesia.ai']);

function resolveCartesiaSttUrl(): string {
  const override = process.env.CARTESIA_STT_URL;
  if (!override) return DEFAULT_CARTESIA_STT_URL;

  try {
    const parsed = new URL(override);
    if (parsed.protocol === 'https:' && ALLOWED_CARTESIA_HOSTS.has(parsed.hostname)) {
      return override;
    }
  } catch {
    // fall through to the warning + pinned default below
  }

  logger.warn(
    '[transcribe] Ignoring CARTESIA_STT_URL override: must be an https URL on an allowlisted host',
  );
  return DEFAULT_CARTESIA_STT_URL;
}

const TRANSCRIPTION_PROVIDER = 'cartesia';
const TRANSCRIPTION_MODEL = 'ink-whisper';

/**
 * Usage receipt for one transcription call (W15). The sidecar has no usage
 * persistence path yet (sidecar persistence is being reworked), so the receipt
 * is returned with the result and written to the structured log. Cartesia
 * bills audio time, not tokens; with no configured price the cost is unknown
 * and reported as null, never as zero.
 */
export interface TranscriptionUsage {
  surface: 'transcription';
  provider: string;
  model: string;
  status: 'succeeded' | 'failed';
  audioBytes: number;
  /** Duration the provider reported, in seconds; null when not reported. */
  audioSeconds: number | null;
  latencyMs: number;
  costUsd: null;
  costBasis: 'unknown';
}

function transcriptionUsage(input: { status: TranscriptionUsage['status']; audioBytes: number; audioSeconds: number | null; startedAt: number }): TranscriptionUsage {
  return {
    surface: 'transcription',
    provider: TRANSCRIPTION_PROVIDER,
    model: TRANSCRIPTION_MODEL,
    status: input.status,
    audioBytes: input.audioBytes,
    audioSeconds: input.audioSeconds,
    latencyMs: Date.now() - input.startedAt,
    costUsd: null,
    costBasis: 'unknown',
  };
}

function reportedDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function baseContentType(contentType: string | undefined): string {
  return (contentType || '').split(';')[0].trim().toLowerCase();
}

const MAGIC_BYTE_VALIDATORS: Record<string, (buf: Buffer) => boolean> = {
  // EBML header used by both WebM and Matroska containers.
  'audio/webm': (buf) => buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3,
  'audio/ogg': (buf) => buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS',
  'audio/wav': (buf) =>
    buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE',
  'audio/mpeg': (buf) => {
    if (buf.length < 3) return false;
    if (buf.toString('ascii', 0, 3) === 'ID3') return true;
    // Raw MPEG frame sync: 11 set bits (0xFFE0 mask) at the start of a frame.
    return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  },
};

function hasValidMagicBytes(contentType: string, buf: Buffer): boolean {
  const validator = MAGIC_BYTE_VALIDATORS[contentType];
  return validator ? validator(buf) : false;
}

router.post(
  '/',
  requireAuth,
  express.raw({ type: ALLOWED_CONTENT_TYPES, limit: MAX_UPLOAD_SIZE }),
  async (req: AuthRequest, res: Response) => {
    const apiKey = process.env.CARTESIA_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: 'Transcription service not configured' });
      return;
    }

    const contentType = baseContentType(req.headers['content-type']);
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      res.status(415).json({ error: 'Unsupported audio content type' });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'No audio data received' });
      return;
    }

    const audioBuffer: Buffer = req.body;

    if (!hasValidMagicBytes(contentType, audioBuffer)) {
      logger.warn(
        { contentType, userId: req.userId },
        '[transcribe] rejected payload whose bytes do not match its declared content type',
      );
      res.status(400).json({ error: 'Audio data does not match its declared content type' });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
    const startedAt = Date.now();
    const failedUsage = () => transcriptionUsage({ status: 'failed', audioBytes: audioBuffer.length, audioSeconds: null, startedAt });

    try {
      const extension = contentType.split('/')[1] || 'bin';
      const blob = new Blob([audioBuffer], { type: contentType });
      const form = new FormData();
      form.append('file', blob, `audio.${extension}`);
      form.append('model', TRANSCRIPTION_MODEL);
      form.append('language', 'en');

      const response = await fetch(resolveCartesiaSttUrl(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Cartesia-Version': '2026-03-01',
        },
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        logger.error({ status: response.status, errBody }, '[transcribe] Cartesia error');
        logger.info({ usage: failedUsage(), userId: req.userId }, '[usage] transcription');
        res.status(502).json({ error: 'Transcription failed' });
        return;
      }

      const data = await response.json() as { text?: string; duration?: unknown };
      const usage = transcriptionUsage({ status: 'succeeded', audioBytes: audioBuffer.length, audioSeconds: reportedDuration(data.duration), startedAt });
      logger.info({ usage, userId: req.userId }, '[usage] transcription');
      res.json({ text: data.text?.trim() || '', usage });
    } catch (err: unknown) {
      // Never surface err.message to the caller — it can include upstream
      // response bodies or internal details. Full detail goes to the
      // server-side log only (C6a F13/F16).
      logger.error({ err }, '[transcribe] error');
      logger.info({ usage: failedUsage(), userId: req.userId }, '[usage] transcription');
      res.status(502).json({ error: 'Transcription failed' });
    } finally {
      clearTimeout(timeout);
    }
  },
);

export default router;
