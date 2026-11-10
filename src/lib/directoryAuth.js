const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const sms = require('./sms');
const { roleFor } = require('./directoryRoles');
const { InvalidCredentials, DirectoryUnavailable } = require('./directory');

/**
 * Turning a directory sign-in into a user of this system.
 *
 * The directory proves who somebody is and which groups they are in. This module
 * decides what that means here: whether they may enter at all, which role they
 * hold, and keeping a local row for them — applications, approvals and the audit
 * trail all point at `User.id`, so a directory person still needs one. What they
 * do *not* need is a password or a hand-made account: the row is created the
 * first time they sign in, or when an administrator imports them.
 *
 * Built by a factory so tests can supply a fake database and a fake directory.
 *
 * ## Rules worth stating
 *
 *  - **No mapped group, no access.** Being in the directory is not enough.
 *  - **Never adopt a resident's account.** If the directory email matches an
 *    existing local account, that is a conflict to be settled by an
 *    administrator, never a silent merge. Without this, anybody able to set
 *    their own directory email could take over somebody else's local account.
 *  - **The directory never reactivates.** An administrator who deactivated an
 *    account made a decision the directory does not know about. Sign-in refuses
 *    it; only an administrator turns it back on.
 *  - **Identity is the objectGUID, not the name.** A reused username does not
 *    inherit a previous holder's history.
 */

const randomPassword = () => crypto.randomBytes(32).toString('base64');

/** A hash nobody knows the preimage of, so a directory row can never be signed into locally. */
const unusableHash = () => bcrypt.hash(randomPassword(), 10);

const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

/** The address to file the person under. The directory may have none; the row needs one and it must be unique. */
function emailFor(entry) {
  return (clean(entry.email) || clean(entry.upn) || `${String(entry.username).toLowerCase()}@directory.invalid`).toLowerCase();
}

/**
 * What to do with this person, given what already exists. Pure.
 *
 *   existing — the row with this externalId, if any
 *   byEmail  — the row with this email, if any
 *
 * Returns { action: 'create' | 'update' | 'conflict', reason?, changes? }.
 */
function plan({ existing, byEmail, entry, role }) {
  if (existing) {
    const changes = {};
    if (existing.role !== role) changes.role = role;
    const first = clean(entry.firstName);
    const last = clean(entry.lastName);
    if (first && first !== existing.firstName) changes.firstName = first;
    if (last && last !== existing.lastName) changes.lastName = last;
    if (entry.username && entry.username !== existing.directoryUsername) changes.directoryUsername = entry.username;
    if (entry.ward !== undefined && clean(entry.ward) !== existing.ward && role === 'COUNCILLOR') changes.ward = clean(entry.ward);
    return { action: 'update', changes };
  }

  if (byEmail) {
    return {
      action: 'conflict',
      reason: byEmail.role === 'APPLICANT'
        ? 'A resident account already uses this email address, so it cannot be used for a staff sign-in.'
        : 'A local staff account already uses this email address. Link it to the directory from the Staff screen, or remove it, first.',
    };
  }
  return { action: 'create' };
}

function create({ prisma, getProvider, getRoleMap, audit, onRoleChange }) {
  /** Create or update the local row. Returns { user, created, roleChanged, previousRole }. */
  async function provision(entry, role) {
    const existing = entry.externalId ? await prisma.user.findUnique({ where: { externalId: entry.externalId } }) : null;
    const byEmail = existing ? null : await prisma.user.findUnique({ where: { email: emailFor(entry) } });
    const decision = plan({ existing, byEmail, entry, role });

    if (decision.action === 'conflict') return { conflict: decision.reason };

    if (decision.action === 'update') {
      const user = await prisma.user.update({
        where: { id: existing.id },
        data: { ...decision.changes, directorySyncedAt: new Date() },
      });
      return { user, created: false, roleChanged: Boolean(decision.changes.role), previousRole: existing.role };
    }

    const user = await prisma.user.create({
      data: {
        email: emailFor(entry),
        password: await unusableHash(),
        role,
        firstName: clean(entry.firstName),
        lastName: clean(entry.lastName),
        cellNumber: sms.normaliseNumber(entry.cellNumber),
        ward: role === 'COUNCILLOR' ? clean(entry.ward) : null,
        // The directory has vouched for them; there is no SMS to confirm.
        isVerified: true,
        cellVerifiedAt: new Date(),
        mustChangePassword: false,
        authSource: 'DIRECTORY',
        externalId: entry.externalId,
        directoryUsername: entry.username,
        directorySyncedAt: new Date(),
      },
    });
    return { user, created: true, roleChanged: false };
  }

  /**
   * Sign somebody in through the directory.
   *
   * Resolves to { ok: true, user, created, roleChanged } or { ok: false, reason, message }.
   * `reason` is one of: invalid, no-role, disabled, conflict, unavailable.
   */
  async function signIn(identifier, password) {
    let entry;
    try {
      entry = await getProvider().authenticate(identifier, password);
    } catch (error) {
      if (error instanceof InvalidCredentials) return { ok: false, reason: 'invalid' };
      if (error instanceof DirectoryUnavailable) {
        console.error('[directory] unavailable:', error.message);
        return { ok: false, reason: 'unavailable' };
      }
      throw error;
    }

    if (!entry.externalId) {
      console.error('[directory] an entry came back without an objectGUID; refusing it');
      return { ok: false, reason: 'unavailable' };
    }

    const role = roleFor(entry.groups, getRoleMap());
    if (!role) return { ok: false, reason: 'no-role', username: entry.username };

    const result = await provision(entry, role);
    if (result.conflict) return { ok: false, reason: 'conflict', message: result.conflict, username: entry.username };

    if (!result.user.isActive) return { ok: false, reason: 'disabled', user: result.user };

    if (result.roleChanged && onRoleChange) await onRoleChange(result.user, result.previousRole);
    return { ok: true, user: result.user, created: result.created, roleChanged: result.roleChanged, entry };
  }

  return { signIn, provision, plan, emailFor };
}

module.exports = { create, plan, emailFor, unusableHash };
