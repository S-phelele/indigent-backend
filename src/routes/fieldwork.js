const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { protect, requireCapture } = require('../middleware/auth');
const audit = require('../lib/audit');
const sms = require('../lib/sms');
const smsTemplates = require('../lib/smsTemplates');
const { temporaryPassword } = require('../lib/credentials');
const saId = require('../lib/saIdNumber');
const slots = require('../lib/documentSlots');
const submission = require('../lib/submission');
const notify = require('../lib/notify');
const eligibility = require('../lib/eligibility');
const cache = require('../lib/cache');
const { staffLimiter } = require('../lib/rateLimit');

/**
 * Door-to-door capture.
 *
 * A ward councillor walks a street with a phone. At each household they create
 * an account for the resident, capture the application, photograph the
 * documents, and submit — with the resident standing there.
 *
 * Two things shape every decision in this file:
 *
 *  1. **The resident must end up with their own account.** Not a record filed
 *     under the councillor. They get a username and a password by SMS, so they
 *     can check on the application, and so the relationship survives the
 *     councillor leaving office.
 *  2. **The councillor is not a caseworker.** They capture and hand over. They
 *     cannot review, cannot decide, and cannot read another councillor's
 *     households. Capture and approval stay in different hands.
 *
 * Administrators may use these routes too — the same job is done at the
 * municipal counter for someone who walked in.
 */
const router = express.Router();
router.use(...protect, requireCapture, staffLimiter);
router.use(cache.invalidateOn(cache.TAGS.APPLICATIONS, cache.TAGS.USERS, cache.TAGS.ANALYTICS));

const displayName = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;

/** Who is capturing, for attribution on the record and in the SMS. */
const capturer = (user) => ({
  id: user.id,
  name: displayName(user),
  ward: user.ward || null,
  channel: user.role === 'COUNCILLOR' ? 'COUNCILLOR' : 'ADMIN',
});

/**
 * A resident registered at the door usually has no email address.
 *
 * Their cell number is the one identifier they certainly have and certainly
 * remember, so it becomes the username. The synthetic address is a placeholder to
 * satisfy the unique column — never somewhere a message is sent, which is why
 * every notification in this flow goes out by SMS.
 */
const cellUsername = (normalisedCell) => `${normalisedCell.replace('+', '')}@cell.indigent.local`;

const isPlaceholderEmail = (email) => String(email || '').endsWith('@cell.indigent.local');

// ---------------------------------------------------------------------------
// Before knocking: does this household already exist?
// ---------------------------------------------------------------------------

/**
 * Look up a resident by ID number or cell before creating a duplicate.
 *
 * Councillors work the same streets as their predecessors and residents forget
 * they ever applied. Without this the register fills with two accounts per
 * household and two half-applications, and the review queue cannot tell which is
 * real.
 */
