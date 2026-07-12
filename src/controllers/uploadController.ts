import { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Menu image upload.
//
// The app already served /uploads statically and carried an `image_url` column,
// but nothing ever wrote a file — so every item fell back to an external
// placeholder service (which is why the UI showed broken "IMG" boxes). This
// endpoint accepts a single image, validates type + size, stores it under
// uploads/menu/, and returns the URL to persist on the menu item.
//
// Files are stored on local disk (uploads/menu). For a multi-instance / cloud
// deployment this should move to object storage (S3/GCS) behind the same URL
// contract — the frontend only ever sees the returned `url`, so that swap is
// isolated to this file.
// ─────────────────────────────────────────────────────────────────────────────

const UPLOAD_ROOT = process.env.UPLOAD_DIR || 'uploads';
const MENU_DIR = path.join(UPLOAD_ROOT, 'menu');
// Ensure the target directory exists at startup so the first upload can't fail
// on a missing folder.
fs.mkdirSync(MENU_DIR, { recursive: true });

const MAX_BYTES = Number(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024;
const ALLOWED = new Map<string, string>([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MENU_DIR),
  filename: (_req, file, cb) => {
    // Derive the extension from the validated mimetype, not the client-supplied
    // filename — never trust `originalname` for anything that lands on disk.
    const ext = ALLOWED.get(file.mimetype) || '.jpg';
    cb(null, `${Date.now()}-${randomUUID()}${ext}`);
  },
});

const uploader = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new Error('INVALID_TYPE'));
  },
}).single('image');

export const uploadMenuImage = (req: Request, res: Response): void => {
  uploader(req, res, (err: unknown) => {
    if (err) {
      let message = 'Upload failed. Please try again.';
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        message = `Image is too large. Maximum size is ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB.`;
      } else if (err instanceof Error && err.message === 'INVALID_TYPE') {
        message = 'Unsupported file type. Please upload a JPEG, PNG, WEBP or GIF image.';
      }
      res.status(400).json({ success: false, message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, message: 'No image was provided (the file field must be named "image").' });
      return;
    }
    // Same-origin path; served by express.static('/uploads') in production and
    // proxied to the API in dev (see vite.config.ts).
    res.status(201).json({ success: true, url: `/uploads/menu/${req.file.filename}` });
  });
};