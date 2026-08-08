const prisma = require('./prisma');

/**
 * Field-level change tracking.
 *
 * The audit log records that somebody updated an application. This records what
 * was actually different. They are not the same question, and only the second
 * one answers the one an auditor asks: *was this household's income edited
 * after it was assessed, and by whom?*
 *
 * AGSA findings on indigent registers are common and they turn on exactly this
 * — a municipality that can show every change to every figure, with a name and
 * a timestamp against it, is in a very different position from one that can only
 * show the current value.
 *
 * ## What is not recorded
 *
 * Timestamps the system maintains itself, and the derived counters that follow
 * from other changes. Logging `updatedAt` on every write would bury the changes
 * that matter under ones nobody made.
 */

/** Columns the system maintains; a change to these is not somebody's edit. */
const IGNORED = new Set([
  'updatedAt', 'createdAt', 'id', 'userId',
  'currentStep', 'renewalNotifiedLevel', 'slaNotifiedLevel',
  'failedVisitCount', 'renewalStatus',
]);

/**
 * Fields worth watching closely.
 *
 * Everything is recorded, but these are the ones a review will actually ask
 * about, so they are marked for the interface to highlight.
 */
const SENSITIVE = new Set([
  'totalHouseholdIncome', 'totalIncomePerPerson', 'salary', 'oldAgePension',
  'disabilityPension', 'businessIncome', 'rentingIncome',
  'idNumber', 'assessedIncome', 'meansTestResult', 'status',
  'peopleOnProperty', 'incomeBelowThreshold', 'ownsOtherProperty',
  'municipalAccountNumber', 'expiresAt',
]);

/** Human labels, so a case history does not read like a column list. */
const LABELS = {
  totalHouseholdIncome: 'Total household income',
  totalIncomePerPerson: 'Income per person',
  salary: 'Salary',
  oldAgePension: 'Old age pension',
  disabilityPension: 'Disability pension',
  businessIncome: 'Business income',
  rentingIncome: 'Rental income',
  peopleOnProperty: 'People on the property',
  childrenUnder18: 'Children under 18',
  pensionersOver60: 'Pensioners over 60',
  idNumber: 'ID number',
  cellNumber: 'Cell number',
  residentialAddress: 'Residential address',
  postalAddress: 'Postal address',
  municipalAccountNumber: 'Municipal account number',
  eskomAccountNumber: 'Eskom account number',
  waterMeterNumber: 'Water meter number',
  electricityMeterNumber: 'Electricity meter number',
  tenure: 'Ownership',
  applicantCategory: 'Household category',
  employmentStatus: 'Employment status',
  maritalStatus: 'Marital status',
  status: 'Application status',
  approvalStage: 'Approval stage',
  meansTestResult: 'Means test result',
  assessedIncome: 'Assessed income',
  budgetConfirmed: 'Budget confirmed',
  expiresAt: 'Registration expires',
  ownsOtherProperty: 'Owns other property',
  incomeBelowThreshold: 'Income below threshold',
  consentSiteVisit: 'Consent to a site visit',
  consentDataMatching: 'Consent to data checks',
  declarationTruthful: 'Sworn declaration',
};

const labelFor = (field) => LABELS[field] || field
  .replace(/([A-Z])/g, ' $1')
  .replace(/^./, (c) => c.toUpperCase())
  .trim();

/**
 * Render a value as the string that will be stored and shown.
 *
 * Everything becomes text because these rows are read by a person reviewing a
 * case, not queried numerically. Prisma's Decimal arrives as an object, so it is
 * coerced rather than stringified into `[object Object]`.
 */
function present(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object' && typeof value.toString === 'function') return String(value);
  return String(value);
}

/** True when two values are the same as far as a reader is concerned. */
const same = (a, b) => present(a) === present(b);

/**
 * Work out what changed between two versions of an application.
 *
 * `next` is usually the update payload rather than a whole record, so only the
 * keys it carries are compared.
 */
function diff(before, next) {
  const changes = [];
  for (const [field, newValue] of Object.entries(next || {})) {
    if (IGNORED.has(field)) continue;
    if (!(field in before)) continue;
    if (same(before[field], newValue)) continue;

    changes.push({
      field,
      label: labelFor(field),
      oldValue: present(before[field]),
      newValue: present(newValue),
      sensitive: SENSITIVE.has(field),
    });
  }
  return changes;
}

/**
 * Record what changed.
 *
 * Never throws: a failure to write history must not turn a successful edit into
 * an error for the person who made it. Failures go to the console loudly,
 * because a silently broken audit trail is worse than a noisy one.
 */
async function record(applicationId, changes, { req, actor, stage } = {}, client = prisma) {
  if (!changes?.length) return 0;

  const who = actor || req?.user || null;
  const forwarded = req?.headers?.['x-forwarded-for'];
  const ip = typeof forwarded === 'string' && forwarded.length
    ? forwarded.split(',')[0].trim()
    : req?.ip || null;

  try {
    await client.fieldChange.createMany({
      data: changes.map((c) => ({
        applicationId,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        actorId: who?.id ?? null,
        actorName: [who?.firstName, who?.lastName].filter(Boolean).join(' ') || who?.email || null,
        actorRole: who?.role ?? null,
        atStage: stage ?? null,
        ipAddress: ip,
      })),
    });
    return changes.length;
  } catch (error) {
    console.error(`[changeLog] failed to record ${changes.length} change(s) on ${applicationId}:`, error.message);
    return 0;
  }
}

/**
 * Compare, then record, in one call.
 *
 * The common case at a route: you have the record as it was and the payload you
 * are about to write.
 */
async function track(applicationId, before, next, context = {}, client = prisma) {
  const changes = diff(before, next);
  await record(applicationId, changes, context, client);
  return changes;
}

/** The history for one application, newest first, grouped for display. */
async function history(applicationId, { limit = 200 } = {}, client = prisma) {
  const rows = await client.fieldChange.findMany({
    where: { applicationId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return rows.map((r) => ({
    ...r,
    label: labelFor(r.field),
    sensitive: SENSITIVE.has(r.field),
    /** A change made after assessment deserves a second look. */
    afterAssessment: ['SUPERVISOR_SIGNOFF', 'COMPLETE'].includes(r.atStage),
  }));
}

module.exports = { diff, record, track, history, labelFor, present, LABELS, SENSITIVE, IGNORED };
