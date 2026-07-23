import { Request, Response as ExpressResponse } from 'express';
import { query, getClient } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { applyPaymentToOrder } from '../services/paymentservice';

// ─── Config ──────────────────────────────────────────────────────────────
// Same "fail fast with a clear message" shape as getMpesaConfig — env vars
// only, never stored in the settings table, since these are real payment
// processor secrets.
const getPesapalConfig = () => {
  const consumerKey = process.env.PESAPAL_CONSUMER_KEY || '';
  const consumerSecret = process.env.PESAPAL_CONSUMER_SECRET || '';
  const env = process.env.PESAPAL_ENV || 'sandbox';
  // Where the CUSTOMER's browser is sent back to after they finish on
  // Pesapal's hosted page — distinct from the IPN url below, which Pesapal
  // calls server-to-server and the customer never sees.
  const callbackUrl = process.env.PESAPAL_CALLBACK_URL || '';
  // Our own server's IPN endpoint, registered once with Pesapal so it knows
  // where to notify us of a status change.
  const ipnUrl = process.env.PESAPAL_IPN_URL || '';

  const missing: string[] = [];
  if (!consumerKey) missing.push('PESAPAL_CONSUMER_KEY');
  if (!consumerSecret) missing.push('PESAPAL_CONSUMER_SECRET');
  if (!callbackUrl) missing.push('PESAPAL_CALLBACK_URL');
  if (!ipnUrl) missing.push('PESAPAL_IPN_URL');
  if (missing.length) {
    throw new Error(`Pesapal is not configured. Missing: ${missing.join(', ')}`);
  }

  const baseUrl = env === 'production' ? 'https://pay.pesapal.com/v3' : 'https://cybqa.pesapal.com/pesapalv3';
  return { consumerKey, consumerSecret, callbackUrl, ipnUrl, baseUrl, env };
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Same retry shape as mpesaController's fetchWithRetry — Pesapal's own
// sandbox in particular is known to be flaky, so transient 5xx/429s get a
// couple of quick retries rather than failing the whole request outright.
const fetchWithRetry = async (url: string, options: RequestInit, retries = 2): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeout);
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        return res;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      lastError = err;
      if (attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; }
      throw err;
    }
  }
  throw lastError;
};

// Pesapal's auth token is short-lived (a few minutes) — cached and
// refreshed proactively rather than re-requested on every single call,
// same spirit as the connection caching used elsewhere in this codebase.
let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;

