import webpush from 'web-push';
import { query } from '../config/database';

// VAPID keys authenticate this server to the browser's push service (the
// actual delivery infrastructure — Google's for Chrome, Mozilla's for
// Firefox, etc.) as the legitimate sender for a given subscription. They're
// a fixed identity for this app, generated once and reused — not a
// per-request secret. If these env vars aren't set, push notifications are
// silently disabled rather than crashing the server; a restaurant that
// hasn't set this up yet should still be able to take orders normally.
const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
const configured = !!(publicKey && privateKey);

if (configured) {
  webpush.setVapidDetails('mailto:admin@shawalsdeli.com', publicKey!, privateKey!);
}

export const isPushConfigured = () => configured;
export const getVapidPublicKey = () => publicKey || null;

interface OrderNotificationPayload {
  title: string;
  body: string;
  orderId: string;
  orderNumber: string;
}

// Sends to every device kitchen staff (kitchen_staff, head_chef,
// administrator, manager — the roles that can actually see Kitchen
// Display) has subscribed. A person can have more than one subscribed
// device (a tablet at the kitchen pass, their own phone) — all of them
// get notified, since there's no way to know which one they'll actually
// have on them.
export const notifyKitchenOfNewOrder = async (payload: OrderNotificationPayload): Promise<void> => {
  if (!configured) return; // Not set up — fail silently, never block order creation on this.

  try {
    const subs = await query(`
      SELECT ps.id, ps.endpoint, ps.subscription
      FROM push_subscriptions ps
      JOIN users u ON ps.user_id = u.id
      WHERE u.role IN ('kitchen_staff', 'head_chef', 'administrator', 'manager')
        AND u.status = 'active'
    `);

    await Promise.all(subs.rows.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify({
          title: payload.title,
          body: payload.body,
          tag: `order-${payload.orderId}`, // Replaces any existing notification for the same order rather than stacking duplicates if this ever fires twice.
          data: { url: '/kitchen', orderId: payload.orderId },
        }));
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        // 404/410 mean the browser has unsubscribed or the subscription
        // expired — clean these up now rather than retrying a dead
        // endpoint on every future order indefinitely.
        if (statusCode === 404 || statusCode === 410) {
          await query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]).catch(() => {});
        } else {
          console.error('Push notification failed for subscription', row.id, err);
        }
      }
    }));
  } catch (error) {
    // A notification failure should never prevent the order itself from
    // succeeding — this is a nice-to-have alert layered on top of a
    // working order flow, not a dependency of it.
    console.error('notifyKitchenOfNewOrder error:', error);
  }
};