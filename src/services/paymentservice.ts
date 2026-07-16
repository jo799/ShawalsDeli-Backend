import { PoolClient } from 'pg';
import { deductInventoryForOrder, StockShortfall } from './inventoryService';

// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for "apply a payment to an order" — used by BOTH the
// cash/card/split path (ordersController.processPayment) and the M-Pesa path
// (mpesaController.markPaymentCompleted). Before this existed, those two paths
// had independently-written status-transition and loyalty logic that had
// already drifted apart:
//
//   - M-Pesa awarded loyalty points on the SINGLE payment's amount; cash
//     awarded on the order's cumulative amount_paid. For a single-method
//     payment these agree, but for a MIXED payment (part M-Pesa, part cash)
//     they'd both fire independently and double-award points.
//   - An order that received a PARTIAL cash payment while still
//     'awaiting_payment' (e.g. cashier started an M-Pesa flow, then decided
//     to take some cash instead) stayed stuck in 'awaiting_payment' forever
//     instead of releasing to the kitchen the way a partially-paid dine-in
//     cash order already does.
//
// Both bugs are exactly what "let some of the bill be M-Pesa and some be
// cash" would expose in practice. Routing every payment — regardless of
// method — through this one function is what makes multi-tender payments
// safe: there is exactly one place that reads the order's current balance,
// decides the new status, deducts stock, and awards loyalty, all under a
// single row lock.
// ─────────────────────────────────────────────────────────────────────────────

export type ApplyPaymentOutcome =
  | { found: false }
  | { found: true; applied: false; reason: 'cancelled' | 'already_paid' | 'exceeds_balance'; order: Record<string, unknown>; balanceRemaining: number }
  | {
      found: true; applied: true; order: Record<string, unknown>; isFullyPaid: boolean;
      balanceRemaining: number; newlyCompleted: boolean; stockWarnings: StockShortfall[]; pointsAwarded: number;
    };

/**
 * Apply `amount` toward an order's balance, inside the caller's open
 * transaction on `client`. Locks the order row for the duration, so two
 * payments racing for the same order (e.g. a cash tender and a late M-Pesa
 * callback both landing at once) serialize correctly instead of one
 * silently overwriting the other's amount_paid.
 *
 * Does NOT insert the `payments` row itself — callers do that after seeing
 * `applied: true`, since a cash payment and an M-Pesa payment record
 * different metadata (reference, mpesa_transaction_id, etc). This function
 * only owns the order-level effects: amount_paid, status, table release,
 * stock deduction, and loyalty.
 */
