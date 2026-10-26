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

// ---------------------------------------------------------------------------
// Bank account
// ---------------------------------------------------------------------------

const spend = require('../src/lib/spend');
const { normaliseVerifyNowBank, normaliseVerifyNowProperty } = require('../src/lib/verifyProvider');

test('bank: open account held by the applicant is a PASS and names only the last four digits', () => {
  const r = idCheck.evaluateBank({ accountFound: true, accountOpen: true, idMatch: true, acceptsCredits: true }, { accountNumber: '1234567890' });
  assert.equal(r.outcome, 'PASS');
  assert.match(r.findings, /ending 7890/);
  assert.doesNotMatch(r.findings, /1234567890/);
});

test('bank: no such account is a FAIL', () => {
  assert.equal(idCheck.evaluateBank({ accountFound: false }, { accountNumber: '1234567890' }).outcome, 'FAIL');
});

test('bank: a closed account is a FAIL', () => {
  assert.equal(idCheck.evaluateBank({ accountFound: true, accountOpen: false }, { accountNumber: '1234567890' }).outcome, 'FAIL');
});

test("bank: somebody else's account is INCONCLUSIVE, not FAIL — households bank through relatives", () => {
  const r = idCheck.evaluateBank({ accountFound: true, accountOpen: true, idMatch: false }, { accountNumber: '1234567890' });
  assert.equal(r.outcome, 'INCONCLUSIVE');
  assert.match(r.findings, /relative/);
});

test('bank: an unanswered holder question is INCONCLUSIVE', () => {
  assert.equal(idCheck.evaluateBank({ accountFound: true, accountOpen: true, idMatch: null }, {}).outcome, 'INCONCLUSIVE');
});

test('bank: warns when the account cannot receive a payment', () => {
  const r = idCheck.evaluateBank({ accountFound: true, accountOpen: true, idMatch: true, acceptsCredits: false }, {});
  assert.equal(r.outcome, 'PASS');
  assert.match(r.findings, /cannot receive/);
});

test('lastFour never returns more than four digits', () => {
  assert.equal(idCheck.lastFour('1234 5678 9012'), '9012');
  assert.equal(idCheck.lastFour('12'), '12');
  assert.equal(idCheck.lastFour(null), '');
});

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

const erf = (n) => ({ description: `Erf ${n}` });

test('property: none found and none declared is a PASS', () => {
  assert.equal(idCheck.evaluateProperty({ properties: [] }, { tenure: 'TENANT', ownsOtherProperty: false }).outcome, 'PASS');
});

test('property: an owner who appears once, as declared, is a PASS', () => {
  assert.equal(idCheck.evaluateProperty({ properties: [erf(1)] }, { tenure: 'OWNER', ownsOtherProperty: false }).outcome, 'PASS');
});

test('property: a second property when "no other property" was declared is a FAIL', () => {
  const r = idCheck.evaluateProperty({ properties: [erf(1), erf(2)] }, { tenure: 'OWNER', ownsOtherProperty: false });
  assert.equal(r.outcome, 'FAIL');
  assert.match(r.findings, /Erf 1; Erf 2/);
});

test('property: a tenant who turns out to own something, having said no, is a FAIL', () => {
  assert.equal(idCheck.evaluateProperty({ properties: [erf(1)] }, { tenure: 'TENANT', ownsOtherProperty: false }).outcome, 'FAIL');
});

test('property: the same finding with the question left blank is only INCONCLUSIVE', () => {
  assert.equal(idCheck.evaluateProperty({ properties: [erf(1)] }, { tenure: 'TENANT', ownsOtherProperty: null }).outcome, 'INCONCLUSIVE');
});

test('property: declared other property that is found is consistent', () => {
  assert.equal(idCheck.evaluateProperty({ properties: [erf(1), erf(2)] }, { tenure: 'OWNER', ownsOtherProperty: true }).outcome, 'PASS');
});

test('property: declared ownership with nothing registered is INCONCLUSIVE — informal tenure is not on the register', () => {
  const r = idCheck.evaluateProperty({ properties: [] }, { tenure: 'OWNER', ownsOtherProperty: false });
  assert.equal(r.outcome, 'INCONCLUSIVE');
  assert.match(r.findings, /Informal/);
});

test('property: a long list is truncated to three', () => {
  const r = idCheck.evaluateProperty({ properties: [erf(1), erf(2), erf(3), erf(4), erf(5)] }, { tenure: 'TENANT', ownsOtherProperty: false });
  assert.match(r.findings, /and 2 more/);
});

test('property: no answer is treated as no properties', () => {
  assert.equal(idCheck.evaluateProperty(null, { tenure: 'TENANT' }).outcome, 'PASS');
});

// ---------------------------------------------------------------------------
// Provider normalisers and the spend cap
// ---------------------------------------------------------------------------

test('normaliseVerifyNowBank reads yes/no and booleans, and leaves unknowns null', () => {
  const r = normaliseVerifyNowBank({ data: { accountFound: true, accountOpen: 'Yes', idMatch: 'no_match', creditsUsed: 6, reference: 'r1' } });
  assert.deepEqual(r, { accountFound: true, accountOpen: true, idMatch: false, acceptsCredits: null, credits: 6, ref: 'r1' });
  assert.doesNotThrow(() => normaliseVerifyNowBank(null));
});

test('normaliseVerifyNowProperty builds a description from erf and township', () => {
  const r = normaliseVerifyNowProperty({ properties: [{ erf: '55', township: 'Soshanguve', registrationDivision: 'JR' }, { description: 'Farm 3' }] });
  assert.deepEqual(r.properties.map((p) => p.description), ['Erf 55, Soshanguve, JR', 'Farm 3']);
  assert.deepEqual(normaliseVerifyNowProperty({}).properties, []);
});

test('spend cap: 0 means unlimited, otherwise refuses once the limit is reached', () => {
  assert.equal(spend.withinLimit(1_000_000, 0), true);
  assert.equal(spend.withinLimit(99, 100), true);
  assert.equal(spend.withinLimit(100, 100), false);
});

test('mock provider: bank and property outcomes follow the documented endings', async () => {
  const p = require('../src/lib/verifyProvider').active();
  assert.equal((await p.checkBank({ accountNumber: '10000000' })).accountFound, false);
  assert.equal((await p.checkBank({ accountNumber: '10001111' })).accountOpen, false);
  assert.equal((await p.checkBank({ accountNumber: '10002222' })).idMatch, false);
  assert.equal((await p.checkBank({ accountNumber: '10009999' })).idMatch, true);
  assert.equal((await p.checkProperty({ idNumber: '8001015003333' })).properties.length, 2);
  assert.equal((await p.checkProperty({ idNumber: '8001015004444' })).properties.length, 1);
  assert.equal((await p.checkProperty({ idNumber: '8001015009999' })).properties.length, 0);
});