const getPesapalToken = async (): Promise<string> => {
  const { consumerKey, consumerSecret, baseUrl } = getPesapalConfig();

  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const res = await fetchWithRetry(`${baseUrl}/api/Auth/RequestToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ consumer_key: consumerKey, consumer_secret: consumerSecret }),
  });
  const data = await res.json() as { token?: string; message?: string; error?: { message?: string } };
  if (!res.ok || !data.token) {
    throw new Error(data.message || data.error?.message || 'Could not authenticate with Pesapal');
  }
  cachedToken = data.token;
  // Refresh a minute early rather than cutting it exactly at expiry, so a
  // request that starts just before expiry doesn't get caught using a
  // token that goes stale mid-flight.
  cachedTokenExpiresAt = Date.now() + 4 * 60 * 1000;
  return cachedToken as string;
};

// The IPN (notification) URL only needs registering with Pesapal once —
// re-registering the same URL is harmless but pointless, so this is cached
// after the first successful call rather than re-registered on every
// order, the same way the auth token is cached above.
let cachedIpnId: string | null = null;

const ensureIpnRegistered = async (): Promise<string> => {
  if (cachedIpnId) return cachedIpnId;
  const { baseUrl, ipnUrl } = getPesapalConfig();
  const token = await getPesapalToken();

  const res = await fetchWithRetry(`${baseUrl}/api/URLSetup/RegisterIPN`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: ipnUrl, ipn_notification_type: 'GET' }),
  });
  const data = await res.json() as { ipn_id?: string; message?: string; error?: { message?: string } };
  if (!res.ok || !data.ipn_id) {
    throw new Error(data.message || data.error?.message || 'Could not register Pesapal notification URL');
  }
  cachedIpnId = data.ipn_id;
  return cachedIpnId as string;
};

// POST /pesapal/create-order  { order_id, amount, customer_email?, customer_phone? }
//
// Same validation shape as initiateStkPush: order must exist and still be
// payable, the amount must fit within what's actually still owed, and a
// second concurrent attempt for the same order is rejected rather than
// silently creating two orders. Unlike M-Pesa, there's no phone number to
// push to directly — the customer completes payment on Pesapal's own
// hosted page (redirect_url), which is what this hands back to the
// frontend to display.
export const createPesapalOrder = async (req: AuthRequest, res: ExpressResponse): Promise<void> => {
  try {
    const { order_id, amount, customer_email, customer_phone, customer_first_name, customer_last_name } = req.body;

    if (!order_id || amount === undefined || amount === null) {
      res.status(400).json({ success: false, message: 'order_id and amount are required' });
      return;
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      res.status(400).json({ success: false, message: 'amount must be a positive number' });
      return;
    }

    let pesapalConfig;
    try {
      pesapalConfig = getPesapalConfig();
    } catch (configError) {
      res.status(503).json({ success: false, message: configError instanceof Error ? configError.message : 'Pesapal is not configured' });
      return;
    }

    const orderResult = await query('SELECT * FROM orders WHERE id = $1', [order_id]);
    if (orderResult.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }
    const order = orderResult.rows[0];

    if (order.status === 'cancelled' || order.status === 'completed') {
      res.status(400).json({ success: false, message: `Order is already ${order.status} — cannot accept payment` });
      return;
    }

    const balanceDue = Number(order.total) - Number(order.amount_paid || 0);
    if (balanceDue <= 0) {
      res.status(400).json({ success: false, message: 'This order has already been paid in full' });
      return;
    }
    if (numericAmount - balanceDue > 1) {
      res.status(400).json({
        success: false,
        message: `Amount KES ${numericAmount.toFixed(2)} exceeds the order balance due of KES ${balanceDue.toFixed(2)}`,
      });
      return;
    }

    const existingPending = await query(
      `SELECT id FROM payments WHERE order_id = $1 AND payment_method = 'card' AND status = 'pending'`,
      [order_id]
    );
    if (existingPending.rows.length > 0) {
      res.status(409).json({
        success: false,
        message: 'A card payment is already pending for this order. Wait for it to resolve or cancel it first.',
      });
      return;
    }

    const token = await getPesapalToken();
    const ipnId = await ensureIpnRegistered();

    // Pesapal requires a unique merchant reference per order submission —
    // the order's own id plus a timestamp keeps this unique even if a
    // previous attempt for the same order was cancelled and retried.
    const merchantReference = `${order.order_number}-${Date.now()}`;

    const submitRes = await fetchWithRetry(`${pesapalConfig.baseUrl}/api/Transactions/SubmitOrderRequest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: merchantReference,
        currency: 'KES',
        amount: Math.round(numericAmount * 100) / 100,
        description: `Order #${order.order_number}`,
        callback_url: pesapalConfig.callbackUrl,
        notification_id: ipnId,
        billing_address: {
          email_address: customer_email || 'customer@shawalsdeli.co.ke',
          phone_number: customer_phone || '0700000000',
          country_code: 'KE',
          first_name: customer_first_name || 'Walk-in',
          last_name: customer_last_name || 'Customer',
          line_1: 'N/A',
          city: 'Nairobi',
          state: 'Nairobi',
          postal_code: '00100',
          zip_code: '00100',
        },
      }),
    });
    const submitData = await submitRes.json() as { order_tracking_id?: string; redirect_url?: string; message?: string; error?: { message?: string } };
    if (!submitRes.ok || !submitData.order_tracking_id) {
      throw new Error(submitData.message || submitData.error?.message || 'Pesapal did not return a valid order');
    }

    await query(`
      INSERT INTO payments (order_id, payment_method, amount, status, reference, award_loyalty, processed_by)
      VALUES ($1, 'card', $2, 'pending', $3, $4, $5)
    `, [order_id, numericAmount, submitData.order_tracking_id, req.body.award_loyalty !== false, req.user!.id]);

    res.json({
      success: true,
      data: {
        redirect_url: submitData.redirect_url,
        order_tracking_id: submitData.order_tracking_id,
      },
    });
  } catch (error) {
    console.error('Pesapal create order error:', error);
    const message = error instanceof Error ? error.message : 'Could not start the card payment';
    res.status(500).json({ success: false, message });
  }
};

