const test = require('node:test');
const assert = require('node:assert/strict');

const meansTest = require('../src/lib/meansTest');
const signature = require('../src/lib/signature');
const renewal = require('../src/lib/renewal');
const changeLog = require('../src/lib/changeLog');

const T = meansTest.THRESHOLD;

// ---------------------------------------------------------------------------
// The means test
// ---------------------------------------------------------------------------

test('a household under the threshold qualifies', () => {
  const f = meansTest.assess({ totalHouseholdIncome: T - 1000, peopleOnProperty: 3 });
  assert.equal(f.result, 'QUALIFIES');
  assert.equal(f.overThreshold, false);
  assert.equal(f.suggestion, 'APPROVE');
});

test('a household over the threshold is flagged, not refused outright', () => {
  const f = meansTest.assess({ totalHouseholdIncome: T + 3000, peopleOnProperty: 1 });
  assert.equal(f.result, 'ABOVE_THRESHOLD');
  assert.equal(f.marginOverThreshold, 3000);
  assert.equal(f.suggestion, 'REJECT');
});

test('a large household over the threshold but under the per-person level is suggested for approval', () => {
  // Nine people sharing an income over the household figure are not wealthy.
  // Judging them by the household total alone is what this exists to prevent.
  const income = T + 2000;
  const f = meansTest.assess({ totalHouseholdIncome: income, peopleOnProperty: 9 });

  assert.equal(f.result, 'ABOVE_THRESHOLD');
  assert.equal(f.overThreshold, true);
  assert.equal(f.underPerPersonFloor, true);
  assert.equal(f.suggestion, 'APPROVE');
  assert.ok(f.notes.some((n) => n.code === 'LARGE_HOUSEHOLD_UNDER_PER_PERSON'));
});

test('a single person on the same income is not', () => {
  const f = meansTest.assess({ totalHouseholdIncome: T + 2000, peopleOnProperty: 1 });
  assert.equal(f.underPerPersonFloor, false);
  assert.equal(f.suggestion, 'REJECT');
});

test('verified income beats a lower declaration', () => {
  const f = meansTest.assess(
    { totalHouseholdIncome: 1500, peopleOnProperty: 2 },
    { checks: [{ source: 'SARS', amountFound: 11000 }] }
  );
  assert.equal(f.assessedIncome, 11000, 'the assessment must use what was verified');
  assert.equal(f.verifiedIncome, 11000);
  assert.ok(f.notes.some((n) => n.code === 'VERIFIED_ABOVE_DECLARED' && n.severity === 'high'));
});

test('a declaration higher than what was verified is kept', () => {
  // Somebody who declared more than SARS shows is not helped by us using the
  // smaller figure.
  const f = meansTest.assess(
    { totalHouseholdIncome: 9000, peopleOnProperty: 2 },
    { checks: [{ source: 'SASSA', amountFound: 2090 }] }
  );
  assert.equal(f.assessedIncome, 9000);
});

test("household members' income is counted when the declaration omits it", () => {
  const f = meansTest.assess(
    { totalHouseholdIncome: 0, peopleOnProperty: 3 },
    { household: [{ monthlyIncome: 4000 }, { monthlyIncome: 3500 }] }
  );
  assert.equal(f.memberIncome, 7500);
  assert.equal(f.assessedIncome, 7500);
  assert.ok(f.notes.some((n) => n.code === 'MEMBERS_ABOVE_DECLARED'));
});

test('no income information at all is reported as such, not as qualifying', () => {
  const f = meansTest.assess({ totalHouseholdIncome: 0, peopleOnProperty: 2 });
  assert.equal(f.result, 'INSUFFICIENT_DATA');
  assert.equal(f.suggestion, 'RETURN');
});

test('a declared zero income with a stated employment status is a real answer', () => {
  const f = meansTest.assess({ totalHouseholdIncome: 0, peopleOnProperty: 4, employmentStatus: 'UNEMPLOYED' });
  assert.equal(f.result, 'QUALIFIES');
});

test('income per person is computed against the real household size', () => {
  const f = meansTest.assess({ totalHouseholdIncome: 6000, peopleOnProperty: 4 });
  assert.equal(f.people, 4);
  assert.equal(f.perPerson, 1500);
});

test('household size never divides by zero', () => {
  const f = meansTest.assess({ totalHouseholdIncome: 3000, peopleOnProperty: 0 });
  assert.equal(f.people, 1);
  assert.equal(f.perPerson, 3000);
});

