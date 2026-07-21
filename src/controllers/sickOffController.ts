import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { logAudit } from '../services/auditLog';
import { notifyAdminsOfSickOffRequest } from '../services/pushService';

// Same upload convention as expense receipts (../controllers/expensesController.ts)
// — same allowed types, same size limit, same disk layout under uploads/,
// just its own subfolder so the two document types don't mix on disk.
const UPLOAD_ROOT = process.env.UPLOAD_DIR || 'uploads';
const RECEIPT_DIR = path.join(UPLOAD_ROOT, 'sick-off-receipts');
fs.mkdirSync(RECEIPT_DIR, { recursive: true });

const MAX_BYTES = Number(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024;
const ALLOWED_RECEIPT_TYPES = new Map<string, string>([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['application/pdf', '.pdf'],
]);

const receiptStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RECEIPT_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${randomUUID()}${ALLOWED_RECEIPT_TYPES.get(file.mimetype) || '.jpg'}`),
});
const receiptUploader = multer({
  storage: receiptStorage,
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_RECEIPT_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('INVALID_TYPE'));
  },
}).single('receipt');

// POST /sick-off-requests  (multipart/form-data: requested_date, message, receipt?)
//
// The receipt is accepted here at creation (the natural, one-step flow —
// "here's my note and here's why") but isn't strictly required at this
// exact moment: someone too unwell to get to a hospital immediately, or
// waiting on a physical copy, can still submit the request and add the
// receipt afterward via uploadSickOffReceipt below. What IS required is
// the message — a bare date with no explanation gives an admin nothing to
// actually evaluate.
export const createSickOffRequest = (req: AuthRequest, res: Response): void => {
  receiptUploader(req, res, async (err: unknown) => {
    if (err) {
      const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? `Receipt is too large. Maximum size is ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB.`
        : 'Unsupported file type. Please upload a JPEG, PNG, WEBP or PDF.';
      res.status(400).json({ success: false, message });
      return;
    }
    try {
      const { requested_date, message } = req.body;
      if (!requested_date || Number.isNaN(new Date(requested_date).getTime())) {
        res.status(400).json({ success: false, message: 'A valid requested_date is required' });
        return;
      }
      if (!message || !String(message).trim()) {
        res.status(400).json({ success: false, message: 'A short message explaining the request is required' });
        return;
      }

      const receiptUrl = req.file ? `/uploads/sick-off-receipts/${req.file.filename}` : null;

      const result = await query(`
        INSERT INTO sick_off_requests (user_id, requested_date, message, receipt_url)
        VALUES ($1, $2, $3, $4) RETURNING *
      `, [req.user!.id, requested_date, String(message).trim(), receiptUrl]);

      notifyAdminsOfSickOffRequest({
        title: '🏥 Sick-Off Request',
        body: `${req.user!.email} has requested ${new Date(requested_date).toLocaleDateString()} off — tap to review.`,
        requestId: result.rows[0].id,
      }).catch(() => {}); // Never let a notification failure block the request itself.

      res.status(201).json({ success: true, data: result.rows[0], message: 'Request submitted — an admin will review it.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });
};

// POST /sick-off-requests/:id/receipt — add or replace the receipt on an
// existing request (e.g. submitted without one initially). Only the
// requester themselves can attach their own supporting document here —
// enforced by the WHERE clause below, not just at the route level, since
// letting anyone attach a "receipt" to someone else's request would let
// that evidence be spoofed.
export const uploadSickOffReceipt = (req: AuthRequest, res: Response): void => {
  receiptUploader(req, res, async (err: unknown) => {
    if (err) {
      const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? `Receipt is too large. Maximum size is ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB.`
        : 'Unsupported file type. Please upload a JPEG, PNG, WEBP or PDF.';
      res.status(400).json({ success: false, message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file was provided (the file field must be named "receipt").' });
      return;
    }
    const url = `/uploads/sick-off-receipts/${req.file.filename}`;
    const result = await query(
      'UPDATE sick_off_requests SET receipt_url = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
      [url, req.params.id, req.user!.id]
    );
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Request not found, or it is not yours to update.' }); return; }
    res.status(201).json({ success: true, url });
  });
};

// GET /sick-off-requests?status=pending — the admin review queue.
export const getSickOffRequests = async (req: Request, res: Response): Promise<void> => {
  try {
    const { status } = req.query;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status && status !== 'all') { conditions.push(`sor.status = $${params.length + 1}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT sor.*, u.full_name as requested_by_name, u.role as requested_by_role, r.full_name as reviewed_by_name
      FROM sick_off_requests sor
      JOIN users u ON sor.user_id = u.id
      LEFT JOIN users r ON sor.reviewed_by = r.id
      ${where}
      ORDER BY sor.created_at DESC
    `, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /sick-off-requests/mine — a staff member's own requests, so they can
// track whether theirs has been reviewed yet without needing admin access
// to the full queue.
export const getMySickOffRequests = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query(`
      SELECT sor.*, r.full_name as reviewed_by_name
      FROM sick_off_requests sor
      LEFT JOIN users r ON sor.reviewed_by = r.id
      WHERE sor.user_id = $1
      ORDER BY sor.created_at DESC
    `, [req.user!.id]);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /sick-off-requests/:id/approve
//
// Approving does more than flip a status flag — it also writes (or
// overwrites) a real 'off' entry in staff_schedules for that date, so the
// schedule grid and this request never disagree about whether that
// person is actually working that day. Uses the same
// ON CONFLICT (user_id, shift_date) upsert the manual schedule editor
// already relies on.
export const approveSickOffRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const existing = await query('SELECT * FROM sick_off_requests WHERE id = $1', [id]);
    if (!existing.rows.length) { res.status(404).json({ success: false, message: 'Request not found' }); return; }
    const request = existing.rows[0];
    if (request.status !== 'pending') {
      res.status(400).json({ success: false, message: `This request has already been ${request.status}.` });
      return;
    }

    const result = await query(`
      UPDATE sick_off_requests SET status = 'approved', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $2 RETURNING *
    `, [req.user!.id, id]);

    await query(`
      INSERT INTO staff_schedules (user_id, shift_date, shift_type, role_label)
      VALUES ($1, $2, 'off', 'Sick Off')
      ON CONFLICT (user_id, shift_date) DO UPDATE SET
        shift_type = 'off', role_label = 'Sick Off', updated_at = CURRENT_TIMESTAMP
    `, [request.user_id, request.requested_date]);

    await logAudit(req, {
      action: 'sick_off_request_approved',
      entityType: 'sick_off_request',
      entityId: id,
      details: { requested_date: request.requested_date, staff_user_id: request.user_id },
    });

    res.json({ success: true, data: result.rows[0], message: 'Request approved — the schedule has been updated.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /sick-off-requests/:id/decline  { decline_reason? }
export const declineSickOffRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { decline_reason } = req.body;
    const existing = await query('SELECT * FROM sick_off_requests WHERE id = $1', [id]);
    if (!existing.rows.length) { res.status(404).json({ success: false, message: 'Request not found' }); return; }
    if (existing.rows[0].status !== 'pending') {
      res.status(400).json({ success: false, message: `This request has already been ${existing.rows[0].status}.` });
      return;
    }

    const result = await query(`
      UPDATE sick_off_requests SET status = 'declined', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP, decline_reason = $2
      WHERE id = $3 RETURNING *
    `, [req.user!.id, decline_reason || null, id]);

    await logAudit(req, {
      action: 'sick_off_request_declined',
      entityType: 'sick_off_request',
      entityId: id,
      details: { requested_date: existing.rows[0].requested_date, staff_user_id: existing.rows[0].user_id, decline_reason },
    });

    res.json({ success: true, data: result.rows[0], message: 'Request declined.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};