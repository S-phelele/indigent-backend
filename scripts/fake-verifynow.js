#!/usr/bin/env node
/**
 * A local stand-in for VerifyNow that speaks the protocol in their published API
 * reference (www.verifynow.co.za/api-docs), so the real adapter can be run end to
 * end with no account, no key and no cost.
 *
 *     node scripts/fake-verifynow.js                       # http://127.0.0.1:4010
 *     FAKE_PORT=4010 FAKE_NAMES="GRACE|MTHEMBU" node scripts/fake-verifynow.js
 *
 * Then point the API at it:
 *
 *     VERIFY_PROVIDER=verifynow VERIFYNOW_API_KEY=anything \
 *     VERIFYNOW_BASE_URL=http://127.0.0.1:4010/api/external npm run dev
 *
 * ## What it enforces, as the real service does
 *
 *  - an `x-api-key` header (401 without);
 *  - `mode` of "sandbox" or "production" in the body (400 otherwise);
 *  - in production, an `Idempotency-Key` of 8–160 characters; the same key with the
 *    same body replays the saved answer, with a different body is 409;
 *  - the real error shapes, including a *completed negative* that arrives as an
 *    error status (502 NO_RECORD_FOUND on /verify).
 *
 * ## What it does NOT prove
 *
 * That VerifyNow behaves as its documentation says. It is only as good as my
 * reading of the reference. Run the real sandbox before going live.
 *
 * ## Test inputs (the same last digits as the built-in mock provider)
 *
 *   ID number    ...0000 no record (502)    ...1111 deceased    ...2222 a different name
 *                ...9091 temporarily unavailable (502)   ...3434 ID number not matched
 *                anything else: the person named by FAKE_NAMES ("FIRST NAMES|SURNAME")
 *   Bank account ...0000 completed negative (code 4)  ...1111 closed  ...2222 someone else's
 *                ...0006 check-digit error (code 6)   ...9091 provider error (502)
 *   Property     ID ...3333 two properties   ...4444 one property   anything else none
 */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.FAKE_PORT || '4010', 10);
const [FIRST, LAST] = (process.env.FAKE_NAMES || 'GRACE|MTHEMBU').split('|');

let credits = 1000;
const saved = new Map();   // Idempotency-Key -> { hash, status, body }
const log = [];            // what we were sent, for tests

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const tail = (v, n) => String(v || '').slice(-n);