// Shared, idempotent completion path — same role and same shape as
// markPaymentCompleted in mpesaController.ts: an atomic pending→completed
// UPDATE (so a race between the frontend's own polling and the IPN
// callback can only ever apply the payment once), then the same locked
// applyPaymentToOrder every other payment method uses.
const markCardPaymentCompleted = async (orderTrackingId: string): Promise<'applied' | 'already_resolved' | 'not_found'> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT * FROM payments WHERE reference = $1', [orderTrackingId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return 'not_found';
    }
    const payment = existing.rows[0];

    const updateResult = await client.query(
      `UPDATE payments SET status = 'completed', result_code = '0', result_desc = 'Pesapal payment succeeded', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [payment.id]
    );
    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return 'already_resolved';
    }
    const resolvedPayment = updateResult.rows[0];

    const outcome = await applyPaymentToOrder(client, payment.order_id, Number(resolvedPayment.amount), null, resolvedPayment.award_loyalty !== false);

    if (outcome.found && !outcome.applied) {
      // Pesapal has already irreversibly captured the card — same
      // situation the M-Pesa callback handles: the payment genuinely
      // happened, but the order can no longer accept it. Flag rather than
      // silently overpay the order record.
      await client.query(
        `UPDATE payments SET result_desc = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [`Received but not applied — order was already ${outcome.reason === 'cancelled' ? 'cancelled' : 'fully paid'} by the time this confirmed. Needs a manual refund.`, payment.id]
      );
      console.warn(`Pesapal card payment ${payment.id} confirmed for an order that could no longer accept it (order ${payment.order_id}, reason: ${outcome.reason}). Flagged for manual refund.`);
    }
    if (outcome.found && outcome.applied && outcome.stockWarnings.length > 0) {
      console.warn(`Stock shortfall on order ${payment.order_id}:`, outcome.stockWarnings);
    }

    await client.query('COMMIT');
    return 'applied';
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('markCardPaymentCompleted error:', err);
    throw err;
  } finally {
    client.release();
  }
};

const markCardPaymentFailed = async (orderTrackingId: string, reason: string): Promise<void> => {
  await query(
    `UPDATE payments SET status = 'failed', result_desc = $1, updated_at = CURRENT_TIMESTAMP WHERE reference = $2 AND status = 'pending'`,
    [reason, orderTrackingId]
  );
};

// Maps Pesapal's own status wording to what the rest of this controller
// treats as the three outcomes that matter.
const isCompletedStatus = (desc: string) => desc?.toUpperCase() === 'COMPLETED';
const isFailedStatus = (desc: string) => ['FAILED', 'INVALID'].includes(desc?.toUpperCase());

// GET /pesapal/status/:order_tracking_id
//
// Called by the frontend while polling, the same way the POS already polls
// queryStkStatus for M-Pesa — the customer completed (or abandoned) the
// hosted checkout page in a browser tab this backend has no direct
// visibility into, so polling is how the cashier's screen finds out.
export const getPesapalPaymentStatus = async (req: AuthRequest, res: ExpressResponse): Promise<void> => {
  try {
    const { order_tracking_id } = req.params;
    let pesapalConfig;
    try {
      pesapalConfig = getPesapalConfig();
    } catch (configError) {
      res.status(503).json({ success: false, message: configError instanceof Error ? configError.message : 'Pesapal is not configured' });
      return;
    }
    const token = await getPesapalToken();

    const statusRes = await fetchWithRetry(
      `${pesapalConfig.baseUrl}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(order_tracking_id)}`,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
    );
    const statusData = await statusRes.json() as { payment_status_description?: string; description?: string };
    const description: string = statusData.payment_status_description || '';

    if (isCompletedStatus(description)) {
      const result = await markCardPaymentCompleted(order_tracking_id);
      if (result === 'not_found') { res.status(404).json({ success: false, message: 'No matching payment record found' }); return; }

      const paymentRow = await query('SELECT order_id FROM payments WHERE reference = $1', [order_tracking_id]);
      const orderId = paymentRow.rows[0]?.order_id;
      const orderRes = orderId ? await query('SELECT id, order_number, status, total, amount_paid FROM orders WHERE id = $1', [orderId]) : { rows: [] };
      const order = orderRes.rows[0];
      const balanceRemaining = order ? Math.max(0, Math.round((Number(order.total) - Number(order.amount_paid)) * 100) / 100) : 0;

      res.json({ success: true, status: 'completed', order_status: order?.status, balance_remaining: balanceRemaining });
    } else if (isFailedStatus(description)) {
      await markCardPaymentFailed(order_tracking_id, statusData.description || 'Payment failed or was cancelled');
      res.json({ success: true, status: 'failed', message: statusData.description || 'Payment failed or was cancelled' });
    } else {
      // Still pending on Pesapal's side — customer likely still on the
      // checkout page.
      res.json({ success: true, status: 'pending' });
    }
  } catch (error) {
    console.error('Pesapal status check error:', error);
    res.status(500).json({ success: false, message: 'Could not check the card payment status' });
  }
};

