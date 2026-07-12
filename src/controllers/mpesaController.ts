import { Request, Response as ExpressResponse } from 'express';
import { query, getClient } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { applyPaymentToOrder } from '../services/paymentservice';

// Express's Response (aliased above) shadows the global Fetch API's
// Response type within this file. fetchWithRetry below explicitly needs
// the global one.
type FetchResponse = globalThis.Response;

// ─── Money helpers ──────────────────────────────────────────────────────────
// All KES amounts are compared/rounded to the cent to avoid float drift
// (e.g. 0.1 + 0.2 !== 0.3 in JS). M-Pesa itself only moves whole shillings,
// but our internal subtotal/tax math can produce fractional cents, so we
// normalize everywhere money crosses a trust boundary (client input, Daraja).
const toCents = (amount: number): number => Math.round(amount * 100);
const amountsMatch = (a: number, b: number, toleranceCents = 1): boolean =>
  Math.abs(toCents(a) - toCents(b)) <= toleranceCents;

// ─── Daraja API helpers ────────────────────────────────────────────────────────

interface CachedToken { token: string; expiresAt: number; }
let cachedToken: CachedToken | null = null;

const getMpesaConfig = () => {
  const consumerKey = process.env.MPESA_CONSUMER_KEY || '';
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET || '';
  const shortcode = process.env.MPESA_SHORTCODE || '';
  const passkey = process.env.MPESA_PASSKEY || '';
  const env = process.env.MPESA_ENV || 'sandbox';
  const callbackUrl = process.env.MPESA_CALLBACK_URL || '';

  const missing: string[] = [];
  if (!consumerKey) missing.push('MPESA_CONSUMER_KEY');
  if (!consumerSecret) missing.push('MPESA_CONSUMER_SECRET');
  if (!shortcode) missing.push('MPESA_SHORTCODE');
  if (!passkey) missing.push('MPESA_PASSKEY');
  if (!callbackUrl) missing.push('MPESA_CALLBACK_URL');

  if (missing.length) {
    throw new Error(`M-Pesa is not configured. Missing: ${missing.join(', ')}`);
  }

  // Real Daraja passkeys are long hex strings (~64 chars). A short value is
  // almost always a leftover placeholder and will fail with a confusing
  // "Bad Request - Invalid PartyA" or similar from Safaricom — fail fast
  // with a clear message instead.
  if (passkey.length < 20) {
    throw new Error(
      'MPESA_PASSKEY looks too short to be a real Daraja passkey. ' +
      'Double-check you copied the full passkey from the Daraja portal.'
    );
  }
  if (!/^https:\/\//.test(callbackUrl)) {
    throw new Error('MPESA_CALLBACK_URL must be a public https:// URL that Safaricom can reach.');
  }
  if (env === 'production' && callbackUrl.includes('webhook.site')) {
    throw new Error('MPESA_CALLBACK_URL is still pointed at webhook.site — set your real production callback URL.');
  }

  const baseUrl = env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

  return { consumerKey, consumerSecret, shortcode, passkey, env, callbackUrl, baseUrl };
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const fetchWithRetry = async (url: string, options: RequestInit, retries = 2): Promise<FetchResponse> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeout);
        // Retry on Safaricom 5xx / 429 — these are typically transient
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
      if (attempt < retries) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('M-Pesa request failed after retries');
};

const getMpesaToken = async (): Promise<string> => {
  // Daraja tokens are valid for 1 hour; cache to avoid hammering the OAuth
  // endpoint on every STK push / status poll (Safaricom rate-limits this).
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token;
  }

  const { consumerKey, consumerSecret, baseUrl } = getMpesaConfig();
  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const response = await fetchWithRetry(
    `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to get M-Pesa token (${response.status}): ${body || response.statusText}`);
  }

  const data = await response.json() as { access_token: string; expires_in?: string };
  const expiresInSec = Number(data.expires_in) || 3599;
  cachedToken = { token: data.access_token, expiresAt: Date.now() + expiresInSec * 1000 };
  return cachedToken.token;
};

const formatPhone = (phone: string): string => {
  // Convert 07XX, 01XX, +2547XX, or 2547XX to 2547XX/2541XX
  const cleaned = phone.replace(/[\s\-+()]/g, '');
  if (cleaned.startsWith('0')) return `254${cleaned.slice(1)}`;
  if (cleaned.startsWith('254')) return cleaned;
  return `254${cleaned}`;
};

