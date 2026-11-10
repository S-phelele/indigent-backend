/**
 * From directory groups to a role in this system.
 *
 * Group membership in the directory is the single place a person's access is
 * decided. Nobody edits a role here for a directory account: they move the
 * person between groups in Active Directory, and the next sign-in follows. That
 * keeps one list of who may do what, owned by the people who already own it, and
 * makes leaving the group the same act as losing access.
 *
 * Pure functions, no I/O, so the rules that grant access to public money can be
 * tested without a directory.
 *
 * ## The map
 *
 * AD_ROLE_MAP is JSON from a group to a role:
 *
 *   {
 *     "Indigent-Admins":       "ADMIN",
 *     "Indigent-Verification": "VERIFICATION_OFFICER",
 *     "CN=Indigent-Capture,OU=Groups,DC=city,DC=gov,DC=za": "CAPTURE_OFFICER"
 *   }
 *
 * A key is either a bare group name (matched against the CN, so it works however
 * the groups are nested in OUs) or a full distinguished name (matched exactly,
 * for when two OUs hold groups with the same name). Matching ignores case and
 * the spaces people put after commas.
 *
 * APPLICANT can never be mapped: residents are not municipal staff, and a
 * directory group must not be a way to make one.
 */

/** Most privileged first. A person in several mapped groups gets the first that matches. */
const PRECEDENCE = [
  'SUPERUSER',
  'ADMIN',
  'SUPERVISOR',
  'ASSESSMENT_OFFICER',
  'VERIFICATION_OFFICER',
  'CAPTURE_OFFICER',
  'COUNCILLOR',
];

const normaliseKey = (value) => String(value ?? '').trim().replace(/\s*,\s*/g, ',').replace(/\s*=\s*/g, '=').toLowerCase();

/** Every form a group can be matched by: its full DN, and its CN on its own. */
function keysFor(group) {
  const dn = normaliseKey(group);
  const cn = /^cn=([^,]+)/i.exec(dn);
  return cn ? [dn, cn[1]] : [dn];
}

/**
 * Parse and validate AD_ROLE_MAP. Throws a sentence naming the problem, because
 * this runs at boot and a bad map should stop the server rather than quietly
 * lock everyone out — or, worse, quietly let the wrong people in.
 */
function parseRoleMap(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return new Map();

  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {
    throw new Error('AD_ROLE_MAP is not valid JSON. Expected {"Group name": "ROLE", ...}.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AD_ROLE_MAP must be a JSON object of group → role.');
  }

  const map = new Map();
  for (const [group, role] of Object.entries(parsed)) {
    if (!PRECEDENCE.includes(role)) {
      throw new Error(`AD_ROLE_MAP maps "${group}" to "${role}", which is not a staff role. Use one of: ${PRECEDENCE.join(', ')}.`);
    }
    const key = normaliseKey(group);
    if (!key) throw new Error('AD_ROLE_MAP has an empty group name.');
    if (map.has(key) && map.get(key) !== role) {
      throw new Error(`AD_ROLE_MAP lists "${group}" twice with different roles.`);
    }
    map.set(key, role);
  }
  return map;
}

/**
 * The role these groups earn, or null when none of them is mapped.
 *
 * Null is a refusal, not a default: somebody who is in the directory but in none
 * of the groups has no business in this system, and must not be given the
 * lowest role "just in case".
 */
function roleFor(groups, roleMap) {
  if (!roleMap || roleMap.size === 0) return null;

  const matched = new Set();
  for (const group of groups || []) {
    for (const key of keysFor(group)) {
      if (roleMap.has(key)) matched.add(roleMap.get(key));
    }
  }
  return PRECEDENCE.find((role) => matched.has(role)) || null;
}

module.exports = { PRECEDENCE, parseRoleMap, roleFor, keysFor, normaliseKey };
