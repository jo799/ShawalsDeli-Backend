import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { getVapidPublicKey, isPushConfigured } from '../services/pushService';

export const getPushConfig = async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ success: true, data: { configured: isPushConfigured(), publicKey: getVapidPublicKey() } });
};

export const subscribe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) {
      res.status(400).json({ success: false, message: 'A valid push subscription is required' });
      return;
    }
    // ON CONFLICT on endpoint (unique per browser+device registration) —
    // re-subscribing the same device (e.g. after clearing site data, or
    // just calling subscribe again defensively) updates who owns it and
    // refreshes the keys, rather than erroring or silently duplicating.
    await query(`
      INSERT INTO push_subscriptions (user_id, endpoint, subscription)
      VALUES ($1, $2, $3)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, subscription = $3
    `, [req.user!.id, subscription.endpoint, JSON.stringify(subscription)]);
    res.status(201).json({ success: true, message: 'Subscribed to kitchen order alerts' });
  } catch (error) {
    console.error('Push subscribe error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const unsubscribe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      res.status(400).json({ success: false, message: 'endpoint is required' });
      return;
    }
    await query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user!.id]);
    res.json({ success: true, message: 'Unsubscribed' });
  } catch (error) {
    console.error('Push unsubscribe error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};