router.get('/residents/lookup', async (req, res) => {
  try {
    const idNumber = String(req.query.idNumber || '').trim();
    const cellNumber = sms.normaliseNumber(req.query.cellNumber);

    if (!idNumber && !cellNumber) {
      return res.status(400).json({ success: false, message: 'Provide an ID number or a cell number to search' });
    }

    const resident = await prisma.user.findFirst({
      where: {
        role: 'APPLICANT',
        OR: [
          ...(idNumber ? [{ idNumber }] : []),
          ...(cellNumber ? [{ cellNumber }] : []),
        ],
      },
      select: {
        id: true, firstName: true, lastName: true, cellNumber: true, idNumber: true, email: true, createdAt: true,
        applications: {
          select: { id: true, reference: true, status: true, createdAt: true, submittedAt: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!resident) {
      return res.json({ success: true, data: null, message: 'No existing record. You can register this household.' });
    }

    const draft = resident.applications.find((a) => a.status === 'DRAFT');
    const active = resident.applications.find((a) => a.status === 'PENDING');

    res.json({
      success: true,
      data: {
        ...resident,
        email: isPlaceholderEmail(resident.email) ? null : resident.email,
        name: displayName(resident),
        hasDraft: Boolean(draft),
        draftId: draft?.id || null,
        hasPending: Boolean(active),
      },
      message: active
        ? `This household already has an application under review (${active.reference}).`
        : draft
          ? 'This household has an unfinished application. You can continue it.'
          : 'This household is registered. You can start a new application for them.',
    });
  } catch (error) {
    console.error('resident lookup error:', error);
    res.status(500).json({ success: false, message: 'We could not complete that search. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Register the household and open its application
// ---------------------------------------------------------------------------

/**
 * Create a resident account and a draft application in one step, and text the
 * resident their sign-in details.
 *
 * One endpoint rather than two because at a doorstep they are one action, and a
 * councillor who loses signal between two calls would leave an account with no
 * application behind.
 */
router.post('/households', async (req, res) => {
  try {
    const { firstName, lastName, idNumber, cellNumber, email } = req.body || {};

    if (!firstName || !lastName) {
      return res.status(400).json({ success: false, message: "The resident's first and last name are required" });
    }

    const normalisedCell = sms.normaliseNumber(cellNumber);
    if (!normalisedCell) {
      return res.status(400).json({
        success: false,
        message: 'A valid South African cell number is required — this is how the resident receives their reference and sign-in details',
      });
    }

    if (!idNumber) {
      return res.status(400).json({ success: false, message: 'Please enter the ID number.' });
    }
    const idCheck = saId.validate(idNumber);
    if (!idCheck.valid) {
      return res.status(400).json({ success: false, message: idCheck.reason });
    }

    const trimmedId = String(idNumber).trim();
    const wantedEmail = email ? String(email).trim().toLowerCase() : cellUsername(normalisedCell);

    const existing = await prisma.user.findFirst({
      where: { OR: [{ idNumber: trimmedId }, { email: wantedEmail }] },
      select: { id: true, idNumber: true, email: true, role: true },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_REGISTERED',
        message: existing.idNumber === trimmedId
          ? 'That ID number is already registered. Search for the household instead of creating a second record.'
          : 'That email address is already in use.',
        data: { userId: existing.id },
      });
    }

    const plainPassword = temporaryPassword();
    const by = capturer(req.user);

    // One transaction: an account with no application, or an application with no
    // account, are both worse than a clean failure the councillor can retry.
    const { resident, application } = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: wantedEmail,
          password: await bcrypt.hash(plainPassword, 12),
          role: 'APPLICANT',
          firstName: String(firstName).trim(),
          lastName: String(lastName).trim(),
          cellNumber: normalisedCell,
          idNumber: trimmedId,
          // Their identity was confirmed face to face against their ID book,
          // which is a stronger check than the SMS code the portal would send.
          // Dated here as well, so submission has a real moment to freeze onto
          // the application rather than a null that reads as "verified, when
          // nobody knows".
          isVerified: true,
          cellVerifiedAt: new Date(),
          mustChangePassword: true,
          registeredById: req.user.id,
        },
        select: { id: true, email: true, firstName: true, lastName: true, cellNumber: true, idNumber: true },
      });

      const app = await tx.application.create({
        data: {
          userId: created.id,
          status: 'DRAFT',
          currentStep: 1,
          surname: created.lastName,
          // `names` is the legacy column, kept for a client not yet migrated.
          // `fullName` is what every current screen displays, so a household
          // captured at the door shows their name on the dashboard immediately
          // rather than blank until the councillor reaches the particulars step —
          // the same placeholder the councillor themselves typed seconds ago.
          names: created.firstName,
          fullName: created.firstName,
          idNumber: created.idNumber,
          cellNumber: created.cellNumber,
          captureChannel: by.channel,
          capturedById: by.id,
          capturedAt: new Date(),
          capturedWard: by.ward,
        },
      });

      await tx.document.createMany({ data: slots.seedRows(app.id) });
      return { resident: created, application: app };
    });

    // Outside the transaction: a slow gateway must not hold a database lock, and
    // a failed SMS must not undo a completed registration.
    const smsResult = await sms.send(
      normalisedCell,
      smsTemplates.build('WELCOME_CREDENTIALS', {
        firstName: resident.firstName,
        username: isPlaceholderEmail(resident.email) ? normalisedCell : resident.email,
        tempPassword: plainPassword,
      }),
      {
        purpose: 'WELCOME_CREDENTIALS',
        userId: resident.id,
        entityType: 'User',
        entityId: resident.id,
        secrets: [plainPassword],
      }
    );

    await notify.toUser(resident.id, {
      type: notify.TYPE.ACCOUNT_CREATED_FOR_YOU,
      title: 'An account was created for you',
      body: `${by.name}${by.ward ? ` (${by.ward})` : ''} registered you on the Indigent Register. Please choose your own password.`,
      link: '/profile',
      entityType: 'User',
      entityId: resident.id,
    });

    await audit.record(req, {
      action: audit.ACTIONS.FIELD_REGISTER_RESIDENT,
      entityType: 'User',
      entityId: resident.id,
      details: `Registered ${displayName(resident)} door-to-door${by.ward ? ` in ${by.ward}` : ''}`,
    });
    await audit.record(req, {
      action: audit.ACTIONS.FIELD_CAPTURE_APPLICATION,
      entityType: 'Application',
      entityId: application.id,
      details: `Opened a field capture for ${displayName(resident)}`,
    });

    const full = await prisma.application.findUnique({
      where: { id: application.id },
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } },
    });

    res.status(201).json({
      success: true,
      message: smsResult.ok
        ? `${displayName(resident)} registered. Sign-in details sent to ${normalisedCell}.`
        : `${displayName(resident)} registered, but the SMS could not be sent — write the password down for them.`,
      data: { resident, application: full },
      // Shown to the capturing councillor once, so they can read it out if the
      // SMS has not arrived by the time they leave. Never stored in clear text.
      credentials: {
        username: isPlaceholderEmail(resident.email) ? normalisedCell : resident.email,
        temporaryPassword: plainPassword,
        smsDelivered: smsResult.ok,
      },
    });
  } catch (error) {
    console.error('field household registration error:', error);
    res.status(500).json({ success: false, message: 'We could not register this household. Please try again.' });
  }
});

/**
 * Open a new application for a household already on the register.
 *
 * Used when the lookup finds a resident whose previous application was decided.
 */
router.post('/residents/:id/applications', async (req, res) => {
  try {
    const resident = await prisma.user.findFirst({
      where: { id: req.params.id, role: 'APPLICANT' },
      select: { id: true, firstName: true, lastName: true, cellNumber: true, idNumber: true, email: true },
    });
    if (!resident) {
      return res.status(404).json({ success: false, message: 'Resident not found' });
    }

    const openApplication = await prisma.application.findFirst({
      where: { userId: resident.id, status: { in: ['DRAFT', 'PENDING'] } },
      select: { id: true, status: true, reference: true },
    });
    if (openApplication) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_OPEN',
        message: openApplication.status === 'DRAFT'
          ? 'This household already has an unfinished application. Continue that one.'
          : `This household already has an application under review (${openApplication.reference}).`,
        data: openApplication,
      });
    }

    const by = capturer(req.user);
    const application = await prisma.application.create({
      data: {
        userId: resident.id,
        status: 'DRAFT',
        currentStep: 1,
        surname: resident.lastName,
        names: resident.firstName,
        fullName: resident.firstName,
        idNumber: resident.idNumber,
        cellNumber: resident.cellNumber,
        captureChannel: by.channel,
        capturedById: by.id,
        capturedAt: new Date(),
        capturedWard: by.ward,
      },
    });
    await prisma.document.createMany({ data: slots.seedRows(application.id) });

    await audit.record(req, {
      action: audit.ACTIONS.FIELD_CAPTURE_APPLICATION,
      entityType: 'Application',
      entityId: application.id,
      details: `Opened a field capture for existing resident ${displayName(resident)}`,
    });

    const full = await prisma.application.findUnique({
      where: { id: application.id },
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } },
    });

    res.status(201).json({ success: true, message: 'Application started', data: full });
  } catch (error) {
    console.error('field application create error:', error);
    res.status(500).json({ success: false, message: 'We could not start the application. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Submit at the door
// ---------------------------------------------------------------------------

/**
 * Submit a captured application.
 *
 * Separate from the applicant's own submit route only so the record carries the
 * councillor's name and the resident's SMS says who called on them. The
 * readiness rules are identical — a field capture is not held to a lower
 * standard.
 */
router.post('/applications/:id/submit', async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: {
        documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] },
        // readiness() checks the income answer and the household count against
        // the declared headcount. A field capture is held to the same standard
        // as a resident's own form, so it has to load the same relations.
        incomeSources: { orderBy: { createdAt: 'asc' } },
        household: { orderBy: { createdAt: 'asc' } },
        // readiness() also checks that the resident's number was verified.
        user: { select: { id: true, isVerified: true, cellVerifiedAt: true, cellNumber: true } },
      },
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    const mine = application.capturedById === req.user.id;
    if (!mine && req.user.role !== 'ADMIN') {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }
    if (application.status !== 'DRAFT') {
      return res.status(400).json({ success: false, message: 'This application has already been submitted' });
    }

    const check = submission.readiness(application);
    if (!check.ready) {
      return res.status(400).json({
        success: false,
        message: check.problems.join(' '),
        missing: check.missingDocuments,
      });
    }

    const updated = await submission.submit(application, {
      actor: req.user,
      capturedBy: capturer(req.user),
    });

    await audit.record(req, {
      action: audit.ACTIONS.FIELD_SUBMIT_APPLICATION,
      entityType: 'Application',
      entityId: updated.id,
      details: `Submitted field capture ${updated.reference}`,
    });

    res.json({
      success: true,
      message: `Submitted. Reference ${updated.reference} was sent to the resident by SMS.`,
      data: { ...updated, eligibility: eligibility.assess(updated) },
    });
  } catch (error) {
    console.error('field submit error:', error);
    res.status(500).json({ success: false, message: 'We could not submit the application. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// The councillor's own view of their work
// ---------------------------------------------------------------------------

/** Everything this councillor has captured. Never anybody else's. */
router.get('/captures', async (req, res) => {
  try {
    const { status = 'all', search = '' } = req.query;

    const captures = await prisma.application.findMany({
      where: {
        capturedById: req.user.id,
        ...(status !== 'all' ? { status: String(status).toUpperCase() } : {}),
        ...(search
          ? {
              OR: [
                { names: { contains: String(search), mode: 'insensitive' } },
                { surname: { contains: String(search), mode: 'insensitive' } },
                { idNumber: { contains: String(search) } },
                { reference: { contains: String(search), mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true, reference: true, status: true, names: true, fullName: true, surname: true, idNumber: true,
        cellNumber: true, residentialAddress: true, capturedAt: true, submittedAt: true,
        reviewedAt: true, capturedWard: true, currentStep: true,
        documents: { select: { id: true, name: true, importance: true, requirementGroup: true, status: true } },
      },
      orderBy: [{ capturedAt: 'desc' }],
      take: 200,
    });

    res.json({
      success: true,
      data: captures.map(({ documents, ...a }) => ({
        ...a,
        name: [a.fullName || a.names, a.surname].filter(Boolean).join(' ') || 'Unnamed',
        documentProgress: slots.progress(documents),
        outstanding: slots.outstandingMessage(documents),
      })),
    });
  } catch (error) {
    console.error('captures list error:', error);
    res.status(500).json({ success: false, message: 'We could not load your captures. Please try again.' });
  }
});

/** Headline figures for the councillor's home page. */
router.get('/summary', async (req, res) => {
  try {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 29);
    since.setUTCHours(0, 0, 0, 0);

    const [byStatus, recent, drafts] = await Promise.all([
      prisma.application.groupBy({
        by: ['status'],
        where: { capturedById: req.user.id },
        _count: { _all: true },
      }),
      prisma.application.count({
        where: { capturedById: req.user.id, capturedAt: { gte: since } },
      }),
      prisma.application.findMany({
        where: { capturedById: req.user.id, status: 'DRAFT' },
        select: { id: true, names: true, fullName: true, surname: true, capturedAt: true, currentStep: true },
        orderBy: { capturedAt: 'desc' },
        take: 5,
      }),
    ]);

    const totals = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));

    res.json({
      success: true,
      data: {
        ward: req.user.ward || null,
        captured: Object.values(totals).reduce((a, b) => a + b, 0),
        draft: totals.DRAFT || 0,
        pending: totals.PENDING || 0,
        approved: totals.APPROVED || 0,
        declined: totals.DECLINED || 0,
        last30Days: recent,
        // Unfinished captures are the councillor's own to-do list: a household
        // visited but never submitted helps nobody.
        unfinished: drafts.map((d) => ({
          ...d,
          name: [d.fullName || d.names, d.surname].filter(Boolean).join(' ') || 'Unnamed',
        })),
      },
    });
  } catch (error) {
    console.error('fieldwork summary error:', error);
    res.status(500).json({ success: false, message: 'We could not load your figures. Please try again.' });
  }
});

module.exports = router;
