#!/usr/bin/env node
/**
 * Run the real LDAP provider against a directory and check what comes back.
 *
 * Against the bundled stand-in server (scripts/dev-ldap/run.sh):
 *
 *     scripts/dev-ldap/run.sh start /tmp/ldap
 *     LDAP_TEST_CA=/tmp/ldap/ca.pem node scripts/verify-ldap-provider.js
 *
 * ## What this proves, and what it does not
 *
 * It proves the provider speaks LDAP and LDAPS correctly, validates certificates,
 * escapes filters, refuses an empty password, drops disabled and ambiguous
 * accounts, and tells an outage from a wrong password. It does NOT prove
 * anything about a real Active Directory forest: the stand-in has no real group
 * nesting, lockout or password policy. Run the same provider against the real
 * thing with a test account before go-live; see docs/ACTIVE-DIRECTORY.md.
 */
const assert = require('node:assert/strict');
const { InvalidCredentials, DirectoryUnavailable } = require('../src/lib/directory');

const CA = process.env.LDAP_TEST_CA;
if (!CA) { console.error('Set LDAP_TEST_CA to the ca.pem written by dev-ldap/run.sh'); process.exit(2); }

const base = {
  AD_URL: 'ldaps://localhost:6360',
  AD_BASE_DN: 'ou=Staff,dc=city,dc=test',
  AD_BIND_DN: 'cn=svc-indigent,ou=Service,dc=city,dc=test',
  AD_BIND_PASSWORD: 'SvcPass#1',
  AD_TLS_CA: CA,
  AD_TIMEOUT_MS: '4000',
};
const provider = (over = {}) => {
  for (const k of Object.keys(process.env)) if (k.startsWith('AD_') && !(k in base) && !(k in over)) delete process.env[k];
  Object.assign(process.env, base, over);
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete process.env[k];
  return require('../src/lib/directoryLdap').create();
};

let pass = 0, fail = 0; const failures = [];
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`   ok   ${name}`); }
  catch (e) { fail += 1; failures.push(name); console.log(`   FAIL ${name} — ${e.message.split('\n')[0]}`); }
}
const rejects = (p, cls) => assert.rejects(p, (e) => e instanceof cls || (console.log('     got:', e.name, e.message), false));

(async () => {
  const ad = provider();

  console.log('\nSigning in');
  await check('correct password returns the person, with groups and a GUID', async () => {
    const e = await ad.authenticate('jadmin', 'Passw0rd!');
    assert.equal(e.username, 'jadmin');
    assert.equal(e.email, 'jane.admin@city.test');
    assert.equal(e.firstName, 'Jane');
    assert.equal(e.cellNumber, '0821110001');
    assert.equal(e.externalId, '33221100-5544-7766-8899-aabbccddeeff');
    assert.equal(e.disabled, false);
    assert.ok(e.groups.some((g) => /^CN=Indigent-Admins/i.test(g)));
  });
  await check('a second group membership is read too', async () => {
    const e = await ad.authenticate('jverify', 'Passw0rd!');
    assert.equal(e.groups.length, 2);
  });
  await check('sign in by UPN', async () => assert.equal((await ad.authenticate('jadmin@city.test', 'Passw0rd!')).username, 'jadmin'));
  await check('sign in by email', async () => assert.equal((await ad.authenticate('jane.admin@city.test', 'Passw0rd!')).username, 'jadmin'));
  await check('sign in as DOMAIN\\user', async () => assert.equal((await ad.authenticate('CITY\\JADMIN', 'Passw0rd!')).username, 'jadmin'));

  console.log('\nRefusals');
  await check('wrong password is InvalidCredentials', () => rejects(ad.authenticate('jadmin', 'nope'), InvalidCredentials));
  await check('an EMPTY password is refused (it would otherwise be an anonymous bind)', () => rejects(ad.authenticate('jadmin', ''), InvalidCredentials));
  await check('a whitespace password is refused', () => rejects(ad.authenticate('jadmin', '   '), InvalidCredentials));
  await check('an unknown user is InvalidCredentials', () => rejects(ad.authenticate('nobody', 'Passw0rd!'), InvalidCredentials));
  await check('a wildcard username matches nobody', () => rejects(ad.authenticate('*', 'Passw0rd!'), InvalidCredentials));
  await check('filter injection matches nobody', () => rejects(ad.authenticate('jadmin)(|(sAMAccountName=*', 'Passw0rd!'), InvalidCredentials));
  await check('a disabled account (userAccountControl 514) is refused', () => rejects(ad.authenticate('jleaver', 'Passw0rd!'), InvalidCredentials));
  await check('two accounts with one name are refused, not guessed between', () => rejects(ad.authenticate('twin', 'Passw0rd!'), InvalidCredentials));
  await check('a computer account is not a person', () => rejects(ad.authenticate('cindy-pc', 'Passw0rd!'), InvalidCredentials));

  console.log('\nSearching');
  await check('finds a person by part of a name, and not a disabled one', async () => {
    const names = (await ad.search('ver')).map((e) => e.username);
    assert.ok(names.includes('jverify'));
    assert.ok(!names.includes('jleaver'));
  });
  await check('a disabled account is never offered', async () => assert.deepEqual(await ad.search('jleaver'), []));
  await check('computers are never offered', async () => assert.deepEqual(await ad.search('cindy'), []));
  await check('a one-letter query returns nothing', async () => assert.deepEqual(await ad.search('j'), []));
  await check('wildcards in the query are escaped, not expanded', async () => assert.deepEqual(await ad.search('*)(sn=*'), []));
  await check('lookup returns the person with groups', async () => {
    const e = await ad.lookup({ username: 'jverify' });
    assert.equal(e.externalId, '33221101-5544-7766-8899-aabbccddeeff');
    assert.equal(e.groups.length, 2);
  });
  await check('lookup of an unknown or ambiguous name is null', async () => {
    assert.equal(await ad.lookup({ username: 'ghost' }), null);
    assert.equal(await ad.lookup({ username: 'twin' }), null);
  });
  await check('lookup still returns a disabled account, marked disabled (the sync needs to see it)', async () => {
    assert.equal((await ad.lookup({ username: 'jleaver' })).disabled, true);
  });

  console.log('\nTransport and outages');
  await check('StartTLS on the plain port works with the CA', async () => {
    const p = provider({ AD_URL: 'ldap://localhost:3890', AD_STARTTLS: 'true' });
    assert.equal((await p.authenticate('jadmin', 'Passw0rd!')).username, 'jadmin');
  });
  await check('ldaps without the CA is refused as a directory fault, not a wrong password', () =>
    rejects(provider({ AD_TLS_CA: undefined }).authenticate('jadmin', 'Passw0rd!'), DirectoryUnavailable));
  await check('a wrong service-account password is an outage, not the user\'s fault', () =>
    rejects(provider({ AD_BIND_PASSWORD: 'wrong' }).authenticate('jadmin', 'Passw0rd!'), DirectoryUnavailable));
  await check('nothing listening is an outage', () =>
    rejects(provider({ AD_URL: 'ldaps://localhost:6399' }).authenticate('jadmin', 'Passw0rd!'), DirectoryUnavailable));
  await check('a wrong base DN finds nobody rather than everybody', async () => {
    const p = provider({ AD_BASE_DN: 'ou=Service,dc=city,dc=test' });
    await rejects(p.authenticate('jadmin', 'Passw0rd!'), InvalidCredentials);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failed:', failures.join('; ')); process.exitCode = 1; }
})();
