/**
 * External identity verification.
 *
 * Same shape as sms.js and geocode.js: one interface, provider chosen by
 * configuration, so going live is a change to .env rather than to code.
 *
 *  - **mock** (default) — answers from the ID number alone, with no network and
 *    no cost. Development and CI use it, so the whole flow can be exercised
 *    without an account.
 *  - **verifynow** — VerifyNow's REST API. Paid per check, in credits.
 *
 * ## VerifyNow
 *
 * Written against VerifyNow's published API reference (www.verifynow.co.za/api-docs,
 * "last updated 3 Nov 2026"). The facts it relies on, so a change on their side
 * is easy to spot:
 *
 *  - base URL https://www.verifynow.co.za/api/external; auth is an `x-api-key` header;
 *  - every request carries `mode`: "sandbox" (mock data, free) or "production"
 *    (real, billed). It defaults to sandbox here and only goes live when
 *    VERIFYNOW_MODE=production is set on purpose;
 *  - production POSTs need an Idempotency-Key (8–160 chars); the same key with the
 *    same body replays the saved answer without a second charge;
 *  - ID check:  POST /verify  reportType home_affairs_real_time_idv (3 credits —
 *    names and deceased status). `said_verification` (1 credit) is cheaper but
 *    does NOT return deceased status;
 *  - bank:      POST /bank-account-verification (6 credits, not charged when
 *    unsuccessful); needs a 6-digit branch code, 7–13 digit account number;
 *  - property:  POST /property-search (10 credits, charged even when nothing is found);
 *  - "no record" on /verify is HTTP 502 + code NO_RECORD_FOUND, a completed and
 *    charged negative — NOT the same as 502 VERIFICATION_TEMPORARILY_UNAVAILABLE.
 *
 * Not yet run against the live service (no API key was available): the response
 * parsers follow the documented examples, and an unreadable response is raised
 * as an error rather than guessed at — a misread must never become a FAIL
 * against a real person. Run it against the sandbox first.
 *
 * Nothing here ever logs the ID number or the response body: both are personal
 * information, and a log file is not a place POPIA expects to find them.
 */

const PROVIDER = process.env.VERIFY_PROVIDER || 'mock';
const TIMEOUT_MS = parseInt(process.env.VERIFY_TIMEOUT_MS || '20000', 10);

