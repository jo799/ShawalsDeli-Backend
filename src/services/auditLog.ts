import { Request } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';

interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}

// Best-effort IP extraction — X-Forwarded-For is trusted here because this
// app is expected to sit behind a reverse proxy in production (the same
// assumption the rate limiter and CORS config already make); falls back to
// the raw socket address for direct/local connections.
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// Fire-and-forget by design — an audit log write failing (a transient DB
// hiccup, say) should never be the reason a real operation (a payment, a
// staff change) fails. Errors are logged to the console for visibility but
// never thrown back to the caller.
export async function logAudit(req: AuthRequest, entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, user_name, user_email, action, entity_type, entity_id, details, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        req.user?.id || null,
        req.user?.full_name || null,
        req.user?.email || null,
        entry.action,
        entry.entityType || null,
        entry.entityId || null,
        entry.details ? JSON.stringify(entry.details) : null,
        getClientIp(req),
      ]
    );
  } catch (error) {
    console.error('Failed to write audit log entry:', entry.action, error);
  }
}

// Separate helper for auth events specifically (login success/failure)
// where req.user isn't populated yet — the whole point of logging a failed
// login is that authentication didn't succeed, so there's no req.user to
// read from at that point. Takes the identifying details explicitly instead.
export async function logAuthEvent(
  req: Request,
  action: string,
  details: { email?: string; userId?: string; userName?: string; reason?: string }
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, user_name, user_email, action, details, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        details.userId || null,
        details.userName || null,
        details.email || null,
        action,
        JSON.stringify({ reason: details.reason }),
        getClientIp(req),
      ]
    );
  } catch (error) {
    console.error('Failed to write audit log entry:', action, error);
  }
}