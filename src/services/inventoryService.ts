import { PoolClient } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Inventory deduction on sale.
//
// When an order enters the kitchen workflow, the ingredients its menu items
// consume (defined in recipe_ingredients) are deducted from stock. This is the
// automatic stock-deduction the POS was previously missing entirely — before
// this, inventory only ever moved through manual adjustments.
//
// Design notes:
//   • Idempotency is enforced by the boolean `orders.inventory_deducted`, flipped
//     atomically with `UPDATE ... WHERE inventory_deducted = false RETURNING id`.
//     Whichever caller (createOrder, the M-Pesa callback, a manual status poll,
//     or the sweep job) wins the flip does the deduction; every other caller
//     sees 0 rows and becomes a safe no-op. This is the same "conditional UPDATE
//     as a lock" pattern the payment resolution helpers already rely on.
//   • These functions ALWAYS run inside a caller-supplied transaction (they take a
//     PoolClient, never the pool). Stock movement must be atomic with the sale /
//     cancellation it belongs to — a committed order with un-deducted stock, or a
//     cancelled order with un-restocked stock, is exactly the drift we're fixing.
//   • Insufficient stock does NOT block the sale. Food physically leaves the
//     kitchen regardless of what our counts say; blocking a real sale on a
//     possibly-stale ingredient count is worse than letting a count go negative
//     and surfacing it. Items that would go negative are returned to the caller
//     so it can log/alert, but the deduction still proceeds.
//   • Menu items with no recipe defined simply consume nothing — the feature
//     degrades gracefully and only acts on items that have been costed out.
// ─────────────────────────────────────────────────────────────────────────────

export interface StockShortfall {
  inventory_item_id: string;
  name: string;
  needed: number;
  available: number;
  unit: string;
}

export interface DeductionResult {
  deducted: boolean;          // false when this order was already deducted (no-op)
  lines: number;              // number of inventory items touched
  shortfalls: StockShortfall[]; // items that went negative (sale still proceeded)
}

/**
 * Deduct all recipe ingredients for a completed/fired order's items.
 * Idempotent: safe to call more than once for the same order.
 * Must be called inside an open transaction on `client`.
 */
export const deductInventoryForOrder = async (
  client: PoolClient,
  orderId: string,
  performedBy: string | null
): Promise<DeductionResult> => {
  // Atomically claim the deduction. If this order was already deducted, the
  // WHERE clause matches nothing and we bail out as a no-op — no double spend.
  // This single flag gates BOTH deduction paths below (ingredients AND
  // countable menu-item units), so one claim covers both consistently.
  const claim = await client.query(
    `UPDATE orders SET inventory_deducted = true, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND inventory_deducted = false
     RETURNING id`,
    [orderId]
  );
  if (claim.rows.length === 0) {
    return { deducted: false, lines: 0, shortfalls: [] };
  }

  const shortfalls: StockShortfall[] = [];
  let lines = 0;

  // ── Ingredient-based deduction (recipe_ingredients bill of materials) ──
  // Aggregate ingredient demand across all of the order's line items in one
  // pass. GROUP BY collapses the case where the same ingredient is used by
  // several different items on the same ticket into a single deduction.
  const demand = await client.query(
    `SELECT ri.inventory_item_id,
            SUM(ri.quantity_per_item * oi.quantity) AS qty_needed
     FROM order_items oi
     JOIN recipe_ingredients ri ON ri.menu_item_id = oi.menu_item_id
     WHERE oi.order_id = $1
     GROUP BY ri.inventory_item_id`,
    [orderId]
  );

  for (const row of demand.rows) {
    const inventoryItemId: string = row.inventory_item_id;
    const needed = Number(row.qty_needed);
    if (!(needed > 0)) continue;

    // Lock the inventory row for the life of the transaction so concurrent
    // sales of the same ingredient serialize instead of both reading the same
    // "before" quantity and racing to a wrong "after".
    const itemRes = await client.query(
      `SELECT id, name, quantity, unit FROM inventory_items WHERE id = $1 FOR UPDATE`,
      [inventoryItemId]
    );
    if (itemRes.rows.length === 0) continue; // ingredient was deleted; skip

    const item = itemRes.rows[0];
    const before = Number(item.quantity);
    const after = Math.round((before - needed) * 1000) / 1000;

    if (after < 0) {
      shortfalls.push({
        inventory_item_id: inventoryItemId,
        name: item.name,
        needed,
        available: before,
        unit: item.unit,
      });
    }

    await client.query(
      `UPDATE inventory_items SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [after, inventoryItemId]
    );

    await client.query(
      `INSERT INTO inventory_transactions
         (inventory_item_id, type, quantity_change, quantity_before, quantity_after, notes, reference_id, performed_by)
       VALUES ($1, 'sale', $2, $3, $4, $5, $6, $7)`,
      [inventoryItemId, -needed, before, after, `Auto stock deduction for order`, orderId, performedBy]
    );
    lines++;
  }

  // ── Countable finished-goods deduction (menu_items.stock_quantity) ──
  // For items sold as pre-made units (chapati, samosa, soda) rather than
  // cooked-to-order dishes. Independent of the ingredient path above — a menu
  // item can have a recipe, countable stock, both, or neither.
  const countable = await client.query(
    `SELECT oi.menu_item_id, SUM(oi.quantity) AS qty_needed
     FROM order_items oi
     JOIN menu_items m ON m.id = oi.menu_item_id
     WHERE oi.order_id = $1 AND m.track_stock = true
     GROUP BY oi.menu_item_id`,
    [orderId]
  );

  for (const row of countable.rows) {
    const menuItemId: string = row.menu_item_id;
    const needed = Number(row.qty_needed);
    if (!(needed > 0)) continue;

    const itemRes = await client.query(
      `SELECT id, name, stock_quantity FROM menu_items WHERE id = $1 FOR UPDATE`,
      [menuItemId]
    );
    if (itemRes.rows.length === 0) continue;

    const item = itemRes.rows[0];
    const before = Number(item.stock_quantity);
    const after = before - needed; // integer units; allowed to go negative, same "surface don't block" policy

    if (after < 0) {
      shortfalls.push({
        inventory_item_id: menuItemId,
        name: item.name,
        needed,
        available: before,
        unit: 'pcs',
      });
    }

    await client.query(
      `UPDATE menu_items SET stock_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [after, menuItemId]
    );
    await client.query(
      `INSERT INTO menu_stock_transactions
         (menu_item_id, type, quantity_change, quantity_before, quantity_after, notes, reference_id, performed_by)
       VALUES ($1, 'sale', $2, $3, $4, $5, $6, $7)`,
      [menuItemId, -needed, before, after, 'Auto stock deduction for order', orderId, performedBy]
    );
    lines++;
  }

  if (shortfalls.length > 0) {
    console.warn(
      `Stock went negative on order ${orderId} for: ${shortfalls
        .map((s) => `${s.name} (needed ${s.needed}${s.unit}, had ${s.available})`)
        .join(', ')}. Sale proceeded; counts need a physical recount.`
    );
  }

  return { deducted: true, lines, shortfalls };
};