function handle(path, b) {
  // ---- /verify -------------------------------------------------------------
  if (path === '/api/external/verify') {
    const type = b.reportType;
    if (!['home_affairs_real_time_idv', 'said_verification'].includes(type)) return [400, { error: `Unsupported reportType "${type}"` }];
    if (!/^\d{13}$/.test(b.idNumber || '')) return [400, { error: 'idNumber must be a 13-digit SA ID number' }];
    const t = tail(b.idNumber, 4);
    if (t === '0000') return [502, { error: 'No record found', code: 'NO_RECORD_FOUND', charged: true }];
    if (t === '9091') return [502, { error: 'Verification temporarily unavailable', code: 'VERIFICATION_TEMPORARILY_UNAVAILABLE' }];
    const cost = type === 'said_verification' ? 1 : 3;
    credits -= cost;
    const first = t === '2222' ? 'SOMEONE' : FIRST;
    const last = t === '2222' ? 'ELSE' : LAST;
    const rt = type === 'said_verification'
      ? { Status: 'ID Number Valid', Verification: { Firstnames: first, Lastname: last, Dob: '1985-03-12', Gender: 'Female' } }
      : {
        idNumber: b.idNumber, inputIdno: b.idNumber, haIdno: b.idNumber,
        idnoMatchStatus: t === '3434' ? 'Not Matched' : 'Matched',
        firstNames: first, surName: last, dob: '1985-03-12',
        deceasedStatus: t === '1111' ? 'Deceased' : 'Alive', ...(t === '1111' ? { deceasedDate: '2020-01-02' } : {}),
        maritalStatus: 'SINGLE',
      };
    return [200, {
      success: true, requestId: 'fake-request', remainingCredits: credits, mode: b.mode, reportType: type, input: { idNumber: b.idNumber },
      results: { [type]: { Status: 'Success', realTimeResults: rt, transaction_id: '1', meta: { environment: b.mode } } },
    }];
  }

  // ---- /bank-account-verification ------------------------------------------
  if (path === '/api/external/bank-account-verification') {
    const need = ['surname', 'identityNumber', 'identityType', 'bankAccountNumber', 'bankBranchCode', 'bankAccountType'];
    const missing = need.filter((k) => !b[k]);
    if (missing.length) return [400, { error: `Missing required fields: ${missing.join(', ')}` }];
    if (!/^\d{7,13}$/.test(b.bankAccountNumber)) return [400, { error: 'bankAccountNumber must be 7-13 digits' }];
    if (!/^\d{6}$/.test(b.bankBranchCode)) return [400, { error: 'bankBranchCode must be 6 digits' }];
    if (!['Unknown', 'Savings', 'Current', 'Transmission', 'Bond', 'SubscriptionShare'].includes(b.bankAccountType)) return [400, { error: 'invalid bankAccountType' }];
    const t = tail(b.bankAccountNumber, 4);
    if (t === '9091') return [502, { error: 'Processing failed' }];
    if (t === '0006') return [200, { success: false, response_code: 6, credits_used: 0, error: 'CDV Error. Check account details.' }];
    if (t === '0000') return [200, { success: false, response_code: 4, credits_used: 0, results: { verification_results: { accountFound: 'No' } } }];
    credits -= 6;
    const vr = { Status: 'VerifiedNoErrors', accountFound: 'Yes', accountOpen: t === '1111' ? 'No' : 'Yes', identityMatch: t === '2222' ? 'No' : 'Yes', accountTypeMatch: 'Yes', acceptsCredits: 'Yes', acceptsDebits: 'Yes', lengthOpen: 'Yes', bankReference: 'fake-bank-ref' };
    return [200, { success: true, requestId: 'fake-bank', remaining_credits: credits, service: 'bank-account-verification', results: { identity_and_account_verified: t !== '2222' && t !== '1111', summary: 'fake', verification_results: vr } }];
  }

  // ---- /property-search ----------------------------------------------------
  if (path === '/api/external/property-search') {
    if (!/^\d{13}$/.test(b.idNumber || '')) return [400, { error: 'idNumber must be a 13-digit SA ID number' }];
    credits -= 10;
    const t = tail(b.idNumber, 4);
    const deed = (n) => ({ titleDeedNumber: `T${n}/2020`, physicalAddress: `${n} FAKE STREET SOSHANGUVE`, propertyType: 'Full Title - Erf', erfSize: '300SQM', buyerName: 'REDACTED IN PRACTICE', purchasePrice: '450000', bondHolderName: 'FAKE BANK', bondAmount: '300000' });
    const props = t === '3333' ? [deed(101), deed(202)] : t === '4444' ? [deed(101)] : [];
    return [200, { success: true, requestId: 'fake-property', remaining_credits: credits, service: 'property-search', mode: b.mode, found: props.length > 0, credits_used: 10, properties: props }];
  }
  return [404, { error: 'Unknown endpoint' }];
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.url === '/__requests') return send(res, 200, log);
    if (req.url === '/api/external/health') return send(res, 200, { status: 'ok' });

    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'Body is not JSON' }); }
    log.push({ method: req.method, url: req.url, headers: { 'x-api-key': req.headers['x-api-key'] ? 'present' : 'absent', authorization: req.headers.authorization, 'idempotency-key': req.headers['idempotency-key'] }, body });

    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (!req.headers['x-api-key']) return send(res, 401, { error: 'Invalid or missing API key', code: 'UNAUTHORIZED' });
    if (!['sandbox', 'production'].includes(body.mode)) return send(res, 400, { error: 'mode must be "sandbox" or "production"' });

    const key = req.headers['idempotency-key'];
    if (body.mode === 'production') {
      if (!key || key.length < 8 || key.length > 160) return send(res, 400, { error: 'Idempotency-Key header (8-160 chars) is required in production' });
    }
    const hash = crypto.createHash('sha256').update(req.url + raw).digest('hex');
    if (key && saved.has(key)) {
      const prior = saved.get(key);
      if (prior.hash !== hash) return send(res, 409, { error: 'Idempotency key reused with a different payload', code: 'IDEMPOTENCY_CONFLICT' });
      return send(res, prior.status, prior.body);
    }

    const [status, out] = handle(req.url, body);
    if (key && status === 200) saved.set(key, { hash, status, body: out });
    send(res, status, out);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Fake VerifyNow on http://127.0.0.1:${PORT}/api/external  (names: ${FIRST} ${LAST})`));
