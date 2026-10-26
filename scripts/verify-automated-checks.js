#!/usr/bin/env node
/**
 * Exercise the automated checks (Home Affairs, bank account, deeds) against a
 * running API, using the mock provider.
 *
 *     node scripts/verify-automated-checks.js                 # http://localhost:5000/api
 *     API=http://localhost:5099/api node scripts/verify-automated-checks.js
 *
 * Needs: the API running with VERIFY_PROVIDER=mock (the default), DATABASE_URL
 * set to the same database, and the demo accounts seeded (`npm run db:seed`).
 *
 * ## What it leaves behind
 *
 * Three throwaway applications belonging to the demo applicant, prefixed
 * "ZZ Check Test" so they are easy to find and remove. It never touches an
 * application it did not create. Nothing is billed: the mock provider is free.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const BASE = process.env.API || 'http://localhost:5000/api';
const PASSWORD = 'Demo@2026';
const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`   ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; failures.push(name); console.log(`   FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function signIn(email) {
  const r = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`Could not sign in as ${email}: ${r.status} ${r.json?.message}`);
  return r.json.data.token;
}

/** A pending (submitted) application with consent, for a given ID number and declaration. */
async function makeApplication(applicant, over = {}) {
  return prisma.application.create({
    data: {
      userId: applicant.id,
      status: 'PENDING', submittedAt: new Date(),
      fullName: 'Grace', surname: 'ZZ Check Test',
      idNumber: '8503124800081',
      consentSiteVisit: true, consentDataMatching: true, declarationTruthful: true,
      ...over,
    },
  });
}

