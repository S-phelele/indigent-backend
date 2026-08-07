const test = require('node:test');
const assert = require('node:assert/strict');

const saId = require('../src/lib/saIdNumber');

/**
 * Two modes. Lenient (the default today) enforces 13 digits and a real date of
 * birth. Strict adds the citizenship digit and the Luhn check digit, and is
 * enabled with SA_ID_STRICT=true once the register has been reconciled.
 */

/** Compute the check digit independently, so the test does not mirror the code. */
function withCheckDigit(first12) {
  for (let d = 0; d <= 9; d++) {
    const candidate = first12 + String(d);
    let sum = 0, double = false;
    for (let i = candidate.length - 1; i >= 0; i--) {
      let digit = Number(candidate[i]);
      if (double) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit;
      double = !double;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error('no check digit found');
}

const VALID_FEMALE = withCheckDigit('900228' + '0123' + '0' + '8');
const VALID_MALE_PR = withCheckDigit('851115' + '5678' + '1' + '8');

const lenient = { strict: false };
const strict = { strict: true };

// ---------------------------------------------------------------------------
// Always enforced, in both modes
// ---------------------------------------------------------------------------

test('accepts a well-formed ID in either mode', () => {
  for (const mode of [lenient, strict]) {
    const result = saId.validate(VALID_FEMALE, mode);
    assert.equal(result.valid, true, result.reason);
    assert.equal(result.gender, 'FEMALE');
    assert.equal(result.birthDate.toISOString().slice(0, 10), '1990-02-28');
  }
});

test('reads gender and citizenship from the right digits', () => {
  const result = saId.validate(VALID_MALE_PR, strict);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.gender, 'MALE');
  assert.equal(result.citizenship, 'PERMANENT_RESIDENT');
});

test('tolerates spaces', () => {
  const spaced = `${VALID_FEMALE.slice(0, 6)} ${VALID_FEMALE.slice(6, 10)} ${VALID_FEMALE.slice(10)}`;
  assert.equal(saId.validate(spaced, lenient).valid, true);
});

test('rejects anything that is not 13 digits, in either mode', () => {
  for (const mode of [lenient, strict]) {
    for (const bad of ['', '123', '12345678901234', 'abcdefghijklm', null, undefined]) {
      assert.equal(saId.validate(bad, mode).valid, false, `should reject ${JSON.stringify(bad)}`);
    }
  }
});

test('rejects an impossible date of birth in either mode', () => {
  for (const mode of [lenient, strict]) {
    assert.equal(saId.validate(withCheckDigit('901332' + '0123' + '0' + '8'), mode).valid, false, 'month 13');
    assert.equal(saId.validate(withCheckDigit('900231' + '0123' + '0' + '8'), mode).valid, false, '31 February');
    assert.equal(saId.validate(withCheckDigit('900000' + '0123' + '0' + '8'), mode).valid, false, 'zero month/day');
  }
});

test('infers the century so a birth date is never in the future', () => {
  const currentYY = new Date().getUTCFullYear() % 100;
  const futureYY = String((currentYY + 1) % 100).padStart(2, '0');
  const result = saId.validate(withCheckDigit(`${futureYY}0615` + '0123' + '0' + '8'), lenient);
  assert.equal(result.valid, true, result.reason);
  assert.ok(result.birthDate.getUTCFullYear() < 2000, `got ${result.birthDate.toISOString()}`);
});

// ---------------------------------------------------------------------------
// Lenient mode — the current default
// ---------------------------------------------------------------------------

test('lenient mode accepts a wrong check digit', () => {
  const digits = VALID_FEMALE.split('');
  digits[7] = String((Number(digits[7]) + 1) % 10);
  const mistyped = digits.join('');

  assert.notEqual(mistyped, VALID_FEMALE);
  const result = saId.validate(mistyped, lenient);
  assert.equal(result.valid, true, 'the check digit is not enforced yet');
  assert.equal(result.checkDigitValid, false, 'but the failure is still reported for later use');
});

test('lenient mode accepts an unusual citizenship digit', () => {
  const result = saId.validate(withCheckDigit('900228' + '0123' + '5' + '8'), lenient);
  assert.equal(result.valid, true);
  assert.equal(result.citizenship, 'UNKNOWN', 'reported rather than rejected');
});

test('lenient mode still rejects a bad date, which is the point of keeping it', () => {
  assert.equal(saId.validate('9913320123089', lenient).valid, false);
});

// ---------------------------------------------------------------------------
// Strict mode — behind SA_ID_STRICT, ready for when the register is reconciled
// ---------------------------------------------------------------------------

test('strict mode rejects a single mistyped digit via the check digit', () => {
  const digits = VALID_FEMALE.split('');
  digits[7] = String((Number(digits[7]) + 1) % 10);
  const result = saId.validate(digits.join(''), strict);
  assert.equal(result.valid, false);
  assert.match(result.reason, /check-digit/i);
});

test('strict mode rejects an invalid citizenship digit', () => {
  const result = saId.validate(withCheckDigit('900228' + '0123' + '5' + '8'), strict);
  assert.equal(result.valid, false);
  assert.match(result.reason, /citizenship/i);
});

test('the default mode is lenient until SA_ID_STRICT is set', () => {
  assert.equal(saId.STRICT_BY_DEFAULT, process.env.SA_ID_STRICT === 'true');
  if (!saId.STRICT_BY_DEFAULT) {
    const digits = VALID_FEMALE.split('');
    digits[7] = String((Number(digits[7]) + 1) % 10);
    assert.equal(saId.validate(digits.join('')).valid, true, 'default call must not enforce the check digit');
  }
});

test('luhnValid agrees with an independently computed check digit', () => {
  assert.equal(saId.luhnValid(VALID_FEMALE), true);
  assert.equal(saId.luhnValid(VALID_MALE_PR), true);
});
