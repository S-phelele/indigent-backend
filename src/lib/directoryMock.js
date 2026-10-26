const crypto = require('crypto');
const { InvalidCredentials } = require('./directory');
const { bareUsername } = require('./ldapHelpers');

/**
 * A stand-in directory for development: no domain controller needed.
 *
 * Users come from AD_MOCK_USERS (a JSON array) if set, otherwise the built-in
 * set below — one person per role, one in no mapped group, one disabled — so
 * every path through sign-in can be walked by hand. The passwords are published
 * in the README, which is why `directory.problems()` refuses this provider in
 * production.
 *
 * Group names here match the example AD_ROLE_MAP in .env.example.
 */
const OU = 'OU=Groups,DC=mock,DC=local';
const group = (name) => `CN=${name},${OU}`;

const DEFAULT_USERS = [
  { username: 'jsuper', firstName: 'Jabu', lastName: 'Super', groups: ['Indigent-Superusers'] },
  { username: 'jadmin', firstName: 'Jane', lastName: 'Admin', groups: ['Indigent-Admins'] },
  { username: 'jsupervise', firstName: 'Sipho', lastName: 'Supervisor', groups: ['Indigent-Supervisors'] },
  { username: 'jassess', firstName: 'Anele', lastName: 'Assessor', groups: ['Indigent-Assessment'] },
  { username: 'jverify', firstName: 'Vusi', lastName: 'Verifier', groups: ['Indigent-Verification'] },
  { username: 'jcapture', firstName: 'Cindy', lastName: 'Capture', groups: ['Indigent-Capture'] },
  { username: 'jcouncil', firstName: 'Thabo', lastName: 'Councillor', groups: ['Indigent-Councillors'], ward: 'Ward 12' },
  // In the directory, in no indigent group: must be refused.
  { username: 'joutsider', firstName: 'Olga', lastName: 'Outsider', groups: ['Finance-Clerks'] },
  // Left the municipality: the account is disabled.
  { username: 'jleaver', firstName: 'Lenny', lastName: 'Leaver', groups: ['Indigent-Verification'], disabled: true },
].map((u) => ({ password: 'Passw0rd!', ...u }));

const guidFor = (username) => {
  const h = crypto.createHash('sha1').update(`mock:${username}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

function create() {
  let users = DEFAULT_USERS;
  if (process.env.AD_MOCK_USERS) {
    try { users = JSON.parse(process.env.AD_MOCK_USERS).map((u) => ({ password: 'Passw0rd!', ...u })); }
    catch { throw new Error('AD_MOCK_USERS is not valid JSON.'); }
  }

  const toEntry = (u) => ({
    externalId: u.externalId || guidFor(u.username),
    username: u.username,
    upn: `${u.username}@mock.local`,
    email: u.email || `${u.username}@mock.local`,
    firstName: u.firstName || null,
    lastName: u.lastName || null,
    cellNumber: u.cellNumber || null,
    ward: u.ward || null,
    groups: (u.groups || []).map((g) => (g.includes('=') ? g : group(g))),
    disabled: Boolean(u.disabled),
  });

  const find = (identifier) => {
    const id = bareUsername(identifier).toLowerCase();
    return users.find((u) => [u.username, `${u.username}@mock.local`, u.email].filter(Boolean).some((x) => x.toLowerCase() === id));
  };

  const same = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  return {
    name: 'mock',

    async authenticate(identifier, password) {
      const user = find(identifier);
      if (!password || !user || !same(user.password, password)) throw new InvalidCredentials();
      if (user.disabled) throw new InvalidCredentials('Account disabled');
      return toEntry(user);
    },

    async search(query) {
      const q = String(query || '').trim().toLowerCase();
      if (!q) return [];
      return users
        .filter((u) => !u.disabled)
        .filter((u) => [u.username, u.firstName, u.lastName, `${u.firstName} ${u.lastName}`].some((x) => String(x || '').toLowerCase().includes(q)))
        .slice(0, 25)
        .map(toEntry);
    },

    async lookup({ username }) {
      const user = find(username);
      return user ? toEntry(user) : null;
    },
  };
}

module.exports = { create, DEFAULT_USERS };
