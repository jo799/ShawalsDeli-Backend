import { Request, Response } from 'express';
import { query, getClient } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { logAudit } from '../services/auditLog';

export const getInventory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { search, category, status, supplier_id, page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const conditions: string[] = ['i.is_active = true'];
    const params: unknown[] = [];
    let idx = 1;

    if (search) { conditions.push(`i.name ILIKE $${idx++}`); params.push(`%${search}%`); }
    if (category) { conditions.push(`i.category = $${idx++}`); params.push(category); }
    if (supplier_id) { conditions.push(`i.supplier_id = $${idx++}`); params.push(supplier_id); }
    if (status === 'low_stock') { conditions.push(`i.quantity > 0 AND i.quantity <= i.reorder_level`); }
    else if (status === 'out_of_stock') { conditions.push(`i.quantity = 0`); }
    else if (status === 'in_stock') { conditions.push(`i.quantity > i.reorder_level`); }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const countRes = await query(`SELECT COUNT(*) FROM inventory_items i ${where}`, params);

    params.push(Number(limit), offset);
    const result = await query(`
      SELECT i.*, s.name as supplier_name,
        CASE WHEN i.quantity = 0 THEN 'out_of_stock'
             WHEN i.quantity <= i.reorder_level THEN 'low_stock'
             ELSE 'in_stock' END as stock_status,
        (i.quantity * i.cost_per_unit) as stock_value
      FROM inventory_items i
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      ${where}
      ORDER BY i.name
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    const statsRes = await query(`
      SELECT
        COUNT(*) as total_items,
        SUM(quantity * cost_per_unit) as total_value,
        COUNT(*) FILTER (WHERE quantity > 0 AND quantity <= reorder_level) as low_stock,
        COUNT(*) FILTER (WHERE quantity = 0) as out_of_stock
      FROM inventory_items
      WHERE is_active = true
    `);

    res.json({ success: true, data: result.rows, stats: statsRes.rows[0], pagination: { total: parseInt(countRes.rows[0].count), page: Number(page), limit: Number(limit) } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const adjustStock = async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { quantity_change, notes, type = 'adjustment' } = req.body;

    const validTypes = ['adjustment', 'waste', 'transfer'];
    if (!validTypes.includes(type)) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: `type must be one of: ${validTypes.join(', ')} ('purchase'/'sale' are recorded automatically, not chosen by hand)` });
      return;
    }
    const change = Number(quantity_change);
    if (!Number.isFinite(change) || change === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'quantity_change must be a non-zero number' });
      return;
    }

    const itemRes = await client.query('SELECT * FROM inventory_items WHERE id = $1 AND is_active = true FOR UPDATE', [id]);
    if (!itemRes.rows.length) {
      // Every early-return inside this transaction MUST roll back before
      // returning — the connection goes back to the pool either way (the
      // `finally` below always runs), but without this, it goes back
      // mid-transaction: still holding the row lock just taken above, and
      // carrying that open transaction into whatever unrelated request
      // happens to check out this same connection next. That's what was
      // happening here before: a request for a bad item id could leave a
      // stale lock on a real row, silently stalling a completely different
      // request until something else on that recycled connection happened
      // to COMMIT or ROLLBACK it away.
      await client.query('ROLLBACK');
      res.status(404).json({ success: false, message: 'Item not found' });
      return;
    }
    const item = itemRes.rows[0];
    const newQty = Math.round((parseFloat(item.quantity) + change) * 1000) / 1000;
    if (newQty < 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: `Insufficient stock — only ${item.quantity} ${item.unit} available` });
      return;
    }

    await client.query('UPDATE inventory_items SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newQty, id]);
    await client.query(`
      INSERT INTO inventory_transactions (inventory_item_id, type, quantity_change, quantity_before, quantity_after, notes, performed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [id, type, change, item.quantity, newQty, notes || null, req.user!.id]);

    await client.query('COMMIT');
    res.json({ success: true, data: { ...item, quantity: newQty } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

export const createInventoryItem = async (req: Request, res: Response): Promise<void> => {
  try {
    const { sku, name, description, category, supplier_id, quantity, unit, cost_per_unit, reorder_level, location, expiry_date } = req.body;

    if (!sku || !String(sku).trim()) {
      res.status(400).json({ success: false, message: 'sku is required' });
      return;
    }
    if (!name || !String(name).trim()) {
      res.status(400).json({ success: false, message: 'name is required' });
      return;
    }
    const qty = quantity === undefined || quantity === '' ? 0 : Number(quantity);
    const cost = cost_per_unit === undefined || cost_per_unit === '' ? 0 : Number(cost_per_unit);
    const reorder = reorder_level === undefined || reorder_level === '' ? 0 : Number(reorder_level);
    if (!Number.isFinite(qty) || qty < 0) {
      res.status(400).json({ success: false, message: 'quantity must be a non-negative number' });
      return;
    }
    if (!Number.isFinite(cost) || cost < 0) {
      res.status(400).json({ success: false, message: 'cost_per_unit must be a non-negative number' });
      return;
    }
    if (!Number.isFinite(reorder) || reorder < 0) {
      res.status(400).json({ success: false, message: 'reorder_level must be a non-negative number' });
      return;
    }

    const result = await query(`
      INSERT INTO inventory_items (sku, name, description, category, supplier_id, quantity, unit, cost_per_unit, reorder_level, location, expiry_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [String(sku).trim(), String(name).trim(), description || null, category || null, supplier_id || null, qty, unit || 'Kg', cost, reorder, location || 'Main Store', expiry_date || null]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === '23505') {
      res.status(400).json({ success: false, message: 'An item with that SKU already exists' });
      return;
    }
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Edits an item's static details — name, cost, reorder level, supplier, etc.
// Deliberately does NOT touch `quantity`: every stock-quantity change in this
// app goes through adjustStock (or the sale/restock services) so it's always
// logged to inventory_transactions. Letting an edit form silently change the
// quantity here would create an untracked stock movement with no audit trail
// — exactly the kind of gap that makes "why does the count not match" days
// impossible to debug later.
export const updateInventoryItem = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { sku, name, description, category, supplier_id, unit, cost_per_unit, reorder_level, location, expiry_date } = req.body;

    if (!sku || !String(sku).trim()) {
      res.status(400).json({ success: false, message: 'sku is required' });
      return;
    }
    if (!name || !String(name).trim()) {
      res.status(400).json({ success: false, message: 'name is required' });
      return;
    }
    const cost = cost_per_unit === undefined || cost_per_unit === '' ? 0 : Number(cost_per_unit);
    const reorder = reorder_level === undefined || reorder_level === '' ? 0 : Number(reorder_level);
    if (!Number.isFinite(cost) || cost < 0) {
      res.status(400).json({ success: false, message: 'cost_per_unit must be a non-negative number' });
      return;
    }
    if (!Number.isFinite(reorder) || reorder < 0) {
      res.status(400).json({ success: false, message: 'reorder_level must be a non-negative number' });
      return;
    }

    const result = await query(`
      UPDATE inventory_items SET sku=$1, name=$2, description=$3, category=$4, supplier_id=$5,
        unit=$6, cost_per_unit=$7, reorder_level=$8, location=$9, expiry_date=$10, updated_at=CURRENT_TIMESTAMP
      WHERE id=$11 AND is_active = true RETURNING *
    `, [String(sku).trim(), String(name).trim(), description || null, category || null, supplier_id || null,
        unit || 'Kg', cost, reorder, location || 'Main Store', expiry_date || null, id]);

    if (!result.rows.length) {
      res.status(404).json({ success: false, message: 'Item not found' });
      return;
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === '23505') {
      res.status(400).json({ success: false, message: 'An item with that SKU already exists' });
      return;
    }
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Soft delete — inventory_items is referenced by recipe_ingredients (which
// CASCADEs on delete) and by inventory_transactions' history, so a hard
// DELETE would silently rip ingredients out of every recipe that used this
// item and orphan its audit trail. Archiving keeps both intact and just
// removes it from active listings, same pattern as menu_items/tables.
export const deleteInventoryItem = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE inventory_items SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND is_active = true RETURNING id, name`,
      [id]
    );
    if (!result.rows.length) {
      res.status(404).json({ success: false, message: 'Item not found' });
      return;
    }
    await logAudit(req, { action: 'inventory_item_deleted', entityType: 'inventory_item', entityId: id, details: { name: result.rows[0].name } });
    res.json({ success: true, message: 'Item archived' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Items at or below their reorder level (or already out), worst first. Feeds
// dashboard "Inventory Alerts" and restock prompts. Out-of-stock and negative
// (oversold) items surface at the top since those are the urgent ones.
export const getLowStock = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(`
      SELECT i.*, s.name AS supplier_name,
        CASE WHEN i.quantity <= 0 THEN 'out_of_stock'
             WHEN i.quantity <= i.reorder_level THEN 'low_stock'
             ELSE 'in_stock' END AS stock_status,
        (i.reorder_level - i.quantity) AS shortfall
      FROM inventory_items i
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE i.is_active = true AND i.quantity <= i.reorder_level
      ORDER BY (i.quantity <= 0) DESC, (i.reorder_level - i.quantity) DESC, i.name
    `);
    // Countable finished-goods (chapati/samosa/soda-style menu items) running
    // low or out — same "Inventory Alerts" concept, different table. Kept as
    // a separate array (rather than merged rows) since the shape differs
    // (units, not weight/volume) and callers may want to render them apart.
    const menuStock = await query(`
      SELECT m.id, m.name, m.stock_quantity, m.reorder_level, m.category_id, c.name AS category_name,
        CASE WHEN m.stock_quantity <= 0 THEN 'out_of_stock'
             WHEN m.stock_quantity <= m.reorder_level THEN 'low_stock'
             ELSE 'in_stock' END AS stock_status,
        (m.reorder_level - m.stock_quantity) AS shortfall
      FROM menu_items m
      LEFT JOIN menu_categories c ON m.category_id = c.id
      WHERE m.track_stock = true AND m.stock_quantity <= m.reorder_level AND m.status != 'archived'
      ORDER BY (m.stock_quantity <= 0) DESC, (m.reorder_level - m.stock_quantity) DESC, m.name
    `);
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length,
      menu_items: menuStock.rows,
      menu_items_count: menuStock.rows.length,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getInventoryActivity = async (req: Request, res: Response): Promise<void> => {
  try {
    const { item_id, limit = 10 } = req.query;
    const where = item_id ? `WHERE t.inventory_item_id = $1` : '';
    const params = item_id ? [item_id, limit] : [limit];
    const result = await query(`
      SELECT t.*, i.name as item_name, u.full_name as performed_by_name
      FROM inventory_transactions t
      JOIN inventory_items i ON t.inventory_item_id = i.id
      LEFT JOIN users u ON t.performed_by = u.id
      ${where}
      ORDER BY t.created_at DESC
      LIMIT $${item_id ? 2 : 1}
    `, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};