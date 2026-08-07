/**
 * South African ID number validation.
 *
 * The register previously accepted any free text as an ID number. On a system
 * deciding who receives municipal support, a mistyped or invented ID makes
 * duplicate detection and later reconciliation impossible — and the format
 * carries a check digit that catches most typos for free.
 *
 * Layout: YYMMDD SSSS C A Z  (13 digits)
 *   YYMMDD  date of birth
 *   SSSS    sequence; 0000–4999 female, 5000–9999 male
 *   C       citizenship: 0 = SA citizen, 1 = permanent resident
 *   A       historically a race digit, now effectively unused
 *   Z       Luhn check digit over the preceding 12
 */

/** Standard Luhn over the full 13 digits (the 13th is the check digit). */
function luhnValid(id) {
  let sum = 0;
  let double = false;
  for (let i = id.length - 1; i >= 0; i--) {
    let digit = Number(id[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Turn YYMMDD into a real date. The century is inferred: a birth date that would
 * be in the future must belong to the previous century.
 */
function parseBirthDate(id) {
  const yy = Number(id.slice(0, 2));
  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));

  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const currentYY = new Date().getUTCFullYear() % 100;
  const century = yy <= currentYY ? 2000 : 1900;
  const date = new Date(Date.UTC(century + yy, mm - 1, dd));

  // Rejects impossible dates such as 31 February, which roll over.
  if (date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return null;
  if (date.getTime() > Date.now()) return null;

  return date;
}

/**
 * Whether the citizenship-digit and Luhn check-digit rules are enforced.
 *
 * Currently off. Those two rules reject real-world data that municipalities do
 * still hold — legacy captures, and cards where the check digit was mistyped at
 * source — and turning them on before the register has been reconciled would
 * lock people out of applying. Only the date-of-birth rule is enforced for now,
 * which catches genuine typos without being able to reject a valid person.
 *
 * Set SA_ID_STRICT=true to enable the full check once that work is done; the
 * logic below is already written and tested for both modes.
 */
const STRICT_BY_DEFAULT = process.env.SA_ID_STRICT === 'true';

/**
 * Validate an ID number.
 *
 * Always enforced: 13 digits, and the first six being a real date of birth.
 * Enforced only in strict mode: the citizenship digit and the Luhn check digit.
 *
 * Returns { valid, reason?, birthDate?, gender?, citizenship?, strict }.
 */
function validate(value, { strict = STRICT_BY_DEFAULT } = {}) {
  const id = String(value ?? '').replace(/\s/g, '');

  if (!/^\d{13}$/.test(id)) {
    return { valid: false, reason: 'A South African ID number must be exactly 13 digits', strict };
  }

  const birthDate = parseBirthDate(id);
  if (!birthDate) {
    return { valid: false, reason: 'The first six digits are not a valid date of birth', strict };
  }

  const citizenshipDigit = Number(id[10]);

  if (strict) {
    if (citizenshipDigit > 1) {
      return { valid: false, reason: 'The citizenship digit must be 0 or 1', strict };
    }
    if (!luhnValid(id)) {
      return { valid: false, reason: 'That ID number failed its check-digit test. Please re-enter it.', strict };
    }
  }

  return {
    valid: true,
    strict,
    birthDate,
    gender: Number(id.slice(6, 10)) < 5000 ? 'FEMALE' : 'MALE',
    // Only meaningful when the digit is one of the two defined values; in
    // lenient mode anything else is reported as unknown rather than rejected.
    citizenship: citizenshipDigit === 0 ? 'CITIZEN' : citizenshipDigit === 1 ? 'PERMANENT_RESIDENT' : 'UNKNOWN',
    // Surfaced so a caller can warn without blocking.
    checkDigitValid: luhnValid(id),
  };
}

module.exports = { validate, luhnValid, STRICT_BY_DEFAULT };
