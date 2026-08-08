const express = require('express');
const prisma = require('../lib/prisma');
const { protect, requireApplicant } = require('../middleware/auth');
const eligibility = require('../lib/eligibility');
const reference = require('../lib/reference');
const saId = require('../lib/saIdNumber');
const timeline = require('../lib/timeline');
const meter = require('../lib/meterNumber');
const geocode = require('../lib/geocode');
const notify = require('../lib/notify');
const slots = require('../lib/documentSlots');
const access = require('../lib/applicationAccess');
const submission = require('../lib/submission');
const functioning = require('../lib/functioning');
const postal = require('../lib/postalAddress');
const cache = require('../lib/cache');

const router = express.Router();

router.use(...protect);

// Submitting or editing changes the figures the admin dashboard caches.
router.use(cache.invalidateOn(cache.TAGS.APPLICATIONS, cache.TAGS.ANALYTICS));

// Helper: convert empty string / null to undefined so we skip the field
const clean = (val) => {
  if (val === '' || val === null) return undefined;
  return val;
};

const toInt = (val) => {
  if (val === '' || val === null || val === undefined) return undefined;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : undefined;
};

const toDecimal = (val) => {
  if (val === '' || val === null || val === undefined) return undefined;
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : undefined;
};

const toBool = (val) => {
  if (val === true || val === false) return val;
  if (val === 'true' || val === 'Yes') return true;
  if (val === 'false' || val === 'No') return false;
  return undefined;
};

// Create new application (draft)
router.post('/', requireApplicant, async (req, res) => {
  try {
    // Only one DRAFT at a time — must submit (or cancel) before starting another
    const existingDraft = await prisma.application.findFirst({
      where: {
        userId: req.user.id,
        status: 'DRAFT',
      },
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } },
    });

    if (existingDraft) {
      return res.status(400).json({
        success: false,
        message: 'You already have a draft application. Please complete and submit it before starting a new one.',
        data: existingDraft,
      });
    }

    const application = await prisma.application.create({
      data: {
        userId: req.user.id,
        status: 'DRAFT',
        currentStep: 1,
        surname: req.user.lastName || null,
        names: req.user.firstName || null,
        idNumber: req.user.idNumber || null,
        cellNumber: req.user.cellNumber || null,
      },
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } },
    });

    await prisma.document.createMany({ data: slots.seedRows(application.id) });

    const full = await prisma.application.findUnique({
      where: { id: application.id },
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } },
    });

    res.status(201).json({ success: true, data: full });
  } catch (error) {
    console.error('Create application error:', error);
    res.status(500).json({
      success: false,
      message: 'We could not start the application. Please try again.',
    });
  }
});

// Get my applications
router.get('/mine', requireApplicant, async (req, res) => {
  try {
    const applications = await prisma.application.findMany({
      where: { userId: req.user.id },
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: applications });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'We could not load the applications. Please try again.' });
  }
});

// Get single application (owner or admin)
router.get('/:id', async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: {
        documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] },
        user: {
          select: { id: true, email: true, firstName: true, lastName: true, cellNumber: true, idNumber: true },
        },
      },
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    if (!access.canView(req.user, application)) {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    res.json({ success: true, data: application });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'We could not load that application. Please try again.' });
  }
});

/**
 * Stage history for one application.
 *
 * Owner or admin. Applicants see a filtered event list — they are told that a
 * municipal official acted, never which one.
 */
router.get('/:id/timeline', async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } },
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    if (!access.canView(req.user, application)) {
      return res.status(404).json({ success: false, message: 'We could not find that application.' });
    }

    const auditRows = await prisma.auditLog.findMany({
      where: { entityType: 'Application', entityId: application.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      success: true,
      data: {
        status: application.status,
        reference: application.reference,
        stages: timeline.stages(application),
        nextAction: timeline.nextAction(application),
        events: timeline.events(auditRows, { forApplicant: req.user.role !== 'ADMIN' }),
        documents: timeline.documentProgress(application.documents),
        reviewNotes: application.reviewNotes,
        submittedAt: application.submittedAt,
        reviewedAt: application.reviewedAt,
      },
    });
  } catch (error) {
    console.error('timeline error:', error);
    res.status(500).json({ success: false, message: 'We could not load the history for this application.' });
  }
});

