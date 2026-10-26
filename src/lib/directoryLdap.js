const fs = require('fs');
const { Client, InvalidCredentialsError } = require('ldapts');
const { DirectoryUnavailable, InvalidCredentials } = require('./directory');
const h = require('./ldapHelpers');

/**
 * Active Directory over LDAP(S), using the `ldapts` client.
 *
 * ## How sign-in works
 *
 *  1. Bind as a read-only **service account** and search for the person by the
 *     name they typed (sAMAccountName, userPrincipalName or mail).
 *  2. Bind again, on a fresh connection, **as that person** with the password
 *     they typed. AD checks it; this system never sees a hash, never stores the
 *     password, and AD's own lockout and password-expiry rules apply.
 *  3. Read their group memberships.
 *
 * ## The traps this code is written around
 *
 *  - **Empty password.** An LDAP "simple bind" with a name and an empty password
 *    is an *unauthenticated bind*, which many servers report as success. It is
 *    refused before anything is sent.
 *  - **Filter injection.** The typed name is escaped (RFC 4515) before it goes
 *    into a search filter.
 *  - **Ambiguity.** If the search matches more than one account, nobody is let
 *    in. Guessing which was meant is how the wrong person gets a session.
 *  - **Plain text.** ldap:// without StartTLS sends passwords unencrypted;
 *    directory.problems() refuses it in production.
 *  - **Outage versus rejection.** An unreachable directory is
 *    DirectoryUnavailable, not InvalidCredentials, so a network fault is never
 *    reported to the user as "wrong password" and never counts against anyone.
 *
 * Written and unit-tested against a real LDAP server, but not against a real
 * Active Directory forest: see the README for the checklist to run on site.
 */

const ATTRIBUTES = [
  'sAMAccountName', 'userPrincipalName', 'mail', 'givenName', 'sn', 'displayName',
  'mobile', 'memberOf', 'objectGUID', 'userAccountControl',
];

