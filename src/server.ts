import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';
import dotenv from 'dotenv';
import routes from './routes';
import { errorHandler, notFound } from './middleware/errorHandler';
import { sweepExpiredMpesaPayments } from './controllers/mpesaController';

dotenv.config();

// ── Fail fast on missing critical config ────────────────────────────────────
// These are checked at startup rather than at the moment they're used, so
// a misconfigured deployment fails loudly at boot instead of signing tokens
// with a known fallback secret or silently breaking M-Pesa payments.
const REQUIRED_ENV = ['JWT_SECRET', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`❌  Server refuses to start — missing required environment variables: ${missingEnv.join(', ')}`);
  console.error('    Copy .env.example to .env and fill in all required values.');
  process.exit(1);
}

if ((process.env.JWT_SECRET || '').length < 32) {
  console.error('❌  JWT_SECRET must be at least 32 characters long. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;

// Security
// Cross-Origin-Resource-Policy defaults to 'same-origin' under helmet,
// which silently blocks the BROWSER from actually displaying anything
// this server returns (menu images, receipts, sick-off documents) once
// requested from a different origin — even though the HTTP request itself
// still succeeds with a 200. That's exactly this app's real deployment
// shape: frontend and backend are two separate Railway services on two
// separate domains by design, not an accident to lock down against.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

// Rate limiting
// Health checks are exempt — skip, not just a route registered later,
// because /api/ here is a prefix match that would otherwise catch
// /api/health regardless of where its own route handler is declared below.
// A liveness/heartbeat endpoint that can itself be rate-limited is a trap:
// the frontend's useOnlineStatus hook polls /api/health every 5s (plus
// Dashboard's 30s poll, OrdersPage's 30s refund-request poll, and ordinary
// clicking around during dev — all from one IP on localhost), so normal
// active testing alone can cross 500 requests/15min. Once that happened,
// EVERY subsequent health check for the rest of that window also got
// rate-limited, which the frontend correctly reads as "backend
// unreachable" — a persistent, self-sustaining "Offline" that only ever
// cleared when the 15-minute window rolled over. Nothing was actually
// wrong with the connection; the health check was rate-limiting itself.
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  // 500/15min (~33/min) turned out to be too tight for how this app
  // actually behaves: the Dashboard's 30s auto-refresh poll, the Orders
  // page's 30s refund-request poll, and ordinary navigation (most pages
  // fire 5-10 parallel requests on load — auth check, settings, the page's
  // own data) all draw from the same budget, and on localhost every one of
  // those comes from a single IP. A single person actively working the app
  // for 15 minutes was enough to trip it, at which point every request —
  // not just polling — started getting rejected with 429 until the window
  // rolled over. 2000/15min (~133/min) gives normal single-restaurant use
  // (even several tills/tablets on one shared IP at a physical location)
  // comfortable headroom while still blocking a real flood/abuse pattern.
  max: 2000,
  // req.path is relative to this middleware's '/api/' mount point, so a
  // request to /api/health arrives here as '/health'.
  skip: (req) => req.path === '/health',
}));

// Tighter limit on auth endpoints to prevent credential stuffing / brute force.
// 10 attempts per 15 minutes per IP is generous for a POS (cashiers log in
// once at shift start) but still blocks automated attacks.
app.use('/api/auth/setup', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many attempts. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Please wait 15 minutes before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// Self-service signup — generous enough for a real new hire but not for
// spinning up a flood of pending accounts.
app.use('/api/auth/register', rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many signup attempts from this network. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// forgot-password already replies with the same generic message whether or
// not the account exists, so this isn't primarily about email enumeration —
// it's about not letting someone repeatedly trigger reset emails at a real
// user as harassment, and not burning through the transactional email
// provider's quota.
app.use('/api/auth/forgot-password', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many password reset requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use('/api/auth/verify-reset-otp', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { success: false, message: 'Too many attempts. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use('/api/auth/reset-password', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many attempts. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// A 6-digit OTP has a million possible values — the per-code attempt cap
// in verifyLoginOtp (5 wrong guesses burns that specific code) is the
// first brake; this is the second, limiting how many different codes/login
// attempts one client can even try in a window regardless of which code
// they're currently guessing against.
app.use('/api/auth/verify-otp', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { success: false, message: 'Too many attempts. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(compression());

// Logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

// Static files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: "Shawal's Deli API" });
});

// Same check, also reachable under /api — the frontend's offline-detection
// heartbeat (useOnlineStatus) hits this one specifically rather than the
// bare /health above. Every other request this app makes already goes
// through /api and is proven to reach the backend correctly in whatever
// way this gets deployed (same-origin reverse proxy, or otherwise); a
// brand-new top-level path would need its own separate proxy/CORS rule
// that isn't guaranteed to exist wherever this actually runs. Registered
// before the main router is mounted so there's no ambiguity about it ever
// being shadowed by anything inside `routes`.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: "Shawal's Deli API" });
});

// API routes
app.use('/api', routes);

// Error handling
app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Shawal's Deli API running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);

  // Catch M-Pesa STK pushes that never got a Safaricom callback (network
  // issue, customer ignored the prompt) and the cashier never manually
  // re-checked. Every 30s is frequent enough that a stuck order doesn't sit
  // in 'awaiting_payment' for long, cheap enough that it's a non-issue at
  // this scale (single WHERE-indexed query against a small pending set).
  setInterval(() => {
    sweepExpiredMpesaPayments().catch(err => console.error('M-Pesa sweep job error:', err));
  }, 30_000);
});

export default app;