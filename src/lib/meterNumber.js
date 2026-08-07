/**
 * Municipal meter number validation — length and character set only.
 *
 * Deliberately NOT a full check. South African meter numbering is not uniform:
 * prepaid electricity meters carry an 11-digit STS number, but conventional
 * credit meters, bulk supplies and water meters are numbered by each
 * municipality's own convention, and legacy captures include hyphens and
 * letters. Enforcing a single format here would reject real meters and block
 * genuine applicants.
 *
 * So this only catches the obvious: something far too short to be a meter
 * number, something implausibly long, or characters that cannot appear on a
 * meter faceplate. Anything that could plausibly be real is accepted.
 *
 * A stricter per-utility check (STS 11-digit validation for prepaid electricity)
 * belongs behind a flag once the municipality's numbering is known.
 */

const MIN_LENGTH = parseInt(process.env.METER_MIN_LENGTH || '5', 10);
const MAX_LENGTH = parseInt(process.env.METER_MAX_LENGTH || '20', 10);

/** Digits, letters, hyphens and slashes are all seen on real meter faceplates. */
const ALLOWED = /^[A-Za-z0-9\-/]+$/;

const LABELS = {
  water: 'water meter number',
  electricity: 'electricity meter number',
};

/**
 * Normalise for storage: strip surrounding and internal whitespace, upper-case
 * so the same meter is not stored two ways.
 */
function normalise(value) {
  return String(value ?? '').replace(/\s+/g, '').toUpperCase();
}

/**
 * Validate a meter number.
 * An empty value is valid — meter numbers are optional on the form.
 *
 * Returns { valid, value, reason? } where `value` is the normalised form.
 */
function validate(value, { kind = 'electricity' } = {}) {
  const cleaned = normalise(value);
  const label = LABELS[kind] || 'meter number';

  if (!cleaned) return { valid: true, value: null };

  if (!ALLOWED.test(cleaned)) {
    return {
      valid: false,
      value: cleaned,
      reason: `A ${label} may only contain letters, numbers, hyphens and slashes.`,
    };
  }

  if (cleaned.length < MIN_LENGTH) {
    return {
      valid: false,
      value: cleaned,
      reason: `That ${label} looks too short — it should be at least ${MIN_LENGTH} characters.`,
    };
  }

  if (cleaned.length > MAX_LENGTH) {
    return {
      valid: false,
      value: cleaned,
      reason: `That ${label} looks too long — it should be at most ${MAX_LENGTH} characters.`,
    };
  }

  return { valid: true, value: cleaned };
}

module.exports = { validate, normalise, MIN_LENGTH, MAX_LENGTH };
