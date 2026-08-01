import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../config/database';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    full_name: string;
  };
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Access token required' });
      return;
    }

    const token = authHeader.substring(7);
    // No fallback here on purpose — server.ts refuses to boot at all unless
    // JWT_SECRET is set and at least 32 characters, so this always reads a
    // real secret. A hardcoded fallback string is a known value sitting in
    // source control; anyone who read it could forge a valid token for any
    // user, administrator included.
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string; email: string; role: string };

    const result = await query('SELECT id, email, role, full_name, status FROM users WHERE id = $1', [decoded.id]);
    if (result.rows.length === 0 || result.rows[0].status === 'inactive') {
      res.status(401).json({ success: false, message: 'User not found or inactive' });
      return;
    }

    req.user = result.rows[0];
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// Small cache of custom role names — refreshed periodically, and can be
// invalidated immediately by rolesController.ts the moment a role is
// created, renamed, or deleted, so a brand new role works right away
// instead of waiting out a stale cache window.
let cachedCustomRoleNames: Set<string> | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60 * 1000;

export const invalidateCustomRoleCache = (): void => {
  cachedCustomRoleNames = null;
};

const getCustomRoleNames = async (): Promise<Set<string>> => {
  if (cachedCustomRoleNames && Date.now() < cacheExpiresAt) return cachedCustomRoleNames;
  try {
    const result = await query('SELECT name FROM custom_roles');
    cachedCustomRoleNames = new Set(result.rows.map(r => r.name));
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return cachedCustomRoleNames;
  } catch {
    // If the lookup itself fails, fail closed (treat as "no custom
    // roles") rather than throwing and breaking every protected route.
    return new Set();
  }
};

export const authorize = (...roles: string[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) { res.status(403).json({ success: false, message: 'Insufficient permissions' }); return; }
    if (roles.includes(req.user.role)) { next(); return; }

    // A custom role automatically gets the same access as 'manager' would
    // for backend purposes — this app's backend authorization is already
    // coarse (admin-only, or admin+manager+cashier — not distinct checks
    // per module even for the 7 built-in roles), so this preserves that
    // exact same granularity rather than inventing a finer one that
    // wouldn't match how anything else here actually works. Never grants
    // admin-only access, regardless of what a custom role's picked
    // permissions include.
    if (roles.includes('manager')) {
      const customRoleNames = await getCustomRoleNames();
      if (customRoleNames.has(req.user.role)) { next(); return; }
    }

    res.status(403).json({ success: false, message: 'Insufficient permissions' });
  };
};