class ProviderError extends Error {
  /**
   * `retryable`  — trying the same thing again later may work.
   * `rejected`   — the provider refused the *input* (a bad account number, say);
   *                the officer can correct it. It says nothing about the applicant.
   */
  constructor(message, { retryable = false, rejected = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
    this.rejected = rejected;
  }
}

/** A completed negative: the register has no such person. Billed, and a real answer. */
class NoRecord extends Error {
  constructor(charged = true) {
    super('no record');
    this.name = 'NoRecord';
    this.charged = charged;
  }
}

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------

/**
 * Deterministic answers so every outcome can be demonstrated and tested:
 *
 *   ID ending 0000 → no record
 *   ID ending 1111 → holder deceased
 *   ID ending 2222 → name on register differs from the application
 *   anything else  → found, and the name echoes whatever was submitted
 */
async function checkIdMock({ idNumber, fullName, surname }) {
  const tail = String(idNumber).slice(-4);
  if (tail === '0000') return { found: false, credits: 0, ref: `mock-${Date.now()}` };
  if (tail === '1111') return { found: true, deceased: true, firstNames: fullName, surname, credits: 0, ref: `mock-${Date.now()}` };
  if (tail === '2222') return { found: true, deceased: false, firstNames: 'Different', surname: 'Person', credits: 0, ref: `mock-${Date.now()}` };
  return { found: true, deceased: false, firstNames: fullName, surname, credits: 0, ref: `mock-${Date.now()}` };
}

/**
 * Bank account, by the last four digits of the account number:
 *
 *   0000 → no such account
 *   1111 → account closed
 *   2222 → open, but held by somebody else
 *   anything else → open and held by this ID number
 */
async function checkBankMock({ accountNumber }) {
  const tail = String(accountNumber).slice(-4);
  const ref = `mock-${Date.now()}`;
  if (tail === '0000') return { accountFound: false, credits: 0, ref };
  if (tail === '1111') return { accountFound: true, accountOpen: false, credits: 0, ref };
  if (tail === '2222') return { accountFound: true, accountOpen: true, idMatch: false, acceptsCredits: true, credits: 0, ref };
  return { accountFound: true, accountOpen: true, idMatch: true, acceptsCredits: true, credits: 0, ref };
}

/**
 * Registered property, by the last four digits of the ID number:
 *
 *   3333 → two properties
 *   4444 → one property
 *   anything else → none
 */
async function checkPropertyMock({ idNumber }) {
  const tail = String(idNumber).slice(-4);
  const ref = `mock-${Date.now()}`;
  const erf = (n) => ({ description: `Erf ${n}, Mock Township, Registration Division JR` });
  if (tail === '3333') return { properties: [erf(101), erf(202)], credits: 0, ref };
  if (tail === '4444') return { properties: [erf(101)], credits: 0, ref };
  return { properties: [], credits: 0, ref };
}

// ---------------------------------------------------------------------------
// verifynow
// ---------------------------------------------------------------------------

const DEFAULT_BASE = 'https://www.verifynow.co.za/api/external';

/** Sandbox unless production is asked for by name. A typo must never spend money. */
const vnMode = () => (String(process.env.VERIFYNOW_MODE || '').toLowerCase() === 'production' ? 'production' : 'sandbox');

/** Credits each product costs, from their pricing, for the cost cap. Overridable if their prices change. */
const CREDITS = {
  home_affairs_real_time_idv: 3,
  said_verification: 1,
  bank: 6,
  property: 10,
};
const creditsFor = (key) => {
  const override = parseInt(process.env[`VERIFYNOW_CREDITS_${key.toUpperCase()}`] || '', 10);
  return Number.isFinite(override) ? override : CREDITS[key];
};

/**
 * One authenticated call to VerifyNow. Every check goes through here, so the
 * auth, timeout and error mapping are written once.
 *
 * Returns the parsed body of a 200. Anything else is mapped to a typed error:
 * NoRecord for a completed negative, ProviderError (with retryable / rejected)
 * for the rest.
 */
async function callVerifyNow({ path, payload, idempotencyKey }) {
  const key = process.env.VERIFYNOW_API_KEY;
  if (!key) throw new ProviderError('VERIFY_PROVIDER is "verifynow" but VERIFYNOW_API_KEY is not set');
  const base = (process.env.VERIFYNOW_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        // Required in production: a retry after a timeout must not be billed twice.
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify({ ...payload, mode: vnMode() }),
      signal: controller.signal,
    });

    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    const code = body?.code;
    const detail = body?.error || body?.message;

