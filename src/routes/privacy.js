const express = require('express');
const prisma = require('../lib/prisma');
const { protect, requireAdmin } = require('../middleware/auth');
const { exportLimiter } = require('../lib/rateLimit');
const audit = require('../lib/audit');
const retention = require('../lib/retention');
const subjectAccess = require('../lib/subjectAccess');
const privacyNotice = require('../lib/privacyNotice');
const sanitize = require('../lib/sanitize');
const respond = require('../lib/respond');
const notify = require('../lib/notify');
const cache = require('../lib/cache');

/**
 * POPIA: the privacy notice, subject requests, retention and the breach register.
 *
 * Split by audience rather than by resource, because the audiences are genuinely
 * different: the notice is public, a data subject may act on their own record,
 * and only an administrator may run retention or touch the breach register.
 */
const router = express.Router();

// ---------------------------------------------------------------------------
// Public — no sign-in required
// ---------------------------------------------------------------------------

/**
 * The privacy notice.
 *
 * Deliberately unauthenticated. Somebody deciding whether to apply needs to know
 * what will be collected *before* they create an account, and a notice you have
 * to register to read is not a notice.
 */
router.get('/notice', (req, res) => {
  res.json({ success: true, data: privacyNotice.notice() });
});

/** The retention schedule on its own, for the footer link. */
router.get('/retention', (req, res) => {
  res.json({ success: true, data: retention.publish() });
});

// ---------------------------------------------------------------------------
// A data subject, acting on their own record
// ---------------------------------------------------------------------------
//
// The full `protect` chain, not `authenticate` alone. Somebody still on the
// temporary password a councillor read out to them has not yet proved the account
// is theirs, and exporting everything the municipality holds on a person is the
// last thing that should be reachable in that state.
router.use(...protect);

/**
 * "What do you hold about me?" — POPIA s23.
 *
 * Answered immediately rather than queued. The municipality already holds the
 * answer; making somebody wait thirty days for a database query it can run in a
 * second would be compliance theatre.
 */
router.get('/my-information', exportLimiter, respond.handler(async (req, res) => {
  const record = await subjectAccess.compile(req.user.id);
  if (!record) return respond.notFound(res, 'We could not find your record.');

  // Somebody exercising a statutory right leaves a trail, both to show the
  // request was honoured and because a burst of them is worth noticing.
  await audit.record(req, {
    action: audit.ACTIONS.SUBJECT_ACCESS_REQUEST,
    entityType: 'User',
    entityId: req.user.id,
    details: 'Exercised the right of access to their own personal information',
  });

  res.json({ success: true, data: record });
}, 'subject access'));