export const applyPaymentToOrder = async (
  client: PoolClient,
  orderId: string,
  amount: number,
  performedBy: string | null,
  awardLoyalty: boolean = true,
  currentPointsTenderAmount: number = 0
): Promise<ApplyPaymentOutcome> => {
  const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (orderRes.rows.length === 0) {
    return { found: false };
  }
  const order = orderRes.rows[0];

  if (order.status === 'cancelled') {
    return { found: true, applied: false, reason: 'cancelled', order, balanceRemaining: 0 };
  }

  const total = Number(order.total);
  const currentPaid = Number(order.amount_paid);
  const balanceDue = Math.round((total - currentPaid) * 100) / 100;

  if (balanceDue <= 0) {
    return { found: true, applied: false, reason: 'already_paid', order, balanceRemaining: 0 };
  }
  // 1 KES tolerance absorbs integer-shilling rounding on the M-Pesa side and
  // the split-bill per-person ceiling math on the frontend. Beyond that,
  // refuse rather than silently cap — a caller asking to apply more than is
  // owed is either a stale total or a tampered request, not something to
  // paper over by short-changing the payment record.
  if (amount - balanceDue > 0.01) {
    return { found: true, applied: false, reason: 'exceeds_balance', order, balanceRemaining: balanceDue };
  }

  const wasAwaitingPayment = order.status === 'awaiting_payment';
  const newAmountPaid = Math.round((currentPaid + amount) * 100) / 100;
  const isFullyPaid = newAmountPaid >= total - 0.01;
  const isInstantCompleteType = order.type === 'takeaway' || order.type === 'delivery';

  // Unified status rule (this is the piece that used to differ between the
  // two payment paths):
  //   - First payment received on an order that was waiting on one (partial
  //     or full) releases it out of 'awaiting_payment' — into 'completed'
  //     immediately for takeaway/delivery once fully paid, otherwise into
  //     'new' so it enters the normal kitchen flow exactly like a cash order
  //     does today (which starts 'new' with zero collected).
  //   - A later top-up payment that completes an already-'new' order only
  //     matters for takeaway/delivery, which jump to 'completed' the moment
  //     the balance clears.
  //   - Dine-in orders that are already 'new'/'preparing'/'ready' are
  //     unaffected by payment — they complete via the kitchen workflow, not
  //     via money.
  let newStatus: string = order.status;
  if (wasAwaitingPayment) {
    newStatus = isFullyPaid && isInstantCompleteType ? 'completed' : 'new';
  } else if (isFullyPaid && isInstantCompleteType && order.status !== 'completed') {
    newStatus = 'completed';
  }
  const willCompleteNow = newStatus === 'completed' && order.status !== 'completed';

  const updateRes = await client.query(
    `UPDATE orders
       SET amount_paid = $1, status = $2,
           completed_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE completed_at END,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $4 RETURNING *`,
    [newAmountPaid, newStatus, willCompleteNow, orderId]
  );
  const updatedOrder = updateRes.rows[0];

  if (willCompleteNow && updatedOrder.table_id) {
    await client.query(
      `UPDATE restaurant_tables SET status = 'available', current_order_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [updatedOrder.table_id]
    );
  }

  // Deduct stock whenever a payment is successfully applied. Always safe to
  // call — idempotent via orders.inventory_deducted, so this is a no-op for
  // cash/card orders that already deducted at creation, and fires exactly
  // once for M-Pesa-originated orders on whichever payment (partial or
  // full, M-Pesa or cash) is the one that first releases them from
  // 'awaiting_payment'.
  const deduction = await deductInventoryForOrder(client, orderId, performedBy);

  // Award loyalty exactly once — the instant the order transitions from
  // "not fully paid" to "fully paid" — computed from the order's TOTAL, not
  // from any single tender. This is what makes a mixed cash+M-Pesa payment
  // award the same points a single-method payment would: once, correctly,
  // regardless of how many separate payments it took to get there.
  //
  // awardLoyalty is a per-transaction choice made at checkout (defaults to
  // true, preserving the original always-award behavior for any caller that
  // doesn't pass it) — a cashier can opt a specific sale out, e.g. a staff
  // discount or an already-discounted bulk order where earning points on
  // top wasn't intended.
  const justBecameFullyPaid = isFullyPaid && currentPaid < total - 0.01;
  let pointsAwarded = 0;
  if (justBecameFullyPaid && updatedOrder.customer_id && awardLoyalty) {
    // Points earned are based on how much was actually paid with real
    // money, not the order's raw total — otherwise a customer who covers
    // part of a bill by redeeming points would earn NEW points back on the
    // very money those points stood in for, letting the balance inflate
    // itself on repeat visits. Whatever was tendered as 'points' — from
    // earlier payments already recorded, PLUS the current one being applied
    // right now (its own payments row isn't inserted until after this
    // function returns, so a query here wouldn't see it yet) — is
    // subtracted out of the earning basis first.
    const pointsTenderRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE order_id = $1 AND payment_method = 'points' AND status = 'completed'`,
      [orderId]
    );
    const earningBasis = Math.max(0, total - Number(pointsTenderRes.rows[0].total) - currentPointsTenderAmount);
    const points = Math.floor(Math.round(earningBasis * 100) / 1000); // 1000 cents = KES 10 = 1 point
    if (points > 0) {
      await client.query(
        `INSERT INTO loyalty_points (customer_id, total_points, available_points)
         VALUES ($1, $2, $2)
         ON CONFLICT (customer_id) DO UPDATE SET
           total_points = loyalty_points.total_points + $2,
           available_points = loyalty_points.available_points + $2,
           updated_at = CURRENT_TIMESTAMP`,
        [updatedOrder.customer_id, points]
      );
      await client.query(
        `INSERT INTO loyalty_transactions (customer_id, type, points, description, reference_id, performed_by)
         VALUES ($1, 'earn', $2, $3, $4, $5)`,
        [updatedOrder.customer_id, points, `Points earned for order ${updatedOrder.order_number}`, orderId, performedBy]
      );
      pointsAwarded = points;
    }
  }

  return {
    found: true,
    applied: true,
    order: updatedOrder,
    isFullyPaid,
    balanceRemaining: Math.max(0, Math.round((total - newAmountPaid) * 100) / 100),
    newlyCompleted: willCompleteNow,
    stockWarnings: deduction.shortfalls,
    pointsAwarded,
  };
};