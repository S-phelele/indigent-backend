const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { protect, requireAdmin } = require('../middleware/auth');
const audit = require('../lib/audit');
const sms = require('../lib/sms');
const smsTemplates = require('../lib/smsTemplates');
const { passwordProblems, temporaryPassword } = require('../lib/credentials');
const saId = require('../lib/saIdNumber');
const sanitize = require('../lib/sanitize');
const cache = require('../lib/cache');
const loginSecurity = require('../lib/loginSecurity');
const directory = require('../lib/directoryService');
const { roleFor } = require('../lib/directoryRoles');
const { unusableHash } = require('../lib/directoryAuth');

/**
 * Administering municipal staff.
 *
 * Three roles work this register besides administrators, and each is created
 * here by an administrator — never by self-registration, because the ability to
 * create resident accounts, or to sign off a verification, has to be granted
 * deliberately by somebody accountable.
 *
 *   COUNCILLOR           captures door to door in a ward
 *   CAPTURE_OFFICER      captures walk-ins at the front desk
 *   VERIFICATION_OFFICER checks a captured application and recommends
 *
 * Administrators are deliberately not creatable here. Granting the role that can
 * approve public money should not be a two-click operation inside the same
 * screen used for routine staff admin.
 *
 * Mounted under /api/admin/staff and administrator-only throughout.
 */
const router = express.Router();
router.use(...protect, requireAdmin);
router.use(cache.invalidateOn(cache.TAGS.STAFF, cache.TAGS.USERS, cache.TAGS.ANALYTICS));

/** Roles this screen may create. ADMIN is not among them, on purpose. */
const MANAGEABLE_ROLES = ['COUNCILLOR', 'CAPTURE_OFFICER', 'VERIFICATION_OFFICER', 'ASSESSMENT_OFFICER', 'SUPERVISOR'];

/**
 * Roles only a superuser may hand out.
 *
 * Both can decide, and SUPERUSER can walk a case through every stage on its own,
 * so neither should be assignable by an account that does not already hold that
 * much power itself.
 */
const PRIVILEGED_ROLES = ['ADMIN', 'SUPERUSER'];

const ROLE_LABELS = {
  COUNCILLOR: 'Ward Councillor',
  CAPTURE_OFFICER: 'Capture Officer',
  VERIFICATION_OFFICER: 'Verification Officer',
  ASSESSMENT_OFFICER: 'Assessment Officer',
  SUPERVISOR: 'Supervisor',
  ADMIN: 'Administrator',
  SUPERUSER: 'Super Administrator',
};

const ROLE_HINTS = {
  COUNCILLOR: 'Captures applications door to door in a ward.',
  CAPTURE_OFFICER: 'Captures walk-in applications at the front desk.',
  VERIFICATION_OFFICER: 'Checks captured applications and recommends an outcome.',
  ASSESSMENT_OFFICER: 'Applies the means test and confirms the budget.',
  SUPERVISOR: 'Signs off approvals. Cannot approve without a drawn signature.',
  ADMIN: 'Runs the register and makes the final decision.',
  SUPERUSER: 'Does everything, including every stage of one case. Grant sparingly.',
};

const STAFF_FIELDS = {
  id: true,
  role: true,
  email: true,
  firstName: true,
  lastName: true,
  cellNumber: true,
  ward: true,
  isActive: true,
  mustChangePassword: true,
  // Sign-in security, so an administrator can see who is locked out and who has
  // not signed in for months — both worth acting on.
  lockedUntil: true,
  failedLoginAttempts: true,
  lastLoginAt: true,
  // Where the account's credentials live, so the screen can say "Windows account".
  authSource: true,
  directoryUsername: true,
  directorySyncedAt: true,
  createdAt: true,
  updatedAt: true,
};

const fullName = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;

/**
 * Issue a password and text it over.
 *
 * The plaintext is returned to the caller — the administrator who just created
 * the account — and nowhere else. It is never persisted, and it is redacted out
 * of the stored SMS body. The administrator needs it because SMS delivery is not
 * guaranteed and somebody has to be able to read the password out over a desk.
 */
