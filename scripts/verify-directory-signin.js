#!/usr/bin/env node
/**
 * Exercise directory (Active Directory) sign-in against a running API.
 *
 *     node scripts/verify-directory-signin.js            # http://localhost:5000/api
 *     API=http://localhost:5098/api node scripts/verify-directory-signin.js
 *
 * Needs the API started with:
 *     AD_ENABLED=true AD_PROVIDER=mock AD_ROLE_MAP=<the one in .env.example>
 * plus DATABASE_URL pointing at the same database, and `npm run db:seed` run.
 *
 * ## What it changes
 *
 * It signs in and imports mock directory users (they appear as Staff with a
 * "Windows account" badge), links the demo capture officer to a mock directory
 * account, and then puts everything back: the directory accounts are deleted and
 * the demo capture officer is restored to a local account with its original
 * password. Nothing outside the demo accounts is touched.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const BASE = process.env.API || 'http://localhost:5000/api';
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
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}
const login = (email, password) => call('POST', '/auth/login', { body: { email, password } });

(async () => {
  const mockUsers = ['jsuper', 'jadmin', 'jsupervise', 'jassess', 'jverify', 'jcapture', 'jcouncil', 'joutsider', 'jleaver'];
  const cleanup = async () => {
    await prisma.user.deleteMany({ where: { authSource: 'DIRECTORY', email: { endsWith: '@mock.local' } } });
    // Undo the link test on the demo capture officer.
    await prisma.user.updateMany({
      where: { email: 'capture@demo.local' },
      data: { authSource: 'LOCAL', externalId: null, directoryUsername: null, directorySyncedAt: null, role: 'CAPTURE_OFFICER',
              password: await bcrypt.hash('Demo@2026', 10), passwordChangedAt: null },
    });
  };
  await cleanup();

  console.log('\nSign-in screen');
  let r = await call('GET', '/auth/sign-in-options');
  check('the directory is advertised to the portal', r.status === 200 && r.json.data.directory === true);

  console.log('\nSigning in with a Windows account');
  r = await login('jadmin', 'Passw0rd!');
  check('jadmin signs in as ADMIN', r.status === 200 && r.json.data.user.role === 'ADMIN', r.json?.message);
  check('the account is marked as a directory account', r.json?.data?.user?.authSource === 'DIRECTORY');
  const adminToken = r.json?.data?.token;
  const adminId = r.json?.data?.user?.id;
  r = await call('GET', '/auth/me', { token: adminToken });
  check('the session token works', r.status === 200 && r.json.data.email === 'jadmin@mock.local');
  r = await call('GET', '/admin/staff', { token: adminToken });
  check('an ADMIN from the directory can use admin screens', r.status === 200);

  r = await login('MOCK\\jverify', 'Passw0rd!');
  check('DOMAIN\\user form works', r.status === 200 && r.json.data.user.role === 'VERIFICATION_OFFICER');
  r = await login('jcouncil@mock.local', 'Passw0rd!');
  check('signing in by email/UPN works, and a councillor gets their ward', r.status === 200 && r.json.data.user.role === 'COUNCILLOR');
  const again = await login('jadmin', 'Passw0rd!');
  check('a second sign-in reuses the same account', again.json?.data?.user?.id === adminId);
  check('exactly one row exists for jadmin', (await prisma.user.count({ where: { email: 'jadmin@mock.local' } })) === 1);

  console.log('\nRefusals');
  r = await login('jadmin', 'wrong');
  check('wrong password is a plain 401', r.status === 401);
  r = await login('jadmin', '');
  check('an empty password is refused', r.status === 400 || r.status === 401);
  r = await login('*)(objectClass=*', 'x');
  check('LDAP filter characters in the username are harmless', r.status === 401);
  r = await login('joutsider', 'Passw0rd!');
  check('in the directory but in no group: 403 DIRECTORY_NOT_AUTHORISED', r.status === 403 && r.json.code === 'DIRECTORY_NOT_AUTHORISED', r.json?.message);
  check('and no account was created for them', (await prisma.user.count({ where: { email: 'joutsider@mock.local' } })) === 0);
  r = await login('jleaver', 'Passw0rd!');
  check('a disabled directory account is refused', r.status === 401);

  console.log('\nLocal accounts are unaffected');
  r = await login('admin@demo.local', 'Demo@2026');
  check('a local staff account still signs in with its local password', r.status === 200 && r.json.data.user.authSource === 'LOCAL');
  const localAdmin = r.json?.data?.token;
  r = await login('applicant@demo.local', 'Passw0rd!');
  check('a resident cannot be reached through the directory', r.status === 401);
  r = await login('jadmin@demo.local', 'Passw0rd!');
  check('an unknown local name falls to the directory and fails cleanly', r.status === 401);

  console.log('\nPasswords belong to Windows');
  r = await call('POST', '/auth/change-password', { token: adminToken, body: { currentPassword: 'Passw0rd!', newPassword: 'Another#Pass1' } });
  check('changing the password here is refused', r.status === 400 && r.json.code === 'PASSWORD_MANAGED_BY_DIRECTORY');
  r = await call('POST', '/auth/forgot-password', { body: { email: 'jadmin@mock.local' } });
  check('forgot-password answers generically and sends nothing', r.status === 200 && !r.json.demoOtp && !r.json.cellHint);

  console.log('\nImporting from the directory');
  r = await call('GET', '/admin/staff/directory/status', { token: localAdmin });
  check('status reports the directory is on, with the role map', r.json?.data?.enabled === true && r.json.data.roleMap.length >= 7 && r.json.data.problems.length === 0);
  r = await call('GET', '/admin/staff/directory/search?q=ver', { token: localAdmin });
  check('search finds Vusi Verifier with the role his group gives', r.json?.data?.some((p) => p.username === 'jverify' && p.role === 'VERIFICATION_OFFICER' && p.canImport));
  check('search does not return the disabled account', !r.json?.data?.some((p) => p.username === 'jleaver'));
  r = await call('GET', '/admin/staff/directory/search?q=outs', { token: localAdmin });
  check('somebody in no mapped group shows but cannot be imported', r.json?.data?.some((p) => p.username === 'joutsider' && p.canImport === false));
  r = await call('GET', '/admin/staff/directory/search?q=x', { token: localAdmin });
  check('a one-letter search returns nothing', r.json?.data?.length === 0);
  r = await call('GET', '/admin/staff/directory/search?q=ver', { token: adminToken });
  check('a directory ADMIN may search too', r.status === 200);
  const capTok = (await login('capture@demo.local', 'Demo@2026')).json?.data?.token;
  r = await call('GET', '/admin/staff/directory/search?q=ver', { token: capTok });
  check('a capture officer may not', r.status === 403);

  r = await call('POST', '/admin/staff/directory/import', { token: localAdmin, body: { username: 'jassess' } });
  check('import creates the account with no password issued', r.status === 201 && r.json.data.role === 'ASSESSMENT_OFFICER' && r.json.data.authSource === 'DIRECTORY' && !r.json.credentials);
  r = await call('POST', '/admin/staff/directory/import', { token: localAdmin, body: { username: 'jassess' } });
  check('importing again refreshes rather than duplicates', r.status === 200);
  r = await call('POST', '/admin/staff/directory/import', { token: localAdmin, body: { username: 'joutsider' } });
  check('importing somebody in no group is refused', r.status === 400 && r.json.code === 'NO_MAPPED_GROUP');
  r = await call('POST', '/admin/staff/directory/import', { token: localAdmin, body: { username: 'jleaver' } });
  check('importing a disabled account is refused', r.status === 404);
  r = await login('jassess', 'Passw0rd!');
  check('the imported person can sign in straight away', r.status === 200 && r.json.data.user.role === 'ASSESSMENT_OFFICER');

  const assessor = await prisma.user.findUnique({ where: { email: 'jassess@mock.local' } });
  r = await call('PATCH', `/admin/staff/${assessor.id}`, { token: localAdmin, body: { role: 'COUNCILLOR' } });
  check("a directory account's role cannot be changed by hand", r.status === 400 && r.json.code === 'ROLE_FROM_DIRECTORY');
  r = await call('POST', `/admin/staff/${assessor.id}/reset-password`, { token: localAdmin });
  check('nor can its password be reset here', r.status === 400 && r.json.code === 'PASSWORD_MANAGED_BY_DIRECTORY');

  console.log('\nLinking an existing local account');
  const cap = await prisma.user.findUnique({ where: { email: 'capture@demo.local' } });
  r = await call('POST', `/admin/staff/${cap.id}/link-directory`, { token: localAdmin, body: { username: 'jcapture' } });
  check('link succeeds and keeps the same account id', r.status === 200 && r.json.data.id === cap.id && r.json.data.authSource === 'DIRECTORY', r.json?.message);
  r = await login('capture@demo.local', 'Demo@2026');
  check('the old local password stops working', r.status !== 200);
  r = await login('jcapture', 'Passw0rd!');
  check('the Windows password works and lands on the same account', r.status === 200 && r.json.data.user.id === cap.id);
  r = await call('POST', `/admin/staff/${cap.id}/link-directory`, { token: localAdmin, body: { username: 'jcapture' } });
  check('linking twice is refused', r.status === 400);
  const me = (await login('admin@demo.local', 'Demo@2026')).json.data.user;
  r = await call('POST', `/admin/staff/${me.id}/link-directory`, { token: localAdmin, body: { username: 'jadmin' } });
  check('nobody can link their own account', r.status === 400 && /own account/.test(r.json.message));
  const sup = await prisma.user.findUnique({ where: { email: 'supervisor@demo.local' } });
  r = await call('POST', `/admin/staff/${sup.id}/link-directory`, { token: localAdmin, body: { username: 'jcapture' } });
  check('a directory account already linked elsewhere is refused', r.status === 409);

  console.log('\nKeeping access in step');
  r = await call('POST', '/admin/staff/directory/sync', { token: localAdmin });
  check('sync runs and changes nobody who is still in their group', r.status === 200 && r.json.data.deactivated.filter((d) => d.email.endsWith('@mock.local')).length === 0 && r.json.data.aborted === null, JSON.stringify(r.json?.data));

  // Pretend jverify has left: point the row at the disabled mock account, which
  // is what the directory would say about somebody whose account was switched off.
  // They hold a live session first, to show it stops at once.
  const verifierToken = (await login('jverify', 'Passw0rd!')).json.data.token;
  check('(setup) their session works before the sync', (await call('GET', '/auth/me', { token: verifierToken })).status === 200);
  await prisma.user.update({ where: { email: 'jverify@mock.local' }, data: { directoryUsername: 'jleaver' } });
  r = await call('POST', '/admin/staff/directory/sync', { token: localAdmin });
  check('sync deactivates somebody the directory no longer vouches for', r.json?.data?.deactivated?.some((d) => d.email === 'jverify@mock.local'), JSON.stringify(r.json?.data));
  r = await call('GET', '/auth/me', { token: verifierToken });
  check('their open session stops working at once', r.status === 403 && r.json.code === 'ACCOUNT_DEACTIVATED');
  r = await login('jverify', 'Passw0rd!');
  check('and they cannot sign in again', r.status === 403);
  const audits = await prisma.auditLog.findMany({ where: { action: { in: ['DIRECTORY_DEACTIVATE', 'DIRECTORY_PROVISION', 'DIRECTORY_LINK', 'DIRECTORY_LOGIN_FAILED'] } } });
  check('provisioning, linking, deactivation and refusals are all in the audit log',
    ['DIRECTORY_DEACTIVATE', 'DIRECTORY_PROVISION', 'DIRECTORY_LINK', 'DIRECTORY_LOGIN_FAILED'].every((a) => audits.some((x) => x.action === a)));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failed:', failures.join('; ')); process.exitCode = 1; }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
