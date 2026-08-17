const income = require('./income');

/**
 * Which applications a report covers.
 *
 * Reports were whole-register only: every application, every ward, since the
 * beginning. That answers almost no question a municipality actually has —
 * "how many disabled households in ward 12 were approved this quarter" is the
 * shape of a real request, and it was unanswerable without exporting
 * everything and pivoting it by hand.
 *
 * ## One definition, two outputs
 *
 * The Excel workbook and the printable report are built from the same rows, so
 * the two cannot disagree about a figure — the failure that makes an exported
 * report worse than no report. These filters sit in front of that single
 * gathering point rather than being applied twice.
 *
 * ## The filters travel with the numbers
 *
 * `describe()` produces the list printed on the report. A statistic without its
 * criteria is not a statistic: "1 204 households" means nothing if the reader
 * cannot tell whether that is this ward or all of them, this year or ever.
 */

const STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'DECLINED'];
const STAGES = ['VERIFICATION', 'ASSESSMENT', 'SUPERVISOR_SIGNOFF', 'COMPLETE'];
const CATEGORIES = ['STANDARD', 'PENSIONER', 'DECEASED_ESTATE', 'CHILD_HEADED', 'DISABLED'];
const TENURES = ['OWNER', 'TENANT', 'OCCUPIER'];
const RENEWAL_STATUSES = ['ACTIVE', 'DUE_SOON', 'OVERDUE', 'LAPSED'];
/** captureChannel is a plain string column, not an enum. These are the values
 *  fieldwork.js and the wizard actually write. */
const CHANNELS = ['SELF', 'COUNCILLOR', 'ADMIN'];

/**
 * Household size bands.
 *
 * Bands rather than an exact number because that is how the question is asked —
 * "how many large households" — and because a per-size breakdown of a register
 * with a few thousand rows is mostly noise.
 */
const SIZE_BANDS = {
  '1': { label: 'One person', min: 1, max: 1 },
  '2-3': { label: 'Two to three', min: 2, max: 3 },
  '4-6': { label: 'Four to six', min: 4, max: 6 },
  '7+': { label: 'Seven or more', min: 7, max: null },
};

/**
 * Disability, with three states rather than two.
 *
 * `null` means the Washington Group questions were never asked, which is not
 * the same as "no disability" and must never be counted as it. That distinction
 * is the whole reason the column is nullable.
 */
const DISABILITY = {
  yes: { label: 'With a disability', where: { hasDisability: true } },
  no: { label: 'Without a disability', where: { hasDisability: false } },
  unknown: { label: 'Not asked about disability', where: { hasDisability: null } },
};

const oneOf = (value, allowed) => {
  const v = String(value ?? '').toUpperCase();
  return allowed.includes(v) ? v : null;
};

const asDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Read a query string into a Prisma `where` and a description of itself.
 *
 * Unrecognised values are dropped rather than refused: a report that quietly
 * covers more than asked is bad, but a report that 400s because somebody
 * bookmarked a stale ward name is worse. Every filter that *was* applied
 * appears in `describe()`, so what the numbers cover is never in doubt.
 */