const isValidKenyanMobile = (phone: string): boolean => {
  const formatted = formatPhone(phone);
  // 254 7XXXXXXXX or 254 1XXXXXXXX, total 12 digits
  return /^254[71]\d{8}$/.test(formatted);
};

const getMpesaTimestamp = (): string => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
};

// ─── STK Push ─────────────────────────────────────────────────────────────────

export const initiateStkPush = async (req: AuthRequest, res: ExpressResponse): Promise<void> => {
  try {
    const { order_id, phone, amount, award_loyalty } = req.body;

    if (!phone || amount === undefined || amount === null || !order_id) {
      res.status(400).json({ success: false, message: 'order_id, phone and amount are required' });
      return;
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      res.status(400).json({ success: false, message: 'amount must be a positive number' });
      return;
    }

    if (!isValidKenyanMobile(phone)) {
      res.status(400).json({ success: false, message: 'Enter a valid Safaricom/Airtel number, e.g. 0712345678' });
      return;
    }

    let mpesaConfig;
    try {
      mpesaConfig = getMpesaConfig();
    } catch (configError) {
      res.status(503).json({
        success: false,
        message: configError instanceof Error ? configError.message : 'M-Pesa is not configured',
      });
      return;
    }
    const { shortcode, passkey, callbackUrl, baseUrl } = mpesaConfig;

    // Verify order exists and is still awaiting payment for this amount.
    // amount_paid tracks partial payments (e.g. a previous failed attempt that
    // somehow posted, or future partial-payment support) so we always push
    // for the actual outstanding balance, never a client-supplied figure
    // that doesn't match what's owed.
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
    // Partial M-Pesa payments are allowed — the amount only needs to fit
    // within what's still owed, not match it exactly. This is what makes
    // "part M-Pesa, part cash" possible: a cashier can push an STK request
    // for less than the full balance due and collect the rest another way.
    // Tolerance of 1 KES (100 cents) absorbs the M-Pesa integer-shilling
    // rounding (Math.ceil below); anything beyond that overshooting the
    // balance is a real mismatch — a stale cart total or a tampered request.
    if (numericAmount - balanceDue > 1) {
      res.status(400).json({
        success: false,
        message: `Amount KES ${numericAmount.toFixed(2)} exceeds the order balance due of KES ${balanceDue.toFixed(2)}`,
      });
      return;
    }

    // Reject if there's already a pending M-Pesa attempt for this order —
    // prevents a cashier double-tapping "Send Push" and creating two
    // concurrent STK prompts (and two payment rows) for the same bill.
    const existingPending = await query(
      `SELECT id FROM payments WHERE order_id = $1 AND payment_method = 'mpesa' AND status = 'pending' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
      [order_id]
    );
    if (existingPending.rows.length > 0) {
      res.status(409).json({
        success: false,
        message: 'A payment request is already pending for this order. Wait for it to resolve or cancel it first.',
      });
      return;
    }

    const timestamp = getMpesaTimestamp();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
    const formattedPhone = formatPhone(phone);
    const amountInt = Math.ceil(numericAmount); // M-Pesa requires a whole-shilling integer

    const token = await getMpesaToken();

    const stkResponse = await fetchWithRetry(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amountInt,
        PartyA: formattedPhone,
        PartyB: shortcode,
        PhoneNumber: formattedPhone,
        CallBackURL: callbackUrl,
        AccountReference: order.order_number,
        TransactionDesc: `Payment for order ${order.order_number} - Shawal's Deli`,
      }),
    }, 1); // only retry once for the actual push — we don't want to risk double-charging on a slow-but-successful first attempt

    const stkData = await stkResponse.json() as {
      ResponseCode?: string;
      ResponseDescription?: string;
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      CustomerMessage?: string;
      errorCode?: string;
      errorMessage?: string;
    };

    if (!stkResponse.ok || stkData.ResponseCode !== '0') {
      console.error('STK Push failed:', stkData);
      res.status(400).json({
        success: false,
        message: stkData.errorMessage || stkData.ResponseDescription || 'STK Push failed',
      });
      return;
    }

    // STK pushes time out on Safaricom's side after ~60-120s if the customer
    // doesn't respond; we mirror that with our own expiry so the sweep job
    // can mark it 'expired' even if Safaricom's callback never arrives.
    await query(`
      INSERT INTO payments (order_id, payment_method, amount, status, reference, mpesa_phone, mpesa_merchant_request_id, expires_at, award_loyalty, processed_by)
      VALUES ($1, 'mpesa', $2, 'pending', $3, $4, $5, CURRENT_TIMESTAMP + INTERVAL '120 seconds', $6, $7)
    `, [order_id, amountInt, stkData.CheckoutRequestID, formattedPhone, stkData.MerchantRequestID, award_loyalty !== false, req.user!.id]);

    await query(
      `UPDATE orders SET status = 'awaiting_payment', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'awaiting_payment'`,
      [order_id]
    );

    res.json({
      success: true,
      message: 'STK Push sent. Please check your phone.',
      data: {
        checkout_request_id: stkData.CheckoutRequestID,
        merchant_request_id: stkData.MerchantRequestID,
        customer_message: stkData.CustomerMessage,
        phone: formattedPhone,
        amount: amountInt,
        order_number: order.order_number,
        expires_in_seconds: 120,
      },
    });
  } catch (error: unknown) {
    console.error('STK Push error:', error);
    const message = error instanceof Error ? error.message : 'M-Pesa request failed';
    res.status(500).json({ success: false, message });
  }
};

