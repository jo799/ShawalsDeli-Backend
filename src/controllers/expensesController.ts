import { Request, Response } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { logAudit } from '../services/auditLog';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { randomUUID } from 'crypto';

const VALID_PAYMENT_METHODS = ['cash', 'mpesa', 'bank_transfer', 'card'];

export const getExpenses = async (req: Request, res: Response): Promise<void> => {
  try {
    const { category_id, payment_method, start_date, end_date, search, page = 1, limit = 10 } = req.query;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (category_id) { conditions.push(`e.category_id = $${idx++}`); params.push(category_id); }
    if (payment_method) { conditions.push(`e.payment_method = $${idx++}`); params.push(payment_method); }
    if (start_date) { conditions.push(`e.expense_date >= $${idx++}`); params.push(start_date); }
    if (end_date) { conditions.push(`e.expense_date <= $${idx++}`); params.push(end_date); }
    if (search) { conditions.push(`(e.title ILIKE $${idx} OR e.vendor ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (Number(page) - 1) * Number(limit);
    const countRes = await query(`SELECT COUNT(*), SUM(amount) as total FROM expenses e ${where}`, params);

    params.push(Number(limit), offset);
    const result = await query(`
      SELECT e.*, ec.name as category_name, ec.color as category_color, u.full_name as created_by_name
      FROM expenses e
      LEFT JOIN expense_categories ec ON e.category_id = ec.id
      LEFT JOIN users u ON e.created_by = u.id
      ${where}
      ORDER BY e.expense_date DESC, e.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    // This used to end with `.replace(/e\./g, 'e.')` — a no-op (replacing
    // "e." with itself) that did nothing at all, presumably a leftover from
    // an edit that never got finished. Removed rather than left in place
    // looking like it was doing something.
    const byCategory = await query(`
      SELECT ec.name, ec.color, SUM(e.amount) as total, COUNT(*) as count
      FROM expenses e JOIN expense_categories ec ON e.category_id = ec.id
      ${where}
      GROUP BY ec.name, ec.color ORDER BY total DESC
    `, params.slice(0, -2));

    res.json({
      success: true, data: result.rows,
      summary: { total: parseFloat(countRes.rows[0].total || '0'), count: parseInt(countRes.rows[0].count) },
      by_category: byCategory.rows.map(r => ({ name: r.name, color: r.color, total: parseFloat(r.total) || 0, count: parseInt(r.count) || 0 })),
      pagination: { total: parseInt(countRes.rows[0].count), page: Number(page), limit: Number(limit) }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Real numbers for what the Expenses page's stat cards used to fabricate:
//   - "This Month" showed the exact same figure as "Total Expenses" (no
//     date scoping applied anywhere), with a hardcoded "↓8.5% vs Apr 2025"
//     underneath it that never changed regardless of any actual spending.
//   - "Average per Day" divided that same all-time total by a hardcoded 30,
//     compounding the first bug with a wrong day-count for good measure.
//   - "Over Budget: 2 Categories" was a fixed string — but
//     expense_categories.budget_limit is a real column nothing was ever
//     reading from, so this is now a real comparison instead of a made-up one.
export const getExpenseStats = async (_req: Request, res: Response): Promise<void> => {
  try {
    const monthRes = await query(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
      FROM expenses
      WHERE DATE_TRUNC('month', expense_date) = DATE_TRUNC('month', CURRENT_DATE)
    `);
    const lastMonthRes = await query(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM expenses
      WHERE DATE_TRUNC('month', expense_date) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
    `);
    const daysElapsedRes = await query(`SELECT EXTRACT(DAY FROM CURRENT_DATE)::int as day`);

    const budgetRes = await query(`
      SELECT ec.id, ec.name, ec.budget_limit, COALESCE(SUM(e.amount), 0) as spent
      FROM expense_categories ec
      LEFT JOIN expenses e ON e.category_id = ec.id AND DATE_TRUNC('month', e.expense_date) = DATE_TRUNC('month', CURRENT_DATE)
      WHERE ec.budget_limit IS NOT NULL
      GROUP BY ec.id, ec.name, ec.budget_limit
    `);
    const overBudget = budgetRes.rows.filter(r => parseFloat(r.spent) > parseFloat(r.budget_limit));

    const thisMonthTotal = parseFloat(monthRes.rows[0].total);
    const lastMonthTotal = parseFloat(lastMonthRes.rows[0].total);
    const changePct = lastMonthTotal > 0
      ? Math.round(((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100)
      : (thisMonthTotal > 0 ? null : 0);
    const daysElapsed = Math.max(1, daysElapsedRes.rows[0].day);

    res.json({
      success: true,
      data: {
        this_month_total: thisMonthTotal,
        this_month_count: parseInt(monthRes.rows[0].count),
        this_month_change_pct: changePct,
        average_per_day: Math.round((thisMonthTotal / daysElapsed) * 100) / 100,
        over_budget_categories: overBudget.map(r => ({ name: r.name, spent: parseFloat(r.spent), budget_limit: parseFloat(r.budget_limit) })),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

function validateExpenseBody(body: Record<string, unknown>): string | null {
  if (!body.title || !String(body.title).trim()) return 'title is required';
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return 'amount must be a positive number';
  if (body.payment_method && !VALID_PAYMENT_METHODS.includes(String(body.payment_method))) {
    return `payment_method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`;
  }
  return null;
}

export const createExpense = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { title, description, category_id, vendor, amount, payment_method, expense_date, reference_no, notes } = req.body;
    const validationError = validateExpenseBody(req.body);
    if (validationError) {
      res.status(400).json({ success: false, message: validationError });
      return;
    }
    if (category_id) {
      const catCheck = await query('SELECT id FROM expense_categories WHERE id = $1', [category_id]);
      if (!catCheck.rows.length) {
        res.status(400).json({ success: false, message: 'category_id does not match a real category' });
        return;
      }
    }

    // expense_date falls back to CURRENT_DATE in SQL (session pinned to
    // Africa/Nairobi) rather than a JS-computed new Date().toISOString()
    // date, which would suffer the exact UTC-vs-local day-boundary bug
    // fixed elsewhere in this app (an expense logged just after midnight
    // Nairobi time could otherwise land on the previous day).
    const result = await query(`
      INSERT INTO expenses (title, description, category_id, vendor, amount, payment_method, expense_date, reference_no, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date, CURRENT_DATE),$8,$9,$10) RETURNING *
    `, [
      String(title).trim(), description || null, category_id || null, vendor || null, Number(amount),
      payment_method || null, expense_date || null, reference_no || null, notes || null, req.user!.id,
    ]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateExpense = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { title, description, category_id, vendor, amount, payment_method, expense_date, reference_no, notes } = req.body;
    const validationError = validateExpenseBody(req.body);
    if (validationError) {
      res.status(400).json({ success: false, message: validationError });
      return;
    }
    if (category_id) {
      const catCheck = await query('SELECT id FROM expense_categories WHERE id = $1', [category_id]);
      if (!catCheck.rows.length) {
        res.status(400).json({ success: false, message: 'category_id does not match a real category' });
        return;
      }
    }

    const result = await query(`
      UPDATE expenses SET title=$1, description=$2, category_id=$3, vendor=$4, amount=$5,
        payment_method=$6, expense_date=COALESCE($7::date, expense_date), reference_no=$8, notes=$9, updated_at=CURRENT_TIMESTAMP
      WHERE id=$10 RETURNING *
    `, [String(title).trim(), description || null, category_id || null, vendor || null, Number(amount),
        payment_method || null, expense_date || null, reference_no || null, notes || null, id]);
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Expense not found' }); return; }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const deleteExpense = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query('DELETE FROM expenses WHERE id=$1 RETURNING id, title, amount, category_id', [req.params.id]);
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Expense not found' }); return; }
    await logAudit(req, { action: 'expense_deleted', entityType: 'expense', entityId: req.params.id, details: { title: result.rows[0].title, amount: result.rows[0].amount } });
    res.json({ success: true, message: 'Expense deleted' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getExpenseCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query('SELECT * FROM expense_categories ORDER BY name');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// The Add Expense form's category dropdown had no way to add one if the
// list didn't already have what was needed — same "+ New" inline-creation
// pattern already used for suppliers on the Purchases page.
export const createExpenseCategory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, color, icon, budget_limit } = req.body;
    if (!name || !String(name).trim()) {
      res.status(400).json({ success: false, message: 'name is required' });
      return;
    }
    const existing = await query('SELECT id FROM expense_categories WHERE name = $1', [String(name).trim()]);
    if (existing.rows.length) {
      res.status(400).json({ success: false, message: 'A category with that name already exists' });
      return;
    }
    const result = await query(
      `INSERT INTO expense_categories (name, color, icon, budget_limit) VALUES ($1,$2,$3,$4) RETURNING *`,
      [String(name).trim(), color || '#6B7280', icon || null, budget_limit ? Number(budget_limit) : null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Receipt upload — expenses.receipt_url has existed in the schema the whole
// time, but nothing anywhere ever wrote to it or let anyone attach a
// receipt. Same validated-disk-storage pattern used for menu images and the
// business logo.
// ─────────────────────────────────────────────────────────────────────────────

const UPLOAD_ROOT = process.env.UPLOAD_DIR || 'uploads';
const RECEIPT_DIR = path.join(UPLOAD_ROOT, 'receipts');
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

export const uploadExpenseReceipt = (req: Request, res: Response): void => {
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
    const url = `/uploads/receipts/${req.file.filename}`;
    const result = await query('UPDATE expenses SET receipt_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id', [url, req.params.id]);
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Expense not found' }); return; }
    res.status(201).json({ success: true, url });
  });
};