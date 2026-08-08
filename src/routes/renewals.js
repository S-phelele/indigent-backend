const express = require('express');
const prisma = require('../lib/prisma');
const { protect, requireRole } = require('../middleware/auth');
const { staffLimiter } = require('../lib/rateLimit');
const cache = require('../lib/cache');
const audit = require('../lib/audit');
const renewal = require('../lib/renewal');
const sanitize = require('../lib/sanitize');
const respond = require('../lib/respond');
const notify = require('../lib/notify');
const sms = require('../lib/sms');
const smsTemplates = require('../lib/smsTemplates');

/**
 * Annual re-verification.
 *
 * The screen that stops a register rotting. Every approved registration carries
 * an expiry date; this is where the ones approaching it are worked through
 * before support stops for a household that still qualifies.
 */
const router = express.Router();
router.use(...protect, requireRole('ASSESSMENT_OFFICER', 'SUPERVISOR', 'ADMIN'), staffLimiter);
router.use(cache.invalidateOn(cache.TAGS.APPLICATIONS, cache.TAGS.ANALYTICS));

/** Registrations by renewal state, soonest to expire first. */
router.get('/', respond.handler(async (req, res) => {
  const status = sanitize.oneOf(req.query.status, ['ACTIVE', 'DUE_SOON', 'OVERDUE', 'LAPSED']);
  const { page, take, skip } = sanitize.pagination(req.query, { defaultSize: 25 });
  const search = sanitize.searchTerm(req.query.search);

  const where = {
    status: 'APPROVED',
    expiresAt: { not: null },
    ...(status ? { renewalStatus: status } : {}),
    ...(search
      ? {
          OR: [
            { reference: { contains: search, mode: 'insensitive' } },
            { surname: { contains: search, mode: 'insensitive' } },
            { names: { contains: search, mode: 'insensitive' } },
            { idNumber: { contains: search } },
          ],
        }
      : {}),
  };

  const [rows, total, counts] = await Promise.all([
    prisma.application.findMany({
      where,
      select: {
        id: true, reference: true, names: true, surname: true, idNumber: true,
        cellNumber: true, wardNumber: true, approvedAt: true, expiresAt: true,
        renewalStatus: true, renewalCount: true, lastRenewedAt: true,
        totalHouseholdIncome: true, peopleOnProperty: true,
      },
      orderBy: { expiresAt: 'asc' },
      skip,
      take,
    }),
    prisma.application.count({ where }),
    prisma.application.groupBy({
      by: ['renewalStatus'],
      where: { status: 'APPROVED', expiresAt: { not: null } },
      _count: { _all: true },
    }),
  ]);

  res.json({
    success: true,
    data: rows.map((a) => ({
      ...a,
      name: [a.names, a.surname].filter(Boolean).join(' ') || 'Unnamed',
      daysRemaining: renewal.daysRemaining(a),
      // Computed live rather than read from the column, so the list is right
      // even between sweeps.
      currentStatus: renewal.statusFor({ ...a, status: 'APPROVED' }),
    })),
    pagination: { page, pageSize: take, total, totalPages: Math.ceil(total / take) || 1 },
    counts: Object.fromEntries(counts.map((c) => [c.renewalStatus, c._count._all])),
    policy: {
      validMonths: renewal.VALID_MONTHS,
      warnDays: renewal.DUE_SOON_DAYS,
      graceDays: renewal.GRACE_DAYS,
    },
  });
}, 'renewals list'));

/**
 * Re-verify a household and extend its registration.
 *
 * Extends the existing record rather than creating a new one: the household is
 * the same household, and splitting their history across records is how a
 * register loses the ability to answer "how long have we supported this family?".
 */
router.post('/:id/renew', respond.handler(async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, reference: true, status: true, userId: true, expiresAt: true,
      renewalCount: true, user: { select: { cellNumber: true } },
    },
  });
  if (!application) return respond.notFound(res, 'We could not find that registration.');

  if (application.status !== 'APPROVED') {
    return respond.badRequest(res, 'Only an approved registration can be renewed.');
  }

  const notes = sanitize.longText(req.body?.notes);
  if (!notes) {
    return respond.badRequest(res, 'Please record what you checked before renewing.');
  }

  const updated = await renewal.renew(application.id, { actor: req.user, notes });

  await audit.record(req, {
    action: audit.ACTIONS.RENEW_REGISTRATION,
    entityType: 'Application',
    entityId: application.id,
    details: `Re-verified and renewed to ${updated.expiresAt.toLocaleDateString('en-ZA')} — ${notes}`,
  });

  const ref = application.reference || application.id.slice(0, 8);

  await notify.toUser(application.userId, {
    type: notify.TYPE.APPLICATION_APPROVED,
    title: 'Your registration has been renewed',
    body: `Reference ${ref} is now valid until ${updated.expiresAt.toLocaleDateString('en-ZA')}.`,
    link: `/applications/${application.id}`,
    entityType: 'Application',
    entityId: application.id,
  });

  await sms.send(
    application.user?.cellNumber,
    smsTemplates.build('RENEWED', { reference: ref, months: renewal.VALID_MONTHS }),
    { purpose: 'RENEWED', userId: application.userId, entityType: 'Application', entityId: application.id }
  );

  res.json({
    success: true,
    message: `Renewed until ${updated.expiresAt.toLocaleDateString('en-ZA')}. The household has been told.`,
    data: updated,
  });
}, 'renewals renew'));

/**
 * Run the re-verification sweep now.
 *
 * The sweep runs on a timer; this exists so an administrator can see the effect
 * immediately rather than waiting for the next cycle.
 */
router.post('/check', requireRole('ADMIN'), respond.handler(async (req, res) => {
  const result = await renewal.sweep();

  await audit.record(req, {
    action: audit.ACTIONS.RENEWAL_CHECK,
    entityType: 'Application',
    details: `Checked ${result.checked}; ${result.changed.length} changed state, ${result.announced.length} announced`,
  });

  res.json({
    success: true,
    message: result.changed.length
      ? `${result.changed.length} registration(s) changed state and ${result.announced.length} household(s) were told.`
      : 'Every registration is already in the right state.',
    data: result,
  });
}, 'renewals check'));

module.exports = router;
