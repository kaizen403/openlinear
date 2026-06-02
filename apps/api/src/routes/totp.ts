import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { prisma } from '@openlinear/db';
import { buildErrorEnvelope } from '../lib/http';
import { generateTOTPSecret, verifyTOTP, generateBackupCodes, verifyBackupCode } from '../services/totp';
import jwt from 'jsonwebtoken';

const router: Router = Router();

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[Auth] JWT_SECRET is required in production');
    }
    return 'openlinear-dev-secret-change-in-production';
  }
  return secret;
}

router.post('/setup', requireAuth, async (req: AuthRequest, res: Response) => {
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

    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: secret },
    });

    const { plain, hashed } = generateBackupCodes();

    await prisma.user.update({
      where: { id: user.id },
      data: { backupCodes: hashed },
    });

    res.json({ secret, uri, backupCodes: plain });
  } catch {
    res.status(500).json(buildErrorEnvelope('TOTP_SETUP_FAILED', 'Failed to set up 2FA'));
  }
});

router.post('/verify', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      res.status(400).json(buildErrorEnvelope('CODE_REQUIRED', 'Verification code is required'));
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || !user.totpSecret) {
      res.status(400).json(buildErrorEnvelope('TOTP_NOT_SETUP', '2FA has not been set up'));
      return;
    }

    if (user.totpEnabled) {
      res.status(400).json(buildErrorEnvelope('TOTP_ALREADY_ENABLED', '2FA is already enabled'));
      return;
    }

    const valid = verifyTOTP(user.totpSecret, code);
    if (!valid) {
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

router.post('/disable', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      res.status(400).json(buildErrorEnvelope('CODE_REQUIRED', 'Verification code is required'));
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || !user.totpEnabled || !user.totpSecret) {
      res.status(400).json(buildErrorEnvelope('TOTP_NOT_ENABLED', '2FA is not enabled'));
      return;
    }

    const valid = verifyTOTP(user.totpSecret, code);
    if (!valid) {
      res.status(400).json(buildErrorEnvelope('INVALID_CODE', 'Invalid verification code'));
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: null, totpEnabled: false, backupCodes: [] },
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
  message: buildErrorEnvelope('RATE_LIMITED', 'Too many 2FA validation attempts. Try again in a minute.'),
});

router.post('/validate', validateLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { code, tempToken } = req.body;
    if (!code || typeof code !== 'string' || !tempToken || typeof tempToken !== 'string') {
      res.status(400).json(buildErrorEnvelope('INVALID_REQUEST', 'code and tempToken are required'));
      return;
    }

    let payload: { userId: string; twoFactorPending?: boolean; username?: string };
    try {
      payload = jwt.verify(tempToken, getJwtSecret()) as typeof payload;
    } catch {
      res.status(401).json(buildErrorEnvelope('INVALID_TOKEN', 'Invalid or expired temp token'));
      return;
    }

    if (!payload.twoFactorPending) {
      res.status(400).json(buildErrorEnvelope('INVALID_TOKEN', 'Token is not a 2FA pending token'));
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user || !user.totpEnabled || !user.totpSecret) {
      res.status(400).json(buildErrorEnvelope('TOTP_NOT_ENABLED', '2FA is not enabled'));
      return;
    }

    let valid = verifyTOTP(user.totpSecret, code);

    if (!valid) {
      const backupIndex = verifyBackupCode(user.backupCodes, code);
      if (backupIndex >= 0) {
        valid = true;
        const updatedCodes = [...user.backupCodes];
        updatedCodes.splice(backupIndex, 1);
        await prisma.user.update({
          where: { id: user.id },
          data: { backupCodes: updatedCodes },
        });
      }
    }

    if (!valid) {
      res.status(401).json(buildErrorEnvelope('INVALID_CODE', 'Invalid 2FA code'));
      return;
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      getJwtSecret(),
      { expiresIn: '7d' },
    );

    res.json({ token });
  } catch {
    res.status(500).json(buildErrorEnvelope('TOTP_VALIDATE_FAILED', 'Failed to validate 2FA'));
  }
});

export default router;
