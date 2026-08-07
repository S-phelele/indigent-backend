const test = require('node:test');
const assert = require('node:assert/strict');

const meter = require('../src/lib/meterNumber');

/**
 * Length and character set only. South African meter numbering is not uniform —
 * prepaid electricity uses an 11-digit STS number, but conventional, bulk and
 * water meters follow each municipality's own convention. These tests pin the
 * boundary between "obviously not a meter number" and "plausibly real", and
 * deliberately assert that plausible-but-unusual values are accepted.
 */

test('an empty value is valid — meter numbers are optional', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const result = meter.validate(empty);
    assert.equal(result.valid, true, `should accept ${JSON.stringify(empty)}`);
    assert.equal(result.value, null, 'stored as null, not an empty string');
  }
});

test('accepts a standard 11-digit prepaid electricity number', () => {
  const result = meter.validate('04212345678', { kind: 'electricity' });
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.value, '04212345678');
});

test('accepts the shapes municipalities actually use', () => {
  for (const value of [
    '12345',            // shortest allowed
    'A1234567',         // letter prefix
    'WM-556677',        // hyphenated
    '123/456/789',      // slash-separated
    '04212345678901234', // long but plausible
  ]) {
    assert.equal(meter.validate(value).valid, true, `should accept ${value}`);
  }
});

test('normalises whitespace and case so one meter is stored one way', () => {
  const a = meter.validate(' wm-55 66 77 ');
  const b = meter.validate('WM-556677');
  assert.equal(a.value, 'WM-556677');
  assert.equal(a.value, b.value, 'the same meter must normalise identically');
});

test('rejects something far too short to be a meter number', () => {
  const result = meter.validate('123', { kind: 'water' });
  assert.equal(result.valid, false);
  assert.match(result.reason, /too short/i);
  assert.match(result.reason, /water meter number/i, 'the message names which meter');
});

test('rejects something implausibly long', () => {
  const result = meter.validate('1'.repeat(meter.MAX_LENGTH + 1), { kind: 'electricity' });
  assert.equal(result.valid, false);
  assert.match(result.reason, /too long/i);
  assert.match(result.reason, /electricity meter number/i);
});

test('the boundaries themselves are accepted', () => {
  assert.equal(meter.validate('1'.repeat(meter.MIN_LENGTH)).valid, true, 'minimum length is valid');
  assert.equal(meter.validate('1'.repeat(meter.MAX_LENGTH)).valid, true, 'maximum length is valid');
});

test('rejects characters that cannot appear on a meter faceplate', () => {
  for (const value of ['1234$678', 'meter #12345', '12345;DROP', 'métèr12345']) {
    const result = meter.validate(value);
    assert.equal(result.valid, false, `should reject ${value}`);
    assert.match(result.reason, /letters, numbers, hyphens and slashes/i);
  }
});

test('does NOT enforce a format beyond length', () => {
  // The point of the current rule: an unusual but plausible number must pass,
  // because rejecting it would block a real applicant.
  assert.equal(meter.validate('00000000000').valid, true, 'all zeros is not our business');
  assert.equal(meter.validate('ZZZZZZZZ').valid, true, 'letters only is not our business');
  assert.equal(meter.validate('E-12345/B').valid, true);
});
