import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { HttpError } from '../errors';

const router: Router = Router();

export const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

/**
 * Allowlisted upload types.
 *
 * The extension is derived from this table, never from `file.originalname`:
 * multer previously preserved the caller's extension, so uploading `x.html`
 * produced a URL that `express.static` served as `text/html` from the API's own
 * origin — with helmet's CSP disabled — giving same-origin script execution
 * against every API endpoint.
 */
const ALLOWED_TYPES: Record<string, { ext: string; magic?: readonly (readonly number[])[] }> = {
  'image/png': { ext: '.png', magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  'image/jpeg': { ext: '.jpg', magic: [[0xff, 0xd8, 0xff]] },
  'image/gif': { ext: '.gif', magic: [[0x47, 0x49, 0x46, 0x38]] },
  'image/webp': { ext: '.webp', magic: [[0x52, 0x49, 0x46, 0x46]] },
  'application/pdf': { ext: '.pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
  'text/plain': { ext: '.txt' },
  'text/markdown': { ext: '.md' },
  'text/csv': { ext: '.csv' },
  'application/json': { ext: '.json' },
};

function matchesMagic(buffer: Buffer, mimeType: string): boolean {
  const spec = ALLOWED_TYPES[mimeType];
  if (!spec) return false;
  if (!spec.magic) return true; // text formats have no reliable signature
  return spec.magic.some((sig) =>
    sig.every((byte, index) => buffer[index] === byte),
  );
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    // Extension comes from the allowlist, not from the caller.
    const ext = ALLOWED_TYPES[file.mimetype]?.ext ?? '.bin';
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) {
      cb(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported file type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

router.post(
  '/',
  requireAuth,
  upload.single('file'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const file = req.file;
    try {
      if (!file) {
        throw new HttpError(400, 'NO_FILE', 'No file uploaded');
      }

      // Verify the bytes match the declared type; a declared MIME alone is
      // attacker-controlled.
      const handle = await fs.promises.open(file.path, 'r');
      try {
        const header = Buffer.alloc(16);
        await handle.read(header, 0, 16, 0);
        if (!matchesMagic(header, file.mimetype)) {
          throw new HttpError(
            415,
            'CONTENT_TYPE_MISMATCH',
            'File contents do not match the declared type',
          );
        }
      } finally {
        await handle.close();
      }

      const attachment = await prisma.chatAttachment.create({
        data: {
          userId: req.userId!,
          filename: path.basename(file.originalname).slice(0, 255),
          mimeType: file.mimetype,
          url: `/uploads/${file.filename}`,
          size: file.size,
        },
      });

      res.status(201).json(attachment);
    } catch (error) {
      // Never leave a rejected upload on disk.
      if (file?.path) {
        await fs.promises.unlink(file.path).catch(() => {});
      }
      next(error);
    }
  },
);

export default router;
