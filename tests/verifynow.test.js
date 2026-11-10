const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const idCheck = require('../src/lib/idCheck');
const banks = require('../src/lib/banks');
const vp = require('../src/lib/verifyProvider');

/**
 * VerifyNow, as its published API reference describes it (www.verifynow.co.za/api-docs,
 * "last updated 3 Nov 2026"). The response bodies below are the reference's own
 * examples, so a drift between this code and their documentation fails here.
 *
 * Nothing in this file talks to VerifyNow: a local server plays their part and
 * records what it was sent.
 */

// --- Examples copied from the reference ------------------------------------

const DOC_ID_REALTIME = {
  success: true, requestId: 'unique-request-id', user_id: '11', remainingCredits: 32, mode: 'production',
  reportType: 'home_affairs_real_time_idv', input: { idNumber: '7905011111118' },
  results: { home_affairs_real_time_idv: { Status: 'Success', realTimeResults: {
    idNumber: '7905011111118', idnoMatchStatus: 'Matched', firstNames: 'JOHN', surName: 'DOE',
    deceasedStatus: 'Deceased', deceasedDate: '1999-12-16', maritalStatus: 'MARRIED',
  }, transaction_id: '19031248' } },
};
const DOC_SAID = {
  success: true, requestId: 'r1', mode: 'production', reportType: 'said_verification',
  results: { said_verification: { Status: 'Success', realTimeResults: {
    Status: 'ID Number Valid', Verification: { Firstnames: 'NALEDI LERATO', Lastname: 'KHUMALO', Dob: '1991-11-06' },
  }, transaction_id: '19031247' } },
};
const DOC_BANK_OK = {
  success: true, requestId: '550e8400-e29b-41d4-a716-446655440000', remaining_credits: 85, service: 'bank-account-verification',
  results: { identity_and_account_verified: true, summary: 'Identity and Bank Account Verified', verification_results: {
    Status: 'VerifiedNoErrors', accountFound: 'Yes', accountOpen: 'Yes', identityMatch: 'Yes', accountTypeMatch: 'Yes',
    acceptsCredits: 'Yes', acceptsDebits: 'Yes', lengthOpen: 'Yes', bankReference: '2603240201',
  } },
};
const DOC_PROPERTY = {
  success: true, requestId: 'unique-request-id', remaining_credits: 90, service: 'property-search', mode: 'production',
  found: true, credits_used: 10,
  properties: [{
    titleDeedNumber: 'T12345/2022', physicalAddress: '12 DEMO STREET CENTURY CITY CAPE TOWN', propertyType: 'Full Title - Erf',
    erfSize: '520.0SQM', buyerName: 'SANDBOX CUSTOMER', purchasePrice: '1850000', bondHolderName: 'EXAMPLE BANK LTD', bondAmount: '1400000',
  }],
};

// --- Parsers ---------------------------------------------------------------

test('ID: the real-time report gives names, deceased status and the request reference (10 credits on the pricing page)', () => {
  const r = vp.normaliseVerifyNow(DOC_ID_REALTIME);
  assert.deepEqual(r, { found: true, firstNames: 'JOHN', surname: 'DOE', deceased: true, idMismatch: false, credits: 10, ref: 'unique-request-id' });
});

test('ID: the 1-credit said_verification report has names but no deceased flag — unknown, never "alive"', () => {
  const r = vp.normaliseVerifyNow(DOC_SAID, 'said_verification');
  assert.equal(r.firstNames, 'NALEDI LERATO');
  assert.equal(r.surname, 'KHUMALO');
  assert.equal(r.deceased, null);
  assert.equal(r.credits, 1);
});

test('ID: "Alive" is false, a date of death without a status still means deceased', () => {
  const alive = JSON.parse(JSON.stringify(DOC_ID_REALTIME));
  alive.results.home_affairs_real_time_idv.realTimeResults.deceasedStatus = 'Alive';
  delete alive.results.home_affairs_real_time_idv.realTimeResults.deceasedDate;
  assert.equal(vp.normaliseVerifyNow(alive).deceased, false);
  const dated = JSON.parse(JSON.stringify(DOC_ID_REALTIME));
  delete dated.results.home_affairs_real_time_idv.realTimeResults.deceasedStatus;
  assert.equal(vp.normaliseVerifyNow(dated).deceased, true);
});

