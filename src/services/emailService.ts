// Thin wrapper around Brevo's (formerly Sendinblue) transactional email
// REST API. Only password reset uses this today, but any future
// transactional email (approval notifications, receipts by email, etc.)
// should go through this same function rather than each caller reimplementing
// the HTTP call.
//
// Fails the same way mpesaController's Daraja calls do: check configuration
// at CALL time (not at server startup) and throw a clear, specific error
// naming exactly which env vars are missing, so a misconfigured deployment
// gets a readable 503 instead of a mysterious 500 or a silent no-op.

interface SendEmailParams {
  to: string;
  toName?: string;
  subject: string;
  htmlContent: string;
}

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

export const sendEmail = async ({ to, toName, subject, htmlContent }: SendEmailParams): Promise<void> => {
  const apiKey = process.env.BREVO_API_KEY || '';
  // Accept either naming convention — BREVO_SENDER_EMAIL/NAME or
  // BREVO_FROM_EMAIL/NAME both describe the same thing, and someone
  // reasonably configuring one instead of the other shouldn't be treated
  // as a misconfiguration.
  const senderEmail = process.env.BREVO_SENDER_EMAIL || process.env.BREVO_FROM_EMAIL || '';
  const senderName = process.env.BREVO_SENDER_NAME || process.env.BREVO_FROM_NAME || "Shawal's Deli";

  const missing: string[] = [];
  if (!apiKey) missing.push('BREVO_API_KEY');
  if (!senderEmail) missing.push('BREVO_SENDER_EMAIL (or BREVO_FROM_EMAIL)');
  if (missing.length > 0) {
    throw new Error(`Email sending is not configured. Missing: ${missing.join(', ')}`);
  }

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to, name: toName || to }],
      subject,
      htmlContent,
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    console.error('Brevo send failed:', res.status, bodyText);
    // Brevo's error responses are JSON with a human-readable `message` field
    // (e.g. "Sender not valid" when the sender email isn't verified in the
    // Brevo dashboard yet — the single most common first-time setup issue).
    // Surfacing that specific reason instead of a generic "rejected" message
    // is the difference between someone being able to fix this themselves
    // and being stuck guessing.
    let reason = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      reason = parsed.message || parsed.code || bodyText;
    } catch { /* body wasn't JSON — fall back to the raw text */ }
    throw new Error(`Brevo rejected the email${reason ? `: ${reason}` : ''} (HTTP ${res.status}). If this says the sender isn't valid, verify ${senderEmail} as a sender in your Brevo dashboard under Senders & IP.`);
  }
};

// Login OTP email — the second factor after a correct email/password.
// Short, deliberately plain (a code to type, not a link to click), since
// this needs to be readable at a glance on a phone while someone's
// standing at a POS terminal waiting to get in.
export const loginOtpEmail = (otp: string): { subject: string; htmlContent: string } => ({
  subject: `${otp} is your Shawal's Deli login code`,
  htmlContent: `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #111;">
      <h2 style="color: #F5A300;">Shawal's Deli</h2>
      <p>Someone is trying to log in to your account. Enter this code to continue:</p>
      <p style="font-size: 32px; font-weight: 800; letter-spacing: 6px; text-align: center; background: #F9FAFB; border-radius: 8px; padding: 16px; margin: 16px 0;">${otp}</p>
      <p style="color: #555; font-size: 13px;">This code expires in 5 minutes. If you didn't try to log in, you can safely ignore this email — your account is still secure and no one can get in without this code.</p>
    </div>
  `,
});

// Password reset code email — a code to type into a popup, not a link to
// click. Kept as its own template (distinct wording from loginOtpEmail)
// so the email itself is unambiguous about which flow triggered it.
export const passwordResetOtpEmail = (otp: string): { subject: string; htmlContent: string } => ({
  subject: `${otp} is your Shawal's Deli password reset code`,
  htmlContent: `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #111;">
      <h2 style="color: #F5A300;">Shawal's Deli</h2>
      <p>Someone requested a password reset for your account. Enter this code to continue:</p>
      <p style="font-size: 32px; font-weight: 800; letter-spacing: 6px; text-align: center; background: #F9FAFB; border-radius: 8px; padding: 16px; margin: 16px 0;">${otp}</p>
      <p style="color: #555; font-size: 13px;">This code expires in 10 minutes. If you didn't request a password reset, you can safely ignore this email — your password hasn't been changed.</p>
    </div>
  `,
});