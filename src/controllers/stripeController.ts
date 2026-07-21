import { Request, Response } from 'express';
import Stripe from 'stripe';
import { query, getClient } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { applyPaymentToOrder } from '../services/paymentservice';

// ─── Config ──────────────────────────────────────────────────────────────
// Same shape and same "fail fast with a clear message" philosophy as
// getMpesaConfig in mpesaController.ts — env vars only, never stored in the
// settings table or returned to the client, since these are real payment
// processor secrets.
let cachedStripe: Stripe | null = null;
let cachedStripeKey: string | null = null;

const getStripeConfig = () => {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
  const locationId = process.env.STRIPE_TERMINAL_LOCATION_ID || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  const missing: string[] = [];
  if (!secretKey) missing.push('STRIPE_SECRET_KEY');
  if (!publishableKey) missing.push('STRIPE_PUBLISHABLE_KEY');
  if (!locationId) missing.push('STRIPE_TERMINAL_LOCATION_ID');
  if (missing.length) {
    throw new Error(`Stripe is not configured. Missing: ${missing.join(', ')}`);
  }
  if (!secretKey.startsWith('sk_')) {
    throw new Error('STRIPE_SECRET_KEY looks wrong — it should start with sk_test_ or sk_live_.');
  }
  if (!publishableKey.startsWith('pk_')) {
    throw new Error('STRIPE_PUBLISHABLE_KEY looks wrong — it should start with pk_test_ or pk_live_.');
  }
  // Mixing a test secret key with a live publishable key (or vice versa) is
  // a common copy-paste mistake that produces confusing downstream errors
  // rather than a clear one at the point it actually went wrong.
  const secretIsLive = secretKey.startsWith('sk_live_');
  const publishableIsLive = publishableKey.startsWith('pk_live_');
  if (secretIsLive !== publishableIsLive) {
    throw new Error('STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are from different modes (one test, one live) — they must match.');
  }

  return { secretKey, publishableKey, locationId, webhookSecret, isLive: secretIsLive };
};

const getStripeClient = (secretKey: string): Stripe => {
  if (cachedStripe && cachedStripeKey === secretKey) return cachedStripe;
  cachedStripe = new Stripe(secretKey);
  cachedStripeKey = secretKey;
  return cachedStripe;
};

// GET /stripe/config — the publishable key and Terminal location the
// frontend SDK needs to initialize. Never exposes the secret key.
export const getStripePublicConfig = (_req: Request, res: Response): void => {
  try {
    const { publishableKey, locationId, isLive } = getStripeConfig();
    res.json({ success: true, data: { publishable_key: publishableKey, location_id: locationId, live_mode: isLive } });
  } catch (error) {
    res.status(503).json({ success: false, message: error instanceof Error ? error.message : 'Stripe is not configured' });
  }
};

// POST /stripe/connection-token
//
// Authenticates the Stripe Terminal JS SDK running in the browser — this is
// how the SDK is allowed to discover and connect to a physical reader at
// all. Short-lived and single-purpose; it doesn't touch an order or take
// any money by itself.
export const createConnectionToken = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { secretKey } = getStripeConfig();
    const stripe = getStripeClient(secretKey);
    const connectionToken = await stripe.terminal.connectionTokens.create();
    res.json({ success: true, data: { secret: connectionToken.secret } });
  } catch (error) {
    console.error('Stripe connection token error:', error);
    const message = error instanceof Error ? error.message : 'Could not create a Terminal connection token';
    res.status(500).json({ success: false, message });
  }
};

