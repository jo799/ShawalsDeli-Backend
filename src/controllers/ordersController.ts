import { Request, Response } from 'express';
import { query, getClient } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { deductInventoryForOrder, restockInventoryForOrder } from '../services/inventoryService';
import { applyPaymentToOrder } from '../services/paymentservice';
import { logAudit } from '../services/auditLog';
import { notifyKitchenOfNewOrder, notifyAdminsOfRefundRequest, notifyChefOfAssignment } from '../services/pushService';


// Timestamp slice alone can collide under concurrent load (two orders in
// the same second, or across multiple app instances/replicas). The random
// suffix doesn't make this cryptographically unique, but combined with the
// UNIQUE constraint on order_number plus the small collision space, an
// actual collision becoming a user-facing error is rare enough to be
// acceptable for an order *number* (a human-facing reference, not a key).
const generateOrderNumber = () => {
  const ts = Date.now().toString().slice(-6);
  const rand = Math.floor(Math.random() * 900 + 100); // 3-digit random suffix
  return `ORD-${ts}${rand}`;
};

export const getOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, type, date, page = 1, limit = 10, search, sort, completed_date } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (status && status !== 'all') { conditions.push(`o.status = $${paramIdx++}`); params.push(status); }
    if (type) { conditions.push(`o.type = $${paramIdx++}`); params.push(type); }
    // DATE(o.created_at) is correct here because config/database.ts pins
    // every DB session to Africa/Nairobi — created_at is a naive TIMESTAMP,
    // and CURRENT_TIMESTAMP writes it using the session's timezone. Without
    // that pin, this comparison would silently misattribute orders near
    // midnight to the wrong calendar day (proven: a UTC-default session
    // wrote an order placed at 00:33 Nairobi time as 21:33 the PREVIOUS
    // day). DATE() itself has no timezone awareness — the correctness
    // entirely depends on what was written, not on anything in this query.
    if (date) { conditions.push(`DATE(o.created_at) = $${paramIdx++}`); params.push(date); }
    // Same reasoning as the created_at filter above, applied to completed_at
    // instead — needed so the Kitchen Display's "Completed" count can mean
    // "completed today" rather than "completed ever", which is what a live
    // ops screen should show, not an all-time historical total.
    if (completed_date) { conditions.push(`DATE(o.completed_at) = $${paramIdx++}`); params.push(completed_date); }
    if (search) {
      conditions.push(`(o.order_number ILIKE $${paramIdx} OR o.customer_name ILIKE $${paramIdx} OR t.table_number ILIKE $${paramIdx})`);
      params.push(`%${search}%`); paramIdx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(`SELECT COUNT(*) FROM orders o LEFT JOIN restaurant_tables t ON o.table_id = t.id ${where}`, params);
    const total = parseInt(countResult.rows[0].count);

    // Sorting by created_at (the default, and the only option before this)
    // answers "what's newest" — but the Kitchen Display's Completed column
    // needs "what finished most recently", which is a different question.
    // An order created hours ago that just now got marked served should
    // appear at the top of that list; sorting by created_at would leave it
    // buried under everything created more recently regardless of when each
    // one actually completed, and worse, a tightly-limited/paginated query
    // sorted by created_at could omit it from the result set entirely.
    // NULLS LAST matters here specifically: Postgres sorts NULLs as the
    // "largest" value by default, so a plain `completed_at DESC` would put
    // every non-completed order (completed_at is null) ahead of actually-
    // completed ones. Harmless today since this is only ever paired with
    // status=completed, but without this it'd be a landmine for whoever
    // reuses sort=completed_at without that filter later.
    const orderByColumn = sort === 'completed_at' ? 'o.completed_at DESC NULLS LAST' : 'o.created_at DESC';
    params.push(Number(limit), offset);
    const result = await query(`
      SELECT o.*, t.table_number, c.full_name as customer_full_name,
             u.full_name as served_by_name, p.full_name as prepared_by_name
      FROM orders o
      LEFT JOIN restaurant_tables t ON o.table_id = t.id
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.served_by = u.id
      LEFT JOIN users p ON o.prepared_by = p.id
      ${where}
      ORDER BY ${orderByColumn}
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `, params);

    res.json({ success: true, data: result.rows, pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) } });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /orders/stats/active — a cheap, row-free count for the POS header
