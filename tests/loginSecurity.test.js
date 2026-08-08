const test = require('node:test');
const assert = require('node:assert/strict');

const login = require('../src/lib/loginSecurity');

const MINUTE = 60 * 1000;
const NOW = new Date('2026-08-08T12:00:00.000Z');
const minutesAgo = (n) => new Date(NOW.getTime() - n * MINUTE);
const minutesAhead = (n) => new Date(NOW.getTime() + n * MINUTE);

// ---------------------------------------------------------------------------
// Counting failures
// ---------------------------------------------------------------------------

test('the first failure counts one and does not lock', () => {
  const failure = login.registerFailure({ failedLoginAttempts: 0, lastFailedLoginAt: null }, NOW);
  assert.equal(failure.attempts, 1);
  assert.equal(failure.locked, false);
  assert.equal(failure.data.lockedUntil, undefined);
});

test('failures accumulate while the run is fresh', () => {
  const failure = login.registerFailure(
    { failedLoginAttempts: 2, lastFailedLoginAt: minutesAgo(5) },
    NOW
  );
  assert.equal(failure.attempts, 3);
});

test('a stale run starts again from one', () => {
  // Five typos spread over a year must not eventually lock an account. Only a
  // burst is evidence of anything.
  const failure = login.registerFailure(
    { failedLoginAttempts: 4, lastFailedLoginAt: minutesAgo(login.FORGET_AFTER_MINUTES + 1) },
    NOW
  );
  assert.equal(failure.attempts, 1);
  assert.equal(failure.locked, false);
});

test('reaching the threshold locks the account', () => {
  const failure = login.registerFailure(
    { failedLoginAttempts: login.THRESHOLD - 1, lastFailedLoginAt: minutesAgo(1) },
    NOW
  );
  assert.equal(failure.locked, true);
  assert.ok(failure.data.lockedUntil > NOW);
  assert.equal(failure.minutes, login.BASE_MINUTES);
});

test('the lock lengthens with each further round', () => {
  // A guesser gets a rapidly worsening return; somebody who mistyped twice never
  // reaches any of this.
  assert.equal(login.lockMinutes(login.THRESHOLD), login.BASE_MINUTES);
  assert.equal(login.lockMinutes(login.THRESHOLD * 2), login.BASE_MINUTES * 2);
  assert.equal(login.lockMinutes(login.THRESHOLD * 3), login.BASE_MINUTES * 4);
});

test('the lock is capped however many rounds there have been', () => {
  // Uncapped doubling reaches years, which is a permanent lock by accident — and
  // a permanent lock is a denial of service anybody can trigger with an email
  // address.
  assert.equal(login.lockMinutes(login.THRESHOLD * 50), login.MAX_MINUTES);
});

test('attempts remaining is reported until the threshold, then withheld', () => {
  const early = login.registerFailure({ failedLoginAttempts: 0, lastFailedLoginAt: null }, NOW);
  assert.equal(early.remaining, login.THRESHOLD - 1);

  const locked = login.registerFailure(
    { failedLoginAttempts: login.THRESHOLD - 1, lastFailedLoginAt: minutesAgo(1) },
    NOW
  );
  // Counting down out loud past the line would tell an attacker exactly where it is.
  assert.equal(locked.remaining, 0);
});

// ---------------------------------------------------------------------------
// Lock state
// ---------------------------------------------------------------------------

test('an account with no lock is not locked', () => {
  assert.equal(login.lockState({ lockedUntil: null }, NOW).locked, false);
  assert.equal(login.lockState({}, NOW).locked, false);
  assert.equal(login.lockState(null, NOW).locked, false);
});

test('a lock in the future is a lock', () => {
  const state = login.lockState({ lockedUntil: minutesAhead(10) }, NOW);
  assert.equal(state.locked, true);
  assert.equal(state.minutesLeft, 10);
});

test('a lock in the past has expired', () => {
  // Locks clear on their own. Nothing has to run to release them, because a job
  // that fails to run would leave people locked out indefinitely.
  const state = login.lockState({ lockedUntil: minutesAgo(1) }, NOW);
  assert.equal(state.locked, false);
  assert.equal(state.expired, true);
});

test('a lock with seconds left still reads as one minute', () => {
  // Rounding to zero would render as "locked for 0 more minutes", which reads as
  // not locked at all.
  const state = login.lockState({ lockedUntil: new Date(NOW.getTime() + 5000) }, NOW);
  assert.equal(state.locked, true);
  assert.equal(state.minutesLeft, 1);
});