// ─── STK Push status query (manual reconciliation / fallback polling) ────────
//
// This is a SAFETY NET, not the primary confirmation path. The Daraja
// callback (mpesaCallback below) is the source of truth and fires
// independently. This endpoint exists for:
//   1. The frontend polling loop, as a fallback if the callback is slow
//   2. A manual "Check status" button a cashier can press if a payment is
//      stuck, without waiting for Safaricom to call back
// Both paths converge on the same idempotent DB update logic, so whichever
// one resolves first wins and the other becomes a no-op.

export const queryStkStatus = async (req: Request, res: ExpressResponse): Promise<void> => {
  try {
    const { checkout_request_id } = req.params;

    // Check our own DB first — if the callback already resolved this,
    // there's no need to call Safaricom at all (cheaper and faster).
    const paymentResult = await query('SELECT * FROM payments WHERE reference = $1', [checkout_request_id]);
    const payment = paymentResult.rows[0];

    if (!payment) {
      res.status(404).json({ success: false, message: 'Payment record not found' });
      return;
    }

    if (payment.status !== 'pending') {
      res.json({ success: true, status: payment.status, message: payment.result_desc || 'Payment already resolved' });
      return;
    }

    if (payment.expires_at && new Date(payment.expires_at) < new Date()) {
      await expirePayment(payment.id, payment.order_id);
      res.json({ success: true, status: 'expired', message: 'Payment request expired' });
      return;
    }

    let mpesaConfig;
    try {
      mpesaConfig = getMpesaConfig();
    } catch (configError) {
      res.status(503).json({ success: false, message: configError instanceof Error ? configError.message : 'M-Pesa not configured' });
      return;
    }
    const { shortcode, passkey, baseUrl } = mpesaConfig;

    const timestamp = getMpesaTimestamp();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
    const token = await getMpesaToken();

    const queryResponse = await fetchWithRetry(`${baseUrl}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkout_request_id,
      }),
    });

    const queryData = await queryResponse.json() as {
      ResponseCode?: string;
      ResultCode?: string;
      ResultDesc?: string;
      errorCode?: string;
      errorMessage?: string;
    };

    // "errorCode" 500.001.1001 means "still being processed" — not a failure
    if (queryData.errorCode === '500.001.1001') {
      res.json({ success: true, status: 'pending', message: 'Still waiting for customer to enter PIN' });
      return;
    }

    if (queryData.ResultCode === '0') {
      await markPaymentCompleted(payment, { resultDesc: queryData.ResultDesc });
      res.json({ success: true, status: 'completed', message: 'Payment confirmed' });
    } else if (queryData.ResultCode === '1032') {
      await markPaymentTerminal(payment.id, 'cancelled', queryData.ResultDesc, queryData.ResultCode);
      res.json({ success: true, status: 'cancelled', message: 'Transaction cancelled by user' });
    } else if (queryData.ResultCode === '1037') {
      await markPaymentTerminal(payment.id, 'expired', queryData.ResultDesc, queryData.ResultCode);
      res.json({ success: true, status: 'expired', message: 'Transaction timed out — customer did not respond' });
    } else if (queryData.ResultCode !== undefined) {
      // Any other non-zero ResultCode is a definitive failure from Safaricom
      await markPaymentTerminal(payment.id, 'failed', queryData.ResultDesc, queryData.ResultCode);
      res.json({ success: true, status: 'failed', message: queryData.ResultDesc || 'Payment failed' });
    } else {
      res.json({ success: true, status: 'pending', message: queryData.errorMessage || 'Waiting for payment' });
    }
  } catch (error) {
    console.error('STK status query error:', error);
    res.status(500).json({ success: false, message: 'Failed to query payment status' });
  }
};

// ─── Shared idempotent payment-resolution helpers ─────────────────────────────
//
// Both the Safaricom callback and the manual/poll query path (and the sweep
// job) can race to resolve the same payment. Every one of these functions
// guards its UPDATE with `WHERE status = 'pending'` and inspects the
// row count, so whichever caller gets there first "wins" and every
// subsequent call becomes a safe no-op — no double loyalty points, no
// double order-status transition, no lost updates.

interface PaymentRow {
  id: string;
  order_id: string;
  amount: string | number;
  status: string;
  reference: string | null;
}

const markPaymentCompleted = async (
  payment: PaymentRow,
  opts: { mpesaReceiptNumber?: string; resultDesc?: string } = {}
): Promise<boolean> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const updateResult = await client.query(
      `UPDATE payments
       SET status = 'completed',
           mpesa_transaction_id = COALESCE($1, mpesa_transaction_id),
           result_code = '0',
           result_desc = COALESCE($2, result_desc),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [opts.mpesaReceiptNumber || null, opts.resultDesc || null, payment.id]
    );

    if (updateResult.rows.length === 0) {
      // Already resolved by a concurrent caller (callback vs. poll race) —
      // this is expected and not an error.
      await client.query('ROLLBACK');
      return false;
    }

    const resolvedPayment = updateResult.rows[0];

    // Apply the money to the order through the SAME locked, shared path
    // cash/card payments use — this is what keeps a mixed cash+M-Pesa
    // payment correct: whichever payment (this M-Pesa one, or a cash one
    // happening at the same moment) reaches the row lock first is the one
    // that gets to decide the status transition and award loyalty; the
    // other sees the updated balance and acts accordingly. Neither path can
    // double-award points or double-deduct stock.
    const outcome = await applyPaymentToOrder(client, payment.order_id, Number(resolvedPayment.amount), null, resolvedPayment.award_loyalty !== false);

    if (outcome.found && !outcome.applied) {
      // The order was already fully settled (or cancelled) by the time this
      // M-Pesa payment resolved — most likely a cashier collected the
      // remaining balance in cash while this STK push was still pending
      // with the customer. Safaricom has already irreversibly moved the
      // money, so the payment row stays 'completed' (it genuinely
      // happened), but it must NOT be applied to amount_paid a second time.
      // Flagging it here surfaces it for a manual refund via the existing
      // refunds flow rather than silently overpaying the order record.
      await client.query(
        `UPDATE payments SET result_desc = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [
          `Received but not applied — order was already ${outcome.reason === 'cancelled' ? 'cancelled' : 'fully paid'} by the time this confirmed. Needs a manual refund.`,
          payment.id,
        ]
      );
      console.warn(`M-Pesa payment ${payment.id} confirmed for an order that could no longer accept it (order ${payment.order_id}, reason: ${outcome.reason}). Flagged for manual refund.`);
    }

    if (outcome.found && outcome.applied && outcome.stockWarnings.length > 0) {
      console.warn(`Stock shortfall on order ${payment.order_id}:`, outcome.stockWarnings);
    }

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('markPaymentCompleted error:', err);
    throw err;
  } finally {
    client.release();
  }
};

const markPaymentTerminal = async (
  paymentId: string,
  status: 'failed' | 'cancelled' | 'expired',
  resultDesc?: string,
  resultCode?: string
): Promise<boolean> => {
  const result = await query(
    `UPDATE payments
     SET status = $1, result_desc = COALESCE($2, result_desc), result_code = COALESCE($3, result_code), updated_at = CURRENT_TIMESTAMP
     WHERE id = $4 AND status = 'pending'
     RETURNING order_id`,
    [status, resultDesc || null, resultCode || null, paymentId]
  );

  if (result.rows.length === 0) return false;

  // Release the order back to the cart-equivalent state so the cashier can
  // retry with a different method. We do NOT cancel the order outright —
  // the cart contents (order_items) are still valid, just unpaid.
  const orderId = result.rows[0].order_id;
  await query(
    `UPDATE orders SET status = 'new', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'awaiting_payment'`,
    [orderId]
  );
  return true;
};

const expirePayment = (paymentId: string, _orderId: string) =>
  markPaymentTerminal(paymentId, 'expired', 'Payment request expired without a response', '1037');

// ─── M-Pesa Daraja callback (called by Safaricom servers) ─────────────────────

export const mpesaCallback = async (req: Request, res: ExpressResponse): Promise<void> => {
  try {
    const body = req.body;
    const stkCallback = body?.Body?.stkCallback;

    if (!stkCallback) {
      console.warn('M-Pesa callback received with unexpected shape:', JSON.stringify(body).slice(0, 500));
      res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
      return;
    }

    const { CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;

    console.log(`M-Pesa callback: CheckoutRequestID=${CheckoutRequestID}, ResultCode=${ResultCode}`);

    const paymentResult = await query('SELECT * FROM payments WHERE reference = $1', [CheckoutRequestID]);
    const payment = paymentResult.rows[0] as PaymentRow | undefined;

    if (!payment) {
      // Could be a callback for a payment we never recorded (shouldn't
      // happen) or a replay for one that's since been cleaned up. Either
      // way, log it loudly — silent swallowing here is how money goes
      // missing without anyone noticing.
      console.error(`M-Pesa callback for unknown CheckoutRequestID=${CheckoutRequestID} — no matching payment row`);
      res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
      return;
    }

    if (ResultCode === 0) {
      const items = stkCallback.CallbackMetadata?.Item || [];
      const getMeta = (name: string) => items.find((i: { Name: string; Value: unknown }) => i.Name === name)?.Value;

      const mpesaReceiptNumber = getMeta('MpesaReceiptNumber') as string | undefined;
      const callbackAmount = getMeta('Amount') as number | undefined;

      // Defense in depth: if Safaricom's reported amount somehow disagrees
      // with what we recorded for this CheckoutRequestID, don't silently
      // trust it — flag for manual review rather than completing the order.
      if (callbackAmount !== undefined && !amountsMatch(Number(callbackAmount), Number(payment.amount), 100)) {
        console.error(
          `M-Pesa callback amount mismatch for ${CheckoutRequestID}: expected ${payment.amount}, got ${callbackAmount}. Flagging for manual review.`
        );
        await query(
          `UPDATE payments SET result_desc = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND status = 'pending'`,
          [`AMOUNT MISMATCH: expected ${payment.amount}, Safaricom reported ${callbackAmount}`, payment.id]
        );
        res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
        return;
      }

      const applied = await markPaymentCompleted(payment, { mpesaReceiptNumber, resultDesc: ResultDesc });
      if (applied) {
        console.log(`Payment confirmed via callback: ${mpesaReceiptNumber} for payment ${payment.id}`);
      } else {
        console.log(`Payment ${payment.id} already resolved before callback arrived (resolved by manual query) — no-op`);
      }
    } else if (ResultCode === 1032) {
      await markPaymentTerminal(payment.id, 'cancelled', ResultDesc, String(ResultCode));
    } else {
      await markPaymentTerminal(payment.id, 'failed', ResultDesc, String(ResultCode));
      console.log(`M-Pesa payment failed: ${ResultDesc}`);
    }

    // Always respond 200 to Safaricom regardless of our internal outcome —
    // a non-200 here makes Safaricom retry the callback, which is fine, but
    // we've already made our handling idempotent so there's no benefit to
    // ever returning an error here.
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (error) {
    console.error('M-Pesa callback error:', error);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // Always 200 to Safaricom
  }
};

// ─── Sweep job: expire stale pending STK pushes ───────────────────────────────
//
// If Safaricom never calls back (network issue between their servers and
// ours, or the customer just never responds) and the cashier never presses
// "Check status", a payment would otherwise sit in 'pending' forever with
// its order stuck in 'awaiting_payment'. Call this on an interval from
// server.ts. Idempotent and safe to run concurrently / overlap.

export const sweepExpiredMpesaPayments = async (): Promise<number> => {
  const expired = await query(`
    SELECT id, order_id FROM payments
    WHERE status = 'pending' AND payment_method = 'mpesa' AND expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
  `);

  let count = 0;
  for (const row of expired.rows) {
    const didExpire = await expirePayment(row.id, row.order_id);
    if (didExpire) count++;
  }
  if (count > 0) {
    console.log(`Swept ${count} expired M-Pesa payment(s)`);
  }
  return count;
};

// ─── Manual reconciliation endpoint ───────────────────────────────────────────
// Lets a cashier/manager force a re-check against Safaricom for a payment
// that appears stuck, without needing direct DB access. Just delegates to
// the same logic as queryStkStatus.

export const reconcilePayment = async (req: AuthRequest, res: ExpressResponse): Promise<void> => {
  await queryStkStatus(req, res);
};