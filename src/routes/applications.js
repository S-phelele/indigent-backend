const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireApplicant } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

router.use(authenticate);

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
      include: { documents: true },
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
      include: { documents: true },
    });

    const requiredDocs = [
      { name: 'ID Copy', type: 'ID_COPY', importance: 'REQUIRED' },
      { name: 'Bank Statements', type: 'BANK_STATEMENTS', importance: 'REQUIRED' },
      { name: 'Affidavit', type: 'AFFIDAVIT', importance: 'REQUIRED' },
      { name: 'Proof of Grant', type: 'PROOF_OF_GRANT', importance: 'OPTIONAL' },
      { name: 'Copy of Death Certificate', type: 'COPY_OF_DEATH_CERT', importance: 'OPTIONAL' },
      { name: 'Letter of Authority', type: 'LETTER_OF_AUTHORITY', importance: 'OPTIONAL' },
    ];

    await prisma.document.createMany({
      data: requiredDocs.map((d) => ({
        applicationId: application.id,
        name: d.name,
        type: d.type,
        importance: d.importance,
        status: 'Pending',
      })),
    });

    const full = await prisma.application.findUnique({
      where: { id: application.id },
      include: { documents: true },
    });

    res.status(201).json({ success: true, data: full });
  } catch (error) {
    console.error('Create application error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create application',
      details: error.message,
    });
  }
});

// Get my applications
router.get('/mine', requireApplicant, async (req, res) => {
  try {
    const applications = await prisma.application.findMany({
      where: { userId: req.user.id },
      include: { documents: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: applications });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch applications' });
  }
});

// Get single application (owner or admin)
router.get('/:id', async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: {
        documents: true,
        user: {
          select: { id: true, email: true, firstName: true, lastName: true, cellNumber: true, idNumber: true },
        },
      },
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    if (req.user.role !== 'ADMIN' && application.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.json({ success: true, data: application });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch application' });
  }
});

// Update application step data
router.patch('/:id', requireApplicant, async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    if (application.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (application.status !== 'DRAFT') {
      return res.status(400).json({ success: false, message: 'Only draft applications can be updated' });
    }

    const body = req.body || {};
    const updateData = {};

    // String fields
    const stringKeys = [
      'maritalStatus', 'surname', 'names', 'idNumber', 'cellNumber',
      'residentialAddress', 'postalAddress', 'employerName', 'employerAddress',
      'workTelNumber', 'employmentStatus', 'waterMeterNumber', 'electricityMeterNumber',
      'addressFormatted', 'addressPlaceId',
    ];
    stringKeys.forEach((key) => {
      if (body[key] !== undefined) {
        const v = clean(body[key]);
        if (v !== undefined) updateData[key] = v;
      }
    });

    // Address coordinates
    if (body.addressLatitude !== undefined) {
      const lat = toDecimal(body.addressLatitude);
      if (lat !== undefined) updateData.addressLatitude = lat;
    }
    if (body.addressLongitude !== undefined) {
      const lng = toDecimal(body.addressLongitude);
      if (lng !== undefined) updateData.addressLongitude = lng;
    }
    if (body.addressVerified !== undefined) {
      const b = toBool(body.addressVerified);
      if (b !== undefined) {
        updateData.addressVerified = b;
        if (b) updateData.addressVerifiedAt = new Date();
      }
    }

    // If residential address text changed without new coordinates, clear verification
    if (
      body.residentialAddress !== undefined &&
      body.addressLatitude === undefined &&
      body.addressVerified === undefined
    ) {
      const newAddr = clean(body.residentialAddress);
      if (newAddr !== undefined && newAddr !== application.residentialAddress) {
        updateData.addressVerified = false;
        updateData.addressLatitude = null;
        updateData.addressLongitude = null;
        updateData.addressFormatted = null;
        updateData.addressPlaceId = null;
        updateData.addressVerifiedAt = null;
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
      'hasMunicipalArrears', 'hasArrearsArrangement'].forEach((key) => {
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
        include: { documents: true },
      });
      return res.json({ success: true, data: current });
    }

    const updated = await prisma.application.update({
      where: { id: req.params.id },
      data: updateData,
      include: { documents: true },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Update application error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update application',
      details: error.message,
    });
  }
});

// Submit application
router.post('/:id/submit', requireApplicant, async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: { documents: true },
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    if (application.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (application.status !== 'DRAFT') {
      return res.status(400).json({ success: false, message: 'Application already submitted' });
    }

    const missingRequired = application.documents.filter(
      (d) => d.importance === 'REQUIRED' && d.status !== 'Uploaded'
    );

    if (missingRequired.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Please upload all required documents before submitting',
        missing: missingRequired.map((d) => d.name),
      });
    }

    if (!application.idNumber || !application.cellNumber || !application.surname) {
      return res.status(400).json({
        success: false,
        message: 'Please complete all required applicant particulars (surname, ID number, cell number)',
      });
    }

    const updated = await prisma.application.update({
      where: { id: req.params.id },
      data: {
        status: 'PENDING',
        submittedAt: new Date(),
        currentStep: 5,
      },
      include: { documents: true },
    });

    res.json({
      success: true,
      message: 'Application submitted successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Submit error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit application',
      details: error.message,
    });
  }
});

module.exports = router;
