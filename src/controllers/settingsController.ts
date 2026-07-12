import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { logAudit } from '../services/auditLog';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Settings: General + Business Profile
//
// Before this, every field on the Settings page lived only in React state —
// "Save Changes" showed a success toast and changed nothing. Refreshing the
// page silently reverted everything to hardcoded defaults (including a
// business name with a typo, "Shawal's D.E.I"). This is a simple key-value
// store rather than fixed columns, since these are small, loosely-related
// preferences that will keep growing one setting at a time.
// ─────────────────────────────────────────────────────────────────────────────

export const getSettings = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query('SELECT key, value FROM settings');
    const settings: Record<string, string> = {};
    for (const row of result.rows) settings[row.key] = row.value;
    res.json({ success: true, data: settings });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const updates = req.body as Record<string, string>;
    const keys = Object.keys(updates);
    if (keys.length === 0) {
      res.status(400).json({ success: false, message: 'No settings provided' });
      return;
    }
    // One upsert per key rather than a single multi-row statement — simpler
    // to reason about and this endpoint is called rarely (a settings save),
    // not on a hot path where the extra round trips would matter.
    for (const key of keys) {
      await query(`
        INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP
      `, [key, updates[key], req.user!.id]);
    }
    await logAudit(req, { action: 'settings_updated', entityType: 'settings', details: { keys } });
    res.json({ success: true, message: 'Settings saved' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Logo upload — same validated-disk-storage pattern as menu image uploads.
// ─────────────────────────────────────────────────────────────────────────────

const UPLOAD_ROOT = process.env.UPLOAD_DIR || 'uploads';
const LOGO_DIR = path.join(UPLOAD_ROOT, 'business');
fs.mkdirSync(LOGO_DIR, { recursive: true });

const MAX_BYTES = Number(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024;
const ALLOWED_IMAGE = new Map<string, string>([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
]);

const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LOGO_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${randomUUID()}${ALLOWED_IMAGE.get(file.mimetype) || '.jpg'}`),
});
const logoUploader = multer({
  storage: logoStorage,
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE.has(file.mimetype)) cb(null, true);
    else cb(new Error('INVALID_TYPE'));
  },
}).single('logo');

export const uploadLogo = (req: AuthRequest, res: Response): void => {
  logoUploader(req, res, async (err: unknown) => {
    if (err) {
      const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? `Logo is too large. Maximum size is ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB.`
        : 'Unsupported file type. Please upload a JPEG, PNG or WEBP image.';
      res.status(400).json({ success: false, message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, message: 'No image was provided (the file field must be named "logo").' });
      return;
    }
    const url = `/uploads/business/${req.file.filename}`;
    await query(`
      INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('business_logo_url', $1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP
    `, [url, req.user!.id]);
    res.status(201).json({ success: true, url });
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// System info — every field here used to be hardcoded fiction (a fake
// version number, a fake "last backup" timestamp, a fake uptime). Everything
// below is a real, live value.
// ─────────────────────────────────────────────────────────────────────────────

export const getSystemInfo = async (_req: Request, res: Response): Promise<void> => {
  try {
    const dbVersion = await query('SELECT version()');
    const appVersion = (await import('../../package.json')).version;
    const lastBackup = await getLatestBackupMeta();

    res.json({
      success: true,
      data: {
        app_version: appVersion,
        environment: process.env.NODE_ENV || 'development',
        database: dbVersion.rows[0].version.split(',')[0], // "PostgreSQL 16.x on ..." -> just the first clause
        node_uptime_seconds: Math.floor(process.uptime()),
        server_time: new Date().toISOString(),
        last_backup: lastBackup, // null if none exist yet — genuinely honest, not a fake date
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Storage usage — was a fully fabricated pie chart (fixed 1.2GB/0.85GB/etc
// regardless of what's actually on disk). Real DB size via Postgres itself,
// real uploads size by walking the actual directory, real backups size from
// the actual backup files.
// ─────────────────────────────────────────────────────────────────────────────

function dirSizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : fs.statSync(full).size;
  }
  return total;
}

export const getStorageUsage = async (_req: Request, res: Response): Promise<void> => {
  try {
    const dbSizeRes = await query('SELECT pg_database_size(current_database()) as bytes');
    const dbBytes = Number(dbSizeRes.rows[0].bytes);
    const uploadsBytes = dirSizeBytes(UPLOAD_ROOT);
    const backupsBytes = dirSizeBytes(BACKUP_DIR);

    const toGB = (b: number) => Math.round((b / (1024 ** 3)) * 100) / 100;
    res.json({
      success: true,
      data: {
        database_gb: toGB(dbBytes),
        uploads_gb: toGB(uploadsBytes),
        backups_gb: toGB(backupsBytes),
        total_gb: toGB(dbBytes + uploadsBytes + backupsBytes),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Backup & restore — "Create Backup Now" and "Download Last Backup" used to
// both be fake: the create button just showed a toast and did nothing, and
// download had no handler at all. This runs a real pg_dump, keeps the
// resulting files on disk, and serves them for download.
//
// Restricted to 'administrator' only (not manager, unlike most other
// settings here) — a backup file is a complete copy of every order, payment,
// and customer record the business has. That's a materially different risk
// than changing the display currency.
// ─────────────────────────────────────────────────────────────────────────────

const BACKUP_DIR = path.join(UPLOAD_ROOT, '..', 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

async function getLatestBackupMeta(): Promise<{ filename: string; size_bytes: number; created_at: string } | null> {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sql'));
  if (files.length === 0) return null;
  const withStats = files.map(f => ({ f, stat: fs.statSync(path.join(BACKUP_DIR, f)) }));
  withStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const latest = withStats[0];
  return { filename: latest.f, size_bytes: latest.stat.size, created_at: latest.stat.mtime.toISOString() };
}

export const createBackup = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `shawalsdeli-backup-${timestamp}.sql`;
    const filepath = path.join(BACKUP_DIR, filename);

    // Shell out to the real pg_dump binary rather than reimplementing a
    // database export — it already handles every type/constraint/sequence
    // correctly, which a hand-rolled "SELECT * FROM every table" export
    // would not (and would silently produce a backup that fails to restore).
    await execFileAsync('pg_dump', [
      '-h', process.env.DB_HOST || 'localhost',
      '-p', process.env.DB_PORT || '5432',
      '-U', process.env.DB_USER || 'postgres',
      '-d', process.env.DB_NAME || 'shawalsdeli',
      '-f', filepath,
      '--no-owner', '--no-privileges',
    ], {
      env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || '' },
      timeout: 5 * 60 * 1000, // 5 minutes — generous for a small-business dataset
    });

    const stat = fs.statSync(filepath);
    res.status(201).json({
      success: true,
      message: 'Backup created',
      data: { filename, size_bytes: stat.size, created_at: stat.mtime.toISOString() },
    });
  } catch (error) {
    console.error('Backup failed:', error);
    res.status(500).json({ success: false, message: 'Backup failed — check server logs for details. This usually means pg_dump is not installed or the database credentials are wrong.' });
  }
};

export const getBackups = async (_req: Request, res: Response): Promise<void> => {
  try {
    const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sql')) : [];
    const backups = files
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { filename: f, size_bytes: stat.size, created_at: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    res.json({ success: true, data: backups });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const downloadBackup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { filename } = req.params;
    // Strict allowlist pattern rather than trusting the URL param directly —
    // without this, a filename like "../../.env" would let someone walk out
    // of the backups directory entirely.
    if (!/^shawalsdeli-backup-[\d-TZ]+\.sql$/.test(filename)) {
      res.status(400).json({ success: false, message: 'Invalid backup filename' });
      return;
    }
    const filepath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(filepath)) {
      res.status(404).json({ success: false, message: 'Backup not found' });
      return;
    }
    res.download(filepath, filename);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Recent activity — was hardcoded mock entries with made-up names and dates.
// This is a lightweight real feed assembled from a few tables that already
// carry timestamps and an actor, not a dedicated audit-log system (that
// would mean adding logging calls throughout the entire codebase — a much
// bigger undertaking). It's honestly partial: only these few event types are
// covered, not literally everything that happens in the app.
// ─────────────────────────────────────────────────────────────────────────────

export const getRecentActivity = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(`
      (SELECT 'login' as type, full_name || ' logged in' as text, last_login as at
       FROM users WHERE last_login IS NOT NULL ORDER BY last_login DESC LIMIT 5)
      UNION ALL
      (SELECT 'staff_added' as type, full_name || ' joined the team' as text, created_at as at
       FROM users ORDER BY created_at DESC LIMIT 5)
      UNION ALL
      (SELECT 'inventory' as type, u.full_name || ' adjusted stock: ' || i.name as text, t.created_at as at
       FROM inventory_transactions t
       JOIN inventory_items i ON t.inventory_item_id = i.id
       JOIN users u ON t.performed_by = u.id
       ORDER BY t.created_at DESC LIMIT 5)
      UNION ALL
      (SELECT 'order' as type, 'Order ' || order_number || ' completed' as text, completed_at as at
       FROM orders WHERE status = 'completed' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 5)
      ORDER BY at DESC LIMIT 8
    `);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};