    if (res.ok && res.status === 200) {
      if (!body || typeof body !== 'object') throw new ProviderError('The verification provider sent a response we could not read.');
      return body;
    }
    if (res.status === 202) throw new ProviderError('The verification provider is still processing this request. Try again in a moment.', { retryable: true });
    if (res.status === 400) throw new ProviderError(`The verification provider rejected the request${detail ? `: ${detail}` : ''}.`, { rejected: true });
    if (res.status === 401 || res.status === 403) throw new ProviderError('The verification provider rejected our API key.');
    if (res.status === 402) throw new ProviderError('The verification account is out of credits.');
    if (res.status === 409) {
      if (code === 'REQUEST_IN_PROGRESS') throw new ProviderError('This check is already in progress. Try again in a moment.', { retryable: true });
      throw new ProviderError('The verification provider saw this request key used for a different request.');
    }
    if (res.status === 429) throw new ProviderError('The verification provider is rate limiting us. Try again in a few seconds.', { retryable: true });
    // A completed negative arrives as an error status. It is an answer, not a fault.
    if (code === 'NO_RECORD_FOUND') throw new NoRecord(body?.charged !== false);
    if (res.status >= 500) throw new ProviderError(`The verification provider could not complete the check (${res.status}).`, { retryable: true });
    throw new ProviderError(`The verification provider refused the request (${res.status}).`);
  } catch (error) {
    if (error instanceof ProviderError || error instanceof NoRecord) throw error;
    if (error.name === 'AbortError') throw new ProviderError('The verification provider took too long to answer.', { retryable: true });
    throw new ProviderError('We could not reach the verification provider.', { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

/** "Yes"/"No"/true/false → boolean; anything else, including absent, → null (unknown, not "no"). */
const tri = (v) => {
  if (v === true || v === false) return v;
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (['yes', 'true', 'y', 'matched', 'match'].includes(t)) return true;
  if (['no', 'false', 'n', 'not matched', 'no match', 'mismatch'].includes(t)) return false;
  return null;
};

const unreadable = () => new ProviderError('The verification provider sent a response we could not understand. Nothing was recorded.');

/**
 * Home Affairs ID result → { found, firstNames, surname, deceased, idMismatch, credits, ref }.
 *
 * Reads both products: `home_affairs_real_time_idv` (realTimeResults.firstNames /
 * surName / deceasedStatus) and `said_verification` (realTimeResults.Verification.
 * Firstnames / Lastname, no deceased flag). A body with neither is unreadable and
 * raises, rather than being taken for "no such person".
 */
function normaliseVerifyNow(body, reportType = 'home_affairs_real_time_idv') {
  const results = body?.results;
  const entry = results?.[reportType] || (results && Object.values(results)[0]);
  const rt = entry?.realTimeResults;
  if (!rt || typeof rt !== 'object') throw unreadable();

  const v = rt.Verification || {};
  const firstNames = rt.firstNames ?? v.Firstnames ?? v.FirstNames ?? null;
  const surname = rt.surName ?? rt.surname ?? v.Lastname ?? v.Surname ?? null;
  if (!firstNames && !surname) throw unreadable();

  // Deceased: known only when the source said so. Absent is unknown, never "alive".
  let deceased = null;
  if (rt.deceasedStatus !== undefined && rt.deceasedStatus !== null && String(rt.deceasedStatus).trim() !== '') {
    const t = String(rt.deceasedStatus).trim().toLowerCase();
    if (['deceased', 'yes', 'true', 'y'].includes(t)) deceased = true;
    else if (['alive', 'no', 'false', 'n', 'not deceased'].includes(t)) deceased = false;
  }
  if (deceased === null && rt.deceasedDate) deceased = true;

  const matchStatus = rt.idnoMatchStatus;
  const idMismatch = matchStatus !== undefined && matchStatus !== null && String(matchStatus).trim() !== '' && !/^match/i.test(String(matchStatus).trim());

  return {
    found: true,
    firstNames,
    surname,
    deceased,
    idMismatch,
    credits: creditsFor(reportType in CREDITS ? reportType : 'home_affairs_real_time_idv'),
    ref: body.requestId ?? entry.transaction_id ?? null,
  };
}

/**
 * Bank result → { accountFound, accountOpen, idMatch, acceptsCredits, credits, ref }.
 *
 * Completed outcomes come back as HTTP 200 with `success` and `response_code`:
 *   success: true                 → read verification_results
 *   success: false, code 6        → CDV error: the account number fails the bank's
 *                                   check-digit test. NOT a verdict on the applicant;
 *                                   raised as a rejected input so the officer corrects it.
 *   success: false, code 4        → a completed negative (not billed)
 *   anything else                 → unreadable; raised, never guessed.
 */
function normaliseVerifyNowBank(body) {
  if (!body || typeof body !== 'object') throw unreadable();
  const vr = body.results?.verification_results || {};
  const ref = body.requestId ?? vr.bankReference ?? null;

  if (body.success === false) {
    if (Number(body.response_code) === 6) {
      throw new ProviderError(
        'The bank says that account number does not pass its check-digit test for that bank and branch. '
        + 'Check the bank and the account number against the statement. You were not charged.',
        { rejected: true },
      );
    }
    if (Number(body.response_code) === 4) {
      return {
        accountFound: tri(vr.accountFound) ?? false,
        accountOpen: tri(vr.accountOpen),
        idMatch: tri(vr.identityMatch),
        acceptsCredits: tri(vr.acceptsCredits),
        credits: Number(body.credits_used ?? 0) || 0,
        ref,
      };
    }
    throw unreadable();
  }
  if (body.success !== true || !body.results) throw unreadable();

  return {
    accountFound: tri(vr.accountFound),
    accountOpen: tri(vr.accountOpen),
    idMatch: tri(vr.identityMatch),
    acceptsCredits: tri(vr.acceptsCredits),
    credits: Number(body.credits_used ?? creditsFor('bank')) || null,
    ref,
  };
}

/**
 * Property result → { properties: [{ description }], credits, ref }.
 *
 * Only a one-line description is kept. The response also carries the buyer's
 * name, purchase price and bond details; none of that is needed to compare
 * ownership with a declaration, so none of it leaves this function.
 */
function normaliseVerifyNowProperty(body) {
  if (!body || typeof body !== 'object' || typeof body.found !== 'boolean') throw unreadable();
  const list = body.found && Array.isArray(body.properties) ? body.properties : [];
  return {
    properties: list.map((p) => ({
      description: [p.titleDeedNumber, p.physicalAddress, p.propertyType && `(${p.propertyType})`].filter(Boolean).join(' — ').replace(' — (', ' (') || 'property on the deeds register',
    })),
    credits: Number(body.credits_used ?? creditsFor('property')) || null,
    ref: body.requestId ?? null,
  };
}

async function checkIdVerifyNow({ idNumber, idempotencyKey }) {
  const reportType = process.env.VERIFYNOW_ID_REPORT_TYPE || 'home_affairs_real_time_idv';
  try {
    const body = await callVerifyNow({ path: '/verify', payload: { reportType, idNumber }, idempotencyKey });
    return normaliseVerifyNow(body, reportType);
  } catch (error) {
    // A completed negative: there is no such person on the register.
    if (error instanceof NoRecord) return { found: false, credits: error.charged ? creditsFor(reportType in CREDITS ? reportType : 'home_affairs_real_time_idv') : 0, ref: null };
    throw error;
  }
}

/** First given name only: the bank match does not need the rest, and less is less to leak. */
const firstGiven = (fullName) => String(fullName || '').trim().split(/\s+/)[0] || '';

const ACCOUNT_TYPE_LABEL = { CURRENT: 'Current', SAVINGS: 'Savings', TRANSMISSION: 'Transmission', UNKNOWN: 'Unknown' };

async function checkBankVerifyNow({ idNumber, fullName, surname, accountNumber, bankName, bankBranchCode, accountType, idempotencyKey }) {
  const body = await callVerifyNow({
    path: '/bank-account-verification',
    payload: {
      type: 'Individual',
      firstName: firstGiven(fullName),
      surname,
      identityNumber: idNumber,
      identityType: 'IDNumber',
      bankName,
      bankAccountNumber: accountNumber,
      bankBranchCode,
      bankAccountType: ACCOUNT_TYPE_LABEL[accountType] || 'Unknown',
    },
    idempotencyKey,
  });
  return normaliseVerifyNowBank(body);
}

async function checkPropertyVerifyNow({ idNumber, idempotencyKey }) {
  const body = await callVerifyNow({ path: '/property-search', payload: { idNumber }, idempotencyKey });
  return normaliseVerifyNowProperty(body);
}

// ---------------------------------------------------------------------------

const PROVIDERS = {
  mock: { name: 'mock', testData: true, checkId: checkIdMock, checkBank: checkBankMock, checkProperty: checkPropertyMock },
  verifynow: {
    // The mode is part of the name, so a sandbox result recorded in the database
    // can never be mistaken for a real one.
    get name() { return `verifynow-${vnMode()}`; },
    get testData() { return vnMode() === 'sandbox'; },
    checkId: checkIdVerifyNow,
    checkBank: checkBankVerifyNow,
    checkProperty: checkPropertyVerifyNow,
  },
};

function active() {
  const provider = PROVIDERS[PROVIDER];
  if (!provider) {
    throw new ProviderError(`Unknown VERIFY_PROVIDER "${PROVIDER}". Use "mock" or "verifynow".`);
  }
  return provider;
}

/** For tests: a provider by name, regardless of VERIFY_PROVIDER. */
const named = (name) => PROVIDERS[name];

/**
 * Things worth saying at boot. Not fatal: a municipality may not use automated
 * checks at all, but nobody should discover a misconfiguration from a result.
 */
function warnings() {
  const list = [];
  if (PROVIDER === 'mock' && process.env.NODE_ENV === 'production') {
    list.push('VERIFY_PROVIDER is "mock" in production: automated checks answer from the last digits of the number and are NOT real. Set VERIFY_PROVIDER=verifynow.');
  }
  if (PROVIDER === 'verifynow') {
    if (!process.env.VERIFYNOW_API_KEY) list.push('VERIFY_PROVIDER=verifynow but VERIFYNOW_API_KEY is not set.');
    if (vnMode() === 'sandbox') list.push('VerifyNow is in SANDBOX mode: results are test data and free. Set VERIFYNOW_MODE=production to run real checks.');
  }
  return list;
}

module.exports = { active, named, warnings, ProviderError, NoRecord, normaliseVerifyNow, normaliseVerifyNowBank, normaliseVerifyNowProperty, callVerifyNow, PROVIDER };