test('the locked message says how long and what to do', () => {
  const message = login.lockedMessage(15);
  assert.match(message, /15 more minutes/);
  assert.match(message, /administrator/);
  // It must never confirm whether the password was right — that would make this a
  // way to test guesses against a locked account.
  assert.doesNotMatch(message, /password (is|was) correct/i);
});

test('the message uses the singular for one minute', () => {
  assert.match(login.lockedMessage(1), /1 more minute\b/);
});

// ---------------------------------------------------------------------------
// Success clears the run
// ---------------------------------------------------------------------------

test('signing in clears the failure count and the lock', () => {
  const data = login.registerSuccess({ ip: '10.0.0.5', headers: {} }, NOW);
  assert.equal(data.failedLoginAttempts, 0);
  assert.equal(data.lockedUntil, null);
  assert.equal(data.lastFailedLoginAt, null);
  assert.equal(data.lastLoginAt, NOW);
});

test('the sign-in address is recorded so an unexpected one can be spotted', () => {
  const data = login.registerSuccess({ ip: '10.0.0.5', headers: {} }, NOW);
  assert.equal(data.lastLoginIp, '10.0.0.5');
});

test('a proxied address is taken from the forwarded header', () => {
  const data = login.registerSuccess(
    { ip: '172.16.0.1', headers: { 'x-forwarded-for': '41.13.2.9, 172.16.0.1' } },
    NOW
  );
  // Behind a load balancer req.ip is the balancer, which would record the same
  // address for every user in the country.
  assert.equal(data.lastLoginIp, '41.13.2.9');
});

// ---------------------------------------------------------------------------
// Session revocation on password change
// ---------------------------------------------------------------------------

const secondsFor = (date) => Math.floor(date.getTime() / 1000);

test('a token issued before the password changed is stale', () => {
  const stale = login.issuedBeforePasswordChange(
    { iat: secondsFor(minutesAgo(30)) },
    { passwordChangedAt: minutesAgo(5) }
  );
  assert.equal(stale, true);
});

test('a token issued after the password changed is fine', () => {
  const stale = login.issuedBeforePasswordChange(
    { iat: secondsFor(NOW) },
    { passwordChangedAt: minutesAgo(5) }
  );
  assert.equal(stale, false);
});

test('a token minted in the same second as the change survives', () => {
  // Without a second of slack, changing a password would invalidate the token
  // issued to replace it, and the person would be signed out of the change they
  // just made.
  const at = new Date('2026-08-08T12:00:00.400Z');
  const stale = login.issuedBeforePasswordChange({ iat: secondsFor(at) }, { passwordChangedAt: at });
  assert.equal(stale, false);
});

test('an account that has never changed its password revokes nothing', () => {
  assert.equal(login.issuedBeforePasswordChange({ iat: secondsFor(NOW) }, { passwordChangedAt: null }), false);
  assert.equal(login.issuedBeforePasswordChange({ iat: secondsFor(NOW) }, {}), false);
});

test('a token with no issued-at claim is not treated as stale here', () => {
  // Rejecting it here would be the wrong place: a token without iat fails
  // signature verification first, and guessing at intent in this function would
  // hide that.
  assert.equal(login.issuedBeforePasswordChange({}, { passwordChangedAt: NOW }), false);
});

// ---------------------------------------------------------------------------
// The published policy
// ---------------------------------------------------------------------------

test('the policy the portals receive carries no secrets', () => {
  const policy = login.policy();
  assert.ok(policy.idleMinutes > 0);
  assert.ok(policy.sessionHours > 0);
  assert.ok(policy.idleWarningMinutes > 0);
  // Nothing here should reveal anything an attacker could not measure anyway.
  assert.deepEqual(
    Object.keys(policy).sort(),
    ['idleMinutes', 'idleWarningMinutes', 'lockoutThreshold', 'sessionHours']
  );
});

test('the warning fires before the timeout, not at it', () => {
  const policy = login.policy();
  assert.ok(
    policy.idleWarningMinutes < policy.idleMinutes,
    'a warning at or after the timeout would never be seen'
  );
});

test('the session cap is short enough to matter', () => {
  // The old default was seven days. A token copied off a shared municipal
  // computer should not still work next week.
  assert.ok(login.SESSION_HOURS <= 24, `session lasts ${login.SESSION_HOURS}h, which is too long for this data`);
});

test('the failure window is longer than the base lock', () => {
  // Otherwise a run would be forgotten while the account was still locked for it,
  // and the second round would restart at one rather than escalating.
  assert.ok(login.FORGET_AFTER_MINUTES >= login.BASE_MINUTES);
});
