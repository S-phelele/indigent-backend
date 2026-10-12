/**
 * Deciding what a Home Affairs answer means.
 *
 * The provider tells us who the register says holds an ID number. This module
 * compares that to who the applicant said they were and turns the difference
 * into a CheckOutcome and a sentence an officer can act on.
 *
 * It is deliberately separate from the provider and does no I/O, so the rules
 * that decide whether somebody's application is flagged can be tested without a
 * network, a database or a paid call.
 *
 * ## What counts as a mismatch
 *
 * Names on a register and names on a form differ for innocent reasons: a second
 * given name left off, a hyphen, an accent, a maiden name. Treating every
 * difference as a failure would send honest households to the bottom of the
 * queue, so only the surname and the *first* given name are compared, and a
 * partial match is INCONCLUSIVE — a prompt for a human to look — never FAIL.
 * FAIL is reserved for what cannot be innocent: an ID number that does not
 * exist, one belonging to somebody else entirely, or one held by a person the
 * register records as deceased.
 */

/** Lower-case, strip accents, punctuation and surplus whitespace. */
function normalise(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first of the given names: the one most reliably written the same way. */
function firstGivenName(fullName) {
  return normalise(fullName).split(' ')[0] || '';
}

/** Two names agree if they are equal once normalised. Empty never agrees with anything. */
function namesAgree(a, b) {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return false;
  return x === y;
}

/**
 * Compare the provider's answer with the application.
 *
 * `result` is the provider adapter's normalised answer:
 *   { found: boolean, firstNames?: string, surname?: string, deceased?: boolean }
 * `declared` is { fullName, surname }.
 *
 * Returns { outcome, findings } with outcome one of PASS | FAIL | INCONCLUSIVE.
 */
function evaluate(result, declared = {}) {
  if (!result || result.found === false) {
    return {
      outcome: 'FAIL',
      findings: 'Home Affairs has no record of this ID number.',
    };
  }

  if (result.deceased === true) {
    return {
      outcome: 'FAIL',
      findings: 'Home Affairs records the holder of this ID number as deceased.',
    };
  }

  const surnameOk = namesAgree(result.surname, declared.surname);
  const firstOk = namesAgree(firstGivenName(result.firstNames), firstGivenName(declared.fullName));

  if (surnameOk && firstOk) {
    return { outcome: 'PASS', findings: 'ID number found. Surname and first name match the application.' };
  }

  // The ID exists and is a live person, but the name is different. Could be a
  // maiden name or a typo — or somebody else's number. That is a judgement call.
  const parts = [];
  if (!surnameOk) parts.push('surname');
  if (!firstOk) parts.push('first name');
  return {
    outcome: 'INCONCLUSIVE',
    findings: `ID number found, but the ${parts.join(' and ')} on the register ${parts.length > 1 ? 'do' : 'does'} not match the application. Register: ${[result.firstNames, result.surname].filter(Boolean).join(' ') || 'unavailable'}.`,
  };
}

module.exports = { evaluate, normalise, firstGivenName, namesAgree };
