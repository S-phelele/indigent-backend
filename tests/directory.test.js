const test = require('node:test');
const assert = require('node:assert/strict');

const roles = require('../src/lib/directoryRoles');
const h = require('../src/lib/ldapHelpers');
const directoryAuth = require('../src/lib/directoryAuth');
const directorySync = require('../src/lib/directorySync');
const { InvalidCredentials, DirectoryUnavailable } = require('../src/lib/directory');
const mock = require('../src/lib/directoryMock');

/**
 * No network, no database: the rules that decide who may sign in, and what
 * happens when they leave. A fake in-memory store stands in for Prisma.
 */

const MAP_JSON = JSON.stringify({
  'Indigent-Admins': 'ADMIN',
  'Indigent-Verification': 'VERIFICATION_OFFICER',
  'Indigent-Capture': 'CAPTURE_OFFICER',
  'CN=Indigent-Super,OU=Special,DC=city,DC=gov,DC=za': 'SUPERUSER',
});
const roleMap = roles.parseRoleMap(MAP_JSON);

// ---------------------------------------------------------------------------
// Role mapping
// ---------------------------------------------------------------------------

test('a bare group name matches by CN wherever the group sits', () => {
  assert.equal(roles.roleFor(['CN=Indigent-Admins,OU=Groups,DC=city,DC=gov,DC=za'], roleMap), 'ADMIN');
  assert.equal(roles.roleFor(['CN=Indigent-Admins,OU=Elsewhere,DC=x'], roleMap), 'ADMIN');
});

test('matching ignores case and spaces after commas', () => {
  assert.equal(roles.roleFor(['cn=INDIGENT-ADMINS, ou=Groups, dc=x'], roleMap), 'ADMIN');
});

test('a full-DN key matches only that exact group, not a namesake in another OU', () => {
  assert.equal(roles.roleFor(['CN=Indigent-Super,OU=Special,DC=city,DC=gov,DC=za'], roleMap), 'SUPERUSER');
  assert.equal(roles.roleFor(['CN=Indigent-Super,OU=Other,DC=city,DC=gov,DC=za'], roleMap), null);
});

test('no mapped group means no role — never a default', () => {
  assert.equal(roles.roleFor(['CN=Finance-Clerks,OU=Groups,DC=x'], roleMap), null);
  assert.equal(roles.roleFor([], roleMap), null);
  assert.equal(roles.roleFor(undefined, roleMap), null);
  assert.equal(roles.roleFor(['CN=Indigent-Admins,OU=G,DC=x'], new Map()), null);
});

test('several mapped groups give the most privileged role', () => {
  assert.equal(roles.roleFor(['CN=Indigent-Capture,DC=x', 'CN=Indigent-Admins,DC=x'], roleMap), 'ADMIN');
  assert.equal(roles.roleFor(['CN=Indigent-Capture,DC=x', 'CN=Indigent-Verification,DC=x'], roleMap), 'VERIFICATION_OFFICER');
});

test('the role map refuses APPLICANT, unknown roles, bad JSON and conflicting duplicates', () => {
  assert.throws(() => roles.parseRoleMap('{"G":"APPLICANT"}'), /not a staff role/);
  assert.throws(() => roles.parseRoleMap('{"G":"KING"}'), /not a staff role/);
  assert.throws(() => roles.parseRoleMap('{nope'), /not valid JSON/);
  assert.throws(() => roles.parseRoleMap('[1]'), /JSON object/);
  assert.throws(() => roles.parseRoleMap('{"G":"ADMIN","g":"COUNCILLOR"}'), /twice/);
  assert.equal(roles.parseRoleMap('').size, 0);
});

// ---------------------------------------------------------------------------
// LDAP helpers
// ---------------------------------------------------------------------------

test('filter values are escaped so a username cannot rewrite the search', () => {
  const evil = '*)(objectClass=*';
  const escaped = h.escapeFilterValue(evil);
  assert.doesNotMatch(escaped, /[*()]/);
  assert.equal(h.escapeFilterValue('a\\b'), 'a\\5cb');
  assert.equal(h.escapeFilterValue('plain.name'), 'plain.name');
});

