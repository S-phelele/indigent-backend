const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

/**
 * Rate limiters.
 *
 * Without these the OTP routes are the weakest point in the system: a six-digit
 * code with unlimited attempts is exhaustible in minutes, and an unauthenticated
 * send-otp endpoint is both an SMS bomb and a direct cost to the municipality
 * once a real gateway is connected.
 *
 * ## Keying, and why it matters here
 *
 * The default key is the client IP. On a municipal system that is wrong in a
 * specific and damaging way: an entire township on one carrier NAT, or every
 * terminal in a municipal office, shares an address. Limiting those as one
 * client means the tenth person to walk up to the counter is told to come back
 * in fifteen minutes.
 *
 * So authenticated traffic is keyed by user, and only anonymous traffic falls
 * back to the address. Credential endpoints stay on the address on purpose —
 * that is exactly where somebody unauthenticated is guessing.
 *
 * Limits are disabled under NODE_ENV=test so the suite is not throttled.
 */

const DISABLED = process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT === 'true';

const passthrough = (req, res, next) => next();

/**
 * One office behind one address must not throttle as one person.
 *
 * Anonymous traffic falls back to the address, normalised through the library's
 * `ipKeyGenerator`. That helper collapses an IPv6 address to its /64 prefix —
 * without it, a client on IPv6 can vary the low bits of their own address freely
 * and step around every limit here.
 */
const ipKey = (req) => ipKeyGenerator(req.ip);
const byUserThenIp = (req) => (req.user?.id ? `u:${req.user.id}` : `ip:${ipKey(req)}`);

function make({ windowMs, limit, message, keyGenerator, skip }) {
  if (DISABLED) return passthrough;
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    skip,
    // Never leak whether the limit was hit for a valid or invalid identity.
    handler: (req, res) => {
      // Worth seeing in the log: a limit firing repeatedly is either an attack
      // or a limit set too low for real use, and the two look different here.
      console.warn(`[ratelimit] ${req.method} ${req.originalUrl} blocked for ${byUserThenIp(req)}`);
      res.status(429).json({ success: false, message });
    },
  });
}

/**
 * Everything else — a backstop against runaway clients.
 *
 * Keyed per user, so a busy municipal office does not exhaust one shared budget.
 * Staff get a much higher ceiling than the public: a reviewer working a queue
 * legitimately makes hundreds of requests an hour, and an applicant filling in
 * one form does not.
 */
const globalLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  keyGenerator: byUserThenIp,
  message: 'Too many requests. Please slow down and try again shortly.',
  // The health check is polled by load balancers and must never be throttled,
  // or an instance gets pulled out of service for being monitored.
  skip: (req) => req.path === '/api/health',
});

/**
 * Staff working a queue.
 *
 * Applied after authentication on the staff routers, where the identity is
 * known, so this is a per-person ceiling rather than a per-office one.
 */
const staffLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 2000,
  keyGenerator: byUserThenIp,
  message: 'You are making requests unusually quickly. Please wait a moment.',
});

/**
 * Credential endpoints. Slow enough to make stuffing impractical.
 *
 * Keyed by address AND by the identity being attempted, so guessing many
 * passwords against one account is limited even from a rotating address pool,
 * and one person failing to sign in does not lock out everybody else in their
 * building.
 */
const loginLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `${ipKey(req)}:${String(req.body?.email || '').toLowerCase().slice(0, 80)}`,
  message: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
});

const registerLimiter = make({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: 'Too many accounts created from this connection. Please try again later.',
});

/** Sending costs money once an SMS gateway exists — keep it tight. */
const otpSendLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => `${ipKey(req)}:${String(req.body?.cellNumber || '').replace(/\D/g, '').slice(-9)}`,
  message: 'Too many verification codes requested. Please wait 15 minutes before requesting another.',
});

/**
 * Verification attempts. This is the second line of defence — the per-code
 * attempt counter in lib/otp.js is the first, and stops a single code being
 * walked through even from many addresses.
 */
const otpVerifyLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  message: 'Too many verification attempts. Please request a new code and try again later.',
});

/**
 * Address lookup. Generous enough for someone typing and re-searching, tight
 * enough that the proxy is not worth abusing — and, with Nominatim, that the
 * municipality does not get blocked for exceeding its usage policy.
 */
const geocodeLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  keyGenerator: byUserThenIp,
  message: 'Too many address lookups. Please wait a few minutes, or type your address manually.',
});

const passwordResetLimiter = make({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => `${ipKey(req)}:${String(req.body?.email || '').toLowerCase().slice(0, 80)}`,
  message: 'Too many password reset requests. Please try again later.',
});

/**
 * File uploads.
 *
 * Each one costs disk and a content sniff. Ten megabytes times an unbounded
 * request rate is the cheapest way to fill the server's disk.
 */
const uploadLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  keyGenerator: byUserThenIp,
  message: 'Too many uploads at once. Please wait a moment and try again.',
});

/** Exports scan and serialise thousands of rows; they are not a page view. */
const exportLimiter = make({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator: byUserThenIp,
  message: 'Too many exports requested. Please wait before generating another.',
});

module.exports = {
  ipKey,
  globalLimiter,
  staffLimiter,
  loginLimiter,
  registerLimiter,
  otpSendLimiter,
  otpVerifyLimiter,
  passwordResetLimiter,
  geocodeLimiter,
  uploadLimiter,
  exportLimiter,
  byUserThenIp,
  DISABLED,
};
