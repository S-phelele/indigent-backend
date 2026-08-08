const test = require('node:test');
const assert = require('node:assert/strict');

const retention = require('../src/lib/retention');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-08T12:00:00.000Z');

/**
 * A stand-in for Prisma.
 *
 * Records what it was asked to do rather than doing it, so the tests can assert
 * on the *decision* — which rows a rule selects, whether a run committed — without
 * a database. `deleteMany` and `updateMany` return whatever count the test seeds.
 */
function fakeClient({ counts = {}, rows = {}, failOn = null } = {}) {
  const calls = { count: [], deleteMany: [], updateMany: [], findMany: [], transactions: 0, flagsSet: [] };

  const model = (name) => ({
    count: async ({ where }) => { calls.count.push({ name, where }); return counts[name] ?? 0; },
    findMany: async (args) => { calls.findMany.push({ name, ...args }); return rows[name] ?? []; },
    deleteMany: async ({ where }) => {
      calls.deleteMany.push({ name, where });
      if (failOn === name) throw new Error(`Table FieldChange is append-only: DELETE is not permitted.`);
      return { count: counts[name] ?? 0 };
    },
    updateMany: async ({ where, data }) => {
      calls.updateMany.push({ name, where, data });
      if (failOn === name) throw new Error('boom');
      return { count: counts[name] ?? 0 };
    },
  });

  const client = {
    application: model('application'),
    otp: model('otp'),
    smsMessage: model('smsMessage'),
    calls,
    $executeRaw: async (strings) => { calls.flagsSet.push(String(strings.raw ?? strings)); return 1; },
    async $transaction(fn) {
      calls.transactions += 1;
      return fn(client);
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// The schedule itself
// ---------------------------------------------------------------------------

test('every rule either has a period or is deliberately kept', () => {
  // A rule with no period and no KEEP action would silently never fire, which
  // looks like a policy but is not one.
  for (const rule of Object.values(retention.POLICY)) {
    if (rule.action === 'KEEP') {
      assert.equal(rule.period, null, `${rule.key} is kept, so it must not have a period`);
    } else {
      assert.ok(rule.period > 0, `${rule.key} must have a positive retention period`);
      assert.ok(rule.from, `${rule.key} must say which date its period runs from`);
    }
  }
});

test('every rule states a lawful basis', () => {
  // "We delete after five years" is not a policy; "because s14 says so" is.
  for (const rule of Object.values(retention.POLICY)) {
    assert.ok(rule.basis && rule.basis.length > 20, `${rule.key} needs a stated basis`);
  }
});

test('approved applications and the audit trail are never swept', () => {
  assert.equal(retention.POLICY.APPROVED_APPLICATION.action, 'KEEP');
  assert.equal(retention.POLICY.AUDIT_TRAIL.action, 'KEEP');
});

test('cutoff is the retention period before now', () => {
  const rule = { period: 5 * 365.25 * DAY };
  const before = retention.cutoff(rule, NOW);
  assert.equal(Math.round((NOW - before) / DAY), Math.round(5 * 365.25));
});

test('a kept rule has no cutoff at all', () => {
  assert.equal(retention.cutoff(retention.POLICY.AUDIT_TRAIL, NOW), null);
});

test('periods are described in the largest sensible unit', () => {
  assert.equal(retention.describePeriod({ period: null }), 'Kept indefinitely');
  assert.equal(retention.describePeriod({ period: 30 * DAY }), '30 days');
  assert.equal(retention.describePeriod({ period: 180 * DAY }), '6 months');
  assert.equal(retention.describePeriod({ period: 365.25 * DAY }), '1 year');
  assert.equal(retention.describePeriod({ period: 5 * 365.25 * DAY }), '5 years');
});

// ---------------------------------------------------------------------------
// Which rows each rule selects
// ---------------------------------------------------------------------------

test('declined applications are selected by decision date, and only once', () => {
  const where = retention.whereFor(retention.POLICY.DECLINED_APPLICATION, NOW);
  assert.equal(where.status, 'DECLINED');
  assert.deepEqual(where.reviewedAt, { lt: NOW });
  // Without this an already-anonymised row would be found again on every sweep
  // and reported as still outstanding for ever.
  assert.equal(where.anonymisedAt, null);
});

test('lapsed registrations need both approval and a lapse', () => {
  const where = retention.whereFor(retention.POLICY.LAPSED_REGISTRATION, NOW);
  assert.equal(where.status, 'APPROVED');
  assert.equal(where.renewalStatus, 'LAPSED');
  assert.deepEqual(where.expiresAt, { lt: NOW });
});

test('abandoned drafts are selected on last activity, not creation', () => {
  // Somebody who created a form two years ago but edited it yesterday has not
  // abandoned it.
  const where = retention.whereFor(retention.POLICY.ABANDONED_DRAFT, NOW);
  assert.equal(where.status, 'DRAFT');
  assert.deepEqual(where.updatedAt, { lt: NOW });
});

test('an unrecognised rule selects nothing rather than everything', () => {
  // The failure mode being guarded against: a new rule added to POLICY without a
  // matcher, whose empty `where` would match the whole table.
  const where = retention.whereFor({ key: 'SOMETHING_NEW' }, NOW);
  assert.deepEqual(where, { id: '__no_such_id__' });
  assert.notDeepEqual(where, {});
});

test('each rule is routed to the right table', () => {
  assert.equal(retention.modelFor(retention.POLICY.EXPIRED_OTP), 'otp');
  assert.equal(retention.modelFor(retention.POLICY.SMS_LOG), 'smsMessage');
  assert.equal(retention.modelFor(retention.POLICY.DECLINED_APPLICATION), 'application');
  assert.equal(retention.modelFor(retention.POLICY.ABANDONED_DRAFT), 'application');
});

// ---------------------------------------------------------------------------
// Anonymisation
// ---------------------------------------------------------------------------

test('anonymisation nulls every identifying field and marks the row', () => {
  const marker = retention.anonymisedMarker('DECLINED_APPLICATION');

  for (const field of Object.keys(retention.IDENTIFYING_FIELDS)) {
    assert.equal(marker[field], null, `${field} must be nulled`);
  }
  assert.equal(marker.anonymisedUnder, 'DECLINED_APPLICATION');
  assert.ok(marker.anonymisedAt instanceof Date);
});

test('coordinates are removed entirely, not rounded', () => {
  // Three decimal places still locates a household within ~100m, which in a small
  // settlement is one family. Rounding is not anonymisation.
  assert.ok('addressLatitude' in retention.IDENTIFYING_FIELDS);
  assert.ok('addressLongitude' in retention.IDENTIFYING_FIELDS);
  assert.equal(retention.IDENTIFYING_FIELDS.addressLatitude, null);
  assert.equal(retention.IDENTIFYING_FIELDS.addressLongitude, null);
});

test('anonymisation keeps what the statistics need', () => {
  const marker = retention.anonymisedMarker('LAPSED_REGISTRATION');
  // The whole justification for anonymising rather than deleting is that these
  // survive. If a future edit adds them to IDENTIFYING_FIELDS, this fails.
  for (const kept of ['peopleOnProperty', 'totalHouseholdIncome', 'wardNumber', 'status', 'age', 'sex']) {
    assert.ok(!(kept in marker), `${kept} must survive anonymisation`);
  }
});

test('free-text fields are stripped, because names hide in them', () => {
  for (const field of ['reviewNotes', 'assessmentNotes', 'budgetNotes', 'otherPropertyDetails']) {
    assert.ok(field in retention.IDENTIFYING_FIELDS, `${field} must be stripped`);
  }
});

// ---------------------------------------------------------------------------
// Surveying
// ---------------------------------------------------------------------------

test('a survey counts what is due and changes nothing', async () => {
  const client = fakeClient({ counts: { application: 3, otp: 12, smsMessage: 4 } });
  const result = await retention.survey(NOW, client);

  assert.equal(client.calls.deleteMany.length, 0);
  assert.equal(client.calls.updateMany.length, 0);
  assert.ok(result.totalDue > 0);
});

test('a survey reports kept rules with nothing due', async () => {
  const client = fakeClient({ counts: { application: 3, otp: 0, smsMessage: 0 } });
  const result = await retention.survey(NOW, client);

  const kept = result.findings.find((f) => f.key === 'AUDIT_TRAIL');
  assert.equal(kept.due, 0);
  assert.equal(kept.period, 'Kept indefinitely');
});

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

test('apply does nothing without commit, however much is due', async () => {
  const client = fakeClient({ counts: { application: 9, otp: 9, smsMessage: 9 } });
  const result = await retention.apply({}, NOW, client);

  assert.equal(client.calls.deleteMany.length, 0, 'nothing may be deleted on a dry run');
  assert.equal(client.calls.updateMany.length, 0, 'nothing may be anonymised on a dry run');
  assert.equal(result.committed, false);
  assert.equal(result.totalApplied, 0);
  // The dry run still has to say what it *would* have done, or it is useless.
  assert.ok(result.results.every((r) => r.due === 9));
});

test('apply with commit deletes and anonymises', async () => {
  const client = fakeClient({ counts: { application: 2, otp: 5, smsMessage: 1 } });
  const result = await retention.apply({ commit: true }, NOW, client);

  assert.ok(client.calls.deleteMany.length >= 1);
  assert.ok(client.calls.updateMany.length >= 1);
  assert.equal(result.committed, true);
  assert.ok(result.totalApplied > 0);
});

test('deletions run inside a transaction that opens the append-only exception', async () => {
  const client = fakeClient({ counts: { application: 1, otp: 1, smsMessage: 1 } });
  await retention.apply({ commit: true }, NOW, client);

  // Three DELETE rules: abandoned drafts, spent OTPs, the message log.
  assert.equal(client.calls.transactions, 3);
  assert.ok(
    client.calls.flagsSet.every((sql) => /retention_sweep/.test(sql)),
    'each deleting transaction must set the retention flag'
  );
  assert.ok(
    client.calls.flagsSet.every((sql) => /true/.test(sql)),
    'the flag must be transaction-local so it cannot be left switched on'
  );
});

test('anonymisation does not open the exception', async () => {
  // Only deletion needs it. A wider window than the problem requires is a bug.
  const client = fakeClient({ counts: { application: 1, otp: 0, smsMessage: 0 } });
  await retention.apply({ commit: true, only: 'DECLINED_APPLICATION' }, NOW, client);

  assert.equal(client.calls.transactions, 0);
  assert.equal(client.calls.flagsSet.length, 0);
  assert.equal(client.calls.updateMany.length, 1);
});

test('only: runs one rule and leaves the others alone', async () => {
  const client = fakeClient({ counts: { otp: 4 } });
  const result = await retention.apply({ commit: true, only: 'EXPIRED_OTP' }, NOW, client);

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].key, 'EXPIRED_OTP');
  assert.equal(client.calls.deleteMany.length, 1);
  assert.equal(client.calls.deleteMany[0].name, 'otp');
});

test('a kept rule cannot be forced to run through only:', async () => {
  const client = fakeClient({ counts: { application: 50 } });
  const result = await retention.apply({ commit: true, only: 'AUDIT_TRAIL' }, NOW, client);

  assert.equal(result.results.length, 0);
  assert.equal(client.calls.deleteMany.length, 0);
  assert.equal(client.calls.updateMany.length, 0);
});

test('nothing due means nothing attempted', async () => {
  const client = fakeClient({ counts: {} });
  const result = await retention.apply({ commit: true }, NOW, client);

  assert.equal(client.calls.deleteMany.length, 0);
  assert.equal(result.totalApplied, 0);
});

test('one failing rule does not abandon the rest', async () => {
  // The real case this guards: the append-only trigger refusing a cascade. Before
  // this was isolated, the first failure threw out of the loop and every later
  // rule silently never ran — a retention policy that had stopped working while
  // still reporting success.
  const client = fakeClient({ counts: { application: 1, otp: 3, smsMessage: 2 }, failOn: 'application' });
  const result = await retention.apply({ commit: true }, NOW, client);

  const draft = result.results.find((r) => r.key === 'ABANDONED_DRAFT');
  const otp = result.results.find((r) => r.key === 'EXPIRED_OTP');

  assert.ok(draft.failure, 'the failing rule must record why');
  assert.equal(draft.applied, 0);
  assert.equal(otp.applied, 3, 'a later rule must still run');
  assert.equal(result.failures.length > 0, true, 'a partial run must not look like a clean one');
});

test('a failed run reports the failure rather than a silent zero', async () => {
  const client = fakeClient({ counts: { otp: 2 }, failOn: 'otp' });
  const result = await retention.apply({ commit: true, only: 'EXPIRED_OTP' }, NOW, client);

  assert.equal(result.totalApplied, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].failure, /append-only/);
});

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

test('the published policy is readable and complete', () => {
  const published = retention.publish();
  assert.equal(published.length, Object.keys(retention.POLICY).length);

  for (const entry of published) {
    assert.ok(entry.label, 'a person has to be able to tell what it refers to');
    assert.ok(entry.retention);
    assert.ok(['Kept', 'Deleted', 'Anonymised'].includes(entry.outcome));
    assert.ok(entry.basis);
  }
});

test('the published policy never leaks raw milliseconds', () => {
  // Publishing `157788000000` to an applicant is not a retention notice.
  for (const entry of retention.publish()) {
    assert.equal(typeof entry.retention, 'string');
    assert.doesNotMatch(entry.retention, /^\d{6,}$/);
  }
});