test('userAccountControl bit 2 means disabled', () => {
  assert.equal(h.isDisabled(514), true);   // normal account + disabled
  assert.equal(h.isDisabled(512), false);  // normal account
  assert.equal(h.isDisabled(66050), true); // disabled + password never expires
  assert.equal(h.isDisabled(undefined), false);
});

test('objectGUID is read in AD mixed-endian order', () => {
  const guid = h.guidFromBuffer(Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
  assert.equal(guid, '33221100-5544-7766-8899-aabbccddeeff');
  assert.equal(h.guidFromBuffer(Buffer.from('short')), null);
  assert.equal(h.guidFromBuffer('not a buffer'), null);
});

test('DOMAIN\\user and user are the same person; an email is left alone', () => {
  assert.equal(h.bareUsername('CITY\\jsmith'), 'jsmith');
  assert.equal(h.bareUsername('jsmith'), 'jsmith');
  assert.equal(h.bareUsername('jsmith@city.gov.za'), 'jsmith@city.gov.za');
});

// ---------------------------------------------------------------------------
// Sign-in and provisioning (fake database)
// ---------------------------------------------------------------------------

function fakePrisma(seed = []) {
  const rows = seed.map((r, i) => ({ id: `u${i}`, isActive: true, role: 'APPLICANT', authSource: 'LOCAL', externalId: null, ...r }));
  let n = rows.length;
  const match = (where) => (r) => Object.entries(where).every(([k, v]) => (typeof v === 'object' && v !== null ? (v.in ? v.in.includes(r[k]) : true) : r[k] === v));
  return {
    rows,
    user: {
      findUnique: async ({ where }) => rows.find(match(where)) || null,
      findMany: async ({ where }) => rows.filter(match(where || {})),
      create: async ({ data }) => { const r = { id: `u${n++}`, isActive: true, ...data }; rows.push(r); return r; },
      update: async ({ where, data }) => { const r = rows.find(match(where)); Object.assign(r, data); return r; },
    },
  };
}

const auditCalls = [];
const fakeAudit = { record: async (_req, call) => { auditCalls.push(call); }, ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }) };

function harness(seedRows = [], users) {
  const provider = mock.create();
  if (users) process.env.AD_MOCK_USERS = JSON.stringify(users);
  const p = users ? mock.create() : provider;
  delete process.env.AD_MOCK_USERS;
  const prisma = fakePrisma(seedRows);
  const auth = directoryAuth.create({ prisma, getProvider: () => p, getRoleMap: () => roleMap, audit: fakeAudit });
  return { prisma, auth, provider: p };
}

const stdRoleMap = roles.parseRoleMap(JSON.stringify({
  'Indigent-Admins': 'ADMIN', 'Indigent-Verification': 'VERIFICATION_OFFICER', 'Indigent-Capture': 'CAPTURE_OFFICER',
}));
function stdHarness(seed) {
  const prisma = fakePrisma(seed);
  const provider = mock.create();
  const auth = directoryAuth.create({ prisma, getProvider: () => provider, getRoleMap: () => stdRoleMap, audit: fakeAudit });
  return { prisma, auth, provider };
}

test('first sign-in creates the local account with the role from the group, and no usable password', async () => {
  const { prisma, auth } = stdHarness();
  const r = await auth.signIn('jverify', 'Passw0rd!');
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.user.role, 'VERIFICATION_OFFICER');
  assert.equal(r.user.authSource, 'DIRECTORY');
  assert.equal(r.user.isVerified, true);
  assert.equal(r.user.mustChangePassword, false);
  assert.ok(r.user.externalId);
  assert.notEqual(r.user.password, 'Passw0rd!');
  assert.equal(prisma.rows.length, 1);
});

test('signing in again reuses the same row instead of creating another', async () => {
  const { prisma, auth } = stdHarness();
  await auth.signIn('jverify', 'Passw0rd!');
  const again = await auth.signIn('JVERIFY', 'Passw0rd!');
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(prisma.rows.length, 1);
});

