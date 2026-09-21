import { Request, Response } from 'express';
import { query } from '../config/database';

// Every number here used to be either hardcoded (Total Points Earned:
// 125,840 regardless of what had actually happened) or computed from a
// nonsensical formula (Points Liability: total customers × 1934, which
// isn't a real relationship to anything). All real now.
//
// Point value is fixed at KES 1 per point — not a configurable setting.
// It used to read a 'loyalty_points_value_kes' row that could be set to
// anything, which is exactly how it ended up misconfigured to 0.2 (a
// 25-point redemption paying out KES 5 instead of KES 25). Points are
// earned at a fixed 1 point per KES 20 spent (paymentservice.ts) — a
// straightforward 5% cash-back scheme — so a point is worth exactly what
// it says on both sides, with no separate rate that can drift out of sync.
const POINT_VALUE_KES = 1;

export const getLoyaltyStats = async (_req: Request, res: Response): Promise<void> => {
  try {
    const totalsRes = await query(`
      SELECT
        COALESCE(SUM(points) FILTER (WHERE type = 'earn'), 0) as total_earned,
        COALESCE(SUM(-points) FILTER (WHERE type = 'redeem'), 0) as total_redeemed
      FROM loyalty_transactions
    `);
    const activeRes = await query(`
      SELECT COUNT(DISTINCT customer_id) as active
      FROM orders
      WHERE customer_id IS NOT NULL AND status = 'completed' AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 days'
    `);
    const liabilityRes = await query(`SELECT COALESCE(SUM(available_points), 0) as total_available FROM loyalty_points`);
    const memberCountRes = await query(`SELECT COUNT(*) as total FROM customers WHERE status != 'inactive'`);

    res.json({
      success: true,
      data: {
        total_members: parseInt(memberCountRes.rows[0].total),
        total_earned: parseInt(totalsRes.rows[0].total_earned),
        total_redeemed: parseInt(totalsRes.rows[0].total_redeemed),
        active_members_30d: parseInt(activeRes.rows[0].active),
        points_liability_kes: parseInt(liabilityRes.rows[0].total_available) * POINT_VALUE_KES,
        point_value_kes: POINT_VALUE_KES,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getLoyaltyTiers = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query('SELECT * FROM loyalty_tiers ORDER BY min_points ASC');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};