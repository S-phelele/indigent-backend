const express = require('express');
const prisma = require('../lib/prisma');
const { protect, requireRole } = require('../middleware/auth');
const audit = require('../lib/audit');
const verification = require('../lib/verification');
const notify = require('../lib/notify');
const sms = require('../lib/sms');
const smsTemplates = require('../lib/smsTemplates');
const geocode = require('../lib/geocode');
const cache = require('../lib/cache');
const { staffLimiter } = require('../lib/rateLimit');
const names = require('../lib/names');

/**
 * The verification stage.
 *
 * Verification officers and administrators only. A councillor or capture officer
 * cannot reach any of this: they collect, somebody else checks, and a third
 * person decides. That separation is the point of having roles at all.
 */
const router = express.Router();

/**
 * The enum values the database will accept, mirrored here so an unrecognised one
 * is answered with a sentence naming the alternatives rather than a 500.
 *
 * Kept in step with SiteVisitOutcome and CheckOutcome in schema.prisma.
 */
const VISIT_OUTCOMES = ['SCHEDULED', 'VERIFIED', 'NO_ACCESS', 'OCCUPANT_ABSENT', 'ADDRESS_NOT_FOUND', 'DETAILS_DISPUTED'];
const CHECK_OUTCOMES = ['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_APPLICABLE'];
router.use(...protect, requireRole('VERIFICATION_OFFICER', 'ADMIN'), staffLimiter);
router.use(cache.invalidateOn(cache.TAGS.APPLICATIONS, cache.TAGS.ANALYTICS));

const officerName = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;

const FULL_INCLUDE = {
  household: { orderBy: { createdAt: 'asc' } },
  incomeSources: { orderBy: { createdAt: 'asc' } },
  siteVisits: { orderBy: { attempt: 'asc' } },
  checks: { orderBy: { checkedAt: 'desc' } },
  documents: { select: { id: true, name: true, type: true, status: true, importance: true, requirementGroup: true } },
  user: { select: { id: true, email: true, firstName: true, lastName: true, cellNumber: true } },
  capturedBy: { select: { id: true, firstName: true, lastName: true, ward: true } },
};

/**
 * The queue of work waiting to be verified.
 *
 * Ordered oldest first. A verification queue sorted newest-first is how
 * applications rot at the bottom.
 */
