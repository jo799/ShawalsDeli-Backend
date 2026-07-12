import { Request, Response } from 'express';
import { query, getClient } from '../config/database';
import { AuthRequest } from '../middleware/auth';

// Uses timestamp + random suffix (same approach as order numbers) rather than
// COUNT(*)+1, which produces duplicates if any PO is ever deleted and races
// if two POs are created simultaneously.
const generatePONumber = (prefix = 'PO'): string => {
  const ts = Date.now().toString().slice(-7);
  const rand = Math.floor(Math.random() * 90 + 10);
  return `${prefix}-${ts}${rand}`;
};

export const getPurchaseOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, supplier_id, start_date, end_date, search, page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (status && status !== 'all') { conditions.push(`po.status = $${idx++}`); params.push(status); }
    if (supplier_id) { conditions.push(`po.supplier_id = $${idx++}`); params.push(supplier_id); }
    if (start_date) { conditions.push(`po.order_date >= $${idx++}`); params.push(start_date); }
    if (end_date) { conditions.push(`po.order_date <= $${idx++}`); params.push(end_date); }
    if (search) { conditions.push(`(po.po_number ILIKE $${idx} OR s.name ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await query(`SELECT COUNT(*) FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id ${where}`, params);

    params.push(Number(limit), offset);
    const result = await query(`
      SELECT po.*, s.name as supplier_name, s.phone as supplier_phone,
        CASE WHEN po.total_amount > 0 THEN
          ROUND((SELECT COALESCE(SUM(quantity_received), 0) FROM purchase_order_items WHERE purchase_order_id = po.id) /
          NULLIF((SELECT COALESCE(SUM(quantity_ordered), 0) FROM purchase_order_items WHERE purchase_order_id = po.id), 0) * 100)
        ELSE 0 END as received_percentage
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      ${where}
      ORDER BY po.order_date DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    const statsRes = await query(`
      SELECT COUNT(*) as total_pos, SUM(total_amount) as total_spent,
        COUNT(*) FILTER (WHERE status='draft') as draft,
        COUNT(*) FILTER (WHERE status='pending') as pending,
        COUNT(*) FILTER (WHERE status='partially_received') as partially_received,
        COUNT(*) FILTER (WHERE status='received') as received,
        COUNT(*) FILTER (WHERE status='cancelled') as cancelled,
        COUNT(*) FILTER (WHERE expected_date < CURRENT_DATE AND status NOT IN ('received','cancelled')) as overdue
      FROM purchase_orders WHERE DATE_TRUNC('month', order_date) = DATE_TRUNC('month', CURRENT_DATE)
    `);

    res.json({ success: true, data: result.rows, stats: statsRes.rows[0], pagination: { total: parseInt(countRes.rows[0].count), page: Number(page), limit: Number(limit) } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getPurchaseOrderById = async (req: Request, res: Response): Promise<void> => {
  try {
    const poRes = await query(`
      SELECT po.*, s.name as supplier_name, s.phone as supplier_phone
      FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id
      WHERE po.id = $1
    `, [req.params.id]);
    if (!poRes.rows.length) { res.status(404).json({ success: false, message: 'Not found' }); return; }
    const itemsRes = await query('SELECT * FROM purchase_order_items WHERE purchase_order_id = $1', [req.params.id]);
    res.json({ success: true, data: { ...poRes.rows[0], items: itemsRes.rows } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const createPurchaseOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { supplier_id, expected_date, items, notes, discount = 0 } = req.body;

    if (!supplier_id) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'supplier_id is required' });
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'At least one order item is required' });
      return;
    }
    for (const item of items) {
      if (!item.item_name || !String(item.item_name).trim()) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: 'Every item needs a name' });
        return;
      }
      const qty = Number(item.quantity_ordered);
      const price = Number(item.unit_price);
      if (!Number.isFinite(qty) || qty <= 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: `quantity_ordered for "${item.item_name}" must be a positive number` });
        return;
      }
      if (!Number.isFinite(price) || price < 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: `unit_price for "${item.item_name}" must be a non-negative number` });
        return;
      }
    }

    const prefixSetting = await client.query("SELECT value FROM settings WHERE key = 'po_number_prefix'");
    const po_number = generatePONumber(prefixSetting.rows[0]?.value || 'PO');
    let subtotal = 0;
    for (const item of items) { subtotal += item.unit_price * item.quantity_ordered; }
    const total_amount = subtotal - discount;

    // Created directly as 'pending' (order placed, awaiting delivery) rather
    // than relying on the schema's 'draft' default — this form is one-shot
    // submission (fill it out, click Create), with no separate "save as
    // draft, edit later, then submit" step for 'draft' to actually mean
    // anything yet.

    const poRes = await client.query(`
      INSERT INTO purchase_orders (po_number, supplier_id, status, expected_date, subtotal, discount, total_amount, notes, created_by)
      VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8) RETURNING *
    `, [po_number, supplier_id, expected_date || null, subtotal, discount, total_amount, notes || null, req.user!.id]);

    for (const item of items) {
      await client.query(`
        INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, item_name, unit, quantity_ordered, unit_price, total)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [poRes.rows[0].id, item.inventory_item_id || null, item.item_name, item.unit, item.quantity_ordered, item.unit_price, item.unit_price * item.quantity_ordered]);
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: poRes.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

// Recording a delivery. This is the piece that was entirely missing: a
// purchase order could be created and listed, but nothing ever credited
// inventory_items.quantity or advanced quantity_received/status — the only
// way stock ever went up was a manual Adjust Stock entry with no link back
// to what was actually ordered or paid for.
//
// Accepts a partial delivery (not everything ordered has to arrive at once):
// each line item can receive anywhere from 0 up to what's still outstanding,
// and the PO's overall status is recomputed from the real line-item totals
// afterward — 'partially_received' if some but not all is in, 'received'
// (with received_date stamped) once every line is fully accounted for.
export const receivePurchaseOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { items } = req.body as { items?: Array<{ id: string; quantity_received_now: number }> };

    if (!Array.isArray(items) || items.length === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'At least one item quantity is required' });
      return;
    }

    const poRes = await client.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!poRes.rows.length) {
      await client.query('ROLLBACK');
      res.status(404).json({ success: false, message: 'Purchase order not found' });
      return;
    }
    const po = poRes.rows[0];
    if (po.status === 'cancelled') {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'This purchase order is cancelled' });
      return;
    }
    if (po.status === 'received') {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'This purchase order has already been fully received' });
      return;
    }

    let anyReceived = false;
    for (const entry of items) {
      const qtyNow = Number(entry.quantity_received_now);
      // Zero/blank rows are expected — a delivery rarely brings every line
      // item at once, so the UI sends the whole list and only some rows
      // carry a positive quantity. Skip the rest rather than rejecting them.
      if (!Number.isFinite(qtyNow) || qtyNow <= 0) continue;

      const itemRes = await client.query(
        'SELECT * FROM purchase_order_items WHERE id = $1 AND purchase_order_id = $2 FOR UPDATE',
        [entry.id, id]
      );
      if (!itemRes.rows.length) continue; // unknown line id — ignore rather than fail the whole receipt
      const poItem = itemRes.rows[0];

      const remaining = Math.round((Number(poItem.quantity_ordered) - Number(poItem.quantity_received)) * 1000) / 1000;
      if (qtyNow - remaining > 0.001) {
        await client.query('ROLLBACK');
        res.status(400).json({
          success: false,
          message: `Cannot receive ${qtyNow} ${poItem.unit} of "${poItem.item_name}" — only ${remaining} ${poItem.unit} still outstanding`,
        });
        return;
      }

      const newReceived = Math.round((Number(poItem.quantity_received) + qtyNow) * 1000) / 1000;
      await client.query('UPDATE purchase_order_items SET quantity_received = $1 WHERE id = $2', [newReceived, poItem.id]);
      anyReceived = true;

      // Credit inventory only if this line is actually linked to a real
      // inventory item — a PO line typed in as free text (no inventory_item_id)
      // has nothing to credit, and that's fine: receiving still records the
      // delivery on the PO itself, it just can't move a stock count that
      // isn't tracked anywhere.
      if (poItem.inventory_item_id) {
        const invRes = await client.query('SELECT * FROM inventory_items WHERE id = $1 AND is_active = true FOR UPDATE', [poItem.inventory_item_id]);
        if (invRes.rows.length > 0) {
          const invItem = invRes.rows[0];
          const before = Number(invItem.quantity);
          const after = Math.round((before + qtyNow) * 1000) / 1000;
          await client.query('UPDATE inventory_items SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [after, invItem.id]);
          await client.query(`
            INSERT INTO inventory_transactions (inventory_item_id, type, quantity_change, quantity_before, quantity_after, notes, reference_id, performed_by)
            VALUES ($1, 'purchase', $2, $3, $4, $5, $6, $7)
          `, [invItem.id, qtyNow, before, after, `Received from PO ${po.po_number}`, id, req.user!.id]);
        }
      }
    }

    if (!anyReceived) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'No positive quantities were provided to receive' });
      return;
    }

    // Recompute the PO's overall status from the real line-item totals,
    // rather than trusting the caller to say "mark this received" — the
    // truth is whatever quantity_received vs quantity_ordered actually says
    // across every line after this update.
    const allItems = await client.query('SELECT quantity_ordered, quantity_received FROM purchase_order_items WHERE purchase_order_id = $1', [id]);
    const fullyReceived = allItems.rows.every(r => Number(r.quantity_received) >= Number(r.quantity_ordered) - 0.001);
    const anyReceivedAtAll = allItems.rows.some(r => Number(r.quantity_received) > 0);
    const newStatus = fullyReceived ? 'received' : anyReceivedAtAll ? 'partially_received' : po.status;

    const updated = await client.query(
      `UPDATE purchase_orders
       SET status = $1::VARCHAR, received_date = CASE WHEN $1::VARCHAR = 'received' THEN CURRENT_DATE ELSE received_date END, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [newStatus, id]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      data: updated.rows[0],
      message: newStatus === 'received' ? 'Purchase order fully received — inventory updated.' : 'Partial delivery recorded — inventory updated.',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

export const getSuppliers = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query('SELECT * FROM suppliers WHERE is_active = true ORDER BY name');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Lets a supplier be added inline while creating a purchase order — before
// this, the supplier picker could only choose from whatever was already in
// the database, with no way to actually add a new one anywhere in the app.
export const createSupplier = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, contact_person, phone, email, address, notes } = req.body;
    if (!name || !String(name).trim()) {
      res.status(400).json({ success: false, message: 'Supplier name is required' });
      return;
    }
    const result = await query(`
      INSERT INTO suppliers (name, contact_person, phone, email, address, notes)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [String(name).trim(), contact_person || null, phone || null, email || null, address || null, notes || null]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};