test('a wrong password is "invalid" and creates nothing', async () => {
  const { prisma, auth } = stdHarness();
  assert.equal((await auth.signIn('jverify', 'nope')).reason, 'invalid');
  assert.equal((await auth.signIn('jverify', '')).reason, 'invalid');
  assert.equal((await auth.signIn('nobody', 'Passw0rd!')).reason, 'invalid');
  assert.equal(prisma.rows.length, 0);
});

test('being in the directory but in no mapped group is refused, and nothing is created', async () => {
  const { prisma, auth } = stdHarness();
  const r = await auth.signIn('joutsider', 'Passw0rd!');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-role');
  assert.equal(prisma.rows.length, 0);
});

test('a disabled directory account cannot sign in', async () => {
  const { auth } = stdHarness();
  assert.equal((await auth.signIn('jleaver', 'Passw0rd!')).reason, 'invalid');
});

test('moving to another group changes the role at the next sign-in', async () => {
  const { prisma, auth } = stdHarness();
  await auth.signIn('jverify', 'Passw0rd!');
  prisma.rows[0].role = 'COUNCILLOR'; // as if the group had changed since
  const r = await auth.signIn('jverify', 'Passw0rd!');
  assert.equal(r.ok, true);
  assert.equal(r.roleChanged, true);
  assert.equal(r.user.role, 'VERIFICATION_OFFICER');
});

test('an account an administrator deactivated is not switched back on by the directory', async () => {
  const { prisma, auth } = stdHarness();
  await auth.signIn('jverify', 'Passw0rd!');
  prisma.rows[0].isActive = false;
  const r = await auth.signIn('jverify', 'Passw0rd!');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(prisma.rows[0].isActive, false);
});

test("a resident's account is never adopted, even with the same email", async () => {
  const { prisma, auth } = stdHarness([{ email: 'jverify@mock.local', role: 'APPLICANT', authSource: 'LOCAL' }]);
  const r = await auth.signIn('jverify', 'Passw0rd!');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict');
  assert.match(r.message, /resident/);
  assert.equal(prisma.rows.length, 1);
  assert.equal(prisma.rows[0].authSource, 'LOCAL');
});

test('an existing local staff account is a conflict too, until an administrator links it', async () => {
  const { auth } = stdHarness([{ email: 'jadmin@mock.local', role: 'ADMIN', authSource: 'LOCAL' }]);
  const r = await auth.signIn('jadmin', 'Passw0rd!');
  assert.equal(r.reason, 'conflict');
  assert.match(r.message, /Link it/);
});

test('an unreachable directory is "unavailable", not a wrong password', async () => {
  const prisma = fakePrisma();
  const down = { authenticate: async () => { throw new DirectoryUnavailable('timeout'); } };
  const auth = directoryAuth.create({ prisma, getProvider: () => down, getRoleMap: () => stdRoleMap, audit: fakeAudit });
  const origError = console.error; console.error = () => {};
  try { assert.equal((await auth.signIn('jadmin', 'x')).reason, 'unavailable'); } finally { console.error = origError; }
});

test('an entry with no objectGUID is refused rather than filed under a guess', async () => {
  const prisma = fakePrisma();
  const odd = { authenticate: async () => ({ username: 'x', groups: ['CN=Indigent-Admins,DC=x'], externalId: null }) };
  const auth = directoryAuth.create({ prisma, getProvider: () => odd, getRoleMap: () => stdRoleMap, audit: fakeAudit });
  const origError = console.error; console.error = () => {};
  try { assert.equal((await auth.signIn('x', 'y')).ok, false); } finally { console.error = origError; }
  assert.equal(prisma.rows.length, 0);
});

test('mock directory: wrong or empty password is InvalidCredentials', async () => {
  const p = mock.create();
  await assert.rejects(() => p.authenticate('jadmin', 'bad'), InvalidCredentials);
  await assert.rejects(() => p.authenticate('jadmin', ''), InvalidCredentials);
  await assert.rejects(() => p.authenticate('jleaver', 'Passw0rd!'), InvalidCredentials);
});

// ---------------------------------------------------------------------------
// Scheduled sync
// ---------------------------------------------------------------------------