// badge and similar live indicators. Scoped to today: a POS terminal cares
// about "what's happening right now", not the full historical order count.
// Deliberately separate from getOrders (which returns full rows + pagination)
// so polling this every ~15s doesn't pull order data across the wire.
export const getOrderStats = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('new','preparing','ready')) AS active,
        COUNT(*) FILTER (WHERE status = 'new') AS new_count,
        COUNT(*) FILTER (WHERE status = 'preparing') AS preparing,
        COUNT(*) FILTER (WHERE status = 'ready') AS ready,
        COUNT(*) FILTER (WHERE status = 'awaiting_payment') AS awaiting_payment
      FROM orders
      WHERE created_at >= CURRENT_DATE
    `);
    const row = result.rows[0];
    res.json({
      success: true,
      data: {
        active: Number(row.active),
        new: Number(row.new_count),
        preparing: Number(row.preparing),
        ready: Number(row.ready),
        awaiting_payment: Number(row.awaiting_payment),
      },
    });
  } catch (error) {
    console.error('Get order stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getOrderById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const orderResult = await query(`
      SELECT o.*, t.table_number, c.full_name as customer_full_name, c.phone as customer_phone,
             u.full_name as served_by_name, p.full_name as prepared_by_name
      FROM orders o
      LEFT JOIN restaurant_tables t ON o.table_id = t.id
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.served_by = u.id
      LEFT JOIN users p ON o.prepared_by = p.id
      WHERE o.id = $1
    `, [id]);

    if (orderResult.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }

    const itemsResult = await query('SELECT * FROM order_items WHERE order_id = $1', [id]);
    const paymentsResult = await query('SELECT * FROM payments WHERE order_id = $1', [id]);
    const refundsResult = await query('SELECT * FROM refunds WHERE order_id = $1 ORDER BY created_at DESC', [id]);
    // Points earned on THIS order specifically — not the customer's running
    // balance, which is a different question entirely (and would still be
    // nonzero for a walk-in sale with no loyalty on it, since it's about the
    // customer overall, not this transaction). Summed rather than assumed
    // to be a single row since a refund can also touch loyalty_transactions
    // (a negative 'earn'-adjacent entry) — see refundOrder below.
    const loyaltyResult = await query(
      `SELECT COALESCE(SUM(points), 0) as points FROM loyalty_transactions WHERE reference_id = $1 AND type = 'earn'`,
      [id]
    );

    res.json({
      success: true,
      data: {
        ...orderResult.rows[0],
        items: itemsResult.rows,
        payments: paymentsResult.rows,
        refunds: refundsResult.rows,
        loyalty_points_earned: parseInt(loyaltyResult.rows[0].points) || 0,
      },
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { type, table_id, customer_id, customer_name, guests, items, special_instructions, payment_method, client_reference_id } = req.body;

    // Idempotency check first, before any other validation — this is what
    // makes it safe for the offline sync queue to retry a submission it's
    // not sure succeeded (e.g. the response was lost after the server had
    // already committed), and incidentally also protects against a
    // double-tap on "Checkout" during a slow response. Same reference
    // twice returns the order that already exists rather than creating a
    // second one or erroring.
    if (client_reference_id) {
      const existing = await client.query('SELECT * FROM orders WHERE client_reference_id = $1', [client_reference_id]);
      if (existing.rows.length) {
        await client.query('ROLLBACK');
        res.status(200).json({ success: true, data: existing.rows[0], idempotent_replay: true });
        return;
      }
    }

    if (!Array.isArray(items) || items.length === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'Order must contain at least one item' });
      return;
    }

    // Trust the database, not the client, for prices. A cashier's screen
    // could be stale or a request could be tampered with — re-fetch current
    // menu prices server-side and compute the bill from those, ignoring
    // whatever unit_price the client sent. This is the same principle as
    // the M-Pesa amount validation: money math never trusts client input.
    const menuItemIds = items.map((i: { menu_item_id: string }) => i.menu_item_id).filter(Boolean);
    const priceLookup = new Map<string, { price: number; name: string }>();
    if (menuItemIds.length > 0) {
      const priceResult = await client.query(
        `SELECT id, name, price FROM menu_items WHERE id = ANY($1::uuid[])`,
        [menuItemIds]
      );
      for (const row of priceResult.rows) {
        priceLookup.set(row.id, { price: Number(row.price), name: row.name });
      }
    }

    let subtotal = 0;
    const resolvedItems: { menu_item_id: string | null; item_name: string; quantity: number; unit_price: number; modifiers: unknown; special_instructions: string | null }[] = [];

    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: `Invalid quantity for item ${item.item_name || item.menu_item_id}` });
        return;
      }

      const known = item.menu_item_id ? priceLookup.get(item.menu_item_id) : undefined;
      // Fall back to client-supplied price+name only for ad-hoc/custom items
      // that don't map to a catalog row (e.g. a manual "custom charge" line).
      // Anything that DOES match a menu_item_id is always priced from the DB.
      const unitPrice = known ? known.price : Number(item.unit_price) || 0;
      const itemName = known ? known.name : (item.item_name || 'Custom item');

      subtotal += unitPrice * quantity;
      resolvedItems.push({
        menu_item_id: item.menu_item_id || null,
        item_name: itemName,
        quantity,
        unit_price: unitPrice,
        modifiers: item.modifiers || null,
        special_instructions: item.special_instructions || null,
      });
    }

    // Round at the subtotal boundary (not per-line-item) to minimize
    // accumulated rounding error across many items.
    subtotal = Math.round(subtotal * 100) / 100;
    // No service charge or VAT — the business charges menu prices as-is.
    // service_charge/tax columns are kept (always 0) rather than dropped
    // from the schema, since payments/receipts/reports already reference
    // them; zeroing here is sufficient and reversible without a migration.
    const service_charge = 0;
    const tax = 0;
    const total = subtotal;

    // Orders intended for M-Pesa payment start in 'awaiting_payment' so they
    // don't occupy kitchen workflow or count as confirmed revenue until the
    // STK push actually resolves. Cash/card/split orders go straight to
    // 'new' since the cashier is confirming payment in the same breath.
    const initialStatus = payment_method === 'mpesa' ? 'awaiting_payment' : 'new';

    const orderResult = await client.query(`
      INSERT INTO orders (order_number, type, status, table_id, customer_id, customer_name, guests,
        subtotal, service_charge, tax, total, special_instructions, served_by, client_reference_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [generateOrderNumber(), type, initialStatus, table_id || null, customer_id || null, customer_name || null,
        guests || 1, subtotal, service_charge, tax, total, special_instructions || null, req.user!.id, client_reference_id || null]);

    const order = orderResult.rows[0];

    for (const item of resolvedItems) {
      await client.query(`
        INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price, total_price, modifiers, special_instructions)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [order.id, item.menu_item_id, item.item_name, item.quantity, item.unit_price,
          Math.round(item.unit_price * item.quantity * 100) / 100, JSON.stringify(item.modifiers), item.special_instructions]);
    }

    if (table_id) {
      await client.query(`UPDATE restaurant_tables SET status = 'occupied', current_order_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [order.id, table_id]);
    }

    // Deduct ingredient stock now for orders that go straight to the kitchen
    // (cash/card/split → status 'new'). M-Pesa orders sit in
    // 'awaiting_payment' and MUST NOT deduct here — they deduct only once the
    // STK push confirms (see markPaymentCompleted in mpesaController), so an
    // abandoned prompt never silently drains inventory.
    let stockShortfalls: { name: string; needed: number; available: number; unit: string }[] = [];
    if (initialStatus === 'new') {
      const deduction = await deductInventoryForOrder(client, order.id, req.user!.id);
      stockShortfalls = deduction.shortfalls;
    }

    await client.query('COMMIT');

    if (initialStatus === 'new') {
      const orderSummary = `Order #${order.order_number} — ${resolvedItems.length} item${resolvedItems.length !== 1 ? 's' : ''}${table_id ? ' · Dine In' : ''}`;
      notifyKitchenOfNewOrder({
        title: '🔔 New Order',
        body: orderSummary,
        orderId: order.id,
        orderNumber: order.order_number,
        createdByUserId: req.user!.id,
      }).catch(() => {}); // Never let a notification failure affect the order response.
      
    }

    res.status(201).json({
      success: true,
      data: order,
      // Surface (but don't block on) any ingredient that went negative so the
      // POS can flag a recount to the cashier without failing the sale.
      ...(stockShortfalls.length > 0 ? { stock_warnings: stockShortfalls } : {}),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create order error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

export const updateOrderStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { status } = req.body;
    // 'awaiting_payment' is intentionally NOT in this list — it's a
    // system-managed transient state set by createOrder/mpesaController,
    // not something a staff member should be able to set or unset by hand
    // through the generic status endpoint.
    const validStatuses = ['new', 'preparing', 'ready', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: 'Invalid status' });
      return;
    }

    // Lock the order row so the cancel/restock is atomic against a concurrent
    // payment or a late M-Pesa callback touching the same order.
    const existing = await client.query(`
      SELECT o.status, o.table_id, o.type, o.total, o.amount_paid, o.prepared_by, u.full_name as prepared_by_name
      FROM orders o LEFT JOIN users u ON o.prepared_by = u.id
      WHERE o.id = $1 FOR UPDATE OF o
    `, [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }

    // Once an admin has assigned this order to a specific chef, nobody
    // else on the kitchen team can be the one to actually start it — the
    // whole point of assigning it was to direct a specific person to pick
    // it up, which a different chef simply grabbing it first would defeat.
    // Admins and managers can still override (they're the ones who can
    // reassign it in the first place, via assignOrderToChef), and the
    // assigned chef themselves is obviously still free to start it.
    if (
      status === 'preparing' &&
      existing.rows[0].prepared_by &&
      existing.rows[0].prepared_by !== req.user!.id &&
      !['administrator', 'manager'].includes(req.user!.role)
    ) {
      await client.query('ROLLBACK');
      res.status(403).json({
        success: false,
        message: `This order is assigned to ${existing.rows[0].prepared_by_name || 'another chef'} — only they (or an admin) can start it.`,
      });
      return;
    }

    // An order stuck in 'awaiting_payment' (e.g. an abandoned M-Pesa push)
    // can only be moved to 'cancelled' through this endpoint — never
    // directly to 'preparing'/'ready'/'completed', which would let kitchen
    // staff push food out before payment is confirmed.
    if (existing.rows[0].status === 'awaiting_payment' && status !== 'cancelled') {
      await client.query('ROLLBACK');
      res.status(409).json({
        success: false,
        message: 'This order has a payment in progress. Cancel the pending payment first, or wait for it to resolve.',
      });
      return;
    }

    // Marking 'completed' on a dine-in order is what frees its table (see
    // below) — it's the system's only signal that the table is free again,
    // since there's no way to physically detect a customer leaving. Without
    // this guard, staff could complete (and thereby free) a table while
    // money is still owed, effectively writing off the balance with no
    // record of why. Takeaway/delivery orders can't hit this at all — they
    // only ever reach 'completed' via full payment (see paymentService.ts).
    if (status === 'completed' && existing.rows[0].type === 'dine_in') {
      const balanceDue = Math.round((Number(existing.rows[0].total) - Number(existing.rows[0].amount_paid)) * 100) / 100;
      if (balanceDue > 0.01) {
        await client.query('ROLLBACK');
        res.status(409).json({
          success: false,
          message: `KES ${balanceDue.toFixed(2)} is still unpaid on this order. Collect payment before marking it completed — or cancel the order if the balance won't be collected.`,
        });
        return;
      }
    }

    const completedAt = status === 'completed' ? 'CURRENT_TIMESTAMP' : 'NULL';
    const preparedByClause = status === 'preparing' ? 'COALESCE(prepared_by, $3)' : 'prepared_by';
    const result = await client.query(`
      UPDATE orders SET status = $1, completed_at = ${completedAt}, updated_at = CURRENT_TIMESTAMP,
        prepared_by = ${preparedByClause}
      WHERE id = $2 RETURNING *
    `, status === 'preparing' ? [status, id, req.user!.id] : [status, id]);

    const order = result.rows[0];
    if (status === 'completed' && order.table_id) {
      await client.query(`UPDATE restaurant_tables SET status = 'available', current_order_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [order.table_id]);
    }

    // If we just cancelled an order that had a pending M-Pesa push in
    // flight, mark that payment cancelled too. Otherwise a late Safaricom
    // callback could land on a payment whose order is gone and silently
    // try to complete a cancelled order, or the sweep job would try to
    // "release" an order that no longer needs releasing.
    if (status === 'cancelled') {
      await client.query(
        `UPDATE payments SET status = 'cancelled', result_desc = 'Order cancelled by staff', updated_at = CURRENT_TIMESTAMP WHERE order_id = $1 AND status = 'pending'`,
        [id]
      );
      if (order.table_id) {
        await client.query(`UPDATE restaurant_tables SET status = 'available', current_order_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [order.table_id]);
      }
      // Return any ingredients this order had already consumed back to stock.
      // Idempotent and a no-op for orders that never deducted (e.g. one that
      // was still awaiting payment), so it's always safe to call on cancel.
      await restockInventoryForOrder(client, id, req.user!.id);
    }

    await client.query('COMMIT');
    res.json({ success: true, data: order });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Update order status error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

