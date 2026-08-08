const express = require('express');
const prisma = require('../lib/prisma');
const { protect, requireStaff } = require('../middleware/auth');
const { exportLimiter } = require('../lib/rateLimit');
const audit = require('../lib/audit');
const exportFormat = require('../lib/exportFormat');
const meansTest = require('../lib/meansTest');
const chain = require('../lib/approvalChain');
const signature = require('../lib/signature');
const sanitize = require('../lib/sanitize');
const respond = require('../lib/respond');
const access = require('../lib/applicationAccess');

/**
 * What comes out of the register: the printable form and the spreadsheet.
 *
 * Municipalities still keep paper files, and a council report still gets built
 * in Excel. Both of those are the register's output as much as the screens are,
 * and doing them badly — an ISO timestamp Excel reads as text, an ID number
 * rendered as 9.20220E+12 — costs somebody an afternoon every month.
 */
const router = express.Router();
router.use(...protect, requireStaff);

const FULL = {
  household: { orderBy: { createdAt: 'asc' } },
  documents: { select: { name: true, type: true, status: true, importance: true, uploadedAt: true } },
  approvalSteps: { orderBy: { sequence: 'asc' } },
  checks: true,
  siteVisits: { orderBy: { attempt: 'asc' } },
  user: { select: { email: true, firstName: true, lastName: true, cellNumber: true } },
  capturedBy: { select: { firstName: true, lastName: true, ward: true } },
};

/**
 * The printable application form.
 *
 * Returns structured sections rather than HTML, so the portal renders it inside
 * its own print stylesheet and the same data can drive a generated PDF later
 * without the layout being duplicated.
 */
router.get('/applications/:id/print', respond.handler(async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: FULL,
  });
  if (!application) return respond.notFound(res, 'We could not find that application.');

  if (!access.canView(req.user, application) && req.user.role === 'APPLICANT') {
    return respond.notFound(res, 'We could not find that application.');
  }

  const finding = meansTest.assess(application, {
    checks: application.checks,
    household: application.household,
  });

  await audit.record(req, {
    action: audit.ACTIONS.PRINT_APPLICATION,
    entityType: 'Application',
    entityId: application.id,
    details: `Printed ${application.reference || application.id.slice(0, 8)}`,
  });

  res.json({
    success: true,
    data: {
      reference: application.reference,
      applicantName: [application.names, application.surname].filter(Boolean).join(' ') || 'Not stated',
      status: application.status,
      printedAt: new Date(),
      printedBy: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email,
      sections: exportFormat.printableSections(application, { meansTest: finding }),
      documents: application.documents.map((d) => ({
        name: d.name,
        required: d.importance === 'REQUIRED',
        supplied: d.status === 'Uploaded',
        status: d.status,
      })),
      /**
       * The approval trail, printed with the form.
       *
       * A paper file that shows only the decision is missing the part that
       * matters at audit: who checked what, in what order, and who signed.
       */
      approvals: application.approvalSteps.map((s) => ({
        stage: chain.config(s.stage)?.label || s.stage,
        outcome: s.outcome,
        description: chain.describeStep(s),
        actor: s.actorName,
        role: s.actorRole,
        at: s.decidedAt || s.startedAt,
        notes: s.notes,
        signature: s.signature ? { image: s.signature, ...signature.describe(s) } : null,
      })),
      siteVisits: application.siteVisits.map((v) => ({
        attempt: v.attempt, outcome: v.outcome, at: v.visitedAt, officer: v.officerName, findings: v.findings,
      })),
    },
  });
}, 'print application'));

/**
 * Applications as a spreadsheet.
 *
 * Filters mirror the queue so an official exports exactly what they were
 * looking at rather than the whole register and then deletes rows.
 */
router.get('/applications.csv', exportLimiter, respond.handler(async (req, res) => {
  const status = sanitize.oneOf(req.query.status, ['DRAFT', 'PENDING', 'APPROVED', 'DECLINED']);
  const stage = sanitize.oneOf(req.query.stage, chain.STAGES);
  const ward = sanitize.text(req.query.ward, { max: 40 });
  const renewalStatus = sanitize.oneOf(req.query.renewalStatus, ['ACTIVE', 'DUE_SOON', 'OVERDUE', 'LAPSED']);
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;

  const where = {
    ...(status ? { status } : { status: { in: ['PENDING', 'APPROVED', 'DECLINED'] } }),
    ...(stage ? { approvalStage: stage } : {}),
    ...(ward ? { wardNumber: ward } : {}),
    ...(renewalStatus ? { renewalStatus } : {}),
    ...(from || to
      ? {
          submittedAt: {
            ...(from && !Number.isNaN(from.valueOf()) ? { gte: from } : {}),
            ...(to && !Number.isNaN(to.valueOf()) ? { lte: to } : {}),
          },
        }
      : {}),
  };

  // Capped rather than unbounded: an export is a report, and a request that
  // serialises the entire register is a way to take the database down.
  const LIMIT = 20000;
  const applications = await prisma.application.findMany({
    where,
    include: { capturedBy: { select: { firstName: true, lastName: true } } },
    orderBy: { submittedAt: 'desc' },
    take: LIMIT,
  });

  await audit.record(req, {
    action: audit.ACTIONS.EXPORT_APPLICATIONS,
    entityType: 'Application',
    details: `Exported ${applications.length} application(s)`
      + `${status ? ` with status ${status}` : ''}${ward ? ` in ${ward}` : ''}`,
  });

  const csv = exportFormat.applicationsCsv(applications);
  const name = exportFormat.filename('indigent-applications', [status, ward].filter(Boolean).join('-').toLowerCase());

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(csv);
}, 'export applications csv'));

/** The renewal list as a spreadsheet — the working list for a re-verification drive. */
router.get('/renewals.csv', exportLimiter, respond.handler(async (req, res) => {
  const renewalStatus = sanitize.oneOf(req.query.status, ['ACTIVE', 'DUE_SOON', 'OVERDUE', 'LAPSED']);

  const applications = await prisma.application.findMany({
    where: {
      status: 'APPROVED',
      expiresAt: { not: null },
      ...(renewalStatus ? { renewalStatus } : {}),
    },
    include: { capturedBy: { select: { firstName: true, lastName: true } } },
    orderBy: { expiresAt: 'asc' },
    take: 20000,
  });

  await audit.record(req, {
    action: audit.ACTIONS.EXPORT_APPLICATIONS,
    entityType: 'Application',
    details: `Exported ${applications.length} registration(s) due for re-verification`,
  });

  const csv = exportFormat.applicationsCsv(applications);
  const name = exportFormat.filename('indigent-renewals', (renewalStatus || 'all').toLowerCase());

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(csv);
}, 'export renewals csv'));

module.exports = router;
