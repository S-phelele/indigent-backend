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

// ---------------------------------------------------------------------------
// Bank account
// ---------------------------------------------------------------------------

/** "•••• 4321" — the only part of an account number that is ever kept or shown. */
function lastFour(accountNumber) {
  const digits = String(accountNumber ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : digits;
}

/**
 * What a bank's answer means.
 *
 * `result` is the adapter's normalised answer:
 *   { accountFound, accountOpen, idMatch, acceptsCredits }
 * each true, false or null/undefined when the bank did not say.
 *
 * An account that does not exist or is closed is a FAIL: it was offered as
 * evidence and is not what it was said to be. An account that exists but is held
 * by somebody else is INCONCLUSIVE, not FAIL — households very commonly bank
 * through a spouse's, parent's or adult child's account, and treating that as
 * dishonesty would punish exactly the people the register is for.
 */
function evaluateBank(result, { accountNumber } = {}) {
  const tag = lastFour(accountNumber) ? ` ending ${lastFour(accountNumber)}` : '';

  if (!result || result.accountFound === false) {
    return { outcome: 'FAIL', findings: `The bank has no open account${tag} with those details.` };
  }
  if (result.accountOpen === false) {
    return { outcome: 'FAIL', findings: `The account${tag} exists but is closed or dormant.` };
  }
  if (result.idMatch === false) {
    return {
      outcome: 'INCONCLUSIVE',
      findings: `The account${tag} is open, but is not held by this ID number. It may belong to a relative; ask the applicant.`,
    };
  }
  if (result.accountFound === true && result.accountOpen !== false && result.idMatch === true) {
    const credits = result.acceptsCredits === false ? ' It does not accept credits, so it cannot receive a payment.' : '';
    return { outcome: 'PASS', findings: `The account${tag} is open and held by this ID number.${credits}` };
  }
  return {
    outcome: 'INCONCLUSIVE',
    findings: `The account${tag} was found, but the bank did not confirm who holds it.`,
  };
}

// ---------------------------------------------------------------------------
// Property (deeds)
// ---------------------------------------------------------------------------

const MAX_LISTED = 3;

function listProperties(properties) {
  const shown = properties.slice(0, MAX_LISTED).map((p) => p.description || 'unnamed property');
  const more = properties.length > MAX_LISTED ? ` and ${properties.length - MAX_LISTED} more` : '';
  return `${shown.join('; ')}${more}`;
}

/**
 * Compare the properties registered to an ID number with what was declared.
 *
 * `result.properties` is a list of { description }. `declared` carries
 * { tenure, ownsOtherProperty }.
 *
 * How many properties are *expected*: somebody who says they own the dwelling
 * they live in is expected to appear once; anybody who declares another property
 * is expected to appear at least once more. More than that contradicts the
 * declaration.
 *
 * That contradiction is a FAIL only where the applicant explicitly said they own
 * no other property. Where the question was left blank it is INCONCLUSIVE — an
 * unanswered question is not a false answer.
 */
function evaluateProperty(result, declared = {}) {
  const properties = Array.isArray(result?.properties) ? result.properties : [];
  const owns = declared.tenure === 'OWNER' ? 1 : 0;
  const expected = owns + (declared.ownsOtherProperty ? 1 : 0);

  if (properties.length === 0) {
    if (owns || declared.ownsOtherProperty) {
      return {
        outcome: 'INCONCLUSIVE',
        findings: 'No property is registered to this ID number, although ownership was declared. '
          + 'Informal, communal or untransferred property will not appear on the deeds register.',
      };
    }
    return { outcome: 'PASS', findings: 'No registered property found for this ID number.' };
  }

  if (properties.length > expected) {
    const outcome = declared.ownsOtherProperty === false ? 'FAIL' : 'INCONCLUSIVE';
    return {
      outcome,
      findings: `${properties.length} registered ${properties.length === 1 ? 'property' : 'properties'} found `
        + `(${listProperties(properties)}), more than the ${expected} declared.`,
    };
  }

  return {
    outcome: 'PASS',
    findings: `${properties.length} registered ${properties.length === 1 ? 'property' : 'properties'} found, consistent with the declaration (${listProperties(properties)}).`,
  };
}

module.exports = { evaluate, evaluateBank, evaluateProperty, lastFour, normalise, firstGivenName, namesAgree };