export const processPayment = async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { payment_method, amount, reference, split_details, award_loyalty, points, client_reference_id } = req.body;

    if (client_reference_id) {
      const existing = await client.query('SELECT * FROM payments WHERE client_reference_id = $1', [client_reference_id]);
      if (existing.rows.length) {
        await client.query('ROLLBACK');
        const orderNow = await client.query('SELECT status, amount_paid, total FROM orders WHERE id = $1', [id]);
        res.status(200).json({
          success: true, data: existing.rows[0], idempotent_replay: true,
          order_status: orderNow.rows[0]?.status,
          balance_remaining: orderNow.rows[0] ? Math.max(0, Number(orderNow.rows[0].total) - Number(orderNow.rows[0].amount_paid)) : 0,
        });
        return;
      }
    }

    if (!['cash', 'card', 'till', 'split', 'points'].includes(payment_method)) {
      await client.query('ROLLBACK');
      res.status(400).json({
        success: false,
        message: payment_method === 'mpesa'
          ? 'Use /api/mpesa/stk-push for M-Pesa payments'
          : 'payment_method must be one of: cash, card, till, split, points',
      });
      return;
    }

    // Points redemption is a payment METHOD, not a discount — the order's
    // subtotal/total (what actually gets reported for tax purposes) never
    // changes. It just contributes toward amount_paid the same way a cash
    // tender does, except the "amount" is derived from a points count and
    // the configured KES-per-point rate rather than typed in directly — a
    // client-supplied amount is never trusted here, only points is.
    let roundedAmount: number;
    let pointsToRedeem = 0;
    let pointValueKes = 1;
    let customerIdForRedemption: string | null = null;

    if (payment_method === 'points') {
      const orderRes = await client.query('SELECT customer_id FROM orders WHERE id = $1', [id]);
      if (!orderRes.rows.length) {
        await client.query('ROLLBACK');
        res.status(404).json({ success: false, message: 'Order not found' });
        return;
      }
      customerIdForRedemption = orderRes.rows[0].customer_id;
      if (!customerIdForRedemption) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: 'This order has no customer attached — attach a customer before redeeming their points' });
        return;
      }

      pointsToRedeem = Math.trunc(Number(points));
      if (!Number.isFinite(pointsToRedeem) || pointsToRedeem <= 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: 'points must be a positive whole number' });
        return;
      }

      const lp = await client.query('SELECT available_points FROM loyalty_points WHERE customer_id = $1 FOR UPDATE', [customerIdForRedemption]);
      const available = lp.rows[0]?.available_points || 0;
      if (pointsToRedeem > available) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: `Customer only has ${available} points available` });
        return;
      }

      const settingRes = await client.query(`SELECT value FROM settings WHERE key = 'loyalty_points_value_kes'`);
      pointValueKes = parseFloat(settingRes.rows[0]?.value) || 1;
      roundedAmount = Math.round(pointsToRedeem * pointValueKes * 100) / 100;
    } else {
      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: 'amount must be a positive number' });
        return;
      }
      roundedAmount = Math.round(numericAmount * 100) / 100;
    }

    // applyPaymentToOrder owns the row lock, the balance check, the status
    // transition, stock deduction, and loyalty — the same logic path the
    // M-Pesa flow uses. This is what makes mixing methods on one order safe:
    // a cash tender and an M-Pesa tender for the same order can never both
    // think they're "the payment that completes it" and double-award
    // loyalty or double-deduct stock, because they both go through this one
    // locked function. A points tender exceeding the balance due is
    // rejected here the same way an overpaid cash tender already is —
    // there's no separate cap-and-adjust logic to get wrong.
    const outcome = await applyPaymentToOrder(
      client, id, roundedAmount, req.user!.id, award_loyalty !== false,
      payment_method === 'points' ? roundedAmount : 0
    );

    if (!outcome.found) {
      await client.query('ROLLBACK');
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }
    if (!outcome.applied) {
      await client.query('ROLLBACK');
      const message =
        outcome.reason === 'cancelled' ? 'Order is cancelled — cannot accept payment'
        : outcome.reason === 'already_paid' ? 'This order has already been paid in full'
        : payment_method === 'points'
          ? `Redeeming ${pointsToRedeem} points (KES ${roundedAmount.toFixed(2)}) exceeds the order balance due of KES ${outcome.balanceRemaining.toFixed(2)} — use fewer points.`
          : `Amount KES ${roundedAmount.toFixed(2)} exceeds the order balance due of KES ${outcome.balanceRemaining.toFixed(2)}`;
      res.status(400).json({ success: false, message });
      return;
    }

    // Only deduct the customer's points once we know the payment actually
    // fit — same reasoning as recording the payments row below: never do
    // the write before the validation that could still reject it.
    if (payment_method === 'points' && customerIdForRedemption) {
      await client.query(
        `UPDATE loyalty_points SET available_points = available_points - $1, redeemed_points = redeemed_points + $1, updated_at = CURRENT_TIMESTAMP
         WHERE customer_id = $2`,
        [pointsToRedeem, customerIdForRedemption]
      );
      await client.query(
        `INSERT INTO loyalty_transactions (customer_id, type, points, description, reference_id, performed_by)
         VALUES ($1, 'redeem', $2, $3, $4, $5)`,
        [customerIdForRedemption, -pointsToRedeem, `${pointsToRedeem} points redeemed toward order ${outcome.order.order_number}`, id, req.user!.id]
      );
    }

    // Only record the payment row once we know it actually fit — recording
    // it first and rolling back the row on rejection would still leave a
    // dangling INSERT id `id` in error logs / sequences with nothing to show
    // for it, and there's no reason to do the write before the validation
    // that could reject it.
    // Record payment as completed for cash/card/split/points. Split bill is
    // recorded as a single 'completed' payment for the full amount the
    // cashier collected — split_details is reference metadata only (how
    // many ways, per-person share) for the receipt, not separate payment
    // rows per person.
    const paymentResult = await client.query(`
      INSERT INTO payments (order_id, payment_method, amount, status, reference, split_details, points_redeemed, processed_by, client_reference_id)
      VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,$8) RETURNING *
    `, [
      id, payment_method, roundedAmount,
      reference || null,
      split_details ? JSON.stringify(split_details) : null,
      payment_method === 'points' ? pointsToRedeem : null,
      req.user!.id,
      client_reference_id || null,
    ]);

    if (outcome.stockWarnings.length > 0) {
      console.warn(`Stock shortfall on order ${id}:`, outcome.stockWarnings);
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      data: paymentResult.rows[0],
      order_status: outcome.order.status,
      balance_remaining: outcome.balanceRemaining,
      points_awarded: outcome.pointsAwarded,
      ...(outcome.stockWarnings.length > 0 ? { stock_warnings: outcome.stockWarnings } : {}),
      message: !outcome.isFullyPaid
        ? `Partial payment recorded. KES ${outcome.balanceRemaining.toFixed(2)} still due.`
        : 'Payment recorded. Order sent to kitchen.',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Payment error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

// Called when a cashier cancels an in-flight M-Pesa modal (e.g. customer
// says "actually let me pay cash instead"). Cancels the pending payment row
// and releases the order from 'awaiting_payment' back to a payable state,
// rather than leaving an orphaned order + payment pair that only the sweep
// job would eventually clean up after the 120s expiry window.
export const cancelPendingPayment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params; // order id

    const result = await query(
      `UPDATE payments SET status = 'cancelled', result_desc = 'Cancelled by cashier before completion', updated_at = CURRENT_TIMESTAMP
       WHERE order_id = $1 AND status = 'pending'
       RETURNING id`,
      [id]
    );

    await query(
      `UPDATE orders SET status = 'new', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'awaiting_payment'`,
      [id]
    );

    res.json({
      success: true,
      cancelled_payments: result.rows.length,
      message: result.rows.length > 0
        ? 'Pending payment cancelled. Order is ready for a different payment method.'
        : 'No pending payment found for this order — it may have already resolved.',
    });
  } catch (error) {
    console.error('Cancel pending payment error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
// ─── Refunds & Voids ──────────────────────────────────────────────────────────
//
// A refund returns money for an order that already has confirmed payment on it.
// `orders.amount_paid` is treated as the NET amount currently retained, so each
// refund decrements it; the immutable `refunds` table is the audit source of
// truth for money that went out. A refund that clears the whole remaining
// balance VOIDS the order (status -> cancelled) and frees its table.
//
// This records the *bookkeeping* of a refund (ledger, order state, loyalty
// clawback, optional restock). It does NOT itself move money back over M-Pesa —
// a Daraja B2C reversal is a separate integration; the cashier issues the
// physical refund (cash from drawer / manual M-Pesa reversal) and records it
// here, with `method` capturing how. Note is left for a future slice.

interface RefundParams {
  orderId: string;
  amount?: number;        // omitted => full refund of the remaining balance
  reason?: string;
  method?: string;        // how the money was returned
  restock: boolean;       // return this order's ingredients to stock?
  isVoid: boolean;
  performedBy: string;
  req: AuthRequest;
}

const REFUND_METHODS = ['cash', 'mpesa', 'card', 'store_credit'];

type RefundResult =
  | { ok: false; statusCode: number; message: string }
  | {
      ok: true;
      refund: Record<string, unknown>;
      orderStatus: string;
      amountPaidRemaining: number;
      pointsReversed: number;
      restocked: boolean;
      message: string;
    };

const processRefund = async (
  { orderId, amount, reason, method, restock, isVoid, performedBy, req }: RefundParams
): Promise<RefundResult> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Lock the order so concurrent refunds can't both read the same balance
    // and both succeed (over-refunding).
    const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, message: 'Order not found' };
    }
    const order = orderRes.rows[0];

    if (order.status === 'awaiting_payment') {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 400, message: 'This order has no confirmed payment yet. Cancel the pending payment instead of refunding.' };
    }
    if (order.status === 'cancelled') {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 400, message: 'This order is already cancelled/voided.' };
    }

    // amount_paid is already net of prior refunds, so it IS the refundable balance.
    const refundable = Math.round(Number(order.amount_paid) * 100) / 100;
    if (refundable <= 0) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 400, message: 'There is no paid amount to refund on this order.' };
    }

    const requested = amount === undefined ? refundable : Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(requested) || requested <= 0) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 400, message: 'Refund amount must be a positive number.' };
    }
    if (requested - refundable > 0.01) {
      await client.query('ROLLBACK');
      return {
        ok: false, statusCode: 400,
        message: `Refund of KES ${requested.toFixed(2)} exceeds the refundable balance of KES ${refundable.toFixed(2)}.`,
      };
    }

    const refundMethod = method && REFUND_METHODS.includes(method) ? method : 'cash';
    const newAmountPaid = Math.round((refundable - requested) * 100) / 100;
    const isFullRefund = newAmountPaid <= 0.01;

    // Reverse loyalty points proportional to the refunded amount (same 1 point
    // per KES 100 rule the payment path awards), never dropping a balance below
    // zero.
    let pointsReversed = 0;
    if (order.customer_id) {
      const pts = Math.floor(Math.round(requested * 100) / 10000);
      if (pts > 0) {
        const lp = await client.query('SELECT available_points, total_points FROM loyalty_points WHERE customer_id = $1 FOR UPDATE', [order.customer_id]);
        if (lp.rows.length > 0) {
          const avail = Number(lp.rows[0].available_points);
          const total = Number(lp.rows[0].total_points);
          pointsReversed = Math.min(pts, total);
          if (pointsReversed > 0) {
            await client.query(
              `UPDATE loyalty_points
                 SET available_points = GREATEST(0, available_points - $1),
                     total_points     = GREATEST(0, total_points - $1),
                     updated_at = CURRENT_TIMESTAMP
               WHERE customer_id = $2`,
              [pointsReversed, order.customer_id]
            );
            void avail;
            await client.query(
              `INSERT INTO loyalty_transactions (customer_id, type, points, description, reference_id, performed_by)
               VALUES ($1, 'adjust', $2, $3, $4, $5)`,
              [order.customer_id, -pointsReversed, `Points reversed for refund on order ${order.order_number}`, orderId, performedBy]
            );
          }
        }
      }
    }

    // Optionally return ingredients to stock. Caller-controlled because whether
    // food was actually made/served is an operational judgement — a mistaken
    // order gets restocked, a "customer ate it but we comped it" refund doesn't.
    let restocked = false;
    if (restock) {
      const r = await restockInventoryForOrder(client, orderId, performedBy);
      restocked = r.restocked;
    }

    // Record the refund (immutable money-out ledger row).
    const refundRow = await client.query(
      `INSERT INTO refunds (order_id, amount, reason, method, is_void, restocked, points_reversed, processed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [orderId, requested, reason || (isVoid ? 'Order voided' : null), refundMethod, isVoid, restocked, pointsReversed, performedBy]
    );

    // Update the order. A full refund voids it; a partial refund leaves it in
    // its current operational status but with a reduced net amount_paid.
    if (isFullRefund) {
      await client.query(
        `UPDATE orders SET amount_paid = 0, status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [orderId]
      );
      // Mark the order's completed payments as refunded for a clean payment history.
      await client.query(
        `UPDATE payments SET status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE order_id = $1 AND status = 'completed'`,
        [orderId]
      );
      if (order.table_id) {
        await client.query(
          `UPDATE restaurant_tables SET status = 'available', current_order_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [order.table_id]
        );
      }
    } else {
      await client.query(
        `UPDATE orders SET amount_paid = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [newAmountPaid, orderId]
      );
    }

    await client.query('COMMIT');
    await logAudit(req, {
      action: isVoid ? 'order_voided' : 'order_refunded',
      entityType: 'order',
      entityId: orderId,
      details: { order_number: order.order_number, amount: requested, reason: reason || null, method: refundMethod, restock, full_refund: isFullRefund },
    });
    return {
      ok: true,
      refund: refundRow.rows[0],
      orderStatus: isFullRefund ? 'cancelled' : order.status,
      amountPaidRemaining: isFullRefund ? 0 : newAmountPaid,
      pointsReversed,
      restocked,
      message: isFullRefund
        ? `Full refund of KES ${requested.toFixed(2)} issued. Order voided.`
        : `Refund of KES ${requested.toFixed(2)} issued. KES ${newAmountPaid.toFixed(2)} still retained on the order.`,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Refund error:', error);
    return { ok: false, statusCode: 500, message: 'Server error' };
  } finally {
    client.release();
  }
};