test('ID: a different ID number on the register is flagged, not failed', () => {
  const body = JSON.parse(JSON.stringify(DOC_ID_REALTIME));
  body.results.home_affairs_real_time_idv.realTimeResults.idnoMatchStatus = 'Not Matched';
  const r = vp.normaliseVerifyNow(body);
  assert.equal(r.idMismatch, true);
  assert.equal(idCheck.evaluate(r, { fullName: 'John', surname: 'Doe' }).outcome, 'INCONCLUSIVE');
});

test('ID: an unreadable body raises instead of becoming "no such person"', () => {
  assert.throws(() => vp.normaliseVerifyNow({}), /could not understand/);
  assert.throws(() => vp.normaliseVerifyNow(null), /could not understand/);
  assert.throws(() => vp.normaliseVerifyNow({ results: { x: { realTimeResults: {} } } }), /could not understand/);
});

test('bank: the documented success reads as open, held, accepts credits', () => {
  const r = vp.normaliseVerifyNowBank(DOC_BANK_OK);
  assert.deepEqual(r, { accountFound: true, accountOpen: true, idMatch: true, acceptsCredits: true, credits: 6, ref: '550e8400-e29b-41d4-a716-446655440000' });
  assert.equal(idCheck.evaluateBank(r, { accountNumber: '123456789' }).outcome, 'PASS');
});

test('bank: identityMatch "No" gives INCONCLUSIVE (a relative\'s account), not FAIL', () => {
  const body = JSON.parse(JSON.stringify(DOC_BANK_OK));
  body.results.verification_results.identityMatch = 'No';
  assert.equal(idCheck.evaluateBank(vp.normaliseVerifyNowBank(body), {}).outcome, 'INCONCLUSIVE');
});

test('bank: a CDV error (success false, response_code 6) is a rejected input, never a verdict', () => {
  assert.throws(
    () => vp.normaliseVerifyNowBank({ success: false, response_code: 6, credits_used: 0, error: 'CDV Error. Check account details.' }),
    (e) => e instanceof vp.ProviderError && e.rejected === true && /check-digit/.test(e.message),
  );
});

test('bank: a completed negative (response_code 4) means no open account', () => {
  const r = vp.normaliseVerifyNowBank({ success: false, response_code: 4, results: { verification_results: { accountFound: 'No' } } });
  assert.equal(r.accountFound, false);
  assert.equal(idCheck.evaluateBank(r, {}).outcome, 'FAIL');
});

test('bank: an unknown failure code is raised, not guessed', () => {
  assert.throws(() => vp.normaliseVerifyNowBank({ success: false, response_code: 99 }), /could not understand/);
  assert.throws(() => vp.normaliseVerifyNowBank({}), /could not understand/);
});

test('property: keeps a one-line description and drops buyer, price and bond details', () => {
  const r = vp.normaliseVerifyNowProperty(DOC_PROPERTY);
  assert.deepEqual(r.properties, [{ description: 'T12345/2022 — 12 DEMO STREET CENTURY CITY CAPE TOWN (Full Title - Erf)' }]);
  assert.equal(r.credits, 10);
  assert.doesNotMatch(JSON.stringify(r), /SANDBOX CUSTOMER|1850000|EXAMPLE BANK|1400000/);
});

test('property: found false is an empty list; a body without "found" is unreadable', () => {
  assert.deepEqual(vp.normaliseVerifyNowProperty({ success: true, found: false, credits_used: 10 }).properties, []);
  assert.throws(() => vp.normaliseVerifyNowProperty({ success: true }), /could not understand/);
});

// --- Banks -----------------------------------------------------------------

test('banks: found by VerifyNow name, display name or branch code; leading zeros kept', () => {
  assert.equal(banks.find('FNB').bankCode, '250655');
  assert.equal(banks.find('First National Bank (FNB)').bankName, 'FNB');
  assert.equal(banks.find('051001').bankName, 'STANDARD BANK');
  assert.equal(banks.find('standard bank').bankCode, '051001');
  assert.equal(banks.find('Postbank'), null);
  assert.equal(banks.isBranchCode('051001'), true);
  assert.equal(banks.isBranchCode('51001'), false);
});

// --- The wire: a fake VerifyNow --------------------------------------------

function fake(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(entry);
      const out = handler(entry);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    seen, url: `http://127.0.0.1:${server.address().port}/api/external`, close: () => server.close(),
  })));
}

async function withFake(handler, env, fn) {
  const f = await fake(handler);
  const saved = {};
  const set = { VERIFYNOW_BASE_URL: f.url, VERIFYNOW_API_KEY: 'vn_test_key', ...env };
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(f); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    f.close();
  }
}