function syncHarness(staff, provider) {
  const prisma = fakePrisma(staff.map((s) => ({ authSource: 'DIRECTORY', isActive: true, ...s })));
  const notified = [];
  const notify = { TYPE: { ACCOUNT_LOCKED: 'ACCOUNT_LOCKED' }, toAdmins: async (n) => { notified.push(n); } };
  const sync = directorySync.create({ prisma, getProvider: () => provider, getRoleMap: () => stdRoleMap, audit: fakeAudit, notify });
  return { prisma, sync, notified };
}

const entryFor = (username, groups, extra = {}) => ({ externalId: `g-${username}`, username, groups, disabled: false, ...extra });
const person = (username, role = 'VERIFICATION_OFFICER') => ({ email: `${username}@x`, role, externalId: `g-${username}`, directoryUsername: username });

test('sync deactivates somebody who left their group, and notifies administrators', async () => {
  const dir = { lookup: async ({ username }) => ({ a: entryFor('a', ['CN=Indigent-Verification,DC=x']), b: entryFor('b', ['CN=Finance,DC=x']) }[username] || null) };
  const { prisma, sync, notified } = syncHarness([person('a'), person('b')], dir);
  const s = await sync.run();
  assert.equal(s.deactivated.length, 1);
  assert.equal(prisma.rows.find((r) => r.directoryUsername === 'b').isActive, false);
  assert.equal(prisma.rows.find((r) => r.directoryUsername === 'a').isActive, true);
  assert.equal(notified.length, 1);
});

test('sync deactivates a disabled directory account and one that no longer exists', async () => {
  const dir = {
    lookup: async ({ username }) => {
      if (username === 'b') return entryFor('b', ['CN=Indigent-Verification,DC=x'], { disabled: true });
      if (username === 'c') return null;
      return entryFor(username, ['CN=Indigent-Verification,DC=x']);
    },
  };
  const { prisma, sync } = syncHarness(['a', 'b', 'c', 'd', 'e', 'f'].map((u) => person(u)), dir);
  const s = await sync.run();
  assert.equal(s.aborted, null);
  assert.deepEqual(s.deactivated.map((d) => d.email).sort(), ['b@x', 'c@x']);
  assert.equal(prisma.rows.filter((r) => r.isActive).length, 4);
});

test('sync follows a role change', async () => {
  const dir = { lookup: async ({ username }) => entryFor(username, ['CN=Indigent-Admins,DC=x']) };
  const { prisma, sync } = syncHarness([person('a')], dir);
  const s = await sync.run();
  assert.deepEqual(s.roleChanges, [{ email: 'a@x', from: 'VERIFICATION_OFFICER', to: 'ADMIN' }]);
  assert.equal(prisma.rows[0].role, 'ADMIN');
});

test('an unreachable directory changes nothing', async () => {
  const dir = { lookup: async () => { throw new DirectoryUnavailable('down'); } };
  const { prisma, sync } = syncHarness([person('a'), person('b')], dir);
  const s = await sync.run();
  assert.match(s.aborted, /could not be reached/);
  assert.equal(prisma.rows.every((r) => r.isActive), true);
});

test('most staff vanishing at once is treated as a fault, not resignations', async () => {
  const dir = { lookup: async ({ username }) => (username === 'a' ? entryFor('a', ['CN=Indigent-Verification,DC=x']) : null) };
  const { prisma, sync } = syncHarness(['a', 'b', 'c', 'd', 'e'].map((u) => person(u)), dir);
  const s = await sync.run();
  assert.match(s.aborted, /configuration or permissions fault/);
  assert.equal(prisma.rows.every((r) => r.isActive), true);
});

test('a reused username belonging to a different person is not mistaken for the original', () => {
  const user = { externalId: 'g-original' };
  const entry = { externalId: 'g-someone-else', groups: ['CN=Indigent-Admins,DC=x'], disabled: false };
  assert.equal(directorySync.classify(user, entry, stdRoleMap).status, 'missing');
});

test('sync never reactivates anybody', async () => {
  const dir = { lookup: async ({ username }) => entryFor(username, ['CN=Indigent-Verification,DC=x']) };
  const { prisma, sync } = syncHarness([{ ...person('a'), isActive: false }], dir);
  await sync.run();
  assert.equal(prisma.rows[0].isActive, false);
});