/** The same thing as a file, for somebody who wants to keep it. */
router.get('/my-information.json', exportLimiter, respond.handler(async (req, res) => {
  const record = await subjectAccess.compile(req.user.id);
  if (!record) return respond.notFound(res, 'We could not find your record.');

  await audit.record(req, {
    action: audit.ACTIONS.SUBJECT_ACCESS_REQUEST,
    entityType: 'User',
    entityId: req.user.id,
    details: 'Downloaded a copy of their personal information',
  });

  const name = `my-information-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(JSON.stringify(record, null, 2));
}, 'subject access download'));

/** Whether a deletion request could be granted, and what happens if not. */
router.get('/my-deletion-options', respond.handler(async (req, res) => {
  res.json({ success: true, data: await subjectAccess.deletionAssessment(req.user.id) });
}, 'deletion assessment'));

/**
 * Lodge a correction, deletion or objection request.
 *
 * Recorded rather than emailed, because POPIA sets response deadlines and "we
 * think somebody dealt with it" is not an answer to the Regulator.
 */
router.post('/requests', respond.handler(async (req, res) => {
  const type = sanitize.oneOf(req.body?.type, ['ACCESS', 'CORRECTION', 'DELETION', 'OBJECTION']);
  const request = sanitize.longText(req.body?.request);
  const correctionDetail = sanitize.longText(req.body?.correctionDetail);

  if (!type) return respond.badRequest(res, 'Please choose what kind of request you are making.');
  if (!request) return respond.badRequest(res, 'Please tell us what you would like us to do.');
  if (type === 'CORRECTION' && !correctionDetail) {
    return respond.badRequest(res, 'Please tell us what is wrong and what it should say.');
  }

  const dueAt = new Date();
  dueAt.setDate(dueAt.getDate() + privacyNotice.RESPONSE_DAYS);

  const created = await prisma.subjectRequest.create({
    data: {
      type,
      request,
      correctionDetail,
      subjectUserId: req.user.id,
      subjectName: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || null,
      subjectEmail: req.user.email,
      subjectIdNumber: req.user.idNumber,
      dueAt,
    },
  });

  await audit.record(req, {
    action: audit.ACTIONS.SUBJECT_REQUEST_LODGED,
    entityType: 'SubjectRequest',
    entityId: created.id,
    details: `${type} request lodged`,
  });

  await notify.toAdmins({
    type: notify.TYPE.SUBJECT_REQUEST,
    title: `A ${type.toLowerCase()} request was lodged`,
    body: `${created.subjectName || created.subjectEmail} asked: ${request.slice(0, 160)}`,
    link: '/privacy/requests',
    entityType: 'SubjectRequest',
    entityId: created.id,
  });

  res.status(201).json({
    success: true,
    message: `Your request has been logged. We will respond within ${privacyNotice.RESPONSE_DAYS} days.`,
    data: { id: created.id, type: created.type, dueAt: created.dueAt },
  });
}, 'lodge subject request'));

/** A data subject following up on their own requests. */
router.get('/my-requests', respond.handler(async (req, res) => {
  const requests = await prisma.subjectRequest.findMany({
    where: { subjectUserId: req.user.id },
    select: {
      id: true, type: true, status: true, request: true, responseNotes: true,
      refusalGround: true, receivedAt: true, dueAt: true, completedAt: true,
    },
    orderBy: { receivedAt: 'desc' },
  });
  res.json({ success: true, data: requests });
}, 'my requests'));

// ---------------------------------------------------------------------------
// Administrators
// ---------------------------------------------------------------------------
// `protect` already ran above for every route past the public block, so this only
// narrows the audience rather than re-authenticating.
router.use(requireAdmin);
router.use(cache.invalidateOn(cache.TAGS.APPLICATIONS, cache.TAGS.ANALYTICS));

/** Whether the governance records are complete enough to operate lawfully. */
router.get('/readiness', (req, res) => {
  res.json({ success: true, data: privacyNotice.readiness() });
});

/** Every subject request, oldest first, so overdue ones surface. */
router.get('/requests', respond.handler(async (req, res) => {
  const status = sanitize.oneOf(req.body?.status || req.query?.status, [
    'RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REFUSED',
  ]);
  const { page, take, skip } = sanitize.pagination(req.query, { defaultSize: 25 });

  const where = status ? { status } : {};
  const now = new Date();

  const [rows, total, counts] = await Promise.all([
    prisma.subjectRequest.findMany({ where, orderBy: { receivedAt: 'asc' }, skip, take }),
    prisma.subjectRequest.count({ where }),
    prisma.subjectRequest.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);

  res.json({
    success: true,
    data: rows.map((r) => ({
      ...r,
      // Overdue is the only thing that matters on this list.
      overdue: r.dueAt && !r.completedAt && new Date(r.dueAt) < now,
      daysRemaining: r.dueAt && !r.completedAt
        ? Math.ceil((new Date(r.dueAt) - now) / 86400000)
        : null,
    })),
    pagination: { page, pageSize: take, total, totalPages: Math.ceil(total / take) || 1 },
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    responseDays: privacyNotice.RESPONSE_DAYS,
  });
}, 'subject requests list'));

/**
 * Respond to a request.
 *
 * A refusal requires a lawful ground. POPIA permits refusing access in defined
 * circumstances; it does not permit refusing without saying which one applies.
 */
router.patch('/requests/:id', respond.handler(async (req, res) => {
  const existing = await prisma.subjectRequest.findUnique({ where: { id: req.params.id } });
  if (!existing) return respond.notFound(res, 'We could not find that request.');

  const status = sanitize.oneOf(req.body?.status, ['RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REFUSED']);
  const responseNotes = sanitize.longText(req.body?.responseNotes);
  const refusalGround = sanitize.longText(req.body?.refusalGround);

  if (!status) return respond.badRequest(res, 'Choose what state to move this request to.');
  if (status === 'REFUSED' && !refusalGround) {
    return respond.badRequest(res, 'A refusal must state the lawful ground it rests on.');
  }
  if (status === 'COMPLETED' && !responseNotes) {
    return respond.badRequest(res, 'Record what you provided or changed before closing this request.');
  }

  const updated = await prisma.subjectRequest.update({
    where: { id: existing.id },
    data: {
      status,
      responseNotes,
      refusalGround,
      handledById: req.user.id,
      handledByName: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email,
      completedAt: ['COMPLETED', 'REFUSED'].includes(status) ? new Date() : null,
    },
  });

  await audit.record(req, {
    action: audit.ACTIONS.SUBJECT_REQUEST_HANDLED,
    entityType: 'SubjectRequest',
    entityId: existing.id,
    details: `${existing.type} request moved to ${status}${refusalGround ? ` — refused: ${refusalGround}` : ''}`,
  });

  // The person who asked is told the outcome; a request answered into a void is
  // not answered.
  if (existing.subjectUserId && ['COMPLETED', 'REFUSED'].includes(status)) {
    await notify.toUser(existing.subjectUserId, {
      type: notify.TYPE.SUBJECT_REQUEST_ANSWERED,
      title: status === 'COMPLETED' ? 'Your request has been actioned' : 'Your request was refused',
      body: status === 'COMPLETED'
        ? responseNotes
        : `${refusalGround} You may complain to the Information Regulator if you disagree.`,
      link: '/privacy',
      entityType: 'SubjectRequest',
      entityId: existing.id,
    });
  }

  res.json({ success: true, message: 'Request updated. The person who asked has been told.', data: updated });
}, 'handle subject request'));

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * What the retention policy would do, without doing it.
 *
 * The default, and the only thing reachable by a GET. Deleting records is not
 * something a link should be able to trigger.
 */
router.get('/retention/survey', respond.handler(async (req, res) => {
  const result = await retention.survey();
  res.json({
    success: true,
    data: result,
    message: result.totalDue === 0
      ? 'Nothing has passed its retention period.'
      : `${result.totalDue} record(s) have passed their retention period. Nothing has been changed.`,
  });
}, 'retention survey'));

/**
 * Apply the policy for real.
 *
 * Requires `confirm: true` in the body on top of being a POST from an
 * administrator. Two deliberate acts, because this deletes and anonymises
 * irreversibly.
 */
router.post('/retention/apply', respond.handler(async (req, res) => {
  const confirmed = req.body?.confirm === true;
  const only = sanitize.oneOf(req.body?.only, Object.keys(retention.POLICY));

  const result = await retention.apply({ commit: confirmed, actor: req.user, only });

  if (!confirmed) {
    return res.json({
      success: true,
      data: result,
      message: 'This was a dry run and nothing changed. Send confirm: true to apply the policy.',
    });
  }

  await audit.record(req, {
    action: audit.ACTIONS.RETENTION_APPLIED,
    entityType: 'Application',
    details: `Applied the retention policy: ${result.results.map((r) => `${r.key} ${r.applied}`).join(', ')}`,
  });

  res.json({
    success: true,
    data: result,
    message: result.totalApplied === 0
      ? 'Nothing was due.'
      : `${result.totalApplied} record(s) were deleted or anonymised under the retention policy.`,
  });
}, 'retention apply'));

// ---------------------------------------------------------------------------
// Breach register
// ---------------------------------------------------------------------------

/**
 * The breach register.
 *
 * An empty register is the correct state. Having one is not an admission that
 * anything has gone wrong — it is what makes a section 22 notification possible
 * within the deadline if it ever does.
 */
router.get('/breaches', respond.handler(async (req, res) => {
  const breaches = await prisma.dataBreach.findMany({ orderBy: { detectedAt: 'desc' } });
  res.json({
    success: true,
    data: breaches,
    guidance: 'POPIA section 22 requires the Information Regulator and the affected data subjects to be notified '
      + 'as soon as reasonably possible after a compromise is discovered.',
  });
}, 'breach register'));

router.post('/breaches', respond.handler(async (req, res) => {
  const title = sanitize.text(req.body?.title, { max: 200 });
  const description = sanitize.longText(req.body?.description);
  const severity = sanitize.oneOf(req.body?.severity, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) || 'MEDIUM';

  if (!title || !description) {
    return respond.badRequest(res, 'Please give the incident a title and describe what happened.');
  }

  const created = await prisma.dataBreach.create({
    data: {
      title,
      description,
      severity,
      dataAffected: sanitize.longText(req.body?.dataAffected),
      peopleAffected: sanitize.number(req.body?.peopleAffected, { min: 0, integer: true }),
      occurredAt: req.body?.occurredAt ? new Date(req.body.occurredAt) : null,
      reportedById: req.user.id,
      reportedByName: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email,
    },
  });

  await audit.record(req, {
    action: audit.ACTIONS.BREACH_RECORDED,
    entityType: 'DataBreach',
    entityId: created.id,
    details: `${severity} breach recorded: ${title}`,
  });

  res.status(201).json({
    success: true,
    message: severity === 'HIGH' || severity === 'CRITICAL'
      ? 'Recorded. Notify the Information Regulator and the affected people as soon as reasonably possible.'
      : 'Recorded.',
    data: created,
  });
}, 'record breach'));

router.patch('/breaches/:id', respond.handler(async (req, res) => {
  const existing = await prisma.dataBreach.findUnique({ where: { id: req.params.id } });
  if (!existing) return respond.notFound(res, 'We could not find that incident.');

  const status = sanitize.oneOf(req.body?.status, ['DETECTED', 'INVESTIGATING', 'CONTAINED', 'NOTIFIED', 'CLOSED']);
  const remediation = sanitize.longText(req.body?.remediation);

  if (status === 'CLOSED' && !remediation && !existing.remediation) {
    return respond.badRequest(res, 'Record what was done, and what changed so it does not recur, before closing.');
  }

  const updated = await prisma.dataBreach.update({
    where: { id: existing.id },
    data: {
      ...(status ? { status } : {}),
      ...(remediation !== null ? { remediation } : {}),
      ...(status === 'CONTAINED' && !existing.containedAt ? { containedAt: new Date() } : {}),
      ...(req.body?.regulatorNotified ? { regulatorNotifiedAt: new Date() } : {}),
      ...(req.body?.subjectsNotified ? { subjectsNotifiedAt: new Date() } : {}),
    },
  });

  await audit.record(req, {
    action: audit.ACTIONS.BREACH_UPDATED,
    entityType: 'DataBreach',
    entityId: existing.id,
    details: `Breach updated${status ? ` to ${status}` : ''}`,
  });

  res.json({ success: true, message: 'Incident updated.', data: updated });
}, 'update breach'));

module.exports = router;
