const test = require('node:test');
const assert = require('node:assert/strict');

const submission = require('../src/lib/submission');
const { requireCellVerified } = require('../src/middleware/auth');

/**
 * Verification moved out of the application wizard and onto the account.
 *
 * Two things are being protected here. First, that an application cannot reach
 * an approval queue with a number nobody proved — the municipality answers by
 * SMS, so an unverified number is a decision that never arrives. Second, that a
 * verification recorded against an application stays true afterwards, which is
 * what lets an auditor ask whether the number was confirmed at the moment the
 * money was approved.
 */

const run = (req) => {
  let nexted = false;
  let status = null;
  let body = null;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  requireCellVerified(req, res, () => { nexted = true; });
  return { nexted, status, body };
};

const applicant = (over = {}) => ({ role: 'APPLICANT', isVerified: false, ...over });

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('an unverified applicant cannot start an application', () => {
  const out = run({ user: applicant(), method: 'POST', originalUrl: '/api/applications' });
  assert.equal(out.nexted, false);
  assert.equal(out.status, 403);
  assert.equal(out.body.code, 'CELL_VERIFICATION_REQUIRED');
});

test('an unverified applicant cannot submit one either', () => {
  const out = run({ user: applicant(), method: 'POST', originalUrl: '/api/applications/abc/submit' });
  assert.equal(out.nexted, false);
  assert.equal(out.status, 403);
});

test('a verified applicant passes', () => {
  const out = run({ user: applicant({ isVerified: true }), method: 'POST', originalUrl: '/api/applications' });
  assert.equal(out.nexted, true);
});

test('the routes that let somebody out of the gate are not behind it', () => {
  // Otherwise an applicant who mistyped their number is stranded: they cannot
  // request a code, cannot enter one, and cannot correct the number.
  const allowed = [
    ['POST', '/api/auth/send-otp'],
    ['POST', '/api/auth/verify-otp'],
    ['PATCH', '/api/auth/me'],
    ['GET', '/api/auth/me'],
    ['POST', '/api/auth/change-password'],
    ['POST', '/api/auth/logout'],
  ];
  for (const [method, originalUrl] of allowed) {
    const out = run({ user: applicant(), method, originalUrl });
    assert.equal(out.nexted, true, `${method} ${originalUrl} must be reachable while unverified`);
  }
});

test('a query string does not smuggle a request past the gate', () => {
  const out = run({ user: applicant(), method: 'POST', originalUrl: '/api/applications?x=1' });
  assert.equal(out.nexted, false);
});

test('the method has to match, not just the path', () => {
  // GET /api/auth/me is allowed; DELETE on the same path is not on the list.
  const out = run({ user: applicant(), method: 'DELETE', originalUrl: '/api/auth/me' });
  assert.equal(out.nexted, false);
});

test('staff are not gated on an SMS', () => {
  for (const role of ['ADMIN', 'SUPERUSER', 'COUNCILLOR', 'VERIFICATION_OFFICER', 'ASSESSMENT_OFFICER', 'SUPERVISOR', 'CAPTURE_OFFICER']) {
    const out = run({ user: { role, isVerified: false }, method: 'GET', originalUrl: '/api/admin/applications' });
    assert.equal(out.nexted, true, `${role} must not be held behind cell verification`);
  }
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

const ready = (over = {}) => ({
  surname: 'Mthembu',
  idNumber: '8503124800081',
  cellNumber: '+27821234567',
  documents: [],
  incomeSources: [{ type: 'CHILD_GRANT', monthlyAmount: 530 }],
  household: [],
  peopleOnProperty: 1,
  user: { isVerified: true },
  ...over,
});

test('submission is refused while the number is unverified', () => {
  const check = submission.readiness(ready({ user: { isVerified: false } }));
  assert.equal(check.ready, false);
  assert.ok(check.problems.some((p) => /cell number has not been verified/i.test(p)));
});

test('a verified number leaves no verification problem', () => {
  const check = submission.readiness(ready());
  assert.ok(!check.problems.some((p) => /verified/i.test(p)));
});

test('the owner can be passed in rather than nested on the application', () => {
  const application = ready();
  delete application.user;
  const check = submission.readiness(application, { owner: { isVerified: true } });
  assert.ok(!check.problems.some((p) => /verified/i.test(p)));
});

// ---------------------------------------------------------------------------
// The snapshot — why it is frozen rather than derived
// ---------------------------------------------------------------------------

test('a draft reports the account, live', () => {
  const out = submission.verificationOf(
    { submittedAt: null },
    { isVerified: true, cellVerifiedAt: new Date('2026-08-01'), cellNumber: '+27821234567' }
  );
  assert.equal(out.verified, true);
  assert.equal(out.source, 'account');
  assert.equal(out.number, '+27821234567');
});

test('a submitted application reports its own frozen copy', () => {
  const out = submission.verificationOf({
    submittedAt: new Date('2026-08-10'),
    cellVerified: true,
    cellVerifiedAt: new Date('2026-08-01'),
    cellVerifiedNumber: '+27821234567',
  }, null);
  assert.equal(out.verified, true);
  assert.equal(out.source, 'submitted');
  assert.equal(out.number, '+27821234567');
});

test('changing the number later does not rewrite a decided application', () => {
  // The account has moved on and is unverified again; the record must still say
  // what was true when it was submitted. This is the whole reason for freezing.
  const application = {
    submittedAt: new Date('2026-08-10'),
    cellVerified: true,
    cellVerifiedAt: new Date('2026-08-01'),
    cellVerifiedNumber: '+27821234567',
  };
  const accountNow = { isVerified: false, cellVerifiedAt: null, cellNumber: '+27829999999' };

  const out = submission.verificationOf(application, accountNow);
  assert.equal(out.verified, true, 'a later number change must not unverify a decided application');
  assert.equal(out.number, '+27821234567', 'the number verified at the time is the one recorded');
});

test('an unverified draft reports no number rather than an unproved one', () => {
  const out = submission.verificationOf(
    { submittedAt: null },
    { isVerified: false, cellVerifiedAt: null, cellNumber: '+27821234567' }
  );
  assert.equal(out.verified, false);
  assert.equal(out.number, null, 'an unproved number must not be presented as the verified one');
});