test('a declared second property is raised for the officer to weigh', () => {
  const f = meansTest.assess({ totalHouseholdIncome: 1000, peopleOnProperty: 2, ownsOtherProperty: true });
  assert.ok(f.notes.some((n) => n.code === 'OTHER_PROPERTY'));
});

test('the finding explains itself in a sentence', () => {
  const f = meansTest.assess({ totalHouseholdIncome: 3000, peopleOnProperty: 4 });
  const text = meansTest.explain(f);
  // en-ZA groups thousands with a NON-BREAKING space (U+00A0), not an ordinary
  // one. A plain-space pattern here silently fails against correct output.
  assert.match(text, /R3[\s ]000,00/);
  assert.match(text, /4 people/);
  assert.match(text, /qualifies/i);
});

test('Prisma Decimal values arriving as strings are handled', () => {
  const f = meansTest.assess({ totalHouseholdIncome: '3500.00', peopleOnProperty: 2 });
  assert.equal(f.declaredIncome, 3500);
  assert.equal(f.perPerson, 1750);
});

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

const pngDataUri = (bytes) => `data:image/png;base64,${Buffer.alloc(bytes, 0x41).toString('base64')}`;

test('a drawn signature of a reasonable size is accepted', () => {
  assert.equal(signature.validate(pngDataUri(4000)).valid, true);
});

test('an empty signature box is refused with an instruction', () => {
  const r = signature.validate(pngDataUri(10));
  assert.equal(r.valid, false);
  assert.match(r.reason, /sign/i);
});

test('a missing signature is refused', () => {
  assert.equal(signature.validate(null).valid, false);
  assert.equal(signature.validate('').valid, false);
  assert.equal(signature.validate(undefined).valid, false);
});

test('something that is not an image data URI is refused', () => {
  assert.equal(signature.validate('not-a-data-uri').valid, false);
  assert.equal(signature.validate('data:text/html;base64,PHNjcmlwdD4=').valid, false);
  assert.equal(signature.validate('javascript:alert(1)').valid, false);
});

test('an oversized signature is refused rather than stored', () => {
  const r = signature.validate(pngDataUri(signature.MAX_BYTES + 5000));
  assert.equal(r.valid, false);
  assert.match(r.reason, /too large/i);
});

test('the signature context records who signed, when and from where', () => {
  const ctx = signature.context(
    { ip: '10.0.0.5', headers: {} },
    { firstName: 'Thandi', lastName: 'Dlamini', email: 't@x.gov.za' }
  );
  assert.equal(ctx.signatureName, 'Thandi Dlamini');
  assert.equal(ctx.signatureIp, '10.0.0.5');
  assert.ok(ctx.signedAt instanceof Date);
});

test('a proxied address is read from the forwarded header', () => {
  const ctx = signature.context(
    { ip: '172.16.0.1', headers: { 'x-forwarded-for': '196.25.1.1, 172.16.0.1' } },
    { email: 'x@y.gov.za' }
  );
  assert.equal(ctx.signatureIp, '196.25.1.1');
});

test('a described signature carries its legal basis', () => {
  const d = signature.describe({
    signature: pngDataUri(2000), signatureName: 'T. Dlamini',
    signedAt: new Date('2026-08-08T10:00:00Z'), signatureIp: '10.0.0.5', actorRole: 'SUPERVISOR',
  });
  assert.equal(d.name, 'T. Dlamini');
  assert.match(d.statement, /Electronic Communications and Transactions Act/);
  assert.ok(d.signedAtLabel);
});

test('a step with no signature describes as nothing', () => {
  assert.equal(signature.describe({ signature: null }), null);
  assert.equal(signature.describe(null), null);
});

// ---------------------------------------------------------------------------
// Renewal cycle
// ---------------------------------------------------------------------------

const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

test('an approval is valid for the policy period', () => {
  const from = new Date('2026-01-15T00:00:00Z');
  const expires = renewal.expiryFrom(from);
  assert.equal(expires.getUTCFullYear(), 2027);
  assert.equal(expires.getUTCMonth(), 0);
});

test('a registration well inside its period is active', () => {
  assert.equal(renewal.statusFor({ status: 'APPROVED', expiresAt: daysFromNow(200) }), 'ACTIVE');
});

test('a registration approaching expiry is flagged before it lapses', () => {
  // The whole point: told while there is still something they can do.
  assert.equal(renewal.statusFor({ status: 'APPROVED', expiresAt: daysFromNow(30) }), 'DUE_SOON');
});

