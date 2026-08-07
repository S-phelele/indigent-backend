const crypto = require('crypto');

/**
 * What we say to people, and what we say to ourselves.
 *
 * These are two different audiences and they need two different messages.
 *
 * **The applicant** is often anxious, sometimes reading on a borrowed phone, and
 * frequently not a native English speaker. "500 Internal Server Error",
 * "ERR_CONSTRAINT_VIOLATION" and "Invalid payload" tell them nothing except that
 * they have done something wrong — which, usually, they have not. They get a
 * sentence in plain language saying what happened and what to do next.
 *
 * **The developer** needs the opposite: the route, the actor, the stack, and the
 * real driver error. That goes to the server console and nowhere near the
 * response, because an error message that names a table is a map of the database
 * handed to anybody who can type a malformed request.
 *
 * The two are tied together by a short reference printed in both. Somebody phones
 * the municipality quoting "ERR-7F3A2B", and that string is greppable in the
 * logs. Without it, "it said something went wrong" is unactionable.
 */

/** Short, readable, and not guessable enough to be worth enumerating. */
const newRef = () => `ERR-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

/**
 * Plain-language equivalents for the failures a person can actually cause.
 *
 * Anything not in this map is treated as our fault, not theirs, and says so.
 */
const HUMAN = {
  UNAUTHENTICATED: 'Please sign in to continue.',
  SESSION_EXPIRED: 'Your session has ended. Please sign in again.',
  FORBIDDEN: 'You do not have access to this.',
  NOT_FOUND: 'We could not find that.',
  VALIDATION: 'Some of the details need correcting.',
  CONFLICT: 'That has already been done.',
  TOO_LARGE: 'That file is too big. The limit is 10 MB.',
  RATE_LIMITED: 'You have tried that too many times. Please wait a few minutes and try again.',
  UNAVAILABLE: 'This service is temporarily unavailable. Please try again shortly.',
  SERVER: 'Something went wrong on our side. Please try again in a moment.',
};

/**
 * Translate a database or driver error into something a person can read.
 *
 * Prisma's codes are precise and completely opaque to anybody outside this
 * codebase. P2002 means a unique constraint was violated; to an applicant it
 * means "that ID number is already registered", which is actionable.
 */
function humanisePrisma(error) {
  switch (error?.code) {
    case 'P2002': {
      const field = error.meta?.target?.[0];
      const NAMES = {
        email: 'That email address is already registered.',
        idNumber: 'That ID number is already registered.',
        reference: 'That reference is already in use.',
      };
      return NAMES[field] || 'That record already exists.';
    }
    case 'P2003':
      return 'That cannot be saved because something it depends on is missing.';
    case 'P2025':
      return 'We could not find that — it may have been removed already.';
    case 'P2000':
      return 'One of the values you entered is too long.';
    default:
      return null;
  }
}

/**
 * Log the developer's version.
 *
 * Deliberately verbose and deliberately server-side. Includes who was acting and
 * what they were doing, because "TypeError: cannot read property id of undefined"
 * without a route is a needle in a haystack at three in the afternoon when the
 * counter is full.
 */
function logForDeveloper(ref, error, req, context) {
  const who = req?.user ? `${req.user.role} ${req.user.id} (${req.user.email})` : 'anonymous';
  const where = req ? `${req.method} ${req.originalUrl}` : 'no request';

  console.error(
    `\n[${ref}] ${context || 'unhandled'}\n`
    + `  where : ${where}\n`
    + `  who   : ${who}\n`
    + `  ip    : ${req?.ip || 'unknown'}\n`
    + `  error : ${error?.name || 'Error'}: ${error?.message}\n`
    + (error?.code ? `  code  : ${error.code}\n` : '')
    + (error?.meta ? `  meta  : ${JSON.stringify(error.meta)}\n` : '')
    + (error?.stack ? `  stack : ${error.stack.split('\n').slice(1, 5).join('\n          ')}\n` : '')
  );
}

/** A successful response, in one shape everywhere. */
const ok = (res, data, message) => res.json({ success: true, ...(message ? { message } : {}), data });

const created = (res, data, message, extra = {}) =>
  res.status(201).json({ success: true, message, data, ...extra });

/**
 * A failure the caller can do something about.
 *
 * `message` is shown to them verbatim, so it must be a sentence, not a code.
 * Nothing is logged: a rejected password or a duplicate ID is the system working,
 * not an incident.
 */
function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

const badRequest = (res, message, extra) => fail(res, 400, message, extra);
const forbidden = (res, message) => fail(res, 403, message || HUMAN.FORBIDDEN);
const notFound = (res, message) => fail(res, 404, message || HUMAN.NOT_FOUND);
const conflict = (res, message, extra) => fail(res, 409, message, extra);

/**
 * A failure that is ours.
 *
 * The person gets an apology and a reference. The console gets everything.
 */
function serverError(res, error, req, context) {
  const ref = newRef();
  logForDeveloper(ref, error, req, context);

  const humanised = humanisePrisma(error);
  return res.status(500).json({
    success: false,
    message: humanised
      ? humanised
      : `${HUMAN.SERVER} If it keeps happening, quote reference ${ref} to your municipal office.`,
    reference: ref,
  });
}

/**
 * Wrap an async route so a thrown error cannot become an unhandled rejection.
 *
 * Express 4 does not catch rejected promises from async handlers: without this,
 * a route that throws leaves the request hanging until the client times out —
 * which reads to the applicant as the site being broken, and leaves nothing in
 * the log to explain it.
 *
 *   router.get('/thing', handler(async (req, res) => { ... }))
 */
const handler = (fn, context) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((error) => {
    if (res.headersSent) return next(error);
    serverError(res, error, req, context || `${req.method} ${req.route?.path || req.originalUrl}`);
  });

module.exports = {
  HUMAN,
  ok,
  created,
  fail,
  badRequest,
  forbidden,
  notFound,
  conflict,
  serverError,
  handler,
  logForDeveloper,
  humanisePrisma,
  newRef,
};
