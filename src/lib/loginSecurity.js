/**
 * Sign-in defences: account lockout, session lifetime, and session revocation.
 *
 * ## Why lockout as well as rate limiting
 *
 * The login route is already rate limited, keyed on the connection and the email
 * being tried. That stops one machine hammering one account. It does not stop
 * somebody working through a pool of addresses, because each new address gets a
 * fresh allowance — and a residential proxy pool is cheap.
 *
 * Lockout moves the count onto the account, which is the thing actually under
 * attack. Ten wrong passwords for `supervisor@municipality.gov.za` is ten wrong
 * passwords however many places they came from.
 *
 * ## Why lockout is temporary
 *
 * A permanent lock turns a nuisance into an outage: anybody who knows an
 * official's email address could keep them signed out indefinitely, which is a
 * denial of service wearing a security feature's clothes. So the lock expires on
 * its own, and it lengthens with repeated rounds — long enough to make guessing
 * pointless, short enough that a real official who mistyped their password three
 * times is not waiting for a phone call.
 *
 * An administrator can also clear it immediately, because the person who has
 * actually been locked out is usually standing in front of one.
 *
 * ## What is deliberately not done
 *
 * The response never says whether the account exists. A locked-account message
 * shown before the password is checked would turn this into a way to enumerate
 * every official's email address, so the lock is reported the same way whether or
 * not the password was right, and only for accounts that genuinely exist and are
 * genuinely locked.
 */

/** Failures before the account locks. */
const THRESHOLD = Number(process.env.LOGIN_LOCKOUT_THRESHOLD || 5);

/** Base lock, in minutes. Doubles for each further round of failures. */
const BASE_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES || 15);

/** However many rounds, never longer than this. */
const MAX_MINUTES = Number(process.env.LOGIN_LOCKOUT_MAX_MINUTES || 120);

/**
 * A run of failures older than this is forgotten.
 *
 * Without it, five typos spread over a year would eventually lock an account, and
 * the count would mean nothing. Only a burst is evidence of an attack.
 */
const FORGET_AFTER_MINUTES = Number(process.env.LOGIN_ATTEMPT_WINDOW_MINUTES || 60);

const MINUTE = 60 * 1000;

/**
 * How long a token is valid for at most.
 *
 * The old default was seven days. For a system holding ID numbers, income
 * declarations and the coordinates of people's homes, a token copied off a shared
 * municipal computer should not still work next week. Eight hours covers a shift;
 * anybody still working signs in again.
 */
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 8);

/**
 * How long the portals wait before signing somebody out for doing nothing.
 *
 * Separate from the absolute lifetime above and enforced in the browser, because
 * the risk it addresses is physical: a front-desk terminal left logged in while
 * the officer helps somebody at the counter. The server cannot see an idle
 * browser; it can only cap the total.
 */
const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 20);

/** Minutes of warning before the idle timeout fires. */
const IDLE_WARNING_MINUTES = Number(process.env.SESSION_IDLE_WARNING_MINUTES || 2);

/** Whether a run of failures is recent enough to still count. */
function withinWindow(user, now = new Date()) {
  if (!user.lastFailedLoginAt) return false;
  return now.getTime() - new Date(user.lastFailedLoginAt).getTime() < FORGET_AFTER_MINUTES * MINUTE;
}

/** Whether this account is currently locked, and for how much longer. */
function lockState(user, now = new Date()) {
  if (!user?.lockedUntil) return { locked: false, minutesLeft: 0 };

  const until = new Date(user.lockedUntil);
  if (until <= now) return { locked: false, minutesLeft: 0, expired: true };

  return {
    locked: true,
    until,
    minutesLeft: Math.max(1, Math.ceil((until - now) / MINUTE)),
  };
}

/**
 * How long to lock for, given how many rounds this account has been through.
 *
 * Each completed round of THRESHOLD failures doubles the wait: 15 minutes, then
 * 30, then 60, capped. Somebody guessing gets a rapidly worsening return; the
 * official who mistyped twice never sees any of it.
 */
function lockMinutes(attempts) {
  const rounds = Math.max(1, Math.floor(attempts / THRESHOLD));
  return Math.min(MAX_MINUTES, BASE_MINUTES * 2 ** (rounds - 1));
}

/**
 * What to write after a failed attempt.
 *
 * Returns the update for the user row plus whether that failure locked the
 * account, so the caller can audit and notify without recomputing it.
 */
function registerFailure(user, now = new Date()) {
  // A stale run starts again from one rather than continuing an old count.
  const previous = withinWindow(user, now) ? user.failedLoginAttempts || 0 : 0;
  const attempts = previous + 1;

  const shouldLock = attempts >= THRESHOLD;
  const minutes = shouldLock ? lockMinutes(attempts) : 0;

  return {
    data: {
      failedLoginAttempts: attempts,
      lastFailedLoginAt: now,
      ...(shouldLock ? { lockedUntil: new Date(now.getTime() + minutes * MINUTE) } : {}),
    },
    locked: shouldLock,
    minutes,
    attempts,
    /**
     * Attempts left before the lock, for the warning shown to somebody who is
     * simply getting their own password wrong. Withheld once locked — counting
     * down out loud for an attacker tells them exactly where the line is.
     */
    remaining: Math.max(0, THRESHOLD - attempts),
  };
}

/** What to write after a successful sign-in: clear the run, record the visit. */
const registerSuccess = (req, now = new Date()) => ({
  failedLoginAttempts: 0,
  lockedUntil: null,
  lastFailedLoginAt: null,
  lastLoginAt: now,
  lastLoginIp: clientIp(req),
});

function clientIp(req) {
  if (!req) return null;
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

/**
 * Whether a token was issued before the password last changed.
 *
 * JWT `iat` is in whole seconds, so a token minted in the same second as the
 * change could otherwise be rejected by a fraction of a second. One second of
 * slack avoids signing somebody out of the session they just created by changing
 * their password.
 */
function issuedBeforePasswordChange(decoded, user) {
  if (!user?.passwordChangedAt || !decoded?.iat) return false;
  const changedAt = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
  return decoded.iat + 1 < changedAt;
}

/** Human wording for a locked account. Never says whether the password was right. */
const lockedMessage = (minutesLeft) =>
  `Too many failed sign-in attempts. This account is locked for ${minutesLeft} more `
  + `${minutesLeft === 1 ? 'minute' : 'minutes'}. If it was not you, contact the municipal administrator.`;

/** What the portals need in order to run the idle timer. Safe to publish. */
const policy = () => ({
  idleMinutes: IDLE_MINUTES,
  idleWarningMinutes: IDLE_WARNING_MINUTES,
  sessionHours: SESSION_HOURS,
  lockoutThreshold: THRESHOLD,
});

module.exports = {
  THRESHOLD,
  BASE_MINUTES,
  MAX_MINUTES,
  FORGET_AFTER_MINUTES,
  SESSION_HOURS,
  IDLE_MINUTES,
  IDLE_WARNING_MINUTES,
  lockState,
  lockMinutes,
  registerFailure,
  registerSuccess,
  issuedBeforePasswordChange,
  withinWindow,
  lockedMessage,
  clientIp,
  policy,
};