// POST /stripe/create-payment-intent  { order_id, amount }
//
// Same validation shape as initiateStkPush: order must exist and still be
// payable, the amount must fit within what's actually still owed (a small
// tolerance absorbs rounding, anything more is a stale cart or a tampered
// request), and a second concurrent attempt for the same order is rejected
// rather than silently creating two intents. capture_method is
// 'automatic' — the reader collecting a successful tap/insert/swipe is
// itself the authorization to capture; there's no separate "confirm this
// charge later" step a cashier would need to remember.
export const createPaymentIntent = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { order_id, amount } = req.body;

    if (!order_id || amount === undefined || amount === null) {
      res.status(400).json({ success: false, message: 'order_id and amount are required' });
      return;
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      res.status(400).json({ success: false, message: 'amount must be a positive number' });
      return;
    }

    let stripeConfig;
    try {
      stripeConfig = getStripeConfig();
    } catch (configError) {
      res.status(503).json({ success: false, message: configError instanceof Error ? configError.message : 'Stripe is not configured' });
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
      `SELECT id, reference FROM payments WHERE order_id = $1 AND payment_method = 'card' AND status = 'pending'`,
      [order_id]
    );
    if (existingPending.rows.length > 0) {
      res.status(409).json({
        success: false,
        message: 'A card payment is already pending for this order. Wait for it to resolve or cancel it first.',
      });
      return;
    }

    const stripe = getStripeClient(stripeConfig.secretKey);

    // Stripe works in the currency's smallest unit — for KES (no minor
    // unit/cents in everyday use), that's just whole shillings, so no ×100
    // conversion here (unlike M-Pesa's own Amount field, which also wants
    // a whole-shilling integer for a different reason: Daraja's own API
    // contract).
    const amountInt = Math.round(numericAmount);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInt,
      currency: 'kes',
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: { order_id, order_number: order.order_number },
    });

    await query(`
      INSERT INTO payments (order_id, payment_method, amount, status, reference, award_loyalty, processed_by)
      VALUES ($1, 'card', $2, 'pending', $3, $4, $5)
    `, [order_id, amountInt, paymentIntent.id, req.body.award_loyalty !== false, req.user!.id]);

    res.json({
      success: true,
      data: {
        client_secret: paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id,
        amount: amountInt,
        order_number: order.order_number,
      },
    });
  } catch (error) {
    console.error('Stripe create payment intent error:', error);
    const message = error instanceof Error ? error.message : 'Could not start the card payment';
    res.status(500).json({ success: false, message });
  }
};

// Shared, idempotent completion path — same role as markPaymentCompleted in
// mpesaController.ts, and deliberately built the same way: an atomic
// pending→completed UPDATE (so a race between the frontend's own
// confirmation call and the webhook can only ever apply the payment once),
// then the same locked applyPaymentToOrder every other payment method uses.
const markCardPaymentCompleted = async (paymentIntentId: string): Promise<'applied' | 'already_resolved' | 'not_found'> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT * FROM payments WHERE reference = $1', [paymentIntentId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return 'not_found';
    }
    const payment = existing.rows[0];

    const updateResult = await client.query(
      `UPDATE payments SET status = 'completed', result_code = '0', result_desc = 'Stripe Terminal payment succeeded', updated_at = CURRENT_TIMESTAMP
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
      // Stripe has already irreversibly captured the card — same situation
      // markPaymentCompleted handles for M-Pesa: the payment genuinely
      // happened, but the order can no longer accept it (settled another
      // way, or cancelled, in the time this was in flight). Flag rather
      // than silently overpay the order record.
      await client.query(
        `UPDATE payments SET result_desc = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [`Received but not applied — order was already ${outcome.reason === 'cancelled' ? 'cancelled' : 'fully paid'} by the time this confirmed. Needs a manual refund.`, payment.id]
      );
      console.warn(`Stripe card payment ${payment.id} confirmed for an order that could no longer accept it (order ${payment.order_id}, reason: ${outcome.reason}). Flagged for manual refund.`);
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

const markCardPaymentFailed = async (paymentIntentId: string, reason: string): Promise<void> => {
  await query(
    `UPDATE payments SET status = 'failed', result_desc = $1, updated_at = CURRENT_TIMESTAMP WHERE reference = $2 AND status = 'pending'`,
    [reason, paymentIntentId]
  );
};

