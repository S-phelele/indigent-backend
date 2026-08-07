const test = require('node:test');
const assert = require('node:assert/strict');

const sms = require('../src/lib/sms');
const templates = require('../src/lib/smsTemplates');
const { temporaryPassword, passwordProblems } = require('../src/lib/credentials');

/**
 * Only the pure parts: number normalisation, segment counting, redaction, and
 * the message templates. Actually sending writes to the database and belongs in
 * the integration run.
 */

// ---------------------------------------------------------------------------
// Number normalisation
// ---------------------------------------------------------------------------

test('accepts every way a South African writes their cell number', () => {
  const forms = [
    '0821234567',
    '082 123 4567',
    '082-123-4567',
    '+27821234567',
    '+27 82 123 4567',
    '27821234567',
    '(082) 123 4567',
  ];
  for (const form of forms) {
    assert.equal(sms.normaliseNumber(form), '+27821234567', `${form} should normalise`);
  }
});

test('one person is one number, however they typed it', () => {
  // The reason this matters: four spellings would otherwise be four outbox rows
  // and, with a real gateway, three silent failures.
  const normalised = new Set(['0821234567', '082 123 4567', '+27821234567', '27821234567'].map(sms.normaliseNumber));
  assert.equal(normalised.size, 1);
});

test('recovers a number that dropped its leading zero', () => {
  assert.equal(sms.normaliseNumber('821234567'), '+27821234567');
});

test('rejects what is not a usable South African number', () => {
  const bad = ['', null, undefined, '123', '08212345', '082123456789', 'not a number', '+441234567890'];
  for (const value of bad) {
    assert.equal(sms.normaliseNumber(value), null, `${JSON.stringify(value)} should be rejected`);
  }
});

test('rejects a landline in mobile position', () => {
  // 011 is Johannesburg landline; the bare-nine-digit rule must not accept 11…
  assert.equal(sms.normaliseNumber('112345678'), null);
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('counts message segments the way a gateway bills them', () => {
  assert.equal(sms.countSegments('short'), 1);
  assert.equal(sms.countSegments('x'.repeat(160)), 1);
  assert.equal(sms.countSegments('x'.repeat(161)), 2);
  assert.equal(sms.countSegments('x'.repeat(306)), 2);
  assert.equal(sms.countSegments('x'.repeat(307)), 3);
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test('a temporary password never reaches the stored message body', () => {
  // The outbox stores bodies. A credential written into one would sit in the
  // database in clear text, defeating the point of hashing it in the users table.
  const password = 'Achd-4#26';
  const body = templates.build('WELCOME_CREDENTIALS', {
    firstName: 'Naledi',
    username: '+27821234567',
    tempPassword: password,
  });

  assert.ok(body.includes(password), 'the message actually sent must contain it');

  const stored = sms.redact(body, [password]);
  assert.ok(!stored.includes(password), 'the stored copy must not');
  assert.match(stored, /••••/);
  assert.ok(stored.includes('+27821234567'), 'the username is not a secret and stays readable');
});

test('redaction leaves a message with no secrets alone', () => {
  const body = 'Reference IND-2026-00001.';
  assert.equal(sms.redact(body, []), body);
  assert.equal(sms.redact(body, [undefined, null, '']), body);
});

test('every occurrence of a secret is removed, not just the first', () => {
  assert.equal(sms.redact('code 1234 — repeat 1234', ['1234']), 'code •••••••• — repeat ••••••••');
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test('every template produces a non-empty message', () => {
  const values = {
    firstName: 'Naledi', username: '+27821234567', tempPassword: 'Achd-4#26',
    reference: 'IND-2026-00042', days: 14, councillor: 'T. Dlamini', ward: 'Ward 12',
    reason: 'Income above the threshold', documentName: 'ID Copy', code: '482913', minutes: 10,
  };
  for (const key of Object.keys(templates.templates)) {
    const body = templates.build(key, values);
    assert.ok(body && body.trim().length > 20, `${key} produced "${body}"`);
  }
});

test('an unknown template throws rather than sending an empty message', () => {
  assert.throws(() => templates.build('NO_SUCH_TEMPLATE', {}), /unknown template/);
});

test('messages about an application always carry the reference', () => {
  // It is the only thing a resident can quote at the counter.
  const withReference = [
    'APPLICATION_SUBMITTED', 'CAPTURED_BY_COUNCILLOR', 'APPLICATION_APPROVED',
    'APPLICATION_DECLINED', 'DOCUMENT_REJECTED', 'APPLICATION_REOPENED',
  ];
  for (const key of withReference) {
    const body = templates.build(key, {
      reference: 'IND-2026-00042', days: 14, councillor: 'T. Dlamini',
      ward: 'Ward 12', documentName: 'ID Copy',
    });
    assert.ok(body.includes('IND-2026-00042'), `${key} must quote the reference`);
  }
});

test('the decline message survives having no reason given', () => {
  const body = templates.build('APPLICATION_DECLINED', { reference: 'IND-2026-00042', reason: null });
  assert.ok(!body.includes('null'));
  assert.ok(!body.includes('undefined'));
});

test('a councillor capture message survives a councillor with no ward', () => {
  const body = templates.build('CAPTURED_BY_COUNCILLOR', {
    reference: 'IND-2026-00042', councillor: 'T. Dlamini', ward: null,
  });
  assert.ok(!body.includes('null'));
  assert.ok(!body.includes('()'));
});

test('an OTP message warns against sharing the code', () => {
  const body = templates.build('OTP', { code: '482913', minutes: 10 });
  assert.match(body, /do not share/i);
  assert.ok(body.length <= 160, `one segment, was ${body.length} characters`);
});

// ---------------------------------------------------------------------------
// Temporary passwords
// ---------------------------------------------------------------------------

test('a generated password satisfies the policy every time', () => {
  for (let i = 0; i < 200; i += 1) {
    const password = temporaryPassword();
    assert.deepEqual(passwordProblems(password), [], `${password} failed the policy`);
  }
});

test('generated passwords avoid characters that are misread over the phone', () => {
  // Somebody reads this out of an SMS to a resident on a borrowed handset. Every
  // O/0 or l/1 is a failed sign-in and a call to the municipality.
  for (let i = 0; i < 200; i += 1) {
    assert.doesNotMatch(temporaryPassword(), /[O0lI1sS5bB8]/, 'ambiguous character in a dictated password');
  }
});

test('generated passwords are not predictable', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(temporaryPassword());
  assert.ok(seen.size > 490, `only ${seen.size} distinct values in 500 draws`);
});

test('the password policy names what is missing, in words a person can act on', () => {
  assert.deepEqual(passwordProblems('Abcdef1!'), []);
  assert.deepEqual(passwordProblems(''), [
    'at least 8 characters', 'a capital letter', 'a small letter', 'a special character (e.g. @, !, #, %, &)',
  ]);
  assert.deepEqual(passwordProblems('abcdefgh'), ['a capital letter', 'a special character (e.g. @, !, #, %, &)']);
});
