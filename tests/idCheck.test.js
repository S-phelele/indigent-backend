const test = require('node:test');
const assert = require('node:assert/strict');

const idCheck = require('../src/lib/idCheck');
const { normaliseVerifyNow, ProviderError } = require('../src/lib/verifyProvider');

/**
 * Pure rules only: how a Home Affairs answer becomes an outcome. No network, no
 * database, no credits.
 */

const declared = { fullName: 'Nomsa Thandiwe', surname: 'Dlamini' };

test('PASS when the surname and first name match', () => {
  const r = idCheck.evaluate({ found: true, deceased: false, firstNames: 'NOMSA THANDIWE', surname: 'DLAMINI' }, declared);
  assert.equal(r.outcome, 'PASS');
});

test('names are compared without case, accents or punctuation', () => {
  const r = idCheck.evaluate({ found: true, firstNames: 'Nómsa', surname: "D'lamini" }, { fullName: 'nomsa', surname: 'D lamini' });
  assert.equal(r.outcome, 'PASS');
});

test('a second given name left off the form is not a mismatch', () => {
  const r = idCheck.evaluate({ found: true, firstNames: 'Nomsa Thandiwe Sibongile', surname: 'Dlamini' }, { fullName: 'Nomsa', surname: 'Dlamini' });
  assert.equal(r.outcome, 'PASS');
});

test('FAIL when Home Affairs has no record of the number', () => {
  const r = idCheck.evaluate({ found: false }, declared);
  assert.equal(r.outcome, 'FAIL');
  assert.match(r.findings, /no record/i);
});

test('FAIL when the holder is recorded as deceased, even if the name matches', () => {
  const r = idCheck.evaluate({ found: true, deceased: true, firstNames: 'Nomsa', surname: 'Dlamini' }, declared);
  assert.equal(r.outcome, 'FAIL');
  assert.match(r.findings, /deceased/i);
});

test('a different surname is INCONCLUSIVE, never FAIL — it may be a maiden name', () => {
  const r = idCheck.evaluate({ found: true, firstNames: 'Nomsa', surname: 'Khumalo' }, declared);
  assert.equal(r.outcome, 'INCONCLUSIVE');
  assert.match(r.findings, /surname/);
});

test('a completely different person is INCONCLUSIVE and names both fields', () => {
  const r = idCheck.evaluate({ found: true, firstNames: 'Sipho', surname: 'Khumalo' }, declared);
  assert.equal(r.outcome, 'INCONCLUSIVE');
  assert.match(r.findings, /surname and first name/);
});

test('an empty name on either side never counts as agreement', () => {
  assert.equal(idCheck.namesAgree('', ''), false);
  const r = idCheck.evaluate({ found: true, firstNames: 'Nomsa', surname: 'Dlamini' }, { fullName: '', surname: '' });
  assert.equal(r.outcome, 'INCONCLUSIVE');
});

test('no answer at all is treated as no record', () => {
  assert.equal(idCheck.evaluate(null, declared).outcome, 'FAIL');
});

// ---------------------------------------------------------------------------
// Provider response normalisation (assumed field names — see verifyProvider.js)
// ---------------------------------------------------------------------------

test('normaliseVerifyNow reads a found, living person', () => {
  const r = normaliseVerifyNow({ data: { status: 'success', firstNames: 'Nomsa', surname: 'Dlamini', deceased: false, creditsUsed: 8, reference: 'abc' } });
  assert.deepEqual(r, { found: true, firstNames: 'Nomsa', surname: 'Dlamini', deceased: false, credits: 8, ref: 'abc' });
});

test('normaliseVerifyNow reads a not-found response', () => {
  assert.equal(normaliseVerifyNow({ status: 'not_found' }).found, false);
});

test('normaliseVerifyNow understands a deceased flag written as text', () => {
  assert.equal(normaliseVerifyNow({ deceased: 'Yes' }).deceased, true);
  assert.equal(normaliseVerifyNow({ deceased: 'No' }).deceased, false);
});

test('normaliseVerifyNow survives an empty body without throwing', () => {
  assert.doesNotThrow(() => normaliseVerifyNow({}));
  assert.doesNotThrow(() => normaliseVerifyNow(null));
});

test('ProviderError carries whether a retry is sensible', () => {
  assert.equal(new ProviderError('x', { retryable: true }).retryable, true);
  assert.equal(new ProviderError('x').retryable, false);
});

test('mock provider gives a distinct answer for each demonstrable outcome', async () => {
  const { active } = require('../src/lib/verifyProvider');
  const p = active();
  const base = { fullName: 'Nomsa', surname: 'Dlamini' };
  assert.equal((await p.checkId({ ...base, idNumber: '8001015009080' })).found, true);
  assert.equal((await p.checkId({ ...base, idNumber: '8001015000000' })).found, false);
  assert.equal((await p.checkId({ ...base, idNumber: '8001015001111' })).deceased, true);
  assert.notEqual((await p.checkId({ ...base, idNumber: '8001015002222' })).surname, 'Dlamini');
});