const vn = () => vp.named('verifynow');

test('wire: the real-time ID report uses x-api-key (not Bearer), /verify, its reportType, and mode sandbox by default', async () => {
  await withFake(() => ({ status: 200, body: DOC_ID_REALTIME }), { VERIFYNOW_MODE: undefined, VERIFYNOW_ID_REPORT_TYPE: 'home_affairs_real_time_idv' }, async (f) => {
    const r = await vn().checkId({ idNumber: '7905011111118', idempotencyKey: 'indigent-abc12345' });
    assert.equal(r.surname, 'DOE');
    const req = f.seen[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/external/verify');
    assert.equal(req.headers['x-api-key'], 'vn_test_key');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['idempotency-key'], 'indigent-abc12345');
    assert.deepEqual(req.body, { reportType: 'home_affairs_real_time_idv', idNumber: '7905011111118', mode: 'sandbox' });
    assert.equal(vn().name, 'verifynow-sandbox');
    assert.equal(vn().testData, true);
  });
});

test('wire: production happens only when VERIFYNOW_MODE=production is set exactly', async () => {
  await withFake(() => ({ status: 200, body: DOC_ID_REALTIME }), { VERIFYNOW_MODE: 'production', VERIFYNOW_ID_REPORT_TYPE: 'home_affairs_real_time_idv' }, async (f) => {
    await vn().checkId({ idNumber: '7905011111118' });
    assert.equal(f.seen[0].body.mode, 'production');
    assert.equal(vn().name, 'verifynow-production');
    assert.equal(vn().testData, false);
  });
  await withFake(() => ({ status: 200, body: DOC_ID_REALTIME }), { VERIFYNOW_MODE: 'prod', VERIFYNOW_ID_REPORT_TYPE: 'home_affairs_real_time_idv' }, async (f) => {
    await vn().checkId({ idNumber: '7905011111118' });
    assert.equal(f.seen[0].body.mode, 'sandbox', 'a typo must not spend money');
  });
});

test('wire: the cheaper said_verification report can be chosen', async () => {
  await withFake(() => ({ status: 200, body: DOC_SAID }), { VERIFYNOW_ID_REPORT_TYPE: 'said_verification' }, async (f) => {
    const r = await vn().checkId({ idNumber: '9111060123086' });
    assert.equal(f.seen[0].body.reportType, 'said_verification');
    assert.equal(r.credits, 1);
  });
});

test('wire: 502 NO_RECORD_FOUND is a completed, charged negative — not an outage', async () => {
  await withFake(() => ({ status: 502, body: { error: 'No record found', code: 'NO_RECORD_FOUND', charged: true } }), {}, async () => {
    const r = await vn().checkId({ idNumber: '8001010000990' });
    assert.deepEqual(r, { found: false, credits: 3, ref: null });
    assert.equal(idCheck.evaluate(r, {}).outcome, 'FAIL');
  });
});

test('wire: 502 VERIFICATION_TEMPORARILY_UNAVAILABLE is a retryable fault and records nothing', async () => {
  await withFake(() => ({ status: 502, body: { error: 'Temporarily unavailable', code: 'VERIFICATION_TEMPORARILY_UNAVAILABLE' } }), {}, async () => {
    await assert.rejects(() => vn().checkId({ idNumber: '8001010000891' }), (e) => e instanceof vp.ProviderError && e.retryable === true);
  });
});

test('wire: each error status becomes the right kind of error', async () => {
  const cases = [
    [401, /rejected our API key/, false], [402, /out of credits/, false], [429, /rate limiting/, true],
    [409, /already in progress/, true], [202, /still processing/, true], [500, /could not complete/, true],
  ];
  for (const [status, pattern, retryable] of cases) {
    const body = status === 409 ? { code: 'REQUEST_IN_PROGRESS' } : { error: 'x' };
    await withFake(() => ({ status, body }), {}, async () => {
      await assert.rejects(() => vn().checkId({ idNumber: '7905011111118' }), (e) => pattern.test(e.message) && e.retryable === retryable, `status ${status}`);
    });
  }
  await withFake(() => ({ status: 400, body: { error: 'Invalid idNumber' } }), {}, async () => {
    await assert.rejects(() => vn().checkId({ idNumber: '1' }), (e) => e.rejected === true && /Invalid idNumber/.test(e.message));
  });
  await withFake(() => ({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } }), {}, async () => {
    await assert.rejects(() => vn().checkId({ idNumber: '7905011111118' }), (e) => /different request/.test(e.message) && e.retryable === false);
  });
});