function create() {
  const e = process.env;
  const url = e.AD_URL;
  const baseDN = e.AD_BASE_DN;
  const timeout = parseInt(e.AD_TIMEOUT_MS || '10000', 10);
  const loginAttrs = (e.AD_LOGIN_ATTRIBUTES || 'sAMAccountName,userPrincipalName,mail').split(',').map((s) => s.trim()).filter(Boolean);
  const wardAttr = e.AD_WARD_ATTRIBUTE || null;
  const nested = String(e.AD_NESTED_GROUPS).toLowerCase() === 'true';
  const startTls = String(e.AD_STARTTLS).toLowerCase() === 'true';

  const tlsOptions = {
    rejectUnauthorized: String(e.AD_TLS_REJECT_UNAUTHORIZED).toLowerCase() !== 'false',
    ...(e.AD_TLS_CA ? { ca: [fs.readFileSync(e.AD_TLS_CA)] } : {}),
  };

  const attributes = wardAttr ? [...ATTRIBUTES, wardAttr] : ATTRIBUTES;
  // Real people only: not computers, not contacts, not groups.
  const PERSON = '(&(objectCategory=person)(objectClass=user))';

  // TLS options go to the constructor only for ldaps://. Given to a plain
  // ldap:// client they make it attempt a TLS handshake on a cleartext port, and
  // StartTLS then fails with "socket disconnected before secure TLS connection".
  const implicitTls = /^ldaps:\/\//i.test(String(url));
  const client = () => new Client({
    url,
    timeout,
    connectTimeout: timeout,
    ...(implicitTls ? { tlsOptions } : {}),
    strictDN: false,
  });

  /** Open a connection, upgrading it with StartTLS when configured. */
  async function connect() {
    const c = client();
    if (startTls) await c.startTLS(tlsOptions);
    return c;
  }

  /** Run `fn` with a bound client and always close it. Translates network faults. */
  async function withBind(dn, password, fn) {
    let c;
    try {
      c = await connect();
      await c.bind(dn, password);
      return await fn(c);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) throw new InvalidCredentials();
      if (error instanceof InvalidCredentials) throw error;
      if (error.name === 'DirectoryUnavailable') throw error;
      throw new DirectoryUnavailable(`The directory could not be reached: ${error.message}`);
    } finally {
      try { await c?.unbind(); } catch { /* already closed */ }
    }
  }

  /** As withBind, but a rejected *service account* is an outage, not a wrong password. */
  const asService = (fn) =>
    withBind(e.AD_BIND_DN, e.AD_BIND_PASSWORD, fn).catch((error) => {
      if (error instanceof InvalidCredentials) {
        throw new DirectoryUnavailable('The directory rejected the service account. Check AD_BIND_DN and AD_BIND_PASSWORD.');
      }
      throw error;
    });

  const toEntry = (raw) => {
    const memberOf = h.all(raw.memberOf);
    return {
      dn: raw.dn,
      externalId: h.guidFromBuffer(h.first(raw.objectGUID)) || null,
      username: h.first(raw.sAMAccountName),
      upn: h.first(raw.userPrincipalName),
      email: h.first(raw.mail),
      firstName: h.first(raw.givenName),
      lastName: h.first(raw.sn),
      displayName: h.first(raw.displayName),
      cellNumber: h.first(raw.mobile),
      ward: wardAttr ? h.first(raw[wardAttr]) : null,
      groups: memberOf.map(String),
      disabled: h.isDisabled(h.first(raw.userAccountControl)),
    };
  };

  async function searchUsers(c, filter, sizeLimit = 25) {
    const { searchEntries } = await c.search(baseDN, {
      scope: 'sub',
      filter,
      attributes,
      explicitBufferAttributes: ['objectGUID'],
      sizeLimit,
    });
    return searchEntries;
  }

  /**
   * With AD_NESTED_GROUPS, ask AD whether the person is in each mapped group
   * *transitively* (LDAP_MATCHING_RULE_IN_CHAIN). A plain memberOf lists only
   * direct membership, so a person in a team group that sits inside
   * Indigent-Admins would otherwise be refused.
   */
  async function withNestedGroups(c, entry) {
    if (!nested) return entry;
    const { roleMap } = require('./directory');
    const extra = [];
    for (const key of roleMap().keys()) {
      if (!key.includes('=')) continue; // chain matching needs a full DN
      const { searchEntries } = await c.search(baseDN, {
        scope: 'sub',
        filter: `(&(distinguishedName=${h.escapeFilterValue(entry.dn)})(memberOf:1.2.840.113556.1.4.1941:=${h.escapeFilterValue(key)}))`,
        attributes: ['distinguishedName'],
        sizeLimit: 1,
      });
      if (searchEntries.length) extra.push(key);
    }
    return { ...entry, groups: [...new Set([...entry.groups, ...extra])] };
  }

  const loginFilter = (name) => {
    const v = h.escapeFilterValue(name);
    return `(&${PERSON}(|${loginAttrs.map((a) => `(${a}=${v})`).join('')}))`;
  };

  return {
    name: 'ldap',

    async authenticate(identifier, password) {
      const name = h.bareUsername(identifier);
      // An empty password turns a bind into an *anonymous* one that many
      // servers accept. Never let it reach the wire.
      if (!name || !password || String(password).trim() === '') throw new InvalidCredentials();

      const found = await asService((c) => searchUsers(c, loginFilter(name), 2));
      if (found.length !== 1) throw new InvalidCredentials(found.length ? 'Ambiguous account' : 'No such account');

      const entry = toEntry(found[0]);
      if (entry.disabled) throw new InvalidCredentials('Account disabled');

      // The decisive step: AD, not this system, checks the password.
      return withBind(entry.dn, password, (c) => withNestedGroups(c, entry));
    },

    async search(query) {
      const q = h.escapeFilterValue(String(query || '').trim());
      if (q.length < 2) return [];
      const filter = `(&${PERSON}`
        + `(|(sAMAccountName=${q}*)(userPrincipalName=${q}*)(mail=${q}*)(displayName=*${q}*)(sn=${q}*)(givenName=${q}*)))`;
      // Disabled accounts are dropped here rather than with AD's bitwise
      // matching rule in the filter: the result is the same, and it does not
      // depend on a server feature only AD has. Fetch extra so dropping a few
      // still leaves a full page.
      const found = await asService((c) => searchUsers(c, filter, 60));
      return found.map(toEntry).filter((entry) => !entry.disabled).slice(0, 25);
    },

    async lookup({ username }) {
      const name = h.bareUsername(username);
      if (!name) return null;
      return asService(async (c) => {
        const rows = await searchUsers(c, `(&${PERSON}(sAMAccountName=${h.escapeFilterValue(name)}))`, 2);
        // Zero is "gone"; more than one is ambiguous, which is treated the same
        // way — never guess which account was meant.
        return rows.length === 1 ? withNestedGroups(c, toEntry(rows[0])) : null;
      });
    },
  };
}

module.exports = { create, ATTRIBUTES };