// POST /stripe/confirm-payment  { payment_intent_id }
//
// Called by the frontend the instant terminal.processPayment() resolves in
// the browser — the tap/insert/swipe already happened at that point. This
// endpoint does NOT trust that report on its own; it retrieves the
// PaymentIntent directly from Stripe to independently verify status is
// actually 'succeeded' before applying anything, the same way the M-Pesa
// path trusts Safaricom's own callback data over a client's say-so. This is
// the fast, synchronous confirmation path; the webhook below is the backup
// in case this call never arrives (e.g. the browser loses network right
// after the card was charged).
export const confirmCardPayment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { payment_intent_id } = req.body;
    if (!payment_intent_id) {
      res.status(400).json({ success: false, message: 'payment_intent_id is required' });
      return;
    }

    let stripeConfig;
    try {
      stripeConfig = getStripeConfig();
    } catch (configError) {
      res.status(503).json({ success: false, message: configError instanceof Error ? configError.message : 'Stripe is not configured' });
      return;
    }
    const stripe = getStripeClient(stripeConfig.secretKey);

    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

    if (paymentIntent.status !== 'succeeded') {
      res.status(400).json({
        success: false,
        message: `Card payment has not succeeded yet (status: ${paymentIntent.status}). Try again once the reader confirms.`,
      });
      return;
    }

    const result = await markCardPaymentCompleted(payment_intent_id);
    if (result === 'not_found') {
      res.status(404).json({ success: false, message: 'No matching payment record found for this payment intent' });
      return;
    }

    const orderRes = await query('SELECT id, order_number, status, total, amount_paid FROM orders WHERE id = $1', [paymentIntent.metadata.order_id]);
    const order = orderRes.rows[0];
    const balanceRemaining = order ? Math.max(0, Math.round((Number(order.total) - Number(order.amount_paid)) * 100) / 100) : 0;

    res.json({
      success: true,
      message: result === 'applied' ? 'Card payment confirmed' : 'Card payment already confirmed',
      order_status: order?.status,
      balance_remaining: balanceRemaining,
    });
  } catch (error) {
    console.error('Stripe confirm payment error:', error);
    const message = error instanceof Error ? error.message : 'Could not confirm the card payment';
    res.status(500).json({ success: false, message });
  }
};

// POST /stripe/cancel-payment-intent  { payment_intent_id }
//
// Same role as M-Pesa's cancel-payment — a cashier backing out mid-flow
// (wrong amount, customer changed their mind, reader trouble). Cancels on
// Stripe's side too so the intent can't be captured later by a stray retry.
export const cancelCardPaymentIntent = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { payment_intent_id } = req.body;
    if (!payment_intent_id) {
      res.status(400).json({ success: false, message: 'payment_intent_id is required' });
      return;
    }
    const { secretKey } = getStripeConfig();
    const stripe = getStripeClient(secretKey);

    try {
      await stripe.paymentIntents.cancel(payment_intent_id);
    } catch (stripeErr) {
      // Already succeeded/canceled on Stripe's side — not a real failure
      // for our purposes, the payment row update below is what matters.
      console.warn('Stripe cancel (non-fatal):', stripeErr instanceof Error ? stripeErr.message : stripeErr);
    }

    await markCardPaymentFailed(payment_intent_id, 'Cancelled by cashier');
    res.json({ success: true, message: 'Card payment cancelled' });
  } catch (error) {
    console.error('Stripe cancel payment error:', error);
    res.status(500).json({ success: false, message: 'Could not cancel the card payment' });
  }
};

// POST /stripe/webhook  (mounted with a raw body parser in server.ts, BEFORE
// the global express.json() — Stripe's signature verification needs the
// exact original bytes, not a re-serialized JSON object)
//
// Source-of-truth backup, same role as mpesaCallback: fires independently of
// whatever the frontend does, so a browser that loses network right after a
// successful tap still results in a correctly completed order once this
// arrives. Idempotent by construction — whichever of this or
// confirmCardPayment resolves first wins; the other is a no-op via the
// status = 'pending' guard inside markCardPaymentCompleted.
export const stripeWebhook = async (req: Request, res: Response): Promise<void> => {
  let event: Stripe.Event;
  try {
    const { secretKey, webhookSecret } = getStripeConfig();
    if (!webhookSecret) {
      console.error('Stripe webhook received but STRIPE_WEBHOOK_SECRET is not set — rejecting rather than trusting an unverified payload.');
      res.status(503).send('Webhook secret not configured');
      return;
    }
    const stripe = getStripeClient(secretKey);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature as string, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err instanceof Error ? err.message : err);
    res.status(400).send('Webhook signature verification failed');
    return;
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object as Stripe.PaymentIntent;
      const result = await markCardPaymentCompleted(intent.id);
      console.log(`Stripe webhook: payment_intent.succeeded for ${intent.id} — ${result}`);
    } else if (event.type === 'payment_intent.payment_failed') {
      const intent = event.data.object as Stripe.PaymentIntent;
      await markCardPaymentFailed(intent.id, intent.last_payment_error?.message || 'Payment failed');
      console.log(`Stripe webhook: payment_intent.payment_failed for ${intent.id}`);
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handling error:', error);
    // Stripe retries on non-2xx — safe to do since our handling is
    // idempotent, so acknowledge receipt regardless rather than causing a
    // retry storm over a logging/transient issue.
    res.json({ received: true });
  }
};