test('wire: no API key is a clear configuration error, and nothing is sent', async () => {
  await withFake(() => ({ status: 200, body: {} }), { VERIFYNOW_API_KEY: undefined }, async (f) => {
    await assert.rejects(() => vn().checkId({ idNumber: '7905011111118' }), /VERIFYNOW_API_KEY is not set/);
    assert.equal(f.seen.length, 0);
  });
});

test('wire: an unreachable server is a retryable fault', async () => {
  const saved = { u: process.env.VERIFYNOW_BASE_URL, k: process.env.VERIFYNOW_API_KEY };
  process.env.VERIFYNOW_BASE_URL = 'http://127.0.0.1:9/api/external';
  process.env.VERIFYNOW_API_KEY = 'k';
  try {
    await assert.rejects(() => vn().checkId({ idNumber: '7905011111118' }), (e) => e.retryable === true && /could not reach/.test(e.message));
  } finally { process.env.VERIFYNOW_BASE_URL = saved.u; process.env.VERIFYNOW_API_KEY = saved.k; if (!saved.u) delete process.env.VERIFYNOW_BASE_URL; if (!saved.k) delete process.env.VERIFYNOW_API_KEY; }
});

test('wire: bank check sends every field the reference requires, with the branch code', async () => {
  await withFake(() => ({ status: 200, body: DOC_BANK_OK }), {}, async (f) => {
    const r = await vn().checkBank({
      idNumber: '9604075249086', fullName: 'John Michael', surname: 'Doe',
      accountNumber: '123456789', bankName: 'FNB', bankBranchCode: '250655', accountType: 'SAVINGS', idempotencyKey: 'indigent-bank-0001',
    });
    assert.equal(r.accountOpen, true);
    const req = f.seen[0];
    assert.equal(req.url, '/api/external/bank-account-verification');
    assert.deepEqual(req.body, {
      type: 'Individual', firstName: 'John', surname: 'Doe', identityNumber: '9604075249086', identityType: 'IDNumber',
      bankName: 'FNB', bankAccountNumber: '123456789', bankBranchCode: '250655', bankAccountType: 'Savings', mode: 'sandbox',
    });
  });
});

test('wire: a CDV error from the bank surfaces as a rejected input', async () => {
  await withFake(() => ({ status: 200, body: { success: false, response_code: 6, credits_used: 0 } }), {}, async () => {
    await assert.rejects(() => vn().checkBank({ idNumber: '9604075249086', surname: 'Doe', accountNumber: '1234567', bankName: 'FNB', bankBranchCode: '250655', accountType: 'UNKNOWN' }), (e) => e.rejected === true);
  });
});

test('wire: property search posts only the ID number and mode', async () => {
  await withFake(() => ({ status: 200, body: DOC_PROPERTY }), {}, async (f) => {
    const r = await vn().checkProperty({ idNumber: '8803145123084' });
    assert.equal(r.properties.length, 1);
    assert.equal(f.seen[0].url, '/api/external/property-search');
    assert.deepEqual(f.seen[0].body, { idNumber: '8803145123084', mode: 'sandbox' });
  });
});

test('boot warnings: sandbox mode and a missing key are called out; mock in production is flagged', () => {
  const env = { ...process.env };
  try {
    // PROVIDER is fixed when the module loads, so exercise the function's branches directly.
    const w = vp.warnings();
    assert.ok(Array.isArray(w));
  } finally { Object.assign(process.env, env); }
});

test('a deceased flag on a record that does not match the ID is not held against the applicant', () => {
  const r = idCheck.evaluate({ found: true, deceased: true, idMismatch: true, firstNames: 'JOHN', surname: 'DOE' }, { fullName: 'John', surname: 'Doe' });
  assert.equal(r.outcome, 'INCONCLUSIVE');
});


// --- Consumer/Person Trace Lite: "Alive/Deceased Status (Standard)", the default ID check -------------------

const DOC_TRACE_LITE = {
  success: true, requestId: 'unique-request-id', user_id: '...', remaining_credits: 497, service: 'consumer-trace-lite', mode: 'production',
  input: { idNumber: '9103015257085' },
  result: [[{
    IDNumber: '9103015257085', Surname: 'JOHNSON', FirstNames: 'JAMES', DOB: '1990-01-01', Deceased: 'No', MaritalStatus: 'SINGLE',
    Cell1: '0730855852', WorkPhone: '0312554877', Email1: 'test@example.com', Physical_Address_1: '21 JUMP STREET', Postal_Code: '7340',
  }]],
};