// GET /pesapal/ipn?OrderTrackingId=...&OrderMerchantReference=...&OrderNotificationType=...
//
// Source-of-truth backup, same role as mpesaCallback: fires independently
// of whatever the frontend's polling is doing, so a browser tab closed
// right after a successful payment still results in a correctly completed
// order once this arrives. Idempotent by construction — whichever of this
// or getPesapalPaymentStatus resolves first wins; the other is a no-op via
// the status = 'pending' guard inside markCardPaymentCompleted. Pesapal
// expects a specific JSON acknowledgment shape back, not just any 200.
export const pesapalIpnCallback = async (req: Request, res: ExpressResponse): Promise<void> => {
  const orderTrackingId = (req.query.OrderTrackingId || req.query.orderTrackingId) as string;
  const merchantReference = (req.query.OrderMerchantReference || req.query.orderMerchantReference) as string;
  const notificationType = (req.query.OrderNotificationType || req.query.orderNotificationType) as string;

  const acknowledge = () => {
    res.json({
      orderNotificationType: notificationType || 'IPNCHANGE',
      orderTrackingId: orderTrackingId || '',
      orderMerchantReference: merchantReference || '',
      status: 200,
    });
  };

  if (!orderTrackingId) { acknowledge(); return; }

  try {
    const { baseUrl } = getPesapalConfig();
    const token = await getPesapalToken();
    const statusRes = await fetchWithRetry(
      `${baseUrl}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
    );
    const statusData = await statusRes.json() as { payment_status_description?: string; description?: string };
    const description: string = statusData.payment_status_description || '';

    if (isCompletedStatus(description)) {
      const result = await markCardPaymentCompleted(orderTrackingId);
      console.log(`Pesapal IPN: payment completed for ${orderTrackingId} — ${result}`);
    } else if (isFailedStatus(description)) {
      await markCardPaymentFailed(orderTrackingId, statusData.description || 'Payment failed or was cancelled');
      console.log(`Pesapal IPN: payment failed for ${orderTrackingId}`);
    }
  } catch (error) {
    console.error('Pesapal IPN handling error:', error);
    // Acknowledge anyway — our handling is idempotent, so there's nothing
    // gained by making Pesapal retry over a logging/transient issue, and
    // getPesapalPaymentStatus's own polling is a real backup for the
    // eventual correct outcome regardless.
  }

  acknowledge();
};

// POST /pesapal/cancel  { order_tracking_id }
//
// Same role as M-Pesa's cancel-payment — a cashier backing out mid-flow
// (customer changed their mind, wrong amount, wants to pay cash instead).
// There's no "cancel on Pesapal's side" API call the way Stripe had; the
// hosted page simply times out or the customer navigates away on their
// own, so this only needs to update our own record.
export const cancelPesapalOrder = async (req: AuthRequest, res: ExpressResponse): Promise<void> => {
  try {
    const { order_tracking_id } = req.body;
    if (!order_tracking_id) {
      res.status(400).json({ success: false, message: 'order_tracking_id is required' });
      return;
    }
    await markCardPaymentFailed(order_tracking_id, 'Cancelled by cashier');
    res.json({ success: true, message: 'Card payment cancelled' });
  } catch (error) {
    console.error('Pesapal cancel error:', error);
    res.status(500).json({ success: false, message: 'Could not cancel the card payment' });
  }
};