async function issueCredentials(user, { purpose }) {
  const plain = temporaryPassword();
  const body = smsTemplates.build('WELCOME_CREDENTIALS', {
    firstName: user.firstName,
    username: user.email,
    tempPassword: plain,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: await bcrypt.hash(plain, 12),
      mustChangePassword: true,
      /**
       * Ends the holder's existing sessions.
       *
       * An administrator resetting a staff password is usually responding to a
       * lost device or a suspected compromise, so the old sessions are precisely
       * what needs to stop working.
       */
      passwordChangedAt: new Date(),
      // A reset is also the way an administrator releases a locked account.
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastFailedLoginAt: null,
    },
  });

  const delivery = await sms.send(user.cellNumber, body, {
    purpose,
    userId: user.id,
    entityType: 'User',
    entityId: user.id,
    secrets: [plain],
  });

  return { temporaryPassword: plain, smsDelivered: delivery.ok, smsReason: delivery.reason };
}

/**
 * The roles this administrator may assign, with their labels and hints.
 *
 * Served rather than hardcoded in the portal. The portal's own list had three
 * entries where the enum has seven, and the two it omitted were
 * ASSESSMENT_OFFICER and SUPERVISOR — the roles that own stages two and three of
 * the approval chain. An administrator could not appoint anybody to half the
 * workflow, and nothing on either side said so.
 *
 * Registered before `/:id` so "roles" is not read as a staff member's id.
 */
router.get('/roles', (req, res) => {
  const assignable = [
    ...MANAGEABLE_ROLES,
    ...(req.user.role === 'SUPERUSER' ? PRIVILEGED_ROLES : []),
  ];

  res.json({
    success: true,
    data: assignable.map((value) => ({
      value,
      label: ROLE_LABELS[value] || value,
      hint: ROLE_HINTS[value] || '',
      privileged: PRIVILEGED_ROLES.includes(value),
    })),
  });
});

/** List councillors, with how much each has captured. */
/**
 * Every role this screen will ever show — the ones it can create and manage
 * outright, plus the privileged two, listed for visibility only.
 *
 * Kept apart from `MANAGEABLE_ROLES` deliberately: the list broadens so an
 * administrator can see who else holds admin access, which is worth knowing,
 * but the view/edit/delete/reset/unlock routes below stay scoped to
 * `MANAGEABLE_ROLES` alone — seeing an administrator here does not mean this
 * screen can act on one.
 */
const VISIBLE_ROLES = [...MANAGEABLE_ROLES, ...PRIVILEGED_ROLES];