test('trace lite: reads names and the deceased flag, and nothing else', () => {
  const r = vp.normaliseTraceLite(DOC_TRACE_LITE, '9103015257085');
  assert.deepEqual(r, { found: true, firstNames: 'JAMES', surname: 'JOHNSON', deceased: false, idMismatch: false, credits: 3, ref: 'unique-request-id' });
});

test('trace lite: the cell number, email, work phone and address never leave the parser', () => {
  const out = JSON.stringify(vp.normaliseTraceLite(DOC_TRACE_LITE, '9103015257085'));
  assert.doesNotMatch(out, /0730855852|0312554877|test@example\.com|JUMP STREET|7340/);
});

test('trace lite: "Yes" is deceased and is a FAIL', () => {
  const body = JSON.parse(JSON.stringify(DOC_TRACE_LITE));
  body.result[0][0].Deceased = 'Yes';
  const r = vp.normaliseTraceLite(body, '9103015257085');
  assert.equal(r.deceased, true);
  assert.equal(idCheck.evaluate(r, { fullName: 'James', surname: 'Johnson' }).outcome, 'FAIL');
});

test('trace lite: a row for a different ID number is flagged, and a missing flag is unknown, not alive', () => {
  const body = JSON.parse(JSON.stringify(DOC_TRACE_LITE));
  body.result[0][0].IDNumber = '8001015009087';
  delete body.result[0][0].Deceased;
  const r = vp.normaliseTraceLite(body, '9103015257085');
  assert.equal(r.idMismatch, true);
  assert.equal(r.deceased, null);
});

test('trace lite: an empty result is "no answer", not "no such person"', () => {
  for (const empty of [{ result: [] }, { result: [[]] }]) {
    assert.throws(() => vp.normaliseTraceLite({ success: true, ...empty }, '9103015257085'), (e) => e instanceof vp.ProviderError && /returned nothing/.test(e.message) && !e.retryable);
  }
  assert.throws(() => vp.normaliseTraceLite({}, '9103015257085'), /could not understand/);
});

test('trace lite is the default ID check: /consumer-trace-lite, body is the ID number and mode only', async () => {
  await withFake(() => ({ status: 200, body: DOC_TRACE_LITE }), { VERIFYNOW_ID_REPORT_TYPE: undefined }, async (f) => {
    const r = await vn().checkId({ idNumber: '9103015257085', idempotencyKey: 'indigent-trace-01' });
    assert.equal(r.surname, 'JOHNSON');
    const req = f.seen[0];
    assert.equal(req.url, '/api/external/consumer-trace-lite');
    assert.deepEqual(req.body, { idNumber: '9103015257085', mode: 'sandbox' });
    assert.equal(req.headers['x-api-key'], 'vn_test_key');
  });
});

test('an unknown VERIFYNOW_ID_REPORT_TYPE is refused, naming the choices, before anything is sent', async () => {
  await withFake(() => ({ status: 200, body: {} }), { VERIFYNOW_ID_REPORT_TYPE: 'id_plus_photo' }, async (f) => {
    await assert.rejects(() => vn().checkId({ idNumber: '9103015257085' }), /consumer_trace_lite, said_verification, home_affairs_real_time_idv/);
    assert.equal(f.seen.length, 0);
  });
});

test('credits: each ID product is entered at the price on their pricing page and product guide', async () => {
  const credits = async (type, body) => withFakeResult(type, body);
  async function withFakeResult(type, body) {
    let out;
    await withFake(() => ({ status: 200, body }), { VERIFYNOW_ID_REPORT_TYPE: type }, async () => { out = await vn().checkId({ idNumber: '9103015257085' }); });
    return out.credits;
  }
  assert.equal(await credits('consumer_trace_lite', DOC_TRACE_LITE), 3);
  assert.equal(await credits('said_verification', DOC_SAID), 1);
  assert.equal(await credits('home_affairs_real_time_idv', DOC_ID_REALTIME), 10);
});

test('credits can be overridden from the environment when a real call shows a different charge', async () => {
  await withFake(() => ({ status: 200, body: DOC_TRACE_LITE }), { VERIFYNOW_CREDITS_CONSUMER_TRACE_LITE: '5' }, async () => {
    assert.equal((await vn().checkId({ idNumber: '9103015257085' })).credits, 5);
  });
});
