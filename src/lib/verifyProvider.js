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
 * ## Read this before switching to verifynow
 *
 * The adapter below was written *without* access to VerifyNow's API reference
 * (the pages could not be fetched when it was built). The request path, the auth
 * header and the response field names are therefore assumptions, gathered from
 * their public marketing pages, and every one of them is isolated in the
 * `VERIFYNOW_*` settings or in `normaliseVerifyNow()` so that correcting them
 * after reading the real docs is a few lines. It must be run against their
 * sandbox and the response compared with `normaliseVerifyNow()` before a single
 * production credit is spent.
 *
 * Nothing here ever logs the ID number or the response body: both are personal
 * information, and a log file is not a place POPIA expects to find them.
 */

const PROVIDER = process.env.VERIFY_PROVIDER || 'mock';
const TIMEOUT_MS = parseInt(process.env.VERIFY_TIMEOUT_MS || '20000', 10);

class ProviderError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
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

/**
 * Turn VerifyNow's response into { found, firstNames, surname, deceased, credits, ref }.
 *
 * ASSUMED field names — confirm against the sandbox. Each lookup tries a few
 * plausible spellings so a near miss degrades to "unknown" instead of throwing.
 */
function normaliseVerifyNow(body) {
  const data = body?.data ?? body?.result ?? body ?? {};
  const pick = (...keys) => keys.map((k) => data[k]).find((v) => v !== undefined && v !== null);

  const status = String(pick('status', 'result', 'outcome') ?? '').toLowerCase();
  const notFound = ['not_found', 'notfound', 'no_record', 'invalid', 'failed'].includes(status)
    || pick('found', 'exists') === false;

  const deceasedRaw = pick('deceased', 'isDeceased', 'deceasedStatus');
  const deceased = typeof deceasedRaw === 'string'
    ? ['yes', 'true', 'deceased'].includes(deceasedRaw.toLowerCase())
    : deceasedRaw === true;

  return {
    found: !notFound,
    firstNames: pick('firstNames', 'first_names', 'forenames', 'firstName'),
    surname: pick('surname', 'lastName', 'last_name'),
    deceased,
    credits: Number(pick('creditsUsed', 'credits_used', 'credits') ?? 0) || null,
    ref: pick('reference', 'requestId', 'request_id', 'id') ?? null,
  };
}

/**
 * One authenticated call to VerifyNow. Every check type goes through here, so
 * the auth scheme, timeout and error mapping are written once.
 *
 * `reportType` and the path are the parts most likely to need correcting against
 * the real API reference; both are settings, not code.
 */