function parse(query = {}) {
  const applied = [];
  const where = {};

  // --- Where -----------------------------------------------------------
  const ward = String(query.ward ?? '').trim();
  if (ward && ward.toLowerCase() !== 'all') {
    where.wardNumber = ward;
    applied.push({ label: 'Ward', value: ward });
  } else {
    applied.push({ label: 'Area', value: 'All wards' });
  }

  // --- What state ------------------------------------------------------
  const status = oneOf(query.status, STATUSES);
  if (status) {
    where.status = status;
    applied.push({ label: 'Status', value: status.toLowerCase() });
  }

  const stage = oneOf(query.stage, STAGES);
  if (stage) {
    where.approvalStage = stage;
    applied.push({ label: 'Approval stage', value: stage.replace(/_/g, ' ').toLowerCase() });
  }

  // --- When ------------------------------------------------------------
  /**
   * Dated on submission or on decision, and the caller says which.
   *
   * "Approved this quarter" and "submitted this quarter" are different
   * questions with different answers, and a report that silently picks one is
   * misleading in a way nobody can see.
   */
  const dateField = String(query.dateField ?? 'submitted').toLowerCase() === 'decided'
    ? 'reviewedAt'
    : 'submittedAt';
  const from = asDate(query.from);
  const to = asDate(query.to);

  if (from || to) {
    where[dateField] = {
      ...(from ? { gte: from } : {}),
      // Inclusive of the closing day: somebody asking for a range ending on the
      // 31st means the whole of the 31st.
      ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
    };
    applied.push({
      label: dateField === 'reviewedAt' ? 'Decided between' : 'Submitted between',
      value: `${from ? from.toISOString().slice(0, 10) : 'the beginning'} and ${to ? to.toISOString().slice(0, 10) : 'today'}`,
    });
  }

  // --- Who -------------------------------------------------------------
  const disability = DISABILITY[String(query.disability ?? '').toLowerCase()];
  if (disability) {
    Object.assign(where, disability.where);
    applied.push({ label: 'Disability', value: disability.label.toLowerCase() });
  }

  const category = oneOf(query.category, CATEGORIES);
  if (category) {
    where.applicantCategory = category;
    applied.push({ label: 'Category', value: category.replace(/_/g, ' ').toLowerCase() });
  }

  const tenure = oneOf(query.tenure, TENURES);
  if (tenure) {
    where.tenure = tenure;
    applied.push({ label: 'Tenure', value: tenure.toLowerCase() });
  }

  const band = SIZE_BANDS[String(query.householdSize ?? '')];
  if (band) {
    where.peopleOnProperty = { gte: band.min, ...(band.max ? { lte: band.max } : {}) };
    applied.push({ label: 'Household size', value: band.label.toLowerCase() });
  }

  // --- Money -----------------------------------------------------------
  /**
   * Households holding a given kind of income, or none at all.
   *
   * `none` is a filter in its own right rather than the absence of one: a
   * household that declared it has nothing is a different group from one whose
   * income section was never reached, and the register cares about the first.
   */
  const sourceType = String(query.incomeType ?? '').toUpperCase();
  if (sourceType === 'NONE') {
    where.declaredNoIncome = true;
    applied.push({ label: 'Income', value: 'declared none at all' });
  } else if (income.VALUES.includes(sourceType)) {
    where.incomeSources = { some: { type: sourceType } };
    applied.push({ label: 'Income includes', value: income.labelFor(sourceType).toLowerCase() });
  }

  // --- Who captured it -------------------------------------------------
  const capturedById = String(query.capturedById ?? '').trim();
  if (capturedById) {
    where.capturedById = capturedById;
    applied.push({ label: 'Captured by', value: 'one officer' });
  }

  const renewalStatus = oneOf(query.renewalStatus, RENEWAL_STATUSES);
  if (renewalStatus) {
    where.renewalStatus = renewalStatus;
    applied.push({ label: 'Renewal', value: renewalStatus.replace(/_/g, ' ').toLowerCase() });
  }

  const channel = oneOf(query.channel, CHANNELS);
  if (channel) {
    where.captureChannel = channel;
    applied.push({ label: 'Captured through', value: channel.replace(/_/g, ' ').toLowerCase() });
  }

  return { where, applied, dateField };
}

/**
 * The filters in force, as lines to print at the top of a report.
 *
 * Always non-empty: even an unfiltered report says "all wards", because a
 * reader must never have to guess whether a filter was applied and left
 * unstated.
 */
const describe = (parsed) => parsed.applied;

/** The options a client renders. Served so the portal cannot drift from the enum. */
function options() {
  return {
    statuses: STATUSES.map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() })),
    stages: STAGES.map((v) => ({ value: v, label: v.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) })),
    categories: CATEGORIES.map((v) => ({ value: v, label: v.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) })),
    tenures: TENURES.map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() })),
    channels: CHANNELS.map((v) => ({ value: v, label: v.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) })),
    householdSizes: Object.entries(SIZE_BANDS).map(([value, b]) => ({ value, label: b.label })),
    disability: Object.entries(DISABILITY).map(([value, d]) => ({ value, label: d.label })),
    incomeTypes: [
      { value: 'NONE', label: 'Declared no income at all' },
      ...income.TYPES.map((t) => ({ value: t.value, label: t.label })),
    ],
    renewalStatuses: RENEWAL_STATUSES.map((v) => ({ value: v, label: v.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) })),
    dateFields: [
      { value: 'submitted', label: 'Date submitted' },
      { value: 'decided', label: 'Date decided' },
    ],
  };
}

module.exports = { parse, describe, options, SIZE_BANDS, DISABILITY, STATUSES, STAGES, RENEWAL_STATUSES };