/**
 * Update the wizard.
 *
 * Reached by the resident filling in their own form and by a ward councillor
 * capturing one at a household — both go through exactly the same validation, so
 * a field-captured application is held to the identical standard. Who is allowed
 * is decided in one place; see lib/applicationAccess.js.
 */
router.patch('/:id', access.loadFor('edit'), async (req, res) => {
  try {
    const application = req.application;
    const body = req.body || {};
    const updateData = {};

    if (body.idNumber !== undefined && clean(body.idNumber) !== undefined) {
      const check = saId.validate(body.idNumber);
      if (!check.valid) return res.status(400).json({ success: false, message: check.reason });
    }

    // Meter numbers are length-checked only; see lib/meterNumber for why.
    const meterChecks = {};
    for (const [key, kind] of [['waterMeterNumber', 'water'], ['electricityMeterNumber', 'electricity']]) {
      if (body[key] === undefined) continue;
      const check = meter.validate(body[key], { kind });
      if (!check.valid) return res.status(400).json({ success: false, message: check.reason });
      meterChecks[key] = check.value;
    }

    // String fields
    const stringKeys = [
      'title', 'maritalStatus', 'surname', 'names', 'idNumber', 'cellNumber',
      'residentialAddress', 'employerName', 'employerAddress',
      'workTelNumber', 'employmentStatus', 'waterMeterNumber', 'electricityMeterNumber',
      'wardNumber', 'municipalAccountNumber', 'eskomAccountNumber',
      'otherPropertyDetails', 'incomeExclusions',
    ];
    stringKeys.forEach((key) => {
      if (body[key] !== undefined) {
        const v = clean(body[key]);
        if (v !== undefined) updateData[key] = v;
      }
    });

    /**
     * The postal address.
     *
     * Handled apart from the plain strings because the single-line
     * `postalAddress` is composed by the server from the parts rather than
     * accepted from the client — otherwise an address edited in parts but
     * printed from a stale single field sends post to the wrong house.
     */
    const POSTAL_PARTS = ['postalLine1', 'postalLine2', 'postalSuburb', 'postalCity', 'postalCode'];
    const postalTouched = POSTAL_PARTS.some((k) => body[k] !== undefined)
      || body.postalSameAsResidential !== undefined
      || body.postalAddress !== undefined;

    if (postalTouched) {
      const sameAs = toBool(body.postalSameAsResidential);
      const merged = { ...application, ...updateData };

      const parts = Object.fromEntries(
        POSTAL_PARTS.map((k) => [k, body[k] !== undefined ? clean(body[k]) : merged[k]])
      );

      const wantsSame = sameAs !== undefined ? sameAs : Boolean(merged.postalSameAsResidential);

      // Only complain about incomplete parts when they are actually being used.
      if (!wantsSame) {
        const found = postal.problems(parts);
        if (found.length) return res.status(400).json({ success: false, message: found[0] });
      }

      Object.assign(updateData, postal.resolve({
        sameAsResidential: wantsSame,
        residentialAddress: merged.residentialAddress,
        ...parts,
      }));
    }

    /**
     * Enumerated answers.
     *
     * Whitelisted rather than passed through: an unknown value would be rejected
     * by Postgres as a 500 rather than as something the applicant can fix.
     */
    const ENUMS = {
      tenure: ['OWNER', 'TENANT', 'OCCUPIER'],
      incomeEvidence: ['PROOF_OF_INCOME', 'BANK_STATEMENTS', 'AFFIDAVIT'],
      applicantCategory: ['STANDARD', 'PENSIONER', 'DECEASED_ESTATE', 'CHILD_HEADED', 'DISABLED'],
      // The six Washington Group domains all take the same four-point scale.
      ...Object.fromEntries(functioning.FIELDS.map((field) => [field, functioning.SCALE_VALUES])),
    };
    for (const [key, allowed] of Object.entries(ENUMS)) {
      if (body[key] === undefined) continue;
      const value = clean(body[key]);
      if (value === undefined) continue;
      if (!allowed.includes(value)) {
        return res.status(400).json({ success: false, message: `${key} must be one of: ${allowed.join(', ')}` });
      }
      updateData[key] = value;
    }

    /**
     * Date of birth, age and sex.
     *
     * Recomputed whenever the ID number is set or corrected, never accepted
     * from the client. They are already in the ID number, so taking them from
     * the request would let the two disagree — and the ID number is the one a
     * reviewer will check against the green book.
     */
    if (updateData.idNumber !== undefined) {
      Object.assign(updateData, functioning.fromIdNumber(updateData.idNumber));
    }

    /**
     * Employer details, when there is no employer.
     *
     * Somebody who filled in an employer and then answered "unemployed" would
     * otherwise leave the old employer on file — invisible on a form that no
     * longer shows those fields, and still there for the verification officer to
     * see and query. Enforced here rather than in the browser so a councillor
     * capturing at a door is held to the same rule.
     */
    const HAS_EMPLOYER = ['EMPLOYED', 'SELF_EMPLOYED'];
    if (updateData.employmentStatus !== undefined && !HAS_EMPLOYER.includes(updateData.employmentStatus)) {
      Object.assign(updateData, { employerName: null, employerAddress: null, workTelNumber: null });
    }

    /**
     * Sex, when the applicant corrects it.
     *
     * The ID number's sequence digits encode sex as recorded at birth, which is
     * the right default and wrong for some people. Applied after the derivation
     * above so an explicit answer wins, and only for sex — the date of birth and
     * age stay derived, because those are checked against the green book and a
     * second answer would only create a contradiction.
     */
    if (body.sex !== undefined) {
      const value = clean(body.sex);
      if (value !== undefined) {
        if (!['FEMALE', 'MALE'].includes(value)) {
          return res.status(400).json({ success: false, message: 'Sex must be female or male.' });
        }
        updateData.sex = value;
      }
    }

    /**
     * The Washington Group disability identifier.
     *
     * Derived from the six answers rather than asked, so it can never disagree
     * with them. Recomputed against the answers as they will stand after this
     * update, not as they were before it.
     */
    if (functioning.FIELDS.some((f) => f in updateData)) {
      const merged = { ...application, ...updateData };
      updateData.hasDisability = functioning.assess(merged).hasDisability;
    }

    /**
     * Consent.
     *
     * Stamped the moment all three are given. Verification cannot lawfully begin
     * without them, and "when did they agree" is the question that survives a
     * dispute — a bare boolean does not answer it.
     */
    const CONSENTS = ['consentSiteVisit', 'consentDataMatching', 'declarationTruthful'];
    let consentTouched = false;
    CONSENTS.forEach((key) => {
      const b = toBool(body[key]);
      if (b !== undefined) { updateData[key] = b; consentTouched = true; }
    });
    if (consentTouched) {
      const merged = { ...application, ...updateData };
      updateData.consentGivenAt = CONSENTS.every((k) => merged[k]) ? new Date() : null;
    }

    // Normalised meter values win over the raw string captured above.
    Object.entries(meterChecks).forEach(([key, value]) => { updateData[key] = value; });

    /**
     * Residential coordinates.
     *
     * Latitude and longitude only ever move together — a lone latitude would
     * place the household somewhere meaningless. When both arrive they are
     * checked against the southern-African bounding box, and the capture is
     * timestamped so a reviewer can see how fresh it is.
     */
    const hasLat = body.addressLatitude !== undefined;
    const hasLon = body.addressLongitude !== undefined;

    if (hasLat !== hasLon) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude must be provided together.',
      });
    }

    if (hasLat && hasLon) {
      const lat = body.addressLatitude === null || body.addressLatitude === '' ? null : Number(body.addressLatitude);
      const lon = body.addressLongitude === null || body.addressLongitude === '' ? null : Number(body.addressLongitude);

      if (lat === null && lon === null) {
        // Explicitly clearing the pin.
        Object.assign(updateData, {
          addressLatitude: null, addressLongitude: null, addressFormatted: null,
          addressSource: null, addressAccuracyM: null, addressVerifiedAt: null,
        });
      } else if (!geocode.withinSouthAfrica(lat, lon)) {
        return res.status(400).json({
          success: false,
          message: 'Those coordinates are outside South Africa. The property must be in the municipal area.',
        });
      } else {
        updateData.addressLatitude = geocode.round7(lat);
        updateData.addressLongitude = geocode.round7(lon);
        updateData.addressVerifiedAt = new Date();

        const source = String(body.addressSource || '').toUpperCase();
        updateData.addressSource = ['DEVICE', 'SEARCH', 'MANUAL'].includes(source) ? source : 'MANUAL';

        if (body.addressFormatted !== undefined) {
          updateData.addressFormatted = clean(body.addressFormatted) ?? null;
        }
        if (body.addressAccuracyM !== undefined) {
          const accuracy = toInt(body.addressAccuracyM);
          updateData.addressAccuracyM = accuracy !== undefined ? Math.min(accuracy, 100000) : null;
        }
      }
    } else if (body.residentialAddress !== undefined) {
      /**
       * The address text changed on its own. The old pin now points at the
       * previous address, which is worse than having no pin — so drop it.
       *
       * This is the logic that used to write columns the schema no longer had,
       * making every step-1 save fail with a 500. The columns exist again now.
       */
      const nextAddress = clean(body.residentialAddress) ?? null;
      if (nextAddress !== application.residentialAddress && application.addressLatitude !== null) {
        Object.assign(updateData, {
          addressLatitude: null, addressLongitude: null, addressFormatted: null,
          addressSource: null, addressAccuracyM: null, addressVerifiedAt: null,
        });
      }
    }

    // Boolean
    if (body.cellVerified !== undefined) {
      const b = toBool(body.cellVerified);
      if (b !== undefined) updateData.cellVerified = b;
    }

    // Integers
    ['peopleOnProperty', 'childrenUnder18', 'adults', 'pensionersOver60'].forEach((key) => {
      if (body[key] !== undefined) {
        const n = toInt(body[key]);
        if (n !== undefined) updateData[key] = n;
      }
    });

    // Decimals
    ['salary', 'oldAgePension', 'disabilityPension', 'businessIncome', 'rentingIncome',
      'totalIncomePerPerson', 'totalHouseholdIncome'].forEach((key) => {
      if (body[key] !== undefined) {
        const n = toDecimal(body[key]);
        if (n !== undefined) updateData[key] = n;
      }
    });

    // Yes/No booleans
    ['ownsImmovableProperty', 'isFullTimeOccupant', 'incomeBelowThreshold',
      'hasMunicipalArrears', 'hasArrearsArrangement', 'ownsOtherProperty'].forEach((key) => {
      if (body[key] !== undefined) {
        const b = toBool(body[key]);
        if (b !== undefined) updateData[key] = b;
      }
    });

    // currentStep
    if (body.currentStep !== undefined) {
      const step = toInt(body.currentStep);
      if (step !== undefined && step >= 1 && step <= 5) {
        updateData.currentStep = step;
      }
    }

    // Auto-calculate totals when any income field is present
    const incomeKeys = ['salary', 'oldAgePension', 'disabilityPension', 'businessIncome', 'rentingIncome'];
    const hasIncomeUpdate = incomeKeys.some((k) => body[k] !== undefined);

    if (hasIncomeUpdate) {
      const s = toDecimal(body.salary) ?? (application.salary != null ? Number(application.salary) : 0);
      const o = toDecimal(body.oldAgePension) ?? (application.oldAgePension != null ? Number(application.oldAgePension) : 0);
      const d = toDecimal(body.disabilityPension) ?? (application.disabilityPension != null ? Number(application.disabilityPension) : 0);
      const b = toDecimal(body.businessIncome) ?? (application.businessIncome != null ? Number(application.businessIncome) : 0);
      const r = toDecimal(body.rentingIncome) ?? (application.rentingIncome != null ? Number(application.rentingIncome) : 0);

      updateData.totalHouseholdIncome = s + o + d + b + r;

      const people =
        toInt(body.peopleOnProperty) ??
        application.peopleOnProperty ??
        1;
      if (people > 0) {
        updateData.totalIncomePerPerson = updateData.totalHouseholdIncome / people;
      }
    }

    if (Object.keys(updateData).length === 0) {
      // Nothing to update — still return current record so UI can advance
      const current = await prisma.application.findUnique({
        where: { id: req.params.id },
        include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } },
      });
      return res.json({ success: true, data: current });
    }

    const updated = await prisma.application.update({
      where: { id: req.params.id },
      data: updateData,
      include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } },
    });

    /**
     * Keep the document checklist in step with the answers.
     *
     * Changing tenure from owner to tenant swaps a title deed for a lease;
     * declaring a deceased estate adds a death certificate. Doing this here
     * rather than in the interface means the checklist is correct however the
     * answer was changed — the applicant's wizard, a councillor's capture
     * screen, or an administrator's edit.
     *
     * Only ever runs on drafts. A submitted application's obligations are frozen.
     */
    const AFFECTS_CHECKLIST = ['tenure', 'applicantCategory'];
    if (updated.status === 'DRAFT' && AFFECTS_CHECKLIST.some((k) => k in updateData)) {
      const { toCreate, toDelete, toUpdate } = slots.reconcile(updated.documents, updated);

      if (toCreate.length || toDelete.length || toUpdate.length) {
        await prisma.$transaction([
          ...(toCreate.length ? [prisma.document.createMany({ data: toCreate })] : []),
          // Only ever removes empty slots — see lib/documentSlots.reconcile.
          ...(toDelete.length ? [prisma.document.deleteMany({ where: { id: { in: toDelete } } })] : []),
          ...toUpdate.map((u) => prisma.document.update({
            where: { id: u.id },
            data: { importance: u.importance, requirementGroup: u.requirementGroup },
          })),
        ]);

        const refreshed = await prisma.application.findUnique({
          where: { id: updated.id },
          include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } },
        });
        return res.json({ success: true, data: refreshed, checklistChanged: true });
      }
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Update application error:', error);
    res.status(500).json({
      success: false,
      message: 'We could not save your changes. Please try again.',
    });
  }
});

/**
 * Submit for review.
 *
 * The readiness rules and everything that follows a submission live in
 * lib/submission.js, shared with the councillor's field capture so both routes
 * produce an identical record.
 */
router.post('/:id/submit', access.loadFor('submit', { include: { documents: { orderBy: [{ importance: 'asc' }, { requirementGroup: 'asc' }, { createdAt: 'asc' }] } } }), async (req, res) => {
  try {
    const application = req.application;

    const check = submission.readiness(application);
    if (!check.ready) {
      return res.status(400).json({
        success: false,
        message: check.problems.join(' '),
        missing: check.missingDocuments,
      });
    }

    const updated = await submission.submit(application, { actor: req.user });

    res.json({
      success: true,
      message: 'Application submitted successfully',
      data: { ...updated, eligibility: eligibility.assess(updated) },
    });
  } catch (error) {
    console.error('Submit error:', error);
    res.status(500).json({
      success: false,
      message: 'We could not submit the application. Please try again.',
    });
  }
});

module.exports = router;