test('an expired registration is overdue during the grace period', () => {
  assert.equal(renewal.statusFor({ status: 'APPROVED', expiresAt: daysFromNow(-10) }), 'OVERDUE');
});

test('a registration past its grace period has lapsed', () => {
  assert.equal(renewal.statusFor({ status: 'APPROVED', expiresAt: daysFromNow(-90) }), 'LAPSED');
});

test('only approved registrations have a renewal cycle', () => {
  assert.equal(renewal.statusFor({ status: 'DECLINED', expiresAt: daysFromNow(-90) }), 'NOT_APPLICABLE');
  assert.equal(renewal.statusFor({ status: 'PENDING', expiresAt: daysFromNow(10) }), 'NOT_APPLICABLE');
  assert.equal(renewal.statusFor({ status: 'APPROVED', expiresAt: null }), 'NOT_APPLICABLE');
});

test('a household is told once per level, not on every sweep', () => {
  assert.equal(renewal.shouldAnnounce('DUE_SOON', 'ACTIVE'), true);
  assert.equal(renewal.shouldAnnounce('DUE_SOON', 'DUE_SOON'), false);
  assert.equal(renewal.shouldAnnounce('OVERDUE', 'DUE_SOON'), true);
  assert.equal(renewal.shouldAnnounce('LAPSED', 'OVERDUE'), true);
  // Escalation only moves forward — renewing must not re-announce a lower level.
  assert.equal(renewal.shouldAnnounce('DUE_SOON', 'LAPSED'), false);
});

test('days remaining goes negative once expiry has passed', () => {
  assert.ok(renewal.daysRemaining({ expiresAt: daysFromNow(10) }) > 0);
  assert.ok(renewal.daysRemaining({ expiresAt: daysFromNow(-10) }) < 0);
  assert.equal(renewal.daysRemaining({ expiresAt: null }), null);
});

// ---------------------------------------------------------------------------
// Field-level change log
// ---------------------------------------------------------------------------

test('a changed field is recorded with its old and new value', () => {
  const changes = changeLog.diff({ totalHouseholdIncome: 3000 }, { totalHouseholdIncome: 8000 });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].oldValue, '3000');
  assert.equal(changes[0].newValue, '8000');
  assert.equal(changes[0].label, 'Total household income');
  assert.equal(changes[0].sensitive, true, 'income is exactly what an auditor asks about');
});

test('an unchanged field is not recorded', () => {
  assert.deepEqual(changeLog.diff({ surname: 'Khumalo' }, { surname: 'Khumalo' }), []);
});

test('system-maintained columns are not treated as somebody’s edit', () => {
  const changes = changeLog.diff(
    { updatedAt: new Date('2026-01-01'), surname: 'Old' },
    { updatedAt: new Date('2026-02-01'), surname: 'New' }
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, 'surname');
});

test('a field the payload does not carry is not compared', () => {
  const changes = changeLog.diff({ surname: 'Khumalo', names: 'Sphelele' }, { surname: 'Khumalo' });
  assert.deepEqual(changes, []);
});

test('booleans read as Yes and No rather than true and false', () => {
  const changes = changeLog.diff({ ownsOtherProperty: false }, { ownsOtherProperty: true });
  assert.equal(changes[0].oldValue, 'No');
  assert.equal(changes[0].newValue, 'Yes');
});

test('a value going from blank to set is a change', () => {
  const changes = changeLog.diff({ municipalAccountNumber: null }, { municipalAccountNumber: 'MUN-1234' });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].oldValue, null);
  assert.equal(changes[0].newValue, 'MUN-1234');
});

test('an empty string and null are the same absence', () => {
  assert.deepEqual(changeLog.diff({ postalAddress: null }, { postalAddress: '' }), []);
});

test('Prisma Decimal objects are compared by value, not by identity', () => {
  const decimalLike = { toString: () => '3000' };
  assert.deepEqual(changeLog.diff({ salary: decimalLike }, { salary: 3000 }), []);
});

test('every sensitive field has a readable label', () => {
  for (const field of changeLog.SENSITIVE) {
    const label = changeLog.labelFor(field);
    assert.ok(label && label !== field.toUpperCase(), `${field} needs a label`);
    assert.doesNotMatch(label, /^[a-z]+[A-Z]/, `${label} still looks like a column name`);
  }
});
