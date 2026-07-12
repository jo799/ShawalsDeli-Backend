import { Response } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';

// ─────────────────────────────────────────────────────────────────────────────
// Held orders — the backing store for the POS "Hold Order" / "Save Draft"
// buttons. These are suspended carts, not real orders: nothing here touches
// inventory, the kitchen display, or table occupancy. See migrate.ts for the
// full rationale on why `items` is stored as an opaque JSONB snapshot rather
// than normalized rows.
// ─────────────────────────────────────────────────────────────────────────────

interface CartItemInput {
  menu_item_id?: string;
  name?: string;
  price?: number;
  quantity?: number;
  [key: string]: unknown;
}

export const createHeldOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { label, type, table_id, table_number, customer_name, items } = req.body as {
      label?: string; type?: string; table_id?: string; table_number?: string;
      customer_name?: string; items?: CartItemInput[];
    };

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ success: false, message: 'Cannot hold an empty cart' });
      return;
    }
    const validTypes = ['dine_in', 'takeaway', 'delivery'];
    const orderType = validTypes.includes(type || '') ? type : 'dine_in';

    // subtotal/item_count are informational only (for the resume-picker list),
    // computed from what the POS already knows about its own cart — never
    // treated as authoritative money, since resuming always re-prices through
    // the normal createOrder path.
    const itemCount = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    const subtotal = Math.round(items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0) * 100) / 100;

    const result = await query(
      `INSERT INTO held_orders (label, type, table_id, table_number, customer_name, items, item_count, subtotal, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [label || null, orderType, table_id || null, table_number || null, customer_name || null,
       JSON.stringify(items), itemCount, subtotal, req.user!.id]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Create held order error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Small business, small list — no pagination. Capped for sanity.
export const getHeldOrders = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query(`SELECT h.*, u.full_name as created_by_name FROM held_orders h LEFT JOIN users u ON h.created_by = u.id ORDER BY h.created_at DESC LIMIT 50`);
    res.json({ success: true, data: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Get held orders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Discarding is how a resume completes (frontend loads the cart, then calls
// this to remove the held record) and also how a cashier abandons a hold they
// no longer need. Both are the same operation from the backend's perspective.
export const deleteHeldOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query('DELETE FROM held_orders WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Held order not found — it may have already been resumed or discarded elsewhere.' });
      return;
    }
    res.json({ success: true, message: 'Held order removed' });
  } catch (error) {
    console.error('Delete held order error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};