// POST /orders/:id/refund  { amount?, reason, method?, restock? }
export const refundOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const { amount, reason, method, restock } = req.body;
  if (!reason || !String(reason).trim()) {
    res.status(400).json({ success: false, message: 'A reason is required for every refund.' });
    return;
  }
  const result = await processRefund({
    orderId: req.params.id,
    amount: amount === undefined || amount === null ? undefined : Number(amount),
    reason: String(reason).trim(),
    method,
    restock: restock === true,
    isVoid: false,
    performedBy: req.user!.id,
    req,
  });
  if (!result.ok) { res.status(result.statusCode).json({ success: false, message: result.message }); return; }
  res.json({
    success: true,
    data: result.refund,
    order_status: result.orderStatus,
    amount_paid_remaining: result.amountPaidRemaining,
    points_reversed: result.pointsReversed,
    restocked: result.restocked,
    message: result.message,
  });
};

// POST /orders/:id/void  { reason, restock? }
// A void is a full refund of the remaining balance that cancels the order.
// Restock defaults to TRUE here (a void generally means the sale shouldn't have
// happened), but the caller can override.
export const voidOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const { reason, method, restock } = req.body;
  if (!reason || !String(reason).trim()) {
    res.status(400).json({ success: false, message: 'A reason is required to void an order.' });
    return;
  }
  const result = await processRefund({
    orderId: req.params.id,
    amount: undefined, // full balance
    reason: String(reason).trim(),
    method,
    restock: restock === false ? false : true,
    isVoid: true,
    performedBy: req.user!.id,
    req,
  });
  if (!result.ok) { res.status(result.statusCode).json({ success: false, message: result.message }); return; }
  res.json({
    success: true,
    data: result.refund,
    order_status: result.orderStatus,
    amount_paid_remaining: result.amountPaidRemaining,
    points_reversed: result.pointsReversed,
    restocked: result.restocked,
    message: result.message,
  });
};

