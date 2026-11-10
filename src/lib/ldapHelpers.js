/**
 * The small pure pieces of talking LDAP to Active Directory, kept apart from
 * the network code so each can be tested on its own.
 */

/**
 * Escape a value for use inside an LDAP search filter (RFC 4515).
 *
 * The username comes straight from a sign-in form. Without this, typing
 * `*)(objectClass=*` as a username rewrites the filter — the classic LDAP
 * injection, which here would let somebody enumerate the directory or match
 * somebody other than who they claim to be.
 */
function escapeFilterValue(value) {
  return String(value ?? '').replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/**
 * Whether an Active Directory account is disabled.
 *
 * userAccountControl is a bit field; 0x2 is ACCOUNTDISABLE. A disabled account
 * cannot bind anyway, but the scheduled sync reads accounts without binding as
 * them, and needs to know.
 */
function isDisabled(userAccountControl) {
  const flags = Number(userAccountControl);
  return Number.isFinite(flags) && (flags & 0x2) === 0x2;
}

/**
 * objectGUID arrives as 16 raw bytes in AD's mixed-endian layout: the first
 * three groups are byte-reversed. Written out as the familiar hyphenated string,
 * which is what an administrator sees in the AD tools and so can compare.
 */
function guidFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 16) return null;
  const hex = buf.toString('hex');
  const rev = (s) => s.match(/../g).reverse().join('');
  return [rev(hex.slice(0, 8)), rev(hex.slice(8, 12)), rev(hex.slice(12, 16)), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** A directory attribute may be a string, an array, or absent. */
const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;
const all = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/**
 * "DOMAIN\\jsmith" and "jsmith" are the same person. Windows users type both.
 * An email address or UPN is left alone.
 */
function bareUsername(identifier) {
  const text = String(identifier ?? '').trim();
  const slash = text.lastIndexOf('\\');
  return slash >= 0 ? text.slice(slash + 1) : text;
}

module.exports = { escapeFilterValue, isDisabled, guidFromBuffer, first, all, bareUsername };
