import { Request, Response } from 'express';
import { query, getClient } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { logAudit } from '../services/auditLog';

export const getMenuItems = async (req: Request, res: Response): Promise<void> => {
  try {
    const { category_id, status, search, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (category_id) { conditions.push(`m.category_id = $${idx++}`); params.push(category_id); }
    if (status && status !== 'all') {
      const statuses = String(status).split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        conditions.push(`m.status = $${idx++}`); params.push(statuses[0]);
      } else {
        conditions.push(`m.status = ANY($${idx++})`); params.push(statuses);
      }
    } else if (!status) {
      // Default listing (no status param at all) hides archived items — this
      // is what the Menu admin grid and the POS both rely on. Deleting an
      // item soft-archives it; without this default it kept showing up in
      // both places because neither ever excluded 'archived'. Callers that
      // genuinely want everything (e.g. an "all statuses" admin view) pass
      // status=all explicitly.
      conditions.push(`m.status != 'archived'`);
    }
    if (search) { conditions.push(`m.name ILIKE $${idx++}`); params.push(`%${search}%`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await query(`SELECT COUNT(*) FROM menu_items m ${where}`, params);

    params.push(Number(limit), offset);
    const result = await query(`
      SELECT m.*, c.name as category_name
      FROM menu_items m
      LEFT JOIN menu_categories c ON m.category_id = c.id
      ${where}
      ORDER BY m.sort_order, m.name
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    res.json({ success: true, data: result.rows, pagination: { total: parseInt(countRes.rows[0].count), page: Number(page), limit: Number(limit) } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(`
      SELECT c.*, COUNT(m.id) as item_count
      FROM menu_categories c
      LEFT JOIN menu_items m ON m.category_id = c.id
      WHERE c.is_active = true
      GROUP BY c.id ORDER BY c.sort_order
    `);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Previously missing entirely — a genuinely fresh database (no seed data)
// had no menu categories and no way to create the first one, meaning the
// category dropdown everywhere else would always be empty with no path
// forward.
export const createCategory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, description, sort_order } = req.body;
    if (!name || !name.toString().trim()) {
      res.status(400).json({ success: false, message: 'name is required' });
      return;
    }
    const trimmed = name.toString().trim();
    const dupe = await query('SELECT id FROM menu_categories WHERE LOWER(name) = LOWER($1) AND is_active = true', [trimmed]);
    if (dupe.rows.length) {
      res.status(400).json({ success: false, message: `A category named "${trimmed}" already exists` });
      return;
    }
    const result = await query(
      `INSERT INTO menu_categories (name, description, sort_order) VALUES ($1,$2,$3) RETURNING *, 0 as item_count`,
      [trimmed, description || null, Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateCategory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, description, sort_order } = req.body;
    if (!name || !name.toString().trim()) {
      res.status(400).json({ success: false, message: 'name is required' });
      return;
    }
    const trimmed = name.toString().trim();
    const dupe = await query('SELECT id FROM menu_categories WHERE LOWER(name) = LOWER($1) AND is_active = true AND id != $2', [trimmed, id]);
    if (dupe.rows.length) {
      res.status(400).json({ success: false, message: `A category named "${trimmed}" already exists` });
      return;
    }
    const result = await query(
      `UPDATE menu_categories SET name=$1, description=$2, sort_order=COALESCE($3, sort_order), updated_at=CURRENT_TIMESTAMP WHERE id=$4 RETURNING *`,
      [trimmed, description || null, Number.isFinite(Number(sort_order)) ? Number(sort_order) : null, id]
    );
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Category not found' }); return; }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Soft delete — menu_items.category_id references this table, and existing
// items shouldn't lose their category label just because it was retired.
export const deleteCategory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE menu_categories SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Category not found' }); return; }
    res.json({ success: true, message: 'Category removed' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const createMenuItem = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, description, price, cost, category_id, preparation_time, status, tags, image_url,
            track_stock, stock_quantity, reorder_level, barcode } = req.body;
    if (!name || !name.toString().trim()) {
      res.status(400).json({ success: false, message: 'name is required' });
      return;
    }
    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      res.status(400).json({ success: false, message: 'price must be a non-negative number' });
      return;
    }
    // Countable stock is unit-based (you can't have half a samosa on the
    // shelf), so validate as a non-negative integer rather than reusing the
    // decimal-quantity rules the ingredient inventory uses.
    const trackStock = track_stock === true;
    const stockQty = trackStock ? Number(stock_quantity) : 0;
    if (trackStock && (!Number.isInteger(stockQty) || stockQty < 0)) {
      res.status(400).json({ success: false, message: 'stock_quantity must be a whole number, zero or more' });
      return;
    }
    const reorderLvl = reorder_level === undefined || reorder_level === null ? 5 : Number(reorder_level);
    if (trackStock && (!Number.isInteger(reorderLvl) || reorderLvl < 0)) {
      res.status(400).json({ success: false, message: 'reorder_level must be a whole number, zero or more' });
      return;
    }
    const trimmedBarcode = barcode ? String(barcode).trim() : null;
    if (trimmedBarcode) {
      const dupe = await query('SELECT id FROM menu_items WHERE barcode = $1', [trimmedBarcode]);
      if (dupe.rows.length) {
        res.status(400).json({ success: false, message: `Another item ("${dupe.rows[0].name || 'unknown'}") already uses that barcode` });
        return;
      }
    }
    const result = await query(`
      INSERT INTO menu_items (name, description, price, cost, category_id, preparation_time, status, tags, image_url,
        track_stock, stock_quantity, reorder_level, barcode)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
    `, [name.toString().trim(), description, numericPrice, cost || 0, category_id || null, preparation_time || 15, status || 'available', tags || [], image_url || null,
        trackStock, stockQty, reorderLvl, trimmedBarcode]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateMenuItem = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, description, price, cost, category_id, preparation_time, status, tags, image_url,
            track_stock, stock_quantity, reorder_level, barcode } = req.body;

    const trackStock = track_stock === true;
    const stockQty = trackStock ? Number(stock_quantity) : 0;
    if (trackStock && (!Number.isInteger(stockQty) || stockQty < 0)) {
      res.status(400).json({ success: false, message: 'stock_quantity must be a whole number, zero or more' });
      return;
    }
    const reorderLvl = reorder_level === undefined || reorder_level === null ? 5 : Number(reorder_level);
    if (trackStock && (!Number.isInteger(reorderLvl) || reorderLvl < 0)) {
      res.status(400).json({ success: false, message: 'reorder_level must be a whole number, zero or more' });
      return;
    }
    const trimmedBarcode = barcode ? String(barcode).trim() : null;
    if (trimmedBarcode) {
      const dupe = await query('SELECT id, name FROM menu_items WHERE barcode = $1 AND id != $2', [trimmedBarcode, id]);
      if (dupe.rows.length) {
        res.status(400).json({ success: false, message: `Another item ("${dupe.rows[0].name}") already uses that barcode` });
        return;
      }
    }

    // Read the prior stock level so a manual count change from the edit form
    // lands in the same audit ledger the POS-driven sale/restock deductions
    // use — "why did this number change" should always be answerable from
    // menu_stock_transactions, not just the sale path.
    const before = await query('SELECT stock_quantity, track_stock FROM menu_items WHERE id = $1', [id]);
    if (before.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Item not found' });
      return;
    }
    const priorQty = Number(before.rows[0].stock_quantity);

    const result = await query(`
      UPDATE menu_items SET name=$1, description=$2, price=$3, cost=$4, category_id=$5,
        preparation_time=$6, status=$7, tags=$8, image_url=$9,
        track_stock=$10, stock_quantity=$11, reorder_level=$12, barcode=$13, updated_at=CURRENT_TIMESTAMP
      WHERE id=$14 RETURNING *
    `, [name, description, price, cost, category_id || null, preparation_time, status, tags, image_url,
        trackStock, stockQty, reorderLvl, trimmedBarcode, id]);
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Item not found' }); return; }

    if (trackStock && stockQty !== priorQty) {
      await query(
        `INSERT INTO menu_stock_transactions (menu_item_id, type, quantity_change, quantity_before, quantity_after, notes, performed_by)
         VALUES ($1, 'adjustment', $2, $3, $4, $5, $6)`,
        [id, stockQty - priorQty, priorQty, stockQty, 'Manual count update from Menu editor', req.user?.id || null]
      );
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Real barcode lookup for POS's Scan feature — matches what a USB barcode
// scanner types (it behaves as a keyboard, typing the code then Enter, not
// a camera feed). Case-sensitive exact match; most retail barcodes are
// purely numeric anyway, but this doesn't assume that.
export const getMenuItemByBarcode = async (req: Request, res: Response): Promise<void> => {
  try {
    const { code } = req.params;
    const result = await query(
      `SELECT * FROM menu_items WHERE barcode = $1 AND status = 'available'`,
      [code]
    );
    if (!result.rows.length) {
      res.status(404).json({ success: false, message: `No available item found for barcode "${code}"` });
      return;
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const deleteMenuItem = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Soft-delete: set status to 'archived' rather than hard-deleting.
    // Hard deletion breaks historical order_items rows that reference this
    // menu_item_id via FK (ON DELETE SET NULL nulls out the reference, losing
    // the item's name/price context from past orders in reports).
    // The POS and kitchen already filter on status='available', so archived
    // items naturally disappear from operational views without losing history.
    const result = await query(
      `UPDATE menu_items SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, name`,
      [req.params.id]
    );
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Item not found' }); return; }
    await logAudit(req, { action: 'menu_item_deleted', entityType: 'menu_item', entityId: req.params.id, details: { name: result.rows[0].name } });
    res.json({ success: true, message: 'Item archived' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Recipe (bill of materials) ───────────────────────────────────────────────
// The recipe is what makes a menu item deduct stock when it sells. Each row
// says "one of this menu item consumes N units of this inventory item."

export const getRecipe = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const result = await query(`
      SELECT ri.id, ri.inventory_item_id, ri.quantity_per_item,
             i.name AS inventory_item_name, i.unit, i.quantity AS current_stock,
             i.cost_per_unit,
             (ri.quantity_per_item * i.cost_per_unit) AS line_cost
      FROM recipe_ingredients ri
      JOIN inventory_items i ON i.id = ri.inventory_item_id
      WHERE ri.menu_item_id = $1
      ORDER BY i.name
    `, [id]);

    const estimatedCost = result.rows.reduce((sum, r) => sum + Number(r.line_cost || 0), 0);
    res.json({
      success: true,
      data: result.rows,
      // Ingredient cost of one serving, handy for margin/food-cost reporting.
      estimated_ingredient_cost: Math.round(estimatedCost * 100) / 100,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const setRecipe = async (req: Request, res: Response): Promise<void> => {
  const client = await getClient();
  try {
    const { id } = req.params;
    const { ingredients } = req.body as {
      ingredients?: { inventory_item_id: string; quantity_per_item: number }[];
    };

    if (!Array.isArray(ingredients)) {
      res.status(400).json({ success: false, message: 'ingredients must be an array' });
      return;
    }

    // Validate before touching anything so a bad payload can't leave a
    // half-written recipe behind.
    const seen = new Set<string>();
    for (const ing of ingredients) {
      if (!ing.inventory_item_id) {
        res.status(400).json({ success: false, message: 'Each ingredient needs an inventory_item_id' });
        return;
      }
      const qty = Number(ing.quantity_per_item);
      if (!Number.isFinite(qty) || qty <= 0) {
        res.status(400).json({ success: false, message: `quantity_per_item for ${ing.inventory_item_id} must be a positive number` });
        return;
      }
      if (seen.has(ing.inventory_item_id)) {
        res.status(400).json({ success: false, message: 'Duplicate inventory item in recipe' });
        return;
      }
      seen.add(ing.inventory_item_id);
    }

    await client.query('BEGIN');

    const itemExists = await client.query('SELECT id FROM menu_items WHERE id = $1', [id]);
    if (itemExists.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ success: false, message: 'Menu item not found' });
      return;
    }

    // Replace the whole recipe atomically (simplest correct semantics for an
    // editor that submits the full ingredient list).
    await client.query('DELETE FROM recipe_ingredients WHERE menu_item_id = $1', [id]);

    for (const ing of ingredients) {
      // FK on inventory_item_id guarantees the referenced stock item exists;
      // a bad id surfaces as a clean 400 below rather than a partial write.
      await client.query(
        `INSERT INTO recipe_ingredients (menu_item_id, inventory_item_id, quantity_per_item)
         VALUES ($1, $2, $3)`,
        [id, ing.inventory_item_id, Number(ing.quantity_per_item)]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Recipe saved', count: ingredients.length });
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    // A foreign-key violation here means one of the inventory_item_ids doesn't
    // exist — report it as a client error, not a 500.
    if (error && typeof error === 'object' && (error as { code?: string }).code === '23503') {
      res.status(400).json({ success: false, message: 'One or more inventory items do not exist' });
      return;
    }
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};