router.get('/', async (req, res) => {
  try {
    const { status = 'all', search = '' } = req.query;
    const role = sanitize.oneOf(req.query.role, VISIBLE_ROLES);
    const term = sanitize.searchTerm(search);

    /**
     * Scoped to every role this screen will show, always.
     *
     * `role` from the query narrows *within* that set; it can never widen it. An
     * earlier version passed the query value straight through, which with no
     * filter selected became `role: undefined` — and Prisma drops an undefined
     * condition, so the screen listed every account in the system including
     * every applicant's email address. A filter must never be the only thing
     * standing between a staff screen and the whole user table.
     */
    const where = {
      role: role ? role : { in: VISIBLE_ROLES },
      ...(status === 'active' ? { isActive: true } : {}),
      ...(status === 'inactive' ? { isActive: false } : {}),
      ...(term
        ? {
            OR: [
              { firstName: { contains: term, mode: 'insensitive' } },
              { lastName: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
              { ward: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const councillors = await prisma.user.findMany({
      where,
      select: { ...STAFF_FIELDS, _count: { select: { captured: true } } },
      orderBy: [{ isActive: 'desc' }, { ward: 'asc' }, { lastName: 'asc' }],
      take: 500,
    });

    // One grouped query rather than a count per councillor.
    const submitted = await prisma.application.groupBy({
      by: ['capturedById'],
      where: { capturedById: { in: councillors.map((c) => c.id) }, status: { not: 'DRAFT' } },
      _count: { _all: true },
    });
    const submittedBy = Object.fromEntries(submitted.map((r) => [r.capturedById, r._count._all]));

    res.json({
      success: true,
      data: councillors.map(({ _count, ...c }) => ({
        ...c,
        name: fullName(c),
        roleLabel: ROLE_LABELS[c.role] || c.role,
        capturedTotal: _count.captured,
        capturedSubmitted: submittedBy[c.id] || 0,
        // Resolved here rather than in the browser, so an expired lock is never
        // shown as still locked because a device clock is wrong.
        locked: loginSecurity.lockState(c).locked,
        lockedForMinutes: loginSecurity.lockState(c).minutesLeft || null,
      })),
    });
  } catch (error) {
    console.error('staff list error:', error);
    res.status(500).json({ success: false, message: 'We could not load the staff list. Please try again.' });
  }
});

/** One councillor, with their recent captures. */
router.get('/:id', async (req, res) => {
  try {
    const councillor = await prisma.user.findFirst({
      where: { id: req.params.id, role: { in: MANAGEABLE_ROLES } },
      select: STAFF_FIELDS,
    });
    if (!councillor) {
      return res.status(404).json({ success: false, message: 'We could not find that staff member.' });
    }

    const [captures, byStatus] = await Promise.all([
      prisma.application.findMany({
        where: { capturedById: councillor.id },
        select: {
          id: true, reference: true, status: true, names: true, fullName: true, surname: true,
          capturedAt: true, submittedAt: true, capturedWard: true,
        },
        orderBy: { capturedAt: 'desc' },
        take: 50,
      }),
      prisma.application.groupBy({
        by: ['status'],
        where: { capturedById: councillor.id },
        _count: { _all: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        ...councillor,
        name: fullName(councillor),
        roleLabel: ROLE_LABELS[councillor.role] || councillor.role,
        captures,
        totals: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      },
    });
  } catch (error) {
    console.error('staff detail error:', error);
    res.status(500).json({ success: false, message: 'We could not load that staff member. Please try again.' });
  }
});

/** Create a councillor and text them their sign-in details. */
router.post('/', async (req, res) => {
  try {
    const { email, firstName, lastName, cellNumber, ward, idNumber, role = 'COUNCILLOR' } = req.body || {};

    /**
     * An administrator may hand out any of the working roles; only a superuser
     * may hand out Administrator or Super Administrator.
     *
     * `/roles` already told a superuser those two were assignable — this used to
     * refuse them regardless of who asked, so the one account actually entitled
     * to grant admin access got a 400 for doing exactly what the form offered.
     * A plain administrator still cannot: creating another administrator is
     * deliberately not a routine action on this screen, only a superuser's.
     */
    const creatable = [...MANAGEABLE_ROLES, ...(req.user.role === 'SUPERUSER' ? PRIVILEGED_ROLES : [])];
    if (!creatable.includes(role)) {
      return res.status(400).json({
        success: false,
        message: req.user.role === 'SUPERUSER'
          ? `Role must be one of: ${creatable.join(', ')}.`
          : `Role must be one of: ${MANAGEABLE_ROLES.join(', ')}. Only a super administrator can create an administrator account.`,
      });
    }

    if (!email || !firstName || !lastName) {
      return res.status(400).json({ success: false, message: 'Please enter a first name, a surname and an email address.' });
    }
    if (!cellNumber) {
      return res.status(400).json({
        success: false,
        message: 'A cell number is required — sign-in details are sent by SMS',
      });
    }

    const normalisedCell = sms.normaliseNumber(cellNumber);
    if (!normalisedCell) {
      return res.status(400).json({
        success: false,
        message: 'That does not look like a South African cell number (e.g. 082 123 4567)',
      });
    }
    if (idNumber) {
      const check = saId.validate(idNumber);
      if (!check.valid) return res.status(400).json({ success: false, message: check.reason });
    }

    const clash = await prisma.user.findFirst({
      where: {
        OR: [
          { email: String(email).trim().toLowerCase() },
          ...(idNumber ? [{ idNumber: String(idNumber).trim() }] : []),
        ],
      },
      select: { id: true },
    });
    if (clash) {
      return res.status(400).json({ success: false, message: 'That email address or ID number is already in use' });
    }

    const created = await prisma.user.create({
      data: {
        email: String(email).trim().toLowerCase(),
        // Replaced immediately by issueCredentials. A random unusable value is
        // written first so the row is never briefly created with a known one.
        password: await bcrypt.hash(temporaryPassword(), 12),
        role,
        firstName: String(firstName).trim(),
        lastName: String(lastName).trim(),
        cellNumber: normalisedCell,
        ward: ward ? String(ward).trim() : null,
        idNumber: idNumber ? String(idNumber).trim() : null,
        isVerified: true,
        // Staff identity is confirmed by the administrator creating the account.
        cellVerifiedAt: new Date(),
        registeredById: req.user.id,
      },
      select: STAFF_FIELDS,
    });

    const credentials = await issueCredentials(created, { purpose: 'WELCOME_CREDENTIALS' });

    await audit.record(req, {
      action: audit.ACTIONS.CREATE_COUNCILLOR,
      entityType: 'User',
      entityId: created.id,
      details: `Created ${ROLE_LABELS[created.role]} ${created.email}${created.ward ? ` for ${created.ward}` : ''}`,
    });

    res.status(201).json({
      success: true,
      message: credentials.smsDelivered
        ? `${ROLE_LABELS[created.role]} created. Sign-in details were sent to ${normalisedCell}.`
        : `${ROLE_LABELS[created.role]} created, but the SMS could not be sent. Give them the temporary password directly.`,
      data: { ...created, name: fullName(created), roleLabel: ROLE_LABELS[created.role] },
      // Shown to this administrator once and never retrievable again.
      credentials: { username: created.email, temporaryPassword: credentials.temporaryPassword },
    });
  } catch (error) {
    console.error('create staff error:', error);
    res.status(500).json({ success: false, message: 'We could not create that account. Please try again.' });
  }
});

/** Correct a councillor's details, change their role, or deactivate them. */
router.patch('/:id', async (req, res) => {
  try {
    const councillor = await prisma.user.findFirst({
      where: { id: req.params.id, role: { in: MANAGEABLE_ROLES } },
      select: { id: true, email: true, role: true, isActive: true, authSource: true },
    });
    if (!councillor) {
      return res.status(404).json({ success: false, message: 'We could not find that staff member.' });
    }

    const { firstName, lastName, cellNumber, ward, email, isActive, role } = req.body || {};

    // The role of a directory account is decided by its Active Directory group.
    // A role set here would be overwritten at their next sign-in, which is worse
    // than refusing: it would look as though it had worked.
    if (councillor.authSource === 'DIRECTORY' && role !== undefined && role !== councillor.role) {
      return res.status(400).json({
        success: false,
        code: 'ROLE_FROM_DIRECTORY',
        message: 'This person signs in with their Windows account, so their role comes from their Active Directory group. Move them between groups there.',
      });
    }
    const data = {};

    /**
     * A promotion, worked the same way any other correction on this screen is —
     * an assessment officer moving to supervisor, or a councillor moving to the
     * front desk. Bounded to the same five roles this screen may already create,
     * so this can never be the route that grants administrator access; that
     * stays a deliberate, separate action for a superuser alone.
     */
    if (role !== undefined && role !== councillor.role) {
      if (!MANAGEABLE_ROLES.includes(role)) {
        return res.status(400).json({
          success: false,
          message: `Role must be one of: ${MANAGEABLE_ROLES.join(', ')}.`,
        });
      }
      data.role = role;
    }

    if (firstName !== undefined) data.firstName = firstName ? String(firstName).trim() : null;
    if (lastName !== undefined) data.lastName = lastName ? String(lastName).trim() : null;
    if (ward !== undefined) data.ward = ward ? String(ward).trim() : null;
    if (isActive !== undefined) data.isActive = Boolean(isActive);

    if (cellNumber !== undefined) {
      const normalised = sms.normaliseNumber(cellNumber);
      if (cellNumber && !normalised) {
        return res.status(400).json({ success: false, message: 'That does not look like a South African cell number' });
      }
      data.cellNumber = normalised;
    }

    if (email !== undefined && String(email).trim().toLowerCase() !== councillor.email) {
      const wanted = String(email).trim().toLowerCase();
      const taken = await prisma.user.findFirst({ where: { email: wanted, NOT: { id: councillor.id } }, select: { id: true } });
      if (taken) return res.status(400).json({ success: false, message: 'That email address is already in use' });
      data.email = wanted;
    }

    const updated = await prisma.user.update({
      where: { id: councillor.id },
      data,
      select: STAFF_FIELDS,
    });

    await audit.record(req, {
      action: data.isActive === false ? audit.ACTIONS.DEACTIVATE_COUNCILLOR : audit.ACTIONS.UPDATE_COUNCILLOR,
      entityType: 'User',
      entityId: updated.id,
      details: data.isActive === false
        ? `Deactivated councillor ${updated.email}`
        : data.role
          ? `Changed ${updated.email} from ${ROLE_LABELS[councillor.role]} to ${ROLE_LABELS[updated.role]}`
          : `Updated councillor ${updated.email}`,
    });

    res.json({
      success: true,
      message: data.role ? `${fullName(updated)} is now ${ROLE_LABELS[updated.role]}.` : 'Staff member updated',
      data: { ...updated, name: fullName(updated), roleLabel: ROLE_LABELS[updated.role] },
    });
  } catch (error) {
    console.error('update staff error:', error);
    res.status(500).json({ success: false, message: 'We could not save those changes. Please try again.' });
  }
});

/**
 * Release a locked account without changing its password.
 *
 * The person who has been locked out is usually standing in front of an
 * administrator saying they mistyped it three times. Making them wait out the
 * lock, or forcing a password reset and an SMS, is disproportionate to that — and
 * a front-desk officer who cannot sign in is a queue of households who cannot be
 * helped.
 *
 * Recorded, because releasing a lock is exactly what somebody who caused the
 * lock would want done. The audit row says who did it and to whom.
 */
router.post('/:id/unlock', async (req, res) => {
  try {
    const staff = await prisma.user.findFirst({
      where: { id: req.params.id, role: { in: MANAGEABLE_ROLES } },
      select: { id: true, email: true, lockedUntil: true, failedLoginAttempts: true },
    });
    if (!staff) {
      return res.status(404).json({ success: false, message: 'We could not find that staff member.' });
    }

    const state = loginSecurity.lockState(staff);
    if (!state.locked) {
      return res.json({ success: true, message: 'That account is not locked.', data: { locked: false } });
    }

    await prisma.user.update({
      where: { id: staff.id },
      data: { lockedUntil: null, failedLoginAttempts: 0, lastFailedLoginAt: null },
    });

    await audit.record(req, {
      action: audit.ACTIONS.ACCOUNT_UNLOCKED,
      entityType: 'User',
      entityId: staff.id,
      details: `Released the sign-in lock on ${staff.email} after ${staff.failedLoginAttempts} failed attempt(s)`,
    });

    res.json({
      success: true,
      message: `${staff.email} can sign in again.`,
      data: { locked: false },
    });
  } catch (error) {
    console.error('unlock staff error:', error);
    res.status(500).json({ success: false, message: 'We could not unlock that account. Please try again.' });
  }
});

/** Issue a fresh temporary password when one is forgotten or compromised. */
router.post('/:id/reset-password', async (req, res) => {
  try {
    const councillor = await prisma.user.findFirst({
      where: { id: req.params.id, role: { in: MANAGEABLE_ROLES } },
      select: { id: true, email: true, firstName: true, cellNumber: true, authSource: true },
    });
    if (!councillor) {
      return res.status(404).json({ success: false, message: 'We could not find that staff member.' });
    }
    if (councillor.authSource === 'DIRECTORY') {
      return res.status(400).json({
        success: false,
        code: 'PASSWORD_MANAGED_BY_DIRECTORY',
        message: 'This person signs in with their Windows account. Their password is reset in Active Directory, not here.',
      });
    }

    const credentials = await issueCredentials(councillor, { purpose: 'PASSWORD_RESET_STAFF' });

    await audit.record(req, {
      action: audit.ACTIONS.RESET_STAFF_PASSWORD,
      entityType: 'User',
      entityId: councillor.id,
      details: `Issued a new temporary password to ${councillor.email}`,
    });

    res.json({
      success: true,
      message: credentials.smsDelivered
        ? `A new password was sent to ${councillor.cellNumber}.`
        : 'A new password was issued, but the SMS could not be sent. Give it to them directly.',
      credentials: { username: councillor.email, temporaryPassword: credentials.temporaryPassword },
    });
  } catch (error) {
    console.error('reset staff password error:', error);
    res.status(500).json({ success: false, message: 'We could not issue a new password. Please try again.' });
  }
});

/**
 * Remove a councillor.
 *
 * Refused once they have captured anything. Their name is the accountability
 * trail on every household they signed up, and deleting the account would strip
 * that from applications the municipality may have to defend. Deactivation is
 * the correct action and the message says so.
 */
router.delete('/:id', async (req, res) => {
  try {
    const councillor = await prisma.user.findFirst({
      where: { id: req.params.id, role: { in: MANAGEABLE_ROLES } },
      select: { id: true, email: true, _count: { select: { captured: true } } },
    });
    if (!councillor) {
      return res.status(404).json({ success: false, message: 'We could not find that staff member.' });
    }

    if (councillor._count.captured > 0) {
      return res.status(409).json({
        success: false,
        code: 'HAS_CAPTURES',
        message:
          `${councillor.email} has captured ${councillor._count.captured} application(s). `
          + 'Deactivate them instead — deleting the account would remove the record of who captured those households.',
      });
    }

    await prisma.user.delete({ where: { id: councillor.id } });

    await audit.record(req, {
      action: audit.ACTIONS.DELETE_COUNCILLOR,
      entityType: 'User',
      entityId: councillor.id,
      details: `Deleted ${councillor.email} (no captures)`,
    });

    res.json({ success: true, message: 'Staff member removed' });
  } catch (error) {
    console.error('delete staff error:', error);
    res.status(500).json({ success: false, message: 'We could not remove that account. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Directory (Active Directory)
// ---------------------------------------------------------------------------
//
// Staff are pulled from the municipal directory rather than created by hand.
// Roles come from AD group membership — see lib/directoryRoles.js — so these
// endpoints can import people and link existing accounts, but never choose a
// role: that is decided in Active Directory.

/** Whether the directory is on, and how it is set up, without revealing any secret. */
router.get('/directory/status', async (req, res) => {
  try {
    const enabled = directory.enabled();
    let map = [];
    let problems = [];
    if (enabled) {
      problems = directory.problems();
      try { map = [...directory.roleMap().entries()].map(([group, role]) => ({ group, role, roleLabel: ROLE_LABELS[role] })); } catch { /* reported in problems */ }
    }
    const last = await prisma.user.aggregate({ where: { authSource: 'DIRECTORY' }, _max: { directorySyncedAt: true }, _count: true });
    res.json({
      success: true,
      data: {
        enabled,
        provider: enabled ? directory.providerName() : null,
        roleMap: map,
        problems,
        accounts: last._count,
        lastSyncedAt: last._max.directorySyncedAt,
        syncEveryMinutes: parseInt(process.env.AD_SYNC_INTERVAL_MINUTES ?? '60', 10) || 0,
      },
    });
  } catch (error) {
    console.error('directory status error:', error);
    res.status(500).json({ success: false, message: 'We could not read the directory settings.' });
  }
});

/** Shared by every directory endpoint: turns an outage into a sentence, not a 500. */
function directoryFailure(res, error, fallback) {
  if (error instanceof directory.DirectoryUnavailable) {
    return res.status(503).json({ success: false, code: 'DIRECTORY_UNAVAILABLE', message: 'We could not reach the municipal directory. Try again shortly.' });
  }
  console.error('directory error:', error);
  return res.status(500).json({ success: false, message: fallback });
}

const directoryOff = (res) => res.status(400).json({
  success: false,
  code: 'DIRECTORY_DISABLED',
  message: 'Directory sign-in is not switched on. Set AD_ENABLED=true in the server settings.',
});

/** Search the directory for somebody to give access to. */
router.get('/directory/search', async (req, res) => {
  if (!directory.enabled()) return directoryOff(res);
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, data: [] });

    const roleMap = directory.roleMap();
    const found = await directory.active().search(q);

    const ids = found.map((f) => f.externalId).filter(Boolean);
    const existing = ids.length
      ? await prisma.user.findMany({ where: { externalId: { in: ids } }, select: { externalId: true, isActive: true } })
      : [];
    const known = new Map(existing.map((u) => [u.externalId, u]));

    res.json({
      success: true,
      data: found.map((f) => {
        const role = roleFor(f.groups, roleMap);
        return {
          username: f.username,
          name: [f.firstName, f.lastName].filter(Boolean).join(' ') || f.displayName || f.username,
          email: f.email || f.upn,
          role,
          roleLabel: role ? ROLE_LABELS[role] : null,
          // A person in the directory but in no mapped group cannot be given access from here.
          canImport: Boolean(role),
          alreadyImported: known.has(f.externalId),
        };
      }),
    });
  } catch (error) {
    directoryFailure(res, error, 'We could not search the directory. Please try again.');
  }
});

/** Create the local account for a directory user ahead of their first sign-in. */
router.post('/directory/import', async (req, res) => {
  if (!directory.enabled()) return directoryOff(res);
  try {
    const username = String(req.body?.username || '').trim();
    if (!username) return res.status(400).json({ success: false, message: 'Choose somebody from the directory first.' });

    const entry = await directory.active().lookup({ username });
    if (!entry || entry.disabled) {
      return res.status(404).json({ success: false, message: 'That person is not an active account in the directory.' });
    }

    const role = roleFor(entry.groups, directory.roleMap());
    if (!role) {
      return res.status(400).json({
        success: false,
        code: 'NO_MAPPED_GROUP',
        message: 'That person is not in any Active Directory group that grants access. Add them to the right group first; their role comes from it.',
      });
    }

    const result = await directory.auth.provision(entry, role);
    if (result.conflict) return res.status(409).json({ success: false, code: 'CONFLICT', message: result.conflict });

    await audit.record(req, {
      action: audit.ACTIONS.DIRECTORY_PROVISION,
      entityType: 'User',
      entityId: result.user.id,
      details: `${result.created ? 'Imported' : 'Refreshed'} ${result.user.email} from the directory as ${ROLE_LABELS[role]}`,
    });

    const user = await prisma.user.findUnique({ where: { id: result.user.id }, select: STAFF_FIELDS });
    res.status(result.created ? 201 : 200).json({
      success: true,
      message: result.created
        ? `${fullName(user)} was added as ${ROLE_LABELS[role]}. They sign in with their Windows account; no password was issued.`
        : `${fullName(user)} was already here; their details were refreshed.`,
      data: { ...user, name: fullName(user), roleLabel: ROLE_LABELS[user.role] },
    });
  } catch (error) {
    directoryFailure(res, error, 'We could not import that person. Please try again.');
  }
});

/** Re-read everybody from the directory now, instead of waiting for the schedule. */
router.post('/directory/sync', async (req, res) => {
  if (!directory.enabled()) return directoryOff(res);
  try {
    const summary = await directory.sync.run();
    await audit.record(req, {
      action: audit.ACTIONS.DIRECTORY_SYNC,
      details: summary.aborted
        ? `Sync stopped: ${summary.aborted}`
        : `Checked ${summary.checked}; deactivated ${summary.deactivated.length}; ${summary.roleChanges.length} role change(s)`,
    });
    res.json({ success: !summary.aborted, message: summary.aborted || 'Sync complete.', data: summary });
  } catch (error) {
    directoryFailure(res, error, 'We could not run the sync. Please try again.');
  }
});

/**
 * Move an existing local staff account onto the directory.
 *
 * The migration path for people who already have an account here. The account
 * keeps its id — so every application, approval and audit row stays attached to
 * the same person — but from now on its password is the Windows one and its role
 * follows its group.
 *
 * Two safeguards. Nobody may link their own account, because if the directory
 * would give them a lower role they would have demoted themselves out of this
 * screen. And at least one *local* administrator must remain active afterwards:
 * that account is the way back in when the directory is down, and without it a
 * directory outage locks every administrator out at once.
 */
router.post('/:id/link-directory', async (req, res) => {
  if (!directory.enabled()) return directoryOff(res);
  try {
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, role: { not: 'APPLICANT' } },
      select: { id: true, email: true, role: true, authSource: true, isActive: true },
    });
    if (!target) return res.status(404).json({ success: false, message: 'We could not find that staff member.' });
    if (target.authSource === 'DIRECTORY') return res.status(400).json({ success: false, message: 'That account already uses the directory.' });
    if (target.id === req.user.id) {
      return res.status(400).json({ success: false, message: 'You cannot link your own account. Ask another administrator to do it.' });
    }

    const username = String(req.body?.username || '').trim();
    if (!username) return res.status(400).json({ success: false, message: 'Enter their Windows username.' });

    const entry = await directory.active().lookup({ username });
    if (!entry || entry.disabled) return res.status(404).json({ success: false, message: 'That is not an active account in the directory.' });

    const role = roleFor(entry.groups, directory.roleMap());
    if (!role) {
      return res.status(400).json({ success: false, code: 'NO_MAPPED_GROUP', message: 'That directory account is not in any group that grants access.' });
    }

    const taken = await prisma.user.findUnique({ where: { externalId: entry.externalId }, select: { id: true } });
    if (taken) return res.status(409).json({ success: false, message: 'That directory account is already linked to another person here.' });

    const remainingLocalAdmins = await prisma.user.count({
      where: { id: { not: target.id }, authSource: 'LOCAL', isActive: true, role: { in: ['ADMIN', 'SUPERUSER'] } },
    });
    if (['ADMIN', 'SUPERUSER'].includes(target.role) && remainingLocalAdmins === 0) {
      return res.status(409).json({
        success: false,
        code: 'LAST_LOCAL_ADMIN',
        message: 'This is the last administrator with a local password. Keep at least one, so somebody can still sign in if the directory is unreachable.',
      });
    }

    const user = await prisma.user.update({
      where: { id: target.id },
      data: {
        authSource: 'DIRECTORY',
        externalId: entry.externalId,
        directoryUsername: entry.username,
        directorySyncedAt: new Date(),
        role,
        password: await unusableHash(),
        mustChangePassword: false,
        // Ends sessions opened with the old local password.
        passwordChangedAt: new Date(),
      },
      select: STAFF_FIELDS,
    });

    await audit.record(req, {
      action: audit.ACTIONS.DIRECTORY_LINK,
      entityType: 'User',
      entityId: user.id,
      details: `Linked ${user.email} to directory account ${entry.username}; role ${target.role} → ${role}`,
    });

    res.json({
      success: true,
      message: `${fullName(user)} now signs in with their Windows account as ${ROLE_LABELS[role]}.`,
      data: { ...user, name: fullName(user), roleLabel: ROLE_LABELS[user.role] },
    });
  } catch (error) {
    directoryFailure(res, error, 'We could not link that account. Please try again.');
  }
});

module.exports = router;
module.exports.MANAGEABLE_ROLES = MANAGEABLE_ROLES;
module.exports.ROLE_LABELS = ROLE_LABELS;
