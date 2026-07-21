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

interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

// Actually delivers to a given set of push_subscriptions rows, and cleans
// up any subscription the browser itself has reported as dead (404/410)
// rather than retrying it forever. Shared by both the role-based and
// single-user senders below, so there's exactly one place that knows how
// to talk to web-push and handle its failures.
const deliverToSubscriptions = async (
  subs: Array<{ id: string; endpoint: string; subscription: webpush.PushSubscription }>,
  payload: PushPayload
): Promise<void> => {
  await Promise.all(subs.map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify({
        title: payload.title,
        body: payload.body,
        tag: payload.tag,
        data: { url: payload.url },
      }));
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]).catch(() => {});
      } else {
        console.error('Push notification failed for subscription', row.id, err);
      }
    }
  }));
};

// Shared delivery mechanism behind every notification type this app sends.
// Looks up every device subscribed by someone in one of the given roles,
// sends to all of them (a person can reasonably have more than one
// subscribed device — a kitchen tablet and their own phone — and there's
// no way to know which one they'll actually have on them), and cleans up
// any subscription the browser itself has reported as dead (404/410)
// rather than retrying it forever.
const sendPushToRoles = async (roles: string[], payload: PushPayload, excludeUserId?: string): Promise<void> => {
  if (!configured) return; // Not set up — fail silently, never block whatever triggered this.

  try {
    const subs = await query(`
      SELECT ps.id, ps.endpoint, ps.subscription
      FROM push_subscriptions ps
      JOIN users u ON ps.user_id = u.id
      WHERE u.role = ANY($1) AND u.status = 'active' AND ($2::uuid IS NULL OR ps.user_id != $2)
    `, [roles, excludeUserId || null]);
    await deliverToSubscriptions(subs.rows, payload);
  } catch (error) {
    // A notification failure should never prevent whatever triggered it
    // (an order, a refund request) from succeeding — this is a
    // nice-to-have alert layered on top of a working flow, not a
    // dependency of it.
    console.error('sendPushToRoles error:', error);
  }
};

// Same delivery mechanism, but targeted at exactly one person by user id —
// for notifications that are inherently about a specific individual (e.g.
// "this order was assigned to YOU"), where sending to an entire role would
// be wrong: the rest of the kitchen has no reason to be notified about
// someone else's personal assignment.
const sendPushToUser = async (userId: string, payload: PushPayload): Promise<void> => {
  if (!configured) return;
  try {
    const subs = await query(`
      SELECT ps.id, ps.endpoint, ps.subscription
      FROM push_subscriptions ps
      JOIN users u ON ps.user_id = u.id
      WHERE ps.user_id = $1 AND u.status = 'active'
    `, [userId]);
    await deliverToSubscriptions(subs.rows, payload);
  } catch (error) {
    console.error('sendPushToUser error:', error);
  }
};

interface OrderNotificationPayload {
  title: string;
  body: string;
  orderId: string;
  orderNumber: string;
  createdByUserId?: string;
}

// Sends to every device kitchen staff (kitchen_staff, head_chef,
// administrator, manager — the roles that can actually see Kitchen
// Display) has subscribed — except the person who actually placed this
// order themselves. A cashier who's also an admin/manager with phone
// alerts enabled would otherwise get buzzed about their own sale on top of
// the in-app "sent to kitchen" toast they're already looking at.
export const notifyKitchenOfNewOrder = async (payload: OrderNotificationPayload): Promise<void> => {
  await sendPushToRoles(
    ['kitchen_staff', 'head_chef', 'administrator', 'manager'],
    { title: payload.title, body: payload.body, tag: `order-${payload.orderId}`, url: '/kitchen' },
    payload.createdByUserId
  );
};

interface RefundRequestNotificationPayload {
  title: string;
  body: string;
  orderId: string;
}

// Administrator-only — they're the sole approval authority for a manager's
// refund request, so nobody else needs to be notified.
export const notifyAdminsOfRefundRequest = async (payload: RefundRequestNotificationPayload): Promise<void> => {
  await sendPushToRoles(
    ['administrator'],
    { title: payload.title, body: payload.body, tag: `refund-${payload.orderId}`, url: '/orders' }
  );
};

interface ChefAssignmentNotificationPayload {
  title: string;
  body: string;
  orderId: string;
}

// A specific order was manually assigned to a specific chef by an admin —
// only that one person should be notified, not the whole kitchen (they'd
// otherwise get a duplicate, irrelevant alert on top of the new-order
// notification everyone already received when the order first came in).
export const notifyChefOfAssignment = async (chefUserId: string, payload: ChefAssignmentNotificationPayload): Promise<void> => {
  await sendPushToUser(chefUserId, { title: payload.title, body: payload.body, tag: `assignment-${payload.orderId}`, url: '/kitchen' });
};

interface SickOffNotificationPayload {
  title: string;
  body: string;
  requestId: string;
}

// Administrator-only — same reasoning as refund requests: they're the sole
// approval authority for a sick-off request, so nobody else needs to be
// notified about it.
export const notifyAdminsOfSickOffRequest = async (payload: SickOffNotificationPayload): Promise<void> => {
  await sendPushToRoles(
    ['administrator'],
    { title: payload.title, body: payload.body, tag: `sick-off-${payload.requestId}`, url: '/scheduling' }
  );
};