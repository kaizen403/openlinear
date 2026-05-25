import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { HttpError } from '../errors';

const router: Router = Router();

const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
});

router.post(
  '/',
  requireAuth,
  upload.single('file'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        throw new HttpError(400, 'NO_FILE', 'No file uploaded');
      }

      const attachment = await prisma.chatAttachment.create({
        data: {
          userId: req.userId!,
          filename: file.originalname,
          mimeType: file.mimetype,
          url: `/uploads/${file.filename}`,
          size: file.size,
        },
      });

      res.status(201).json(attachment);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
