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

export const authorize = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ success: false, message: 'Insufficient permissions' });
      return;
    }
    next();
  };
};