// ─────────────────────────────────────────────────────────────────────────
// Refund approval workflow. Administrators refund directly via refundOrder/
// voidOrder above (they're the approval authority — there's no one else to
// check them). Managers go through this queue instead: a request moves no
// money and changes nothing about the order until an admin explicitly
// approves it.

// POST /orders/:id/refund-request  { amount?, reason, method?, restock?, isVoid? }
export const requestRefund = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { amount, reason, method, restock, isVoid } = req.body;
    const orderId = req.params.id;

    if (!reason || !String(reason).trim()) {
      res.status(400).json({ success: false, message: 'A reason is required to request a refund.' });
      return;
    }

    const orderRes = await query('SELECT id, order_number, status, amount_paid FROM orders WHERE id = $1', [orderId]);
    if (orderRes.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }
    const order = orderRes.rows[0];
    if (order.status === 'awaiting_payment') {
      res.status(400).json({ success: false, message: 'This order has no confirmed payment yet.' });
      return;
    }
    if (order.status === 'cancelled') {
      res.status(400).json({ success: false, message: 'This order is already cancelled/voided.' });
      return;
    }
    const refundable = Math.round(Number(order.amount_paid) * 100) / 100;
    if (refundable <= 0) {
      res.status(400).json({ success: false, message: 'There is no paid amount to refund on this order.' });
      return;
    }
    const requestedAmount = amount === undefined || amount === null ? null : Number(amount);
    if (requestedAmount !== null && (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount - refundable > 0.01)) {
      res.status(400).json({ success: false, message: `Amount must be a positive number, at most the refundable balance of KES ${refundable.toFixed(2)}.` });
      return;
    }

    const requestRow = await query(`
      INSERT INTO refund_requests (order_id, amount, reason, method, restock, is_void, requested_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [orderId, requestedAmount, String(reason).trim(), method || null, restock === true, isVoid === true, req.user!.id]);

    await logAudit(req, {
      action: 'refund_requested',
      entityType: 'order',
      entityId: orderId,
      details: { order_number: order.order_number, amount: requestedAmount ?? refundable, reason: String(reason).trim() },
    });

    const amountText = requestedAmount !== null ? `KES ${requestedAmount.toFixed(2)}` : 'the full amount';
    notifyAdminsOfRefundRequest({
      title: '🔔 Refund Request',
      body: `Order #${order.order_number} — ${amountText} — "${String(reason).trim()}"`,
      orderId,
    }).catch(() => {}); // Never let a notification failure block the request itself.

    res.status(201).json({
      success: true,
      data: requestRow.rows[0],
      message: 'Refund request submitted — an administrator needs to approve it before anything is refunded.',
    });
  } catch (error) {
    console.error('Request refund error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /refund-requests?status=pending
export const getRefundRequests = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const params: unknown[] = [];
    let where = '';
    if (status && ['pending', 'approved', 'declined'].includes(status)) {
      params.push(status);
      where = `WHERE rr.status = $${params.length}`;
    }
    const result = await query(`
      SELECT rr.*, o.order_number, o.type as order_type, o.total as order_total,
             req.full_name as requested_by_name, rev.full_name as reviewed_by_name
      FROM refund_requests rr
      JOIN orders o ON rr.order_id = o.id
      LEFT JOIN users req ON rr.requested_by = req.id
      LEFT JOIN users rev ON rr.reviewed_by = rev.id
      ${where}
      ORDER BY rr.status = 'pending' DESC, rr.created_at DESC
      LIMIT 100
    `, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get refund requests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /refund-requests/:id/approve
export const approveRefundRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const reqRes = await query('SELECT * FROM refund_requests WHERE id = $1', [req.params.id]);
    if (reqRes.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Refund request not found' });
      return;
    }
    const reqRow = reqRes.rows[0];
    if (reqRow.status !== 'pending') {
      res.status(400).json({ success: false, message: `This request was already ${reqRow.status}.` });
      return;
    }

    const result = await processRefund({
      orderId: reqRow.order_id,
      amount: reqRow.amount === null ? undefined : Number(reqRow.amount),
      reason: reqRow.reason,
      method: reqRow.method || undefined,
      restock: reqRow.restock,
      isVoid: reqRow.is_void,
      performedBy: req.user!.id, // the refund is executed by the approving admin, not the original requester
      req,
    });

    if (!result.ok) {
      // Left 'pending' rather than auto-declined — the underlying issue
      // (e.g. order state changed since the request was made) may be worth
      // the admin investigating rather than the system silently deciding
      // this request is dead.
      res.status(result.statusCode).json({ success: false, message: `Could not approve: ${result.message}` });
      return;
    }

    await query(`
      UPDATE refund_requests SET status = 'approved', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP, refund_id = $2
      WHERE id = $3
    `, [req.user!.id, (result.refund as { id: string }).id, reqRow.id]);

    await logAudit(req, {
      action: 'refund_request_approved',
      entityType: 'order',
      entityId: reqRow.order_id,
      details: { refund_request_id: reqRow.id, requested_by: reqRow.requested_by },
    });

    res.json({
      success: true,
      data: result.refund,
      order_status: result.orderStatus,
      amount_paid_remaining: result.amountPaidRemaining,
      message: `Approved. ${result.message}`,
    });
  } catch (error) {
    console.error('Approve refund request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /refund-requests/:id/decline  { decline_reason? }
export const declineRefundRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { decline_reason } = req.body;
    const reqRes = await query('SELECT * FROM refund_requests WHERE id = $1', [req.params.id]);
    if (reqRes.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Refund request not found' });
      return;
    }
    const reqRow = reqRes.rows[0];
    if (reqRow.status !== 'pending') {
      res.status(400).json({ success: false, message: `This request was already ${reqRow.status}.` });
      return;
    }

    await query(`
      UPDATE refund_requests SET status = 'declined', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP, decline_reason = $2
      WHERE id = $3
    `, [req.user!.id, decline_reason ? String(decline_reason).trim() : null, reqRow.id]);

    await logAudit(req, {
      action: 'refund_request_declined',
      entityType: 'order',
      entityId: reqRow.order_id,
      details: { refund_request_id: reqRow.id, requested_by: reqRow.requested_by, decline_reason: decline_reason || null },
    });

    res.json({ success: true, message: 'Refund request declined. Nothing was refunded.' });
  } catch (error) {
    console.error('Decline refund request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /orders/:id/assign-chef  { chef_id }
//
// Distinct from the existing "Start Preparing" flow above (which sets
// prepared_by via COALESCE — only if nobody's claimed it yet, and only the
// person who physically clicks it). This is an admin *directing* a
// specific chef to a specific order sitting unattended, which is a
// deliberate assignment, not a claim — so it overwrites prepared_by
// outright rather than only filling it if empty. Status is deliberately
// left untouched: the order stays exactly where it is in the queue (still
// 'new', or wherever it already was); only who's responsible for it
// changes. The chef still needs to tap "Start Preparing" themselves once
// they've seen the notification — an admin can point at who should pick an
// order up, but shouldn't be able to silently start the clock on someone
// else's behalf.
export const assignOrderToChef = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { chef_id } = req.body;
    const orderId = req.params.id;

    if (!chef_id) {
      res.status(400).json({ success: false, message: 'chef_id is required' });
      return;
    }

    const orderRes = await query('SELECT id, order_number, status FROM orders WHERE id = $1', [orderId]);
    if (orderRes.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }
    const order = orderRes.rows[0];
    if (!['new', 'preparing'].includes(order.status)) {
      res.status(400).json({ success: false, message: `Cannot assign a chef to an order that is already ${order.status}.` });
      return;
    }

    // Only a genuine kitchen role can be assigned — assigning "the chef"
    // for a dish to, say, a cashier account wouldn't mean anything.
    const chefRes = await query(`
      SELECT id, full_name FROM users
      WHERE id = $1 AND role IN ('kitchen_staff', 'head_chef') AND status = 'active'
    `, [chef_id]);
    if (chefRes.rows.length === 0) {
      res.status(400).json({ success: false, message: 'chef_id must be an active kitchen staff member or head chef.' });
      return;
    }
    const chef = chefRes.rows[0];

    const updateRes = await query(
      `UPDATE orders SET prepared_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [chef_id, orderId]
    );

    await logAudit(req, {
      action: 'order_assigned_to_chef',
      entityType: 'order',
      entityId: orderId,
      details: { order_number: order.order_number, assigned_to: chef.full_name, chef_id },
    });

    notifyChefOfAssignment(chef_id, {
      title: '🔔 Order Assigned To You',
      body: `Order #${order.order_number} has been assigned to you — please attend to it.`,
      orderId,
    }).catch(() => {}); // Never let a notification failure block the assignment itself.

    res.json({
      success: true,
      data: updateRes.rows[0],
      message: `Order #${order.order_number} assigned to ${chef.full_name}.`,
    });
  } catch (error) {
    console.error('Assign chef error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};