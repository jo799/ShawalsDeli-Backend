import { Request, Response } from 'express';
import { query } from '../config/database';

// Every number here used to be either hardcoded (Total Points Earned:
// 125,840 regardless of what had actually happened) or computed from a
// nonsensical formula (Points Liability: total customers × 1934, which
// isn't a real relationship to anything). All real now, and Points
// Liability in particular only became a meaningful number once redemption
// had an actual KES conversion rate behind it — before that, "how much are
// outstanding points worth" had no defined answer at all.
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

    const settingRes = await query(`SELECT value FROM settings WHERE key = 'loyalty_points_value_kes'`);
    const pointValueKes = parseFloat(settingRes.rows[0]?.value) || 1;

    res.json({
      success: true,
      data: {
        total_members: parseInt(memberCountRes.rows[0].total),
        total_earned: parseInt(totalsRes.rows[0].total_earned),
        total_redeemed: parseInt(totalsRes.rows[0].total_redeemed),
        active_members_30d: parseInt(activeRes.rows[0].active),
        points_liability_kes: Math.round(parseInt(liabilityRes.rows[0].total_available) * pointValueKes * 100) / 100,
        point_value_kes: pointValueKes,
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

// The KES value of one point — this is what makes redemption mean "points
// convert to money" rather than "points buy a specific listed reward". A
// setting rather than a constant so the business can actually change it
// without a code deploy; reuses the same key-value settings store the rest
// of the app's configurable business rules already live in.
export const updatePointValue = async (req: Request, res: Response): Promise<void> => {
  try {
    const { point_value_kes } = req.body;
    const value = parseFloat(point_value_kes);
    if (!Number.isFinite(value) || value <= 0) {
      res.status(400).json({ success: false, message: 'point_value_kes must be a positive number' });
      return;
    }
    await query(`
      INSERT INTO settings (key, value, updated_at) VALUES ('loyalty_points_value_kes', $1, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP
    `, [String(value)]);
    res.json({ success: true, message: 'Point value updated' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};