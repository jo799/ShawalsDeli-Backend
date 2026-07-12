import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { sendEmail, passwordResetOtpEmail, loginOtpEmail } from '../services/emailService';
import { logAuthEvent, logAudit } from '../services/auditLog';

// A brand-new deployment has zero rows in users — and normal self-registration
// (see `register` below) creates every account as 'pending', requiring an
// existing administrator to approve it. On a fresh install there is no
// administrator yet, so that first account can never get approved by
// anyone. This is the deliberate escape hatch: while the users table is
// genuinely empty, the frontend shows a one-time "create your administrator
// account" screen instead of the normal login form.
export const getSystemStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query('SELECT COUNT(*) FROM users');
    const needsSetup = parseInt(result.rows[0].count, 10) === 0;
    res.json({ success: true, data: { needs_setup: needsSetup } });
  } catch (error) {
    console.error('System status error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Creates the very first account, as an already-approved administrator, and
// logs them straight in — there's no one else who could approve them, and
// requiring email-based OTP here would risk locking someone out if Brevo
// isn't configured yet during initial setup (a very real chicken-and-egg
// problem of its own). The emptiness check happens again here, server-side,
// immediately before the insert — the frontend's own check is only ever a
// hint for which screen to show, never something this endpoint trusts. Once
// a single user exists anywhere, this permanently refuses to create another
// one, regardless of what the caller claims.
export const setupFirstAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const countResult = await query('SELECT COUNT(*) FROM users');
    if (parseInt(countResult.rows[0].count, 10) > 0) {
      res.status(403).json({ success: false, message: 'Setup has already been completed. Please log in instead.' });
      return;
    }

    const { full_name, email, phone, password } = req.body;
    if (!full_name || !String(full_name).trim()) {
      res.status(400).json({ success: false, message: 'Full name is required' });
      return;
    }
    const trimmedEmail = String(email || '').toLowerCase().trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      res.status(400).json({ success: false, message: 'A valid email address is required' });
      return;
    }
    if (!password || String(password).length < 8) {
      res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(`
      INSERT INTO users (full_name, email, phone, password_hash, role, status, approval_status)
      VALUES ($1,$2,$3,$4,'administrator','active','approved')
      RETURNING id, full_name, email, phone, role, status, approval_status
    `, [String(full_name).trim(), trimmedEmail, phone || null, passwordHash]);
    const user = result.rows[0];

    await logAuthEvent(req, 'system_setup_completed', { email: trimmedEmail, userId: user.id, userName: user.full_name });

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      res.status(503).json({ success: false, message: 'Server is not properly configured' });
      return;
    }
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, secret, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    } as jwt.SignOptions);

    res.status(201).json({ success: true, data: { token, user } });
  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ success: false, message: 'Email and password are required' });
      return;
    }

    const result = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (result.rows.length === 0) {
      await logAuthEvent(req, 'login_failed', { email, reason: 'unknown_email' });
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];
    if (user.status === 'inactive') {
      await logAuthEvent(req, 'login_failed', { email, userId: user.id, userName: user.full_name, reason: 'inactive_account' });
      res.status(401).json({ success: false, message: 'Account is inactive' });
      return;
    }
    // Account approval gate — checked separately from the work-schedule
    // `status` above. A self-service signup sits here until an admin acts
    // on it; only 'approved' accounts can actually log in.
    if (user.approval_status === 'pending') {
      await logAuthEvent(req, 'login_failed', { email, userId: user.id, userName: user.full_name, reason: 'pending_approval' });
      res.status(403).json({ success: false, message: 'Your account is awaiting admin approval. You\'ll be able to log in once approved.' });
      return;
    }
    if (user.approval_status === 'rejected') {
      await logAuthEvent(req, 'login_failed', { email, userId: user.id, userName: user.full_name, reason: 'rejected_approval' });
      res.status(403).json({ success: false, message: 'Your account request was declined. Contact your administrator for details.' });
      return;
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      await logAuthEvent(req, 'login_failed', { email, userId: user.id, userName: user.full_name, reason: 'wrong_password' });
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    await query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    await logAuthEvent(req, 'login_success', { email, userId: user.id, userName: user.full_name });

    // OTP 2FA — configurable (Settings > POS & Payments... actually General)
    // rather than unconditionally forced on everyone, since a shared POS
    // terminal with frequent shift-change logins is a real, different
    // tradeoff than a back-office admin account. Defaults to OFF so an
    // existing deployment's login behavior doesn't silently change the
    // moment this ships; a business turns it on deliberately.
    const otpSetting = await query(`SELECT value FROM settings WHERE key = 'otp_login_enabled'`);
    // Opt-out, not opt-in: OTP is required unless the row explicitly says
    // 'false'. If the row is missing entirely (a fresh database whose
    // migration seed hasn't run yet, or a settings row that got cleared for
    // any other reason), that must still mean "required", not "off" — an
    // absent row silently disabling a security control is exactly the kind
    // of gap that made this stop asking for a code after a database reset.
    const otpEnabled = otpSetting.rows[0]?.value !== 'false';

    if (otpEnabled) {
      const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits, always
      const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      // Only one live OTP per user at a time — a fresh login attempt
      // invalidates whatever code was issued moments before, so an old
      // email lying around in an inbox can't be used later.
      await query(`UPDATE login_otps SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
      await query(
        `INSERT INTO login_otps (user_id, otp_hash, expires_at) VALUES ($1, $2, $3::timestamptz)`,
        [user.id, otpHash, expiresAt]
      );

      try {
        const { subject, htmlContent } = loginOtpEmail(otp);
        await sendEmail({ to: user.email, toName: user.full_name, subject, htmlContent });
      } catch (emailError) {
        console.error('Failed to send login OTP email:', emailError);
        res.status(503).json({ success: false, message: emailError instanceof Error ? emailError.message : 'Could not send your login code right now. Please try again shortly.' });
        return;
      }

      res.json({ success: true, otp_required: true, email: user.email, message: 'Enter the code we just emailed you to finish logging in.' });
      return;
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      // This should never happen in a properly configured environment —
      // server.ts validates this at startup. But defensively guard here too.
      res.status(503).json({ success: false, message: 'Server is not properly configured' });
      return;
    }
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, secret, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    } as jwt.SignOptions);

    const { password_hash, ...userWithoutPassword } = user;
    void password_hash;

    res.json({ success: true, data: { token, user: userWithoutPassword } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Second step of login when OTP 2FA is enabled — verifies the emailed code
// and, only then, issues the real session token. Deliberately looks up the
// user by email again rather than trusting a client-supplied id, and
// re-verifies against the DB's current state (an account could have been
// deactivated in the few minutes between step one and step two).
export const verifyLoginOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      res.status(400).json({ success: false, message: 'email and otp are required' });
      return;
    }

    const userResult = await query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase().trim()]);
    if (!userResult.rows.length) {
      res.status(401).json({ success: false, message: 'Invalid or expired code' });
      return;
    }
    const user = userResult.rows[0];

    const otpResult = await query(
      `SELECT * FROM login_otps WHERE user_id = $1 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (!otpResult.rows.length) {
      await logAuthEvent(req, 'otp_verify_failed', { email, userId: user.id, userName: user.full_name, reason: 'no_active_otp' });
      res.status(401).json({ success: false, message: 'Invalid or expired code. Please log in again to get a new one.' });
      return;
    }
    const otpRow = otpResult.rows[0];

    // Five wrong guesses burns this specific code even if it hasn't expired
    // yet — on top of, not instead of, the endpoint-level rate limit. Two
    // independent brakes on the same 1-in-a-million-ish guessing attempt.
    if (otpRow.attempts >= 5) {
      await query(`UPDATE login_otps SET used_at = CURRENT_TIMESTAMP WHERE id = $1`, [otpRow.id]);
      await logAuthEvent(req, 'otp_verify_failed', { email, userId: user.id, userName: user.full_name, reason: 'too_many_attempts' });
      res.status(401).json({ success: false, message: 'Too many incorrect attempts. Please log in again to get a new code.' });
      return;
    }

    const submittedHash = crypto.createHash('sha256').update(String(otp).trim()).digest('hex');
    if (submittedHash !== otpRow.otp_hash) {
      await query(`UPDATE login_otps SET attempts = attempts + 1 WHERE id = $1`, [otpRow.id]);
      await logAuthEvent(req, 'otp_verify_failed', { email, userId: user.id, userName: user.full_name, reason: 'wrong_code' });
      res.status(401).json({ success: false, message: 'Incorrect code. Please try again.' });
      return;
    }

    await query(`UPDATE login_otps SET used_at = CURRENT_TIMESTAMP WHERE id = $1`, [otpRow.id]);
    await logAuthEvent(req, 'otp_verify_success', { email, userId: user.id, userName: user.full_name });

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      res.status(503).json({ success: false, message: 'Server is not properly configured' });
      return;
    }
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, secret, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    } as jwt.SignOptions);

    const { password_hash, ...userWithoutPassword } = user;
    void password_hash;
    res.json({ success: true, data: { token, user: userWithoutPassword } });
  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Public self-service signup. Always creates the account as
