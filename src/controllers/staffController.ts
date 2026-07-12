import { Request, Response } from 'express';
import { query } from '../config/database';
import bcrypt from 'bcryptjs';
import { AuthRequest } from '../middleware/auth';
import { logAudit } from '../services/auditLog';

const VALID_ROLES = ['administrator', 'manager', 'head_chef', 'cashier', 'waiter', 'kitchen_staff', 'cleaner'];
const VALID_STATUSES = ['active', 'on_leave', 'inactive'];

export const getStaff = async (req: Request, res: Response): Promise<void> => {
  try {
    const { role, status, approval_status, search, page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (role && role !== 'all') { conditions.push(`role = $${idx++}`); params.push(role); }
    if (status && status !== 'all') { conditions.push(`status = $${idx++}`); params.push(status); }
    // Default listing (used by the main Staff table) only shows approved
    // accounts — a pending signup isn't "staff" yet, it's a request waiting
    // on a decision. The Pending Approvals view passes approval_status=pending
    // explicitly to see those instead.
    if (approval_status) { conditions.push(`approval_status = $${idx++}`); params.push(approval_status); }
    else { conditions.push(`approval_status = 'approved'`); }
    if (search) { conditions.push(`(full_name ILIKE $${idx} OR email ILIKE $${idx} OR phone ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await query(`SELECT COUNT(*) FROM users ${where}`, params);

    params.push(Number(limit), offset);
    const result = await query(`
      SELECT id, full_name, email, phone, role, status, approval_status, schedule_type, avatar_url, joined_date, last_login, created_at
      FROM users ${where}
      ORDER BY joined_date DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    const statsRes = await query(`
      SELECT
        COUNT(*) FILTER (WHERE approval_status = 'approved') as total,
        COUNT(*) FILTER (WHERE approval_status = 'approved' AND status = 'active') as active,
        COUNT(*) FILTER (WHERE approval_status = 'approved' AND status = 'on_leave') as on_leave,
        COUNT(*) FILTER (WHERE approval_status = 'approved' AND status = 'inactive') as inactive,
        COUNT(*) FILTER (WHERE approval_status = 'pending') as pending_approval
      FROM users
    `);

    res.json({ success: true, data: result.rows, stats: statsRes.rows[0], pagination: { total: parseInt(countRes.rows[0].count), page: Number(page), limit: Number(limit) } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const createStaff = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { full_name, email, phone, role, schedule_type, joined_date, password } = req.body;
    if (!full_name || !email || !password) {
      res.status(400).json({ success: false, message: 'full_name, email and password are required' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      return;
    }
    if (role && !VALID_ROLES.includes(role)) {
      res.status(400).json({ success: false, message: `role must be one of: ${VALID_ROLES.join(', ')}` });
      return;
    }
    const trimmedEmail = String(email).toLowerCase().trim();
    const existing = await query('SELECT id FROM users WHERE email = $1', [trimmedEmail]);
    if (existing.rows.length > 0) {
      res.status(400).json({ success: false, message: 'A user with that email already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    // Explicitly 'approved' — an admin creating this account directly (as
    // opposed to someone self-registering) is itself the approval.
    // joined_date falls back to CURRENT_DATE in SQL (session pinned to
    // Africa/Nairobi — see config/database.ts) rather than a JS-computed
    // date, which would suffer the same UTC-vs-local day-boundary bug fixed
    // elsewhere in this app.
    const result = await query(`
      INSERT INTO users (full_name, email, phone, password_hash, role, schedule_type, joined_date, approval_status)
      VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date, CURRENT_DATE),'approved')
      RETURNING id, full_name, email, phone, role, status, approval_status, schedule_type, joined_date, created_at
    `, [full_name, trimmedEmail, phone || null, passwordHash, role || 'waiter', schedule_type || 'full_time', joined_date || null]);
    await logAudit(req, { action: 'staff_created', entityType: 'user', entityId: result.rows[0].id, details: { full_name, email: trimmedEmail, role: role || 'waiter' } });
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Approve or reject a pending self-service signup. Deliberately separate
// from updateStaff below — this is a one-time decision on an account that
// isn't "staff" yet, not a routine edit to an existing staff member's
// details, and it's worth keeping that distinction visible in the API.
export const setApprovalStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { approval_status, role } = req.body;
    const validStatuses = ['approved', 'rejected'];
    if (!validStatuses.includes(approval_status)) {
      res.status(400).json({ success: false, message: `approval_status must be one of: ${validStatuses.join(', ')}` });
      return;
    }
    if (role && !VALID_ROLES.includes(role)) {
      res.status(400).json({ success: false, message: `role must be one of: ${VALID_ROLES.join(', ')}` });
      return;
    }

    const result = await query(`
      UPDATE users SET approval_status = $1, role = COALESCE($2, role), updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND approval_status = 'pending'
      RETURNING id, full_name, email, role, approval_status
    `, [approval_status, role || null, id]);

    if (!result.rows.length) {
      res.status(404).json({ success: false, message: 'No pending signup found with that id (it may have already been decided)' });
      return;
    }
    await logAudit(req, { action: approval_status === 'approved' ? 'staff_approved' : 'staff_rejected', entityType: 'user', entityId: id, details: { full_name: result.rows[0].full_name, role: result.rows[0].role } });
    res.json({
      success: true,
      data: result.rows[0],
      message: approval_status === 'approved' ? `${result.rows[0].full_name} approved and can now log in.` : `${result.rows[0].full_name}'s request was declined.`,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateStaff = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { full_name, email, phone, role, status, schedule_type } = req.body;

    if (!full_name || !full_name.toString().trim()) {
      res.status(400).json({ success: false, message: 'full_name is required' });
      return;
    }
    if (role && !VALID_ROLES.includes(role)) {
      res.status(400).json({ success: false, message: `role must be one of: ${VALID_ROLES.join(', ')}` });
      return;
    }
    if (status && !VALID_STATUSES.includes(status)) {
      res.status(400).json({ success: false, message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      return;
    }
    // An admin deactivating or demoting their own account is almost always
    // a mistake, not a decision — and unlike other edits, this one can lock
    // them out with nobody left able to undo it. Doesn't block editing
    // your own name/phone/email, just the two changes that could end the
    // session permanently.
    if (req.user!.id === id) {
      if (status && status !== 'active') {
        res.status(400).json({ success: false, message: 'You cannot deactivate your own account' });
        return;
      }
      if (role && role !== 'administrator' && req.user!.role === 'administrator') {
        res.status(400).json({ success: false, message: 'You cannot remove your own administrator role' });
        return;
      }
    }

    // Email wasn't editable at all before — it wasn't even in the accepted
    // fields, so a typo made at creation time was permanent. Uniqueness is
    // checked explicitly (rather than just relying on a DB constraint
    // erroring out) so the rejection reason is actually legible.
    let trimmedEmail: string | undefined;
    if (email !== undefined) {
      trimmedEmail = String(email).toLowerCase().trim();
      if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        res.status(400).json({ success: false, message: 'A valid email address is required' });
        return;
      }
      const existing = await query('SELECT id FROM users WHERE email = $1 AND id != $2', [trimmedEmail, id]);
      if (existing.rows.length > 0) {
        res.status(400).json({ success: false, message: 'Another user already has that email' });
        return;
      }
    }

    // Fetched before the update specifically so the audit log can record an
    // actual role or status CHANGE (and what it changed from/to) rather than
    // just "this record was edited" — a role escalation is the kind of
    // thing worth being able to find later, a phone number typo fix isn't.
    const before = await query('SELECT role, status FROM users WHERE id = $1', [id]);

    const result = await query(`
      UPDATE users SET full_name=$1, email=COALESCE($2, email), phone=$3, role=COALESCE($4, role),
        status=COALESCE($5, status), schedule_type=$6, updated_at=CURRENT_TIMESTAMP
      WHERE id=$7
      RETURNING id, full_name, email, phone, role, status, approval_status, schedule_type, joined_date, last_login, avatar_url
    `, [full_name.toString().trim(), trimmedEmail || null, phone || null, role || null, status || null, schedule_type || null, id]);
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Staff not found' }); return; }

    const updated = result.rows[0];
    if (before.rows.length && before.rows[0].role !== updated.role) {
      await logAudit(req, { action: 'staff_role_changed', entityType: 'user', entityId: id, details: { full_name: updated.full_name, from: before.rows[0].role, to: updated.role } });
    }
    if (before.rows.length && before.rows[0].status !== updated.status) {
      await logAudit(req, { action: updated.status === 'inactive' ? 'staff_deactivated' : 'staff_status_changed', entityType: 'user', entityId: id, details: { full_name: updated.full_name, from: before.rows[0].status, to: updated.status } });
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Admin-initiated password reset — distinct from the self-service
// forgot-password flow (which requires the user to have email access and
// wait for a link). Useful when someone's locked out and needs back in
// right now, or when Brevo isn't configured at all yet.
export const resetStaffPassword = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (!password || password.length < 8) {
      res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(
      `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, full_name`,
      [passwordHash, id]
    );
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Staff not found' }); return; }
    await logAudit(req, { action: 'staff_password_reset_by_admin', entityType: 'user', entityId: id, details: { full_name: result.rows[0].full_name } });
    res.json({ success: true, message: `Password reset for ${result.rows[0].full_name}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getSchedules = async (req: Request, res: Response): Promise<void> => {
  try {
    const { start_date, end_date } = req.query;
    // Same fix as createStaff above — CURRENT_DATE in SQL (Nairobi-pinned
    // session) rather than a JS-computed UTC date for the "today" fallback.
    const result = await query(`
      SELECT ss.*, u.full_name, u.role as user_role, u.avatar_url
      FROM staff_schedules ss
      JOIN users u ON ss.user_id = u.id
      WHERE ss.shift_date BETWEEN COALESCE($1::date, CURRENT_DATE) AND COALESCE($2::date, CURRENT_DATE)
      ORDER BY ss.shift_date, u.full_name
    `, [start_date || null, end_date || null]);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const VALID_SHIFT_TYPES = ['morning', 'day', 'evening', 'night', 'off'];

export const upsertSchedule = async (req: Request, res: Response): Promise<void> => {
  try {
    const { user_id, shift_date, shift_type, start_time, end_time, role_label } = req.body;

    if (!user_id || !shift_date || !shift_type) {
      res.status(400).json({ success: false, message: 'user_id, shift_date and shift_type are required' });
      return;
    }
    if (!VALID_SHIFT_TYPES.includes(shift_type)) {
      res.status(400).json({ success: false, message: `shift_type must be one of: ${VALID_SHIFT_TYPES.join(', ')}` });
      return;
    }
    if (Number.isNaN(new Date(shift_date).getTime())) {
      res.status(400).json({ success: false, message: 'shift_date must be a valid date' });
      return;
    }
    if (start_time && end_time && start_time >= end_time) {
      res.status(400).json({ success: false, message: 'end_time must be after start_time' });
      return;
    }
    const userCheck = await query('SELECT id FROM users WHERE id = $1', [user_id]);
    if (!userCheck.rows.length) {
      res.status(404).json({ success: false, message: 'Staff member not found' });
      return;
    }

    const result = await query(`
      INSERT INTO staff_schedules (user_id, shift_date, shift_type, start_time, end_time, role_label)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (user_id, shift_date) DO UPDATE SET
        shift_type = EXCLUDED.shift_type, start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time, role_label = EXCLUDED.role_label, updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [user_id, shift_date, shift_type, start_time || null, end_time || null, role_label || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Removing a shift entirely (not the same as setting it to 'off' — 'off' is
// a real, deliberate day-off record; this is "there is no schedule entry
// here at all", e.g. undoing a mistaken assignment).
export const deleteSchedule = async (req: Request, res: Response): Promise<void> => {
  try {
    const { user_id, shift_date } = req.params;
    const result = await query(
      'DELETE FROM staff_schedules WHERE user_id = $1 AND shift_date = $2 RETURNING id',
      [user_id, shift_date]
    );
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'No schedule entry found for that staff member on that date' }); return; }
    res.json({ success: true, message: 'Schedule entry removed' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};