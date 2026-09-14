import { Router, Response, NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { HttpError } from '../errors';
import { UPLOADS_DIR } from './chat-attachments';

const router: Router = Router();

/**
 * Authenticated attachment download.
 *
 * This replaces `app.use('/uploads', express.static('uploads'))`, which served
 * every uploaded file to anyone who knew (or guessed) a filename, with a
 * content type derived from the file extension and no CSP. The URL shape is
 * preserved because `ChatAttachment.url` rows already store `/uploads/<name>`.
 */
router.get(
  '/:filename',
  requireAuth,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const raw = req.params.filename;
      const requested = typeof raw === 'string' ? raw : '';
      const filename = path.basename(requested);
      if (!filename || filename !== requested) {
        throw new HttpError(400, 'INVALID_FILENAME', 'Invalid filename');
      }

      const attachment = await prisma.chatAttachment.findFirst({
        where: { url: `/uploads/${filename}` },
        select: { userId: true, filename: true, mimeType: true },
      });

      // Same response for "does not exist" and "not yours", so the endpoint is
      // not an existence oracle for other users' uploads.
      if (!attachment || attachment.userId !== req.userId) {
        throw new HttpError(404, 'NOT_FOUND', 'Attachment not found');
      }

      const absolute = path.resolve(UPLOADS_DIR, filename);
      if (path.dirname(absolute) !== UPLOADS_DIR || !fs.existsSync(absolute)) {
        throw new HttpError(404, 'NOT_FOUND', 'Attachment not found');
      }

      // Never render an upload in the API's origin: force a download, forbid
      // sniffing, and deny every capability if a browser does render it anyway.
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(attachment.filename)}"`,
      );
      res.sendFile(absolute);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