// approval_status='pending' and forces role to the lowest-privilege value
// regardless of what the request body asks for — letting a public form
// grant its own role (e.g. "administrator") would be a straightforward
// privilege-escalation hole. An admin assigns the real role when approving.
export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { full_name, email, phone, password } = req.body;

    if (!full_name || !String(full_name).trim()) {
      res.status(400).json({ success: false, message: 'Full name is required' });
      return;
    }
    const trimmedEmail = String(email || '').toLowerCase().trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      res.status(400).json({ success: false, message: 'A valid email address is required' });
      return;
    }
    if (!password || String(password).length < 8) {
      res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      return;
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [trimmedEmail]);
    if (existing.rows.length > 0) {
      res.status(400).json({ success: false, message: 'An account with that email already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(`
      INSERT INTO users (full_name, email, phone, password_hash, role, approval_status)
      VALUES ($1,$2,$3,$4,'waiter','pending')
      RETURNING id, full_name, email, approval_status
    `, [String(full_name).trim(), trimmedEmail, phone || null, passwordHash]);

    res.status(201).json({
      success: true,
      data: result.rows[0],
      message: "Account created. It's awaiting admin approval — you'll be able to log in once approved.",
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Requesting a reset NEVER reveals whether the email exists — the response
// is identical either way. Without this, the endpoint becomes a way to probe
// which email addresses have accounts (a real, common vulnerability class).
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  const genericMessage = "If an account exists for that email, we've sent a password reset code.";
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!email) {
      res.status(400).json({ success: false, message: 'Email is required' });
      return;
    }

    const result = await query('SELECT id, full_name, email, approval_status FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      res.json({ success: true, message: genericMessage });
      return;
    }
    const user = result.rows[0];
    // A pending/rejected account has no password worth resetting yet — still
    // return the generic message so this can't be used to distinguish
    // "no account" from "account exists but isn't approved".
    if (user.approval_status !== 'approved') {
      res.json({ success: true, message: genericMessage });
      return;
    }

    // A 6-digit code to type into a popup, not a link to click — the
    // token_hash column (and the reset flow it feeds into) is unchanged
    // underneath; only what gets generated and emailed here is different.
    // verifyResetOtp below "upgrades" this same row from a low-entropy
    // emailed code into a high-entropy one-time token once the code is
    // confirmed correct, and resetPassword only ever sees that upgraded
    // token — the emailed code itself is never enough to actually change
    // the password.
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Only one live reset request per user at a time.
    await query('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    await query(
      // The explicit ::timestamptz cast matters here: without it, node-postgres
      // serializes a JS Date parameter destined for a naive TIMESTAMP column
      // using raw UTC, ignoring the session's Africa/Nairobi pin entirely
      // (verified directly against Postgres). That silently stored expiry
      // times ~3 hours earlier than intended, making a valid code appear
      // expired well before it should. The cast forces Postgres to do the
      // timezone conversion itself, consistent with the pinned session, the
      // same way CURRENT_TIMESTAMP already is everywhere else.
      'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3::timestamptz)',
      [user.id, otpHash, expiresAt]
    );

    const { subject, htmlContent } = passwordResetOtpEmail(otp);

    try {
      await sendEmail({ to: user.email, toName: user.full_name, subject, htmlContent });
    } catch (emailErr) {
      // The code now exists in the DB whether or not the email actually
      // went out — surfacing the real failure here (rather than the
      // generic message) is deliberate: this is the one case where the
      // caller genuinely needs to know sending failed (e.g. Brevo not
      // configured), since silently saying "code sent" when it wasn't
      // would leave someone stuck with no way to reset their password at all.
      console.error('Failed to send password reset email:', emailErr);
      res.status(503).json({ success: false, message: emailErr instanceof Error ? emailErr.message : 'Failed to send reset email' });
      return;
    }

    res.json({ success: true, message: genericMessage });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Step two of the popup flow — verifies the emailed code and, only if
// correct, mints a fresh high-entropy one-time token (a different, much
// higher-entropy secret than the 6-digit code itself) that resetPassword
// below accepts to actually change the password. Keeping this as a
// separate step means the low-entropy emailed code is only ever used for
// verification, never for the state-changing action itself.
export const verifyResetOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      res.status(400).json({ success: false, message: 'email and otp are required' });
      return;
    }

    const userResult = await query('SELECT id, full_name FROM users WHERE email = $1', [String(email).toLowerCase().trim()]);
    if (!userResult.rows.length) {
      res.status(401).json({ success: false, message: 'Invalid or expired code' });
      return;
    }
    const user = userResult.rows[0];

    const otpHash = crypto.createHash('sha256').update(String(otp).trim()).digest('hex');
    const resetResult = await query(
      `SELECT * FROM password_resets WHERE user_id = $1 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (!resetResult.rows.length) {
      await logAuthEvent(req, 'password_reset_otp_failed', { email, userId: user.id, userName: user.full_name, reason: 'no_active_code' });
      res.status(401).json({ success: false, message: 'Invalid or expired code. Please request a new one.' });
      return;
    }
    const reset = resetResult.rows[0];

    if (reset.attempts >= 5) {
      await query('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = $1', [reset.id]);
      await logAuthEvent(req, 'password_reset_otp_failed', { email, userId: user.id, userName: user.full_name, reason: 'too_many_attempts' });
      res.status(401).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
      return;
    }

    if (otpHash !== reset.token_hash) {
      await query('UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1', [reset.id]);
      await logAuthEvent(req, 'password_reset_otp_failed', { email, userId: user.id, userName: user.full_name, reason: 'wrong_code' });
      res.status(401).json({ success: false, message: 'Incorrect code. Please try again.' });
      return;
    }

    // Correct code — "upgrade" this same row to a fresh, high-entropy
    // one-time token rather than marking it used yet. resetPassword needs
    // something to accept next; reusing the low-entropy 6-digit code for
    // that final step would leave the actual password-changing action
    // protected by only a million-ish possibilities instead of a proper
    // random token.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const newTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const newExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await query(
      'UPDATE password_resets SET token_hash = $1, expires_at = $2::timestamptz, attempts = 0 WHERE id = $3',
      [newTokenHash, newExpiresAt, reset.id]
    );
    await logAuthEvent(req, 'password_reset_otp_verified', { email, userId: user.id, userName: user.full_name });

    res.json({ success: true, reset_token: rawToken });
  } catch (error) {
    console.error('Verify reset OTP error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      res.status(400).json({ success: false, message: 'token and newPassword are required' });
      return;
    }
    if (String(newPassword).length < 8) {
      res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
      return;
    }

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const result = await query(
      `SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
      [tokenHash]
    );
    if (result.rows.length === 0) {
      res.status(400).json({ success: false, message: 'This reset session has expired. Please start over and request a new code.' });
      return;
    }
    const reset = result.rows[0];

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [passwordHash, reset.user_id]);
    await query('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = $1', [reset.id]);
    // Invalidate any other outstanding reset requests for this user — a
    // second, older reset attempt should stop working the moment one of
    // them is actually used.
    await query('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL', [reset.user_id]);
    await logAuthEvent(req, 'password_reset_via_email', { userId: reset.user_id });

    res.json({ success: true, message: 'Password reset — you can now log in with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query(
      'SELECT id, full_name, email, phone, role, status, schedule_type, avatar_url, joined_date, last_login, created_at FROM users WHERE id = $1',
      [req.user!.id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const changePassword = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ success: false, message: 'currentPassword and newPassword are required' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
      return;
    }
    if (currentPassword === newPassword) {
      res.status(400).json({ success: false, message: 'New password must be different from current password' });
      return;
    }

    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    const user = result.rows[0];

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      res.status(400).json({ success: false, message: 'Current password is incorrect' });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newHash, req.user!.id]);
    await logAudit(req, { action: 'password_changed', entityType: 'user', entityId: req.user!.id });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};