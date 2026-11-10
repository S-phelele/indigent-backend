const { parseRoleMap } = require('./directoryRoles');

/**
 * The municipal directory (Active Directory), behind one interface.
 *
 * Same shape as sms.js and verifyProvider.js: provider chosen by configuration,
 * so the rest of the system never learns whether it is talking to a domain
 * controller or to the development stand-in.
 *
 *  - **ldap**  — binds to a domain controller over LDAPS.
 *  - **mock**  — a handful of built-in users with published passwords, for
 *    working on the sign-in flow without a directory. Refused in production.
 *
 * A provider offers:
 *   authenticate(identifier, password) → entry | throws InvalidCredentials | DirectoryUnavailable
 *   search(query)                      → entry[]
 *   lookup({ username, externalId })   → entry | null
 *
 * where an entry is:
 *   { externalId, username, upn, email, firstName, lastName, cellNumber, ward, groups[], disabled }
 */

class DirectoryUnavailable extends Error {
  constructor(message) { super(message); this.name = 'DirectoryUnavailable'; }
}
class InvalidCredentials extends Error {
  constructor(message = 'Invalid credentials') { super(message); this.name = 'InvalidCredentials'; }
}

const env = () => process.env;

const enabled = () => String(env().AD_ENABLED || '').toLowerCase() === 'true';
const providerName = () => (env().AD_PROVIDER || 'ldap').toLowerCase();
const roleMap = () => parseRoleMap(env().AD_ROLE_MAP);

/**
 * Everything wrong with the current configuration, as sentences.
 *
 * Checked at boot. In production a non-empty list stops the server: running with
 * a half-configured directory means either nobody can sign in, or — the worse
 * case — an insecure bind is quietly in use.
 */
function problems() {
  if (!enabled()) return [];
  const e = env();
  const list = [];
  const production = e.NODE_ENV === 'production';

  if (!['ldap', 'mock'].includes(providerName())) list.push(`AD_PROVIDER "${providerName()}" is not "ldap" or "mock".`);

  try {
    if (roleMap().size === 0) list.push('AD_ROLE_MAP is empty, so nobody would be allowed in. Map at least one group to a role.');
  } catch (error) { list.push(error.message); }

  if (providerName() === 'mock' && production) {
    list.push('AD_PROVIDER=mock has built-in users with published passwords and must never run in production.');
  }

  if (providerName() === 'ldap') {
    for (const name of ['AD_URL', 'AD_BASE_DN', 'AD_BIND_DN', 'AD_BIND_PASSWORD']) {
      if (!e[name]) list.push(`${name} is not set.`);
    }
    const url = String(e.AD_URL || '');
    if (url && !/^ldaps?:\/\//i.test(url)) list.push('AD_URL must start with ldaps:// (or ldap:// with AD_STARTTLS=true).');
    const secure = /^ldaps:\/\//i.test(url) || String(e.AD_STARTTLS).toLowerCase() === 'true';
    if (url && !secure) {
      const msg = 'AD_URL is a plain ldap:// connection. Passwords would cross the network unencrypted. Use ldaps:// or set AD_STARTTLS=true.';
      if (production) list.push(msg);
      else console.warn(`WARNING: ${msg}`);
    }
    if (String(e.AD_TLS_REJECT_UNAUTHORIZED).toLowerCase() === 'false' && production) {
      list.push('AD_TLS_REJECT_UNAUTHORIZED=false switches off certificate checking. Provide the CA with AD_TLS_CA instead.');
    }
  }
  return list;
}

let cached;
/** The active provider. Throws if the directory is not enabled. */
function active() {
  if (!enabled()) throw new Error('Directory sign-in is not enabled (AD_ENABLED).');
  if (!cached || cached.name !== providerName()) {
    cached = providerName() === 'mock' ? require('./directoryMock').create() : require('./directoryLdap').create();
  }
  return cached;
}

/** For tests: forget the cached provider after changing the environment. */
function reset() { cached = undefined; }

module.exports = { enabled, providerName, roleMap, problems, active, reset, DirectoryUnavailable, InvalidCredentials };