router.get('/queue', async (req, res) => {
  try {
    const { stage = 'all', search = '', ward = 'all' } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));

    const where = {
      status: 'PENDING',
      ...(stage !== 'all' ? { verificationStage: String(stage).toUpperCase() } : {}),
      ...(ward !== 'all' ? { wardNumber: String(ward) } : {}),
      ...(search
        ? {
            OR: [
              { reference: { contains: String(search), mode: 'insensitive' } },
              { surname: { contains: String(search), mode: 'insensitive' } },
              { names: { contains: String(search), mode: 'insensitive' } },
              { idNumber: { contains: String(search) } },
            ],
          }
        : {}),
    };

    const [rows, total, stageCounts] = await Promise.all([
      prisma.application.findMany({
        where,
        // Narrow on purpose. The queue needs a name, a reference and a state —
        // pulling whole applications with their documents made this the slowest
        // page in the portal for no benefit.
        select: {
          id: true, reference: true, names: true, fullName: true, surname: true, idNumber: true,
          submittedAt: true, verificationStage: true, failedVisitCount: true,
          recommendation: true, wardNumber: true, applicantCategory: true,
          consentSiteVisit: true, consentDataMatching: true, declarationTruthful: true,
          capturedById: true, captureChannel: true,
          _count: { select: { siteVisits: true, checks: true, household: true } },
        },
        orderBy: { submittedAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.application.count({ where }),
      prisma.application.groupBy({
        by: ['verificationStage'],
        where: { status: 'PENDING' },
        _count: { _all: true },
      }),
    ]);

    const now = Date.now();
    res.json({
      success: true,
      data: rows.map(({ _count, ...a }) => ({
        ...a,
        name: names.display(a),
        waitingDays: a.submittedAt ? Math.floor((now - new Date(a.submittedAt)) / 86400000) : null,
        visits: _count.siteVisits,
        checks: _count.checks,
        householdSize: _count.household,
        // A queue item this officer captured cannot be picked up by them.
        mine: a.capturedById === req.user.id,
        consentComplete: a.consentSiteVisit && a.consentDataMatching && a.declarationTruthful,
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
      stages: Object.fromEntries(stageCounts.map((s) => [s.verificationStage, s._count._all])),
    });
  } catch (error) {
    console.error('verification queue error:', error);
    res.status(500).json({ success: false, message: 'We could not load the queue. Please try again.' });
  }
});

/** Everything about one application, assembled for the officer working it. */
router.get('/applications/:id', async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: FULL_INCLUDE,
    });
    if (!application) {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    const separation = verification.separationOfDuties(application, req.user);
    const consent = verification.consentGate(application);

    await audit.record(req, {
      action: audit.ACTIONS.VIEW_APPLICATION,
      entityType: 'Application',
      entityId: application.id,
      details: `Opened ${application.reference || application.id.slice(0, 8)} for verification`,
    });

    res.json({
      success: true,
      data: {
        ...application,
        assessment: verification.assess(application, {
          checks: application.checks,
          siteVisits: application.siteVisits,
          household: application.household,
        }),
        canVerify: separation.ok && consent.ok,
        separation,
        consent,
        maxVisitAttempts: verification.MAX_VISIT_ATTEMPTS,
      },
    });
  } catch (error) {
    console.error('verification detail error:', error);
    res.status(500).json({ success: false, message: 'We could not load that application. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Site visits
// ---------------------------------------------------------------------------

/**
 * Schedule or record a visit.
 *
 * The attempt number is allocated here rather than sent by the client, so it
 * cannot be manipulated to reach three failures early.
 */
router.post('/applications/:id/visits', async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, reference: true, userId: true, capturedById: true, status: true,
        consentSiteVisit: true, consentDataMatching: true, declarationTruthful: true,
        siteVisits: { select: { id: true, attempt: true, outcome: true } },
      },
    });
    if (!application) {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    // Entering somebody's property without their consent is not a shortcut.
    if (!application.consentSiteVisit) {
      return res.status(403).json({
        success: false,
        code: 'NO_CONSENT',
        message: 'This applicant has not consented to a site visit. One cannot be recorded.',
      });
    }

    const separation = verification.separationOfDuties(application, req.user);
    if (!separation.ok) {
      return res.status(403).json({ success: false, code: 'SEPARATION_OF_DUTIES', message: separation.reason });
    }

    const state = verification.visitState(application.siteVisits);
    if (state.verified) {
      return res.status(400).json({ success: false, message: 'This property has already been verified.' });
    }
    if (state.exhausted) {
      return res.status(400).json({
        success: false,
        message: `All ${verification.MAX_VISIT_ATTEMPTS} permitted attempts have been used.`,
      });
    }

    const { scheduledFor, visitedAt, outcome = 'SCHEDULED', findings, latitude, longitude } = req.body || {};

    /**
     * Check the outcome before Prisma does.
     *
     * An unrecognised value otherwise reaches the database, which rejects it, and
     * the catch below turns that into "we could not save that visit — please try
     * again". Trying again cannot help: the value will be wrong every time. This
     * says what was actually wrong and what is accepted instead.
     */
    if (!VISIT_OUTCOMES.includes(outcome)) {
      return res.status(400).json({
        success: false,
        message: `"${outcome}" is not a visit outcome. Choose one of: ${VISIT_OUTCOMES.join(', ')}.`,
      });
    }

    if (latitude !== undefined && longitude !== undefined && latitude !== null && longitude !== null) {
      if (!geocode.withinSouthAfrica(latitude, longitude)) {
        return res.status(400).json({ success: false, message: 'Those coordinates are outside South Africa.' });
      }
    }

    const visit = await prisma.siteVisit.create({
      data: {
        applicationId: application.id,
        attempt: state.nextAttempt,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
        visitedAt: visitedAt ? new Date(visitedAt) : (outcome !== 'SCHEDULED' ? new Date() : null),
        outcome,
        officerId: req.user.id,
        officerName: officerName(req.user),
        findings: findings || null,
        latitude: latitude ?? null,
        longitude: longitude ?? null,
      },
    });

    const updated = await verification.refresh(application.id);

    await audit.record(req, {
      action: audit.ACTIONS.SITE_VISIT,
      entityType: 'Application',
      entityId: application.id,
      details: `Attempt ${visit.attempt}: ${outcome}${findings ? ` — ${findings}` : ''}`,
    });

    // Tell the applicant when a visit failed, before it counts against them.
    if (verification.isFailure(outcome)) {
      const remaining = verification.MAX_VISIT_ATTEMPTS - (updated?.failedVisitCount ?? 0);
      await notify.toUser(application.userId, {
        type: notify.TYPE.SITE_VISIT_FAILED,
        title: 'We could not complete a site visit',
        body: remaining > 0
          ? `We visited but could not confirm your household. ${remaining} more attempt${remaining === 1 ? '' : 's'} will be made before your application is affected.`
          : 'We have now attempted a site visit three times without success. Please contact your municipal office urgently.',
        link: `/applications/${application.id}`,
        entityType: 'Application',
        entityId: application.id,
      });

      const applicant = await prisma.user.findUnique({
        where: { id: application.userId },
        select: { cellNumber: true },
      });
      await sms.send(
        applicant?.cellNumber,
        smsTemplates.build('SITE_VISIT_FAILED', {
          reference: application.reference || application.id.slice(0, 8),
          remaining,
        }),
        { purpose: 'SITE_VISIT_FAILED', userId: application.userId, entityType: 'Application', entityId: application.id }
      );
    }

    res.status(201).json({
      success: true,
      message: outcome === 'SCHEDULED' ? 'Visit scheduled' : 'Visit recorded',
      data: visit,
      state: verification.visitState([...application.siteVisits, visit]),
    });
  } catch (error) {
    console.error('site visit error:', error);
    res.status(500).json({ success: false, message: 'We could not save that visit. Please try again.' });
  }
});

/** Complete or correct a scheduled visit. */
router.patch('/visits/:id', async (req, res) => {
  try {
    const visit = await prisma.siteVisit.findUnique({
      where: { id: req.params.id },
      include: { application: { select: { id: true, capturedById: true } } },
    });
    if (!visit) return res.status(404).json({ success: false, message: 'We could not find that visit.' });

    const separation = verification.separationOfDuties(visit.application, req.user);
    if (!separation.ok) {
      return res.status(403).json({ success: false, message: separation.reason });
    }

    const { outcome, findings, visitedAt, latitude, longitude } = req.body || {};
    const updated = await prisma.siteVisit.update({
      where: { id: visit.id },
      data: {
        ...(outcome ? { outcome } : {}),
        ...(findings !== undefined ? { findings: findings || null } : {}),
        ...(visitedAt !== undefined ? { visitedAt: visitedAt ? new Date(visitedAt) : null } : {}),
        ...(latitude !== undefined ? { latitude } : {}),
        ...(longitude !== undefined ? { longitude } : {}),
        ...(outcome && outcome !== 'SCHEDULED' && !visit.visitedAt ? { visitedAt: new Date() } : {}),
        officerId: req.user.id,
        officerName: officerName(req.user),
      },
    });

    await verification.refresh(visit.applicationId);

    await audit.record(req, {
      action: audit.ACTIONS.SITE_VISIT,
      entityType: 'Application',
      entityId: visit.applicationId,
      details: `Attempt ${visit.attempt} updated to ${updated.outcome}`,
    });

    res.json({ success: true, message: 'Visit updated', data: updated });
  } catch (error) {
    console.error('site visit update error:', error);
    res.status(500).json({ success: false, message: 'We could not save that change. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// External checks
// ---------------------------------------------------------------------------

/**
 * Log the result of an external check.
 *
 * The integrations are not built here — SARS, UIF, SASSA and the credit bureaux
 * each need a contract and credentials the municipality holds. What this records
 * is what an officer found on whichever system they have access to, which is
 * what an audit actually needs and the seam an API drops into later.
 */
router.post('/applications/:id/checks', async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      select: { id: true, reference: true, capturedById: true, consentDataMatching: true },
    });
    if (!application) return res.status(404).json({ success: false, message: 'We could not find that application.' });

    if (!application.consentDataMatching) {
      return res.status(403).json({
        success: false,
        code: 'NO_CONSENT',
        message: 'This applicant has not consented to external data checks. One cannot be recorded against them.',
      });
    }

    const separation = verification.separationOfDuties(application, req.user);
    if (!separation.ok) {
      return res.status(403).json({ success: false, message: separation.reason });
    }

    const { source, outcome = 'INCONCLUSIVE', externalRef, findings, amountFound } = req.body || {};
    const SOURCES = ['SARS', 'UIF', 'SASSA', 'CREDIT_BUREAU', 'DEEDS_OFFICE', 'MUNICIPAL_ACCOUNT', 'OTHER'];
    if (!SOURCES.includes(source)) {
      return res.status(400).json({ success: false, message: `Source must be one of: ${SOURCES.join(', ')}` });
    }
    // The source was already checked here; the outcome was not, so an
    // unrecognised one fell through to Prisma and came back as a 500 telling the
    // officer to try again — advice that could never work.
    if (!CHECK_OUTCOMES.includes(outcome)) {
      return res.status(400).json({
        success: false,
        message: `"${outcome}" is not a check outcome. Choose one of: ${CHECK_OUTCOMES.join(', ')}.`,
      });
    }

    const check = await prisma.verificationCheck.create({
      data: {
        applicationId: application.id,
        source,
        outcome,
        externalRef: externalRef || null,
        findings: findings || null,
        amountFound: amountFound === '' || amountFound === undefined || amountFound === null ? null : Number(amountFound),
        officerId: req.user.id,
        officerName: officerName(req.user),
      },
    });

    await verification.refresh(application.id);

    await audit.record(req, {
      action: audit.ACTIONS.VERIFICATION_CHECK,
      entityType: 'Application',
      entityId: application.id,
      details: `${source}: ${outcome}${findings ? ` — ${findings}` : ''}`,
    });

    res.status(201).json({ success: true, message: `${source} check recorded`, data: check });
  } catch (error) {
    console.error('verification check error:', error);
    res.status(500).json({ success: false, message: 'We could not save that check. Please try again.' });
  }
});

router.delete('/checks/:id', async (req, res) => {
  try {
    const check = await prisma.verificationCheck.findUnique({ where: { id: req.params.id } });
    if (!check) return res.status(404).json({ success: false, message: 'We could not find that check.' });

    await prisma.verificationCheck.delete({ where: { id: check.id } });
    await verification.refresh(check.applicationId);

    await audit.record(req, {
      action: audit.ACTIONS.VERIFICATION_CHECK,
      entityType: 'Application',
      entityId: check.applicationId,
      details: `Removed a ${check.source} check`,
    });

    res.json({ success: true, message: 'Check removed' });
  } catch (error) {
    console.error('check delete error:', error);
    res.status(500).json({ success: false, message: 'We could not remove that check. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/**
 * Record a recommendation.
 *
 * This is not a decision. It reaches an administrator, who decides. Keeping the
 * two apart is what stops one person approving public money on their own
 * signature — and it is why the applicant is not told anything at this point.
 */
router.post('/applications/:id/recommend', async (req, res) => {
  try {
    const { recommendation, notes } = req.body || {};
    if (!['APPROVE', 'REJECT', 'ESCALATE'].includes(recommendation)) {
      return res.status(400).json({ success: false, message: 'Recommendation must be APPROVE, REJECT or ESCALATE' });
    }
    if (recommendation !== 'APPROVE' && !notes?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'A reason is required when recommending a rejection or an escalation.',
      });
    }

    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: { siteVisits: true, checks: true, household: true },
    });
    if (!application) return res.status(404).json({ success: false, message: 'We could not find that application.' });

    if (application.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: 'Only an application awaiting a decision can be recommended on.',
      });
    }

    const separation = verification.separationOfDuties(application, req.user);
    if (!separation.ok) {
      return res.status(403).json({ success: false, message: separation.reason });
    }

    const updated = await prisma.application.update({
      where: { id: application.id },
      data: {
        recommendation,
        recommendedById: req.user.id,
        recommendedAt: new Date(),
        recommendationNotes: notes?.trim() || null,
        verificationStage: 'RECOMMENDED',
      },
    });

    await audit.record(req, {
      action: audit.ACTIONS.RECOMMEND_APPLICATION,
      entityType: 'Application',
      entityId: application.id,
      details: `Recommended ${recommendation}${notes ? ` — ${notes}` : ''}`,
    });

    await notify.toAdmins({
      type: notify.TYPE.RECOMMENDATION_READY,
      title: `Verification complete — ${recommendation.toLowerCase()} recommended`,
      body: `${application.reference || application.id.slice(0, 8)} was verified by ${officerName(req.user)}.`,
      link: `/applications/${application.id}`,
      entityType: 'Application',
      entityId: application.id,
      exceptUserId: req.user.id,
    });

    res.json({
      success: true,
      message: `Recommendation recorded. An administrator will make the final decision.`,
      data: updated,
    });
  } catch (error) {
    console.error('recommendation error:', error);
    res.status(500).json({ success: false, message: 'We could not save your recommendation. Please try again.' });
  }
});

/** Ask the applicant for more before recommending. */
router.post('/applications/:id/request-information', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message?.trim()) {
      return res.status(400).json({ success: false, message: 'Say what is needed from the applicant.' });
    }

    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      select: { id: true, reference: true, userId: true, capturedById: true, user: { select: { cellNumber: true } } },
    });
    if (!application) return res.status(404).json({ success: false, message: 'We could not find that application.' });

    await prisma.application.update({
      where: { id: application.id },
      data: { verificationStage: 'AWAITING_INFORMATION' },
    });

    await notify.toUser(application.userId, {
      type: notify.TYPE.INFORMATION_REQUESTED,
      title: 'We need more information',
      body: message.trim(),
      link: `/applications/${application.id}`,
      entityType: 'Application',
      entityId: application.id,
    });

    await sms.send(
      application.user?.cellNumber,
      smsTemplates.build('INFORMATION_REQUESTED', {
        reference: application.reference || application.id.slice(0, 8),
      }),
      { purpose: 'INFORMATION_REQUESTED', userId: application.userId, entityType: 'Application', entityId: application.id }
    );

    await audit.record(req, {
      action: audit.ACTIONS.REQUEST_INFORMATION,
      entityType: 'Application',
      entityId: application.id,
      details: message.trim(),
    });

    res.json({ success: true, message: 'The applicant has been asked, by notification and SMS.' });
  } catch (error) {
    console.error('request information error:', error);
    res.status(500).json({ success: false, message: 'We could not send that request. Please try again.' });
  }
});

module.exports = router;