async function callVerifyNow({ reportType, path, payload, idempotencyKey }) {
  const base = process.env.VERIFYNOW_BASE_URL;
  const key = process.env.VERIFYNOW_API_KEY;
  if (!base || !key) {
    throw new ProviderError('VERIFY_PROVIDER is "verifynow" but VERIFYNOW_BASE_URL or VERIFYNOW_API_KEY is not set');
  }

  // Their pages show both a Bearer token and an x-api-key header. Set
  // VERIFYNOW_AUTH_HEADER=x-api-key to switch; Bearer is the default.
  const headerName = (process.env.VERIFYNOW_AUTH_HEADER || 'authorization').toLowerCase();
  const authHeader = headerName === 'authorization' ? { Authorization: `Bearer ${key}` } : { [headerName]: key };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader,
        // A retry after a timeout must not be billed twice.
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify({ reportType, consent: true, ...payload }),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) throw new ProviderError('The verification provider rejected our credentials.');
    if (res.status === 402) throw new ProviderError('The verification account is out of credits.');
    if (res.status === 429 || res.status >= 500) throw new ProviderError(`The verification provider is unavailable (${res.status}).`, { retryable: true });
    if (!res.ok) throw new ProviderError(`The verification provider refused the request (${res.status}).`);

    try { return await res.json(); } catch { throw new ProviderError('The verification provider sent a response we could not read.'); }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error.name === 'AbortError') throw new ProviderError('The verification provider took too long to answer.', { retryable: true });
    throw new ProviderError('We could not reach the verification provider.', { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

const tri = (v) => (v === true || v === false ? v : typeof v === 'string' ? ['yes', 'true', 'match', 'matched'].includes(v.toLowerCase()) ? true : ['no', 'false', 'mismatch', 'no_match'].includes(v.toLowerCase()) ? false : null : null);

/** ASSUMED field names for the bank response — confirm against the sandbox. */
function normaliseVerifyNowBank(body) {
  const data = body?.data ?? body?.result ?? body ?? {};
  const pick = (...keys) => keys.map((k) => data[k]).find((v) => v !== undefined && v !== null);
  return {
    accountFound: tri(pick('accountFound', 'account_found', 'accountExists', 'exists')),
    accountOpen: tri(pick('accountOpen', 'account_open', 'accountActive', 'active')),
    idMatch: tri(pick('idMatch', 'id_match', 'idNumberMatch', 'identityMatch')),
    acceptsCredits: tri(pick('acceptsCredits', 'accepts_credits', 'acceptCredits')),
    credits: Number(pick('creditsUsed', 'credits_used', 'credits') ?? 0) || null,
    ref: pick('reference', 'requestId', 'request_id', 'id') ?? null,
  };
}

/** ASSUMED field names for the property response — confirm against the sandbox. */
function normaliseVerifyNowProperty(body) {
  const data = body?.data ?? body?.result ?? body ?? {};
  const pick = (...keys) => keys.map((k) => data[k]).find((v) => v !== undefined && v !== null);
  const list = pick('properties', 'results', 'deeds') ?? [];
  return {
    properties: (Array.isArray(list) ? list : []).map((p) => ({
      description: p.description || p.propertyDescription
        || [p.erf && `Erf ${p.erf}`, p.township, p.registrationDivision].filter(Boolean).join(', ')
        || p.lpiCode || null,
    })),
    credits: Number(pick('creditsUsed', 'credits_used', 'credits') ?? 0) || null,
    ref: pick('reference', 'requestId', 'request_id', 'id') ?? null,
  };
}

async function checkIdVerifyNow({ idNumber, idempotencyKey }) {
  const body = await callVerifyNow({
    reportType: process.env.VERIFYNOW_ID_REPORT_TYPE || 'home_affairs_id_photo',
    path: process.env.VERIFYNOW_ID_PATH || '/verify',
    payload: { idNumber },
    idempotencyKey,
  });
  return normaliseVerifyNow(body);
}

async function checkBankVerifyNow({ idNumber, accountNumber, bankName, accountType, idempotencyKey }) {
  const body = await callVerifyNow({
    reportType: process.env.VERIFYNOW_BANK_REPORT_TYPE || 'bank_account_verification',
    path: process.env.VERIFYNOW_BANK_PATH || '/verify',
    payload: { idNumber, accountNumber, bankName, accountType },
    idempotencyKey,
  });
  return normaliseVerifyNowBank(body);
}

async function checkPropertyVerifyNow({ idNumber, idempotencyKey }) {
  const body = await callVerifyNow({
    reportType: process.env.VERIFYNOW_PROPERTY_REPORT_TYPE || 'property_search',
    path: process.env.VERIFYNOW_PROPERTY_PATH || '/verify',
    payload: { idNumber },
    idempotencyKey,
  });
  return normaliseVerifyNowProperty(body);
}

// ---------------------------------------------------------------------------

const PROVIDERS = {
  mock: { name: 'mock', checkId: checkIdMock, checkBank: checkBankMock, checkProperty: checkPropertyMock },
  verifynow: { name: 'verifynow', checkId: checkIdVerifyNow, checkBank: checkBankVerifyNow, checkProperty: checkPropertyVerifyNow },
};

function active() {
  const provider = PROVIDERS[PROVIDER];
  if (!provider) {
    throw new ProviderError(`Unknown VERIFY_PROVIDER "${PROVIDER}". Use "mock" or "verifynow".`);
  }
  return provider;
}

module.exports = { active, ProviderError, normaliseVerifyNow, normaliseVerifyNowBank, normaliseVerifyNowProperty, PROVIDER };
