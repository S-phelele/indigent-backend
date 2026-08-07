const crypto = require('crypto');

/**
 * Password rules and temporary passwords.
 *
 * The policy lived inside admin.js as a private function while three other
 * places needed it. It is the sort of thing that gets reimplemented slightly
 * differently each time, so it now lives here and everything imports it.
 */

/** Returns the unmet requirements, phrased to be shown directly to a person. */
function passwordProblems(password) {
  const value = password || '';
  const problems = [];
  if (value.length < 8) problems.push('at least 8 characters');
  if (!/[A-Z]/.test(value)) problems.push('a capital letter');
  if (!/[a-z]/.test(value)) problems.push('a small letter');
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(value)) {
    problems.push('a special character (e.g. @, !, #, %, &)');
  }
  return problems;
}

/**
 * Characters that survive being read off a phone screen and typed again.
 *
 * No O/0, no I/l/1, no S/5, no B/8. Someone is going to read this out of an SMS
 * to a resident holding a borrowed handset, and every ambiguous glyph is a failed
 * sign-in and a phone call to the municipality.
 */
const UPPER = 'ACDEFHJKMNPQRTUVWXY';
const LOWER = 'acdefhjkmnpqrtuvwxy';
const DIGITS = '234679';
const SYMBOLS = '@#%&*!';

const pick = (alphabet) => alphabet[crypto.randomInt(0, alphabet.length)];

/**
 * A temporary password that satisfies the policy and can be dictated.
 *
 * Shaped as `Abcd-2345` — grouped, hyphenated, and always containing one of each
 * required class by construction rather than by retrying until it passes.
 */
function temporaryPassword() {
  const letters = [pick(UPPER), pick(LOWER), pick(LOWER), pick(LOWER)];
  const rest = [pick(DIGITS), pick(DIGITS), pick(DIGITS), pick(SYMBOLS)];

  // Shuffle the tail so the symbol is not always in the same position.
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }

  const password = `${letters.join('')}-${rest.join('')}`;

  /* istanbul ignore next — construction guarantees this; the check is a tripwire
     in case the alphabets above are edited carelessly. */
  if (passwordProblems(password).length) {
    throw new Error('temporaryPassword generated a value that fails the password policy');
  }
  return password;
}

module.exports = { passwordProblems, temporaryPassword };