/**
 * Reverse a prior deduction when an order is cancelled. Idempotent: flipping
 * `inventory_deducted` back to false is the guard, so a second cancel is a
 * no-op and an order that never deducted (e.g. an abandoned M-Pesa push that
 * never left 'awaiting_payment') restocks nothing.
 * Must be called inside an open transaction on `client`.
 */
export const restockInventoryForOrder = async (
  client: PoolClient,
  orderId: string,
  performedBy: string | null
): Promise<{ restocked: boolean; lines: number }> => {
  const claim = await client.query(
    `UPDATE orders SET inventory_deducted = false, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND inventory_deducted = true
     RETURNING id`,
    [orderId]
  );
  if (claim.rows.length === 0) {
    return { restocked: false, lines: 0 };
  }

  const demand = await client.query(
    `SELECT ri.inventory_item_id,
            SUM(ri.quantity_per_item * oi.quantity) AS qty_returned
     FROM order_items oi
     JOIN recipe_ingredients ri ON ri.menu_item_id = oi.menu_item_id
     WHERE oi.order_id = $1
     GROUP BY ri.inventory_item_id`,
    [orderId]
  );

  let lines = 0;
  for (const row of demand.rows) {
    const inventoryItemId: string = row.inventory_item_id;
    const returned = Number(row.qty_returned);
    if (!(returned > 0)) continue;

    const itemRes = await client.query(
      `SELECT quantity FROM inventory_items WHERE id = $1 FOR UPDATE`,
      [inventoryItemId]
    );
    if (itemRes.rows.length === 0) continue;

    const before = Number(itemRes.rows[0].quantity);
    const after = Math.round((before + returned) * 1000) / 1000;

    await client.query(
      `UPDATE inventory_items SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [after, inventoryItemId]
    );
    await client.query(
      `INSERT INTO inventory_transactions
         (inventory_item_id, type, quantity_change, quantity_before, quantity_after, notes, reference_id, performed_by)
       VALUES ($1, 'adjustment', $2, $3, $4, $5, $6, $7)`,
      [inventoryItemId, returned, before, after, `Stock restored — order cancelled`, orderId, performedBy]
    );
    lines++;
  }

  // ── Restore countable finished-goods units ──
  const countableReturns = await client.query(
    `SELECT oi.menu_item_id, SUM(oi.quantity) AS qty_returned
     FROM order_items oi
     JOIN menu_items m ON m.id = oi.menu_item_id
     WHERE oi.order_id = $1 AND m.track_stock = true
     GROUP BY oi.menu_item_id`,
    [orderId]
  );

  for (const row of countableReturns.rows) {
    const menuItemId: string = row.menu_item_id;
    const returned = Number(row.qty_returned);
    if (!(returned > 0)) continue;

    const itemRes = await client.query(`SELECT stock_quantity FROM menu_items WHERE id = $1 FOR UPDATE`, [menuItemId]);
    if (itemRes.rows.length === 0) continue;

    const before = Number(itemRes.rows[0].stock_quantity);
    const after = before + returned;

    await client.query(
      `UPDATE menu_items SET stock_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [after, menuItemId]
    );
    await client.query(
      `INSERT INTO menu_stock_transactions
         (menu_item_id, type, quantity_change, quantity_before, quantity_after, notes, reference_id, performed_by)
       VALUES ($1, 'restock', $2, $3, $4, $5, $6, $7)`,
      [menuItemId, returned, before, after, 'Stock restored — order cancelled', orderId, performedBy]
    );
    lines++;
  }

  return { restocked: true, lines };
};