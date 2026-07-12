import { Request, Response } from 'express';
import { query } from '../config/database';

// Admin-only (enforced at the route level) — this is a record of who did
// what across the whole system, including other admins' actions, so it
// isn't something managers or staff get a view into.
export const getAuditLogs = async (req: Request, res: Response): Promise<void> => {
  try {
    const { action, user_id, start_date, end_date, page = 1, limit = 50 } = req.query;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (action) { conditions.push(`action = $${idx++}`); params.push(action); }
    if (user_id) { conditions.push(`user_id = $${idx++}`); params.push(user_id); }
    if (start_date) { conditions.push(`created_at >= $${idx++}`); params.push(start_date); }
    if (end_date) { conditions.push(`created_at <= $${idx++}::date + INTERVAL '1 day'`); params.push(end_date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (Number(page) - 1) * Number(limit);

    const countRes = await query(`SELECT COUNT(*) FROM audit_logs ${where}`, params);
    params.push(Number(limit), offset);
    const result = await query(`
      SELECT * FROM audit_logs ${where}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    res.json({
      success: true,
      data: result.rows,
      pagination: { total: parseInt(countRes.rows[0].count), page: Number(page), limit: Number(limit) },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Distinct action types actually present — populates the filter dropdown
// with what's real rather than a hardcoded, possibly-stale list.
export const getAuditLogActions = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query('SELECT DISTINCT action FROM audit_logs ORDER BY action');
    res.json({ success: true, data: result.rows.map(r => r.action) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};