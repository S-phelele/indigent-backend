require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');

const prisma = require('./lib/prisma');
const { globalLimiter } = require('./lib/rateLimit');
const sanitize = require('./lib/sanitize');
const respond = require('./lib/respond');
const slaMonitor = require('./lib/slaMonitor');
const authRoutes = require('./routes/auth');
const applicationRoutes = require('./routes/applications');
const adminRoutes = require('./routes/admin');
const documentRoutes = require('./routes/documents');
const notificationRoutes = require('./routes/notifications');
const geocodeRoutes = require('./routes/geocode');
const staffRoutes = require('./routes/staff');
const fieldworkRoutes = require('./routes/fieldwork');
const verificationRoutes = require('./routes/verification');
const householdRoutes = require('./routes/household');
const approvalRoutes = require('./routes/approvals');
const renewalRoutes = require('./routes/renewals');
const exportRoutes = require('./routes/documentsOut');
const privacyRoutes = require('./routes/privacy');
const renewal = require('./lib/renewal');
const retention = require('./lib/retention');
const loginSecurity = require('./lib/loginSecurity');

const app = express();
const PORT = process.env.PORT || 5000;

// --- Fail fast on an unsafe secret -----------------------------------------
// A placeholder JWT secret in production means anyone can mint a valid admin
// token. Refuse to start rather than run in that state.
const PLACEHOLDER_SECRETS = ['some-long-random-string', 'changeme', 'secret'];
if (!process.env.JWT_SECRET || PLACEHOLDER_SECRETS.includes(process.env.JWT_SECRET)) {
  const message = 'JWT_SECRET is missing or still set to a placeholder value.';
  if (process.env.NODE_ENV === 'production') {
    console.error(`FATAL: ${message} Generate one with: openssl rand -base64 48`);
    process.exit(1);
  }
  console.warn(`WARNING: ${message} This must be changed before deploying.`);
}

/**
 * JWT_EXPIRES_IN no longer does anything.
 *
 * Session length is set by SESSION_HOURS alone. Said out loud because a stale
 * `JWT_EXPIRES_IN=7d` in an existing .env is exactly the kind of setting an
 * operator would trust — and it was silently overriding the shorter default,
 * leaving tokens valid for a week on a system holding ID numbers.
 */
if (process.env.JWT_EXPIRES_IN) {
  console.warn(
    `WARNING: JWT_EXPIRES_IN is set to "${process.env.JWT_EXPIRES_IN}" but is no longer used. `
    + `Sessions last SESSION_HOURS (currently ${loginSecurity.SESSION_HOURS}h). Remove it from your .env.`
  );
}

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// --- Security headers -------------------------------------------------------
app.use(
  helmet({
    // The API serves JSON and file downloads, never HTML pages of its own, so the
    // default CSP is unnecessary. The download route sets its own restrictive one.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  })
);

// Behind a reverse proxy this is what makes req.ip the real client address —
// without it every request appears to come from the proxy and rate limiting
// would throttle all users as one.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 0));

// --- CORS -------------------------------------------------------------------
// An explicit allowlist. `origin: true` reflects whatever origin asks, which
// with credentials enabled is effectively no protection at all.
//
// Entries must carry a scheme. An `Origin` header is always `scheme://host[:port]`,
// so a bare `192.168.1.10:8081` can never match anything a client actually sends.
const allowedOrigins = (
  process.env.CORS_ORIGINS
  || 'http://localhost:5173,http://localhost:5174,http://localhost:8081'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * In development only, accept any origin on a private network.
 *
 * Expo serves its web build and its dev tooling from the laptop's LAN address,
 * and that address comes from DHCP — it changes. Pinning today's IP in the
 * allowlist means the setup breaks on the next lease, at which point somebody
 * pastes in a wildcard and never takes it out again.
 *
 * Restricted to the RFC 1918 ranges plus loopback, so it can only ever admit a
 * machine already on the same network, and switched off entirely in production:
 * a municipal server has no business trusting a caller merely for being nearby.
 */
const PRIVATE_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/;
const allowPrivateNetwork = process.env.NODE_ENV !== 'production';

app.use(
  cors({
    origin(origin, callback) {
      /**
       * No Origin at all: same-origin, curl, server-to-server — and every native
       * mobile request.
       *
       * React Native is not a browser and sends no Origin, so CORS never applies
       * to the Expo app on a device or emulator. A request from the app that is
       * failing is failing for another reason: the API address it was given, the
       * firewall, or Android refusing plain HTTP.
       */
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (allowPrivateNetwork && PRIVATE_ORIGIN.test(origin)) return callback(null, true);

      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

/**
 * Clean every string in every request body before any route sees it.
 *
 * Removes control characters and invisible bidirectional overrides, caps length,
 * and drops prototype-pollution keys. Route handlers still validate their own
 * fields — this only guarantees nothing pathological reaches them, and that a
 * name typed with a trailing space is stored the same way twice.
 */
app.use(sanitize.scrubBody);

app.use(globalLimiter);

// Uploaded files are intentionally NOT served statically — they contain ID copies
// and bank statements. Use GET /api/documents/file/:documentId, which authenticates
// and checks ownership before streaming.

// --- Routes -----------------------------------------------------------------
app.use('/api/auth', authRoutes);
// Mounted before the general applications router so /:id/household resolves
// here rather than falling into the wizard's /:id handler.
app.use('/api/applications', householdRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/renewals', renewalRoutes);
app.use('/api/export', exportRoutes);
// Partly public: the privacy notice must be readable before somebody registers.
app.use('/api/privacy', privacyRoutes);
// Mounted before the general admin router so its own paths win; admin.js has no
// /staff route, so order is defensive rather than load-bearing.
app.use('/api/admin/staff', staffRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/fieldwork', fieldworkRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/geocode', geocodeRoutes);

/**
 * Liveness plus a real dependency check. Returning 200 while Postgres is down
 * tells a load balancer to keep sending traffic to an instance that cannot serve it.
 */
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', message: 'Indigent Register API is running', database: 'connected' });
  } catch (error) {
    console.error('health check failed:', error.message);
    res.status(503).json({ status: 'degraded', message: 'Database unavailable', database: 'disconnected' });
  }
});

// --- 404 --------------------------------------------------------------------
// Without this, unmatched API routes fall through to Express's default HTML
// handler, so clients parsing JSON get markup instead.
//
// The response says nothing about which route was tried. Echoing the path back
// turns a 404 into a way to map the API by guessing at it.
app.use('/api', (req, res) => {
  console.warn(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, message: 'We could not find what you were looking for.' });
});

/**
 * Last-resort error handler.
 *
 * Anything reaching here is unexpected. The person gets a sentence and a short
 * reference; the console gets the route, the actor, the driver code and the
 * stack. Those are two different audiences and they must not be given the same
 * text — an error naming a table is a map of the database handed to anybody who
 * can send a malformed request.
 */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);

  if (err?.message === 'Not allowed by CORS') {
    console.warn(`[cors] refused origin ${req.headers.origin} on ${req.method} ${req.originalUrl}`);
    return res.status(403).json({ success: false, message: 'This request came from somewhere we do not recognise.' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'That is too large to send. Please reduce it and try again.' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'We could not read that request. Please try again.' });
  }

  // A 4xx thrown deliberately already carries a message meant for a person.
  const status = err.status || 500;
  if (status < 500) {
    return res.status(status).json({ success: false, message: err.message });
  }

  return respond.serverError(res, err, req, 'unhandled error');
});

/**
 * A crash must not take the register down silently.
 *
 * Logged loudly and left to the process manager to restart, rather than
 * swallowed — an instance that keeps running in an unknown state after an
 * unhandled rejection is worse than one that restarts.
 */
process.on('unhandledRejection', (reason) => {
  console.error('\n[FATAL] Unhandled promise rejection — this is a bug:\n', reason);
});
process.on('uncaughtException', (error) => {
  console.error('\n[FATAL] Uncaught exception:\n', error);
  shutdown('uncaughtException').finally(() => process.exit(1));
});

const server = app.listen(PORT, () => {
  console.log(`Indigent Register API running on http://localhost:${PORT}`);
  console.log(`CORS allowlist: ${allowedOrigins.join(', ')}`);
  if (allowPrivateNetwork) {
    // Said out loud so nobody mistakes a development convenience for the
    // production posture, and so a stray NODE_ENV is obvious at a glance.
    console.log('CORS: also accepting any private-network origin (development only)');
  }
  // Mobile devices reach the API on the LAN address, not localhost, and this is
  // the setting people most often get wrong when the app "cannot connect".
  console.log(`Mobile app should use: http://<this-machine-lan-ip>:${PORT}/api`);
});

// A breach is caused by the absence of action, so nothing in the request path
// can detect it. This is the only notification that needs a timer.
const stopSlaMonitor = slaMonitor.schedule();

// Registrations expire on a date nobody watches, so the sweep has to.
const stopRenewalMonitor = renewal.schedule();

// POPIA s14: information stops being needed on a date, not on a request. Reports
// what is overdue; only removes it if RETENTION_AUTO_APPLY is explicitly on.
const stopRetentionSweep = retention.schedule();

// --- Graceful shutdown ------------------------------------------------------
// Finish in-flight requests and close the connection pool, so deploys and
// restarts do not sever open uploads or leak Postgres connections.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);

  const force = setTimeout(() => {
    console.error('Shutdown timed out; forcing exit');
    process.exit(1);
  }, 10000).unref();

  stopSlaMonitor();
  stopRenewalMonitor();
  stopRetentionSweep();

  server.close(async () => {
    try {
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error disconnecting Prisma:', error.message);
    }
    clearTimeout(force);
    process.exit(0);
  });
}

['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => shutdown(signal)));

module.exports = { app, server };