(async () => {
  const applicant = await prisma.user.findUnique({ where: { email: 'applicant@demo.local' } });
  if (!applicant) throw new Error('Run `npm run db:seed` first.');

  const verifier = await signIn('verifier@demo.local');
  const capture = await signIn('capture@demo.local');
  const url = (app, what) => `/verification/applications/${app.id}/checks/${what}`;

  console.log('\nHome Affairs');
  const a = await makeApplication(applicant, { idNumber: '8503124800081' });
  let r = await call('POST', url(a, 'home-affairs'), { token: verifier, body: {} });
  check('201 and a PASS for a matching ID', r.status === 201 && r.json.data.outcome === 'PASS', r.json?.message);
  check('marked automated, with provider recorded', r.json?.data?.automated === true && r.json?.data?.provider === 'mock');
  r = await call('POST', url(a, 'home-affairs'), { token: verifier, body: {} });
  check('a repeat is refused with 409 ALREADY_CHECKED', r.status === 409 && r.json.code === 'ALREADY_CHECKED');
  r = await call('POST', url(a, 'home-affairs'), { token: verifier, body: { force: true } });
  check('force allows a repeat', r.status === 201);
  r = await call('POST', url(a, 'home-affairs'), { token: capture, body: {} });
  check('a capture officer cannot run it', r.status === 403);

  const dead = await makeApplication(applicant, { idNumber: '8503124801111' });
  r = await call('POST', url(dead, 'home-affairs'), { token: verifier, body: {} });
  check('deceased holder is a FAIL', r.json?.data?.outcome === 'FAIL' && /deceased/i.test(r.json.data.findings));
  const noRec = await makeApplication(applicant, { idNumber: '8503124800000' });
  r = await call('POST', url(noRec, 'home-affairs'), { token: verifier, body: {} });
  check('unknown ID is a FAIL', r.json?.data?.outcome === 'FAIL');
  const other = await makeApplication(applicant, { idNumber: '8503124802222' });
  r = await call('POST', url(other, 'home-affairs'), { token: verifier, body: {} });
  check('different name is INCONCLUSIVE', r.json?.data?.outcome === 'INCONCLUSIVE');

  console.log('\nConsent gate');
  const noConsent = await makeApplication(applicant, { consentDataMatching: false });
  r = await call('POST', url(noConsent, 'home-affairs'), { token: verifier, body: {} });
  check('refused without consent (NO_CONSENT)', r.status === 403 && r.json.code === 'NO_CONSENT');
  r = await call('POST', url(noConsent, 'bank-account'), { token: verifier, body: { bankName: 'FNB', accountNumber: '62000009999' } });
  check('same for bank', r.status === 403);
  r = await call('POST', url(noConsent, 'property'), { token: verifier, body: {} });
  check('same for property', r.status === 403);

  console.log('\nBank account');
  const b = await makeApplication(applicant);
  r = await call('POST', url(b, 'bank-account'), { token: verifier, body: { bankName: 'FNB' } });
  check('rejects a missing account number', r.status === 400);
  r = await call('POST', url(b, 'bank-account'), { token: verifier, body: { bankName: 'FNB', accountNumber: 'abc' } });
  check('rejects a non-numeric account number', r.status === 400);
  r = await call('POST', url(b, 'bank-account'), { token: verifier, body: { bankName: 'FNB', accountNumber: '62000009999' } });
  check('open account held by applicant is a PASS', r.status === 201 && r.json.data.outcome === 'PASS', r.json?.data?.findings);
  check('only the last four digits are kept', /9999/.test(r.json?.data?.findings || '') && !/62000009999/.test(JSON.stringify(r.json)));
  const stored = await prisma.verificationCheck.findMany({ where: { applicationId: b.id } });
  const audits = await prisma.auditLog.findMany({ where: { entityId: b.id } });
  check('the full account number is nowhere in the database',
    !JSON.stringify(stored).includes('62000009999') && !JSON.stringify(audits).includes('62000009999'));
  const b2 = await makeApplication(applicant);
  for (const [tail, want] of [['0000', 'FAIL'], ['1111', 'FAIL'], ['2222', 'INCONCLUSIVE']]) {
    r = await call('POST', url(b2, 'bank-account'), { token: verifier, body: { bankName: 'FNB', accountNumber: `6200000${tail}`, force: true } });
    check(`account ending ${tail} is ${want}`, r.json?.data?.outcome === want, r.json?.data?.findings);
  }

  console.log('\nProperty (deeds)');
  const p1 = await makeApplication(applicant, { idNumber: '8503124803333', tenure: 'TENANT', ownsOtherProperty: false });
  r = await call('POST', url(p1, 'property'), { token: verifier, body: {} });
  check('two properties, none declared: FAIL', r.status === 201 && r.json.data.outcome === 'FAIL', r.json?.data?.findings);
  const p2 = await makeApplication(applicant, { idNumber: '8503124804444', tenure: 'OWNER', ownsOtherProperty: false });
  r = await call('POST', url(p2, 'property'), { token: verifier, body: {} });
  check('owner with one property: PASS', r.json?.data?.outcome === 'PASS', r.json?.data?.findings);
  const p3 = await makeApplication(applicant, { idNumber: '8503124800081', tenure: 'TENANT', ownsOtherProperty: false });
  r = await call('POST', url(p3, 'property'), { token: verifier, body: {} });
  check('tenant with none: PASS', r.json?.data?.outcome === 'PASS');
  const detail = await call('GET', `/verification/applications/${p1.id}`, { token: verifier });
  check('the result shows on the verification detail screen',
    detail.status === 200 && (detail.json?.data?.checks || []).some((c) => c.source === 'DEEDS_OFFICE' && c.automated));

  console.log('\nManual entry still works');
  r = await call('POST', `/verification/applications/${a.id}/checks`, { token: verifier, body: { source: 'BANK_ACCOUNT', outcome: 'PASS', findings: 'seen at the counter' } });
  check('BANK_ACCOUNT is accepted as a manual source', r.status === 201 && r.json.data.automated === false);

  // Clean up everything this run created.
  await prisma.application.deleteMany({ where: { surname: 'ZZ Check Test' } });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failed:', failures.join('; ')); process.exitCode = 1; }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
