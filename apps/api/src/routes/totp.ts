import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireInteractiveSession, AuthRequest } from '../middleware/auth';
import { prisma, encryptToken } from '@openlinear/db';
import { buildErrorEnvelope } from '../lib/http';
import {
  consumeBackupCode,
  consumeTotpCode,
  generateBackupCodes,
  generateTOTPSecret,
  resolveTotpSecret,
} from '../services/totp';
import { issueSession, verifyTwoFactorPendingToken } from '../lib/auth-tokens';

const router: Router = Router();

const codeBodySchema = z.object({ code: z.string().trim().min(1).max(64) });
const validateBodySchema = z.object({
  code: z.string().trim().min(1).max(64),
  tempToken: z.string().min(1).max(256),
});

router.post('/setup', requireInteractiveSession, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) {
      res.status(404).json(buildErrorEnvelope('USER_NOT_FOUND', 'User not found'));
      return;
    }

    if (user.totpEnabled) {
      res.status(400).json(buildErrorEnvelope('TOTP_ALREADY_ENABLED', '2FA is already enabled'));
      return;
    }

    const { secret, uri } = generateTOTPSecret(user.username);
    const { plain, hashed } = generateBackupCodes();

    // One write: a new secret starts with no accepted step.
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: encryptToken(secret), backupCodes: hashed, totpLastUsedStep: null },
    });

    res.json({ secret, uri, backupCodes: plain });
  } catch {
    res.status(500).json(buildErrorEnvelope('TOTP_SETUP_FAILED', 'Failed to set up 2FA'));
  }
});

router.post('/verify', requireInteractiveSession, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = codeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(buildErrorEnvelope('CODE_REQUIRED', 'Verification code is required'));
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) {
      res.status(400).json(buildErrorEnvelope('TOTP_NOT_SETUP', '2FA has not been set up'));
      return;
    }
    const totpSecret = resolveTotpSecret(user.totpSecret);
    if (!totpSecret) {
      res.status(400).json(buildErrorEnvelope('TOTP_NOT_SETUP', '2FA has not been set up'));
      return;
    }

    if (user.totpEnabled) {
      res.status(400).json(buildErrorEnvelope('TOTP_ALREADY_ENABLED', '2FA is already enabled'));
      return;
    }

    const result = await consumeTotpCode(user.id, totpSecret, parsed.data.code);
    if (result !== 'accepted') {
      res.status(400).json(buildErrorEnvelope('INVALID_CODE', 'Invalid verification code'));
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: true },
    });

    res.json({ success: true });
  } catch {
    res.status(500).json(buildErrorEnvelope('TOTP_VERIFY_FAILED', 'Failed to verify 2FA'));
  }
});

router.post('/disable', requireInteractiveSession, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = codeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(buildErrorEnvelope('CODE_REQUIRED', 'Verification code is required'));
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const totpSecret = resolveTotpSecret(user?.totpSecret);
    if (!user || !user.totpEnabled || !totpSecret) {
      res.status(400).json(buildErrorEnvelope('TOTP_NOT_ENABLED', '2FA is not enabled'));
      return;
    }

    const result = await consumeTotpCode(user.id, totpSecret, parsed.data.code);
    if (result !== 'accepted') {
      res.status(400).json(buildErrorEnvelope('INVALID_CODE', 'Invalid verification code'));
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: null, totpEnabled: false, backupCodes: [], totpLastUsedStep: null },
    });

    res.json({ success: true });
  } catch {
    res.status(500).json(buildErrorEnvelope('TOTP_DISABLE_FAILED', 'Failed to disable 2FA'));
  }
});

const validateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: buildErrorEnvelope('RATE_LIMITED', 'Too many 2FA validation attempts. Try again in a minute.'),
});

router.post('/validate', validateLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = validateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(buildErrorEnvelope('INVALID_REQUEST', 'code and tempToken are required'));
      return;
    }
    const { code, tempToken } = parsed.data;

    // Only an opaque, single-use 2FA challenge is accepted here (claimed
    // atomically), so a full session token cannot be replayed to satisfy the
    // second factor and one challenge cannot be spent twice.
    const pending = await verifyTwoFactorPendingToken(tempToken);
    if (!pending) {
      res.status(401).json(buildErrorEnvelope('INVALID_TOKEN', 'Invalid or expired temp token'));
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: pending.id } });
    const totpSecret = resolveTotpSecret(user?.totpSecret);
    if (!user || !user.totpEnabled || !totpSecret) {
      res.status(400).json(buildErrorEnvelope('TOTP_NOT_ENABLED', '2FA is not enabled'));
      return;
    }

    // A TOTP code is accepted once per time step; a backup code exactly once.
    const totp = await consumeTotpCode(user.id, totpSecret, code);
    const valid = totp === 'accepted'
      || (totp === 'invalid' && await consumeBackupCode(user.id, user.backupCodes, code));

    if (!valid) {
      res.status(401).json(buildErrorEnvelope('INVALID_CODE', 'Invalid 2FA code'));
      return;
    }

    const issued = await issueSession(
      { id: user.id, username: user.username },
      req,
    );

    res.json({ token: issued.accessToken, refreshToken: issued.refreshToken });
  } catch {
    res.status(500).json(buildErrorEnvelope('TOTP_VALIDATE_FAILED', 'Failed to validate 2FA'));
  }
});

export default router;
