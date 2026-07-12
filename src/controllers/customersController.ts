import { Request, Response } from 'express';
import { query, getClient } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { logAudit } from '../services/auditLog';

export const getCustomers = async (req: Request, res: Response): Promise<void> => {
  try {
    const { search, status, tier, page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (search) { conditions.push(`(c.full_name ILIKE $${idx} OR c.phone ILIKE $${idx} OR c.email ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    // Default to hiding inactive (soft-deleted) customers — status=all
    // explicitly requests them back, e.g. an admin reviewing deleted records.
    if (status && status !== 'all') { conditions.push(`c.status = $${idx++}`); params.push(status); }
    else if (!status) { conditions.push(`c.status != 'inactive'`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await query(`SELECT COUNT(*) FROM customers c ${where}`, params);

    // Tier used to come from lp.tier_id via a join — but nothing anywhere in
    // the app ever actually SET tier_id on a customer, so that join always
    // returned null and the frontend quietly papered over it with its own
    // client-side guess at tier thresholds. Computed live here instead, from
    // the real loyalty_tiers table, so it's always correct and never needs
    // a separate "promote this customer" step that could fall out of sync.
    let havingClause = '';
    if (tier) { havingClause = `HAVING (SELECT lt.name FROM loyalty_tiers lt WHERE lt.min_points <= COALESCE(lp.total_points, 0) ORDER BY lt.min_points DESC LIMIT 1) = $${idx++}`; params.push(tier); }

    const limitIdx = idx++;
    const offsetIdx = idx++;
    params.push(Number(limit), offset);

    const result = await query(`
      SELECT c.*,
        COUNT(DISTINCT o.id) as total_orders,
        COALESCE(SUM(o.total), 0) as total_spent,
        MAX(o.created_at) as last_visit,
        lp.total_points, lp.available_points, lp.redeemed_points,
        (SELECT lt.name FROM loyalty_tiers lt WHERE lt.min_points <= COALESCE(lp.total_points, 0) ORDER BY lt.min_points DESC LIMIT 1) as loyalty_tier,
        (SELECT COALESCE(SUM(t.points), 0) FROM loyalty_transactions t
           WHERE t.customer_id = c.id AND t.type = 'earn' AND t.created_at > CURRENT_TIMESTAMP - INTERVAL '30 days') as points_earned_30d
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'completed'
      LEFT JOIN loyalty_points lp ON lp.customer_id = c.id
      ${where}
      GROUP BY c.id, lp.total_points, lp.available_points, lp.redeemed_points
      ${havingClause}
      ORDER BY c.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, params);

    res.json({ success: true, data: result.rows, pagination: { total: parseInt(countRes.rows[0].count), page: Number(page), limit: Number(limit) } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getCustomerById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const custRes = await query(`
      SELECT c.*,
        COUNT(DISTINCT o.id) as total_orders,
        COALESCE(SUM(o.total), 0) as total_spent,
        MAX(o.created_at) as last_visit,
        lp.total_points, lp.available_points, lp.redeemed_points,
        (SELECT lt.name FROM loyalty_tiers lt WHERE lt.min_points <= COALESCE(lp.total_points, 0) ORDER BY lt.min_points DESC LIMIT 1) as loyalty_tier
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'completed'
      LEFT JOIN loyalty_points lp ON lp.customer_id = c.id
      WHERE c.id = $1
      GROUP BY c.id, lp.total_points, lp.available_points, lp.redeemed_points
    `, [id]);

    if (!custRes.rows.length) { res.status(404).json({ success: false, message: 'Customer not found' }); return; }

    const recentOrders = await query(`SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]);
    // Real points ledger (earn/redeem/adjust/expire) — this existed in the
    // database already but was never actually surfaced anywhere in the UI.
    const loyaltyHistory = await query(
      `SELECT * FROM loyalty_transactions WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 30`,
      [id]
    );

    res.json({ success: true, data: { ...custRes.rows[0], recent_orders: recentOrders.rows, loyalty_history: loyaltyHistory.rows } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const createCustomer = async (req: Request, res: Response): Promise<void> => {
  try {
    const { full_name, phone, email, address, city, tags, is_vip, credit_limit, notes } = req.body;
    if (!full_name || !full_name.toString().trim()) {
      res.status(400).json({ success: false, message: 'full_name is required' });
      return;
    }
    const ts = Date.now().toString().slice(-6);
    const rand = Math.floor(Math.random() * 900 + 100);
    const code = `CUS-${ts}${rand}`;
    const result = await query(`
      INSERT INTO customers (customer_code, full_name, phone, email, address, city, tags, is_vip, credit_limit, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [code, full_name.toString().trim(), phone, email, address, city, tags || [], is_vip || false, credit_limit || 0, notes]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateCustomer = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { full_name, phone, email, address, city, tags, is_vip, credit_limit, notes, status,
            sms_notifications, email_notifications, whatsapp_notifications, marketing_offers } = req.body;
    if (!full_name || !full_name.toString().trim()) {
      res.status(400).json({ success: false, message: 'full_name is required' });
      return;
    }
    const result = await query(`
      UPDATE customers SET full_name=$1, phone=$2, email=$3, address=$4, city=$5, tags=$6,
        is_vip=$7, credit_limit=$8, notes=$9, status=$10, sms_notifications=$11,
        email_notifications=$12, whatsapp_notifications=$13, marketing_offers=$14, updated_at=CURRENT_TIMESTAMP
      WHERE id=$15 RETURNING *
    `, [full_name.toString().trim(), phone || null, email || null, address || null, city || null, tags || [],
        is_vip || false, credit_limit || 0, notes || null, status || 'active',
        sms_notifications ?? true, email_notifications ?? true, whatsapp_notifications ?? false, marketing_offers ?? true, id]);
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Customer not found' }); return; }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Redeeming was previously impossible even though the schema was already
// built for it — loyalty_points.redeemed_points and the 'redeem' type on
// loyalty_transactions have existed since the loyalty system was first
// built, but nothing ever wrote to them. This is the first thing that does.
//
// Row-locks loyalty_points for the duration, the same pattern used for
// order payments — two redemption requests racing for the same customer
// (e.g. a double-click, or two staff members at once) must serialize
// against the same available_points balance rather than both reading it
// before either writes, which could let more points be redeemed than the
// customer actually has.
export const redeemPoints = async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { points, description } = req.body;
    const pointsToRedeem = Math.floor(Number(points));

    if (!Number.isFinite(pointsToRedeem) || pointsToRedeem <= 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'points must be a positive whole number' });
      return;
    }

    const lp = await client.query('SELECT * FROM loyalty_points WHERE customer_id = $1 FOR UPDATE', [id]);
    const available = lp.rows[0]?.available_points || 0;
    if (pointsToRedeem > available) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: `Customer only has ${available} points available` });
      return;
    }

    await client.query(
      `UPDATE loyalty_points SET available_points = available_points - $1, redeemed_points = redeemed_points + $1, updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $2`,
      [pointsToRedeem, id]
    );
    await client.query(
      `INSERT INTO loyalty_transactions (customer_id, type, points, description, performed_by)
       VALUES ($1, 'redeem', $2, $3, $4)`,
      [id, -pointsToRedeem, description || `${pointsToRedeem} points redeemed`, req.user!.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: `${pointsToRedeem} points redeemed`, remaining_points: available - pointsToRedeem });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

// Soft delete — sets status='inactive' rather than removing the row.
// Orders reference customer_id with ON DELETE SET NULL, so a hard delete
// wouldn't even break order history, but it also can't be undone and
// destroys the loyalty ledger along with it (loyalty_points cascades).
// 'inactive' matches how the rest of this app treats things people want
// gone from daily use without erasing the record — the same pattern menu
// items, tables, and inventory items already use.
export const deleteCustomer = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE customers SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, full_name`,
      [id]
    );
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Customer not found' }); return; }
    await logAudit(req, { action: 'customer_deleted', entityType: 'customer', entityId: id, details: { full_name: result.rows[0].full_name } });
    res.json({ success: true, message: 'Customer deleted' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Manual points correction — for goodwill gestures, fixing a mistake, or
// any adjustment that isn't tied to an actual sale (which is what earning
// via a paid order, and spending via redeemPoints above, already cover).
// Can go either direction: a positive amount adds points, negative removes
// them (still can't be pushed below zero available).
export const adjustPoints = async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { points, description } = req.body;
    const delta = Math.trunc(Number(points));

    if (!Number.isFinite(delta) || delta === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'points must be a non-zero whole number' });
      return;
    }
    if (!description || !description.toString().trim()) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'A reason is required for manual point adjustments' });
      return;
    }

    const lp = await client.query('SELECT * FROM loyalty_points WHERE customer_id = $1 FOR UPDATE', [id]);
    const currentAvailable = lp.rows[0]?.available_points || 0;
    if (currentAvailable + delta < 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: `That would take available points below zero (currently ${currentAvailable})` });
      return;
    }

    await client.query(
      `INSERT INTO loyalty_points (customer_id, total_points, available_points)
       VALUES ($1, GREATEST($2, 0), $2)
       ON CONFLICT (customer_id) DO UPDATE SET
         total_points = GREATEST(loyalty_points.total_points + $2, 0),
         available_points = loyalty_points.available_points + $2,
         updated_at = CURRENT_TIMESTAMP`,
      [id, delta]
    );
    await client.query(
      `INSERT INTO loyalty_transactions (customer_id, type, points, description, performed_by)
       VALUES ($1, 'adjust', $2, $3, $4)`,
      [id, delta, description.toString().trim(), req.user!.id]
    );

    await client.query('COMMIT');
    await logAudit(req, { action: 'loyalty_points_adjusted', entityType: 'customer', entityId: id, details: { points: delta, reason: description.toString().trim() } });
    res.json({ success: true, message: `Adjusted by ${delta > 0 ? '+' : ''}${delta} points` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};