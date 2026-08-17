const analytics = require('./analytics');
const eligibility = require('./eligibility');

/**
 * The statistics report, as a set of named tables.
 *
 * One definition, two outputs. The Excel workbook writes each table to its own
 * sheet; the printable report renders the same tables as a document somebody can
 * save as PDF. Building both from one structure is the point — a council report
 * and a spreadsheet that disagree about the approval rate is worse than having
 * neither, and that is precisely what happens when the two are assembled apart.
 *
 * Every column declares its kind, so a count reaches Excel as a number, money as
 * money and a date as a date. Handing somebody a grid of text they must retype
 * before they can chart it is not an export.
 */

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

const humanise = (value) => (value == null || value === ''
  ? 'Not stated'
  : String(value).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()));

const tally = (items, pick) => items.reduce((acc, item) => {
  const key = pick(item);
  const bucket = key == null || key === '' ? 'Not stated' : key;
  acc[bucket] = (acc[bucket] || 0) + 1;
  return acc;
}, {});

/**
 * Build every table.
 *
 * `data` is what the analytics route already gathers, passed in rather than
 * queried again: this module does no database work, which keeps it testable and
 * keeps the report and the on-screen analytics reading from the same rows.
 */
function build({
  applications = [],
  documents = [],
  councillors = [],
  totalUsers = 0,
  usersWithApplication = 0,
  days = 30,
  generatedBy = null,
  municipality = process.env.MUNICIPALITY_NAME || null,
  /**
   * The criteria these numbers cover, printed at the top of the report.
   *
   * A statistic without its criteria is not a statistic: "1 204 households"
   * means nothing if the reader cannot tell whether that is one ward or all of
   * them, this quarter or since the register opened. Always present — an
   * unfiltered report still says "all wards" rather than saying nothing and
   * leaving the reader to assume.
   */
  filters = [],
} = {}) {
  const approved = applications.filter((a) => a.status === 'APPROVED');
  const declined = applications.filter((a) => a.status === 'DECLINED');
  const pending = applications.filter((a) => a.status === 'PENDING');
  const draft = applications.filter((a) => a.status === 'DRAFT');
  const decided = approved.length + declined.length;
  const submitted = applications.filter((a) => a.submittedAt);

  const threshold = Number(eligibility.INCOME_THRESHOLD);

  const turnaround = analytics.turnaround(applications);
  const ageing = analytics.pendingAgeing(pending);
  const demographics = analytics.demographics(applications);
  const households = analytics.households(applications);
  const income = analytics.income(applications, threshold);
  const channels = analytics.channels(applications);
  const geography = analytics.geography(applications);
  const bottlenecks = analytics.documentBottlenecks(documents);
  const funnel = analytics.funnel({
    registered: totalUsers,
    started: usersWithApplication,
    submitted: submitted.length,
    decided,
    approved: approved.length,
  });
  const performance = analytics.councillorPerformance(applications, councillors);
  const disability = analytics.disability(applications);

  const sections = [];

  // -------------------------------------------------------------------------
  sections.push({
    key: 'summary',
    name: 'Summary',
    title: 'Register summary',
    note: `Every application on the register as at ${new Date().toLocaleDateString('en-ZA')}.`,
    columns: [
      { key: 'Measure', label: 'Measure', width: 250 },
      { key: 'Value', label: 'Value', kind: 'number', width: 100 },
      { key: 'Note', label: 'What it means', width: 340 },
    ],
    rows: [
      { Measure: 'Applications on the register', Value: applications.length, Note: 'Every application, including drafts nobody submitted.' },
      { Measure: 'Submitted', Value: submitted.length, Note: 'Reached a municipal official for a decision.' },
      { Measure: 'Still being decided', Value: pending.length, Note: 'Somewhere in the approval chain now.' },
      { Measure: 'Approved', Value: approved.length, Note: 'Households currently entitled to relief.' },
      { Measure: 'Not approved', Value: declined.length, Note: 'Refused after assessment.' },
      { Measure: 'Never submitted', Value: draft.length, Note: 'Started and left. Removed after a year under the retention policy.' },
      { Measure: 'Approval rate (%)', Value: pct(approved.length, decided), Note: 'Of decided applications only. Pending ones are excluded.' },
      { Measure: 'People registered', Value: totalUsers, Note: 'Accounts on the applicant portal.' },
      { Measure: 'People who applied', Value: usersWithApplication, Note: 'Registered people who went on to start an application.' },
    ],
  });

  // -------------------------------------------------------------------------
  sections.push({
    key: 'turnaround',
    name: 'Turnaround',
    title: 'How long decisions take',
    note: 'Days from submission to decision. The median rather than the average: one application '
      + 'stuck for six months drags an average far more than it reflects the ordinary experience.',
    columns: [
      { key: 'Measure', label: 'Measure', width: 250 },
      { key: 'Days', label: 'Days', kind: 'number', width: 90 },
      { key: 'Note', label: 'What it means', width: 340 },
    ],
    rows: [
      { Measure: 'Median', Days: turnaround.medianDays, Note: 'Half were faster, half slower. The typical experience.' },
      { Measure: 'Average', Days: turnaround.averageDays, Note: 'Pulled upwards by a few very slow cases.' },
      { Measure: 'Slowest tenth (90th percentile)', Days: turnaround.p90Days, Note: 'What the worst-served households wait.' },
      { Measure: 'Fastest', Days: turnaround.fastestDays, Note: null },
      { Measure: 'Slowest', Days: turnaround.slowestDays, Note: null },
      { Measure: 'Decisions measured', Days: turnaround.decided, Note: 'Applications with both a submission and a decision date.' },
      { Measure: 'Met the service target', Days: turnaround.withinSla, Note: `${turnaround.withinSlaPercent ?? 0}% of decisions.` },
      { Measure: 'Missed the service target', Days: turnaround.breached, Note: 'Decided later than the target allows.' },
    ],
  });

  // -------------------------------------------------------------------------
  sections.push({
    key: 'ageing',
    name: 'Waiting now',
    title: 'How long the current queue has been waiting',
    note: `${ageing.total} application(s) awaiting a decision. The oldest has been waiting `
      + `${ageing.oldestDays ?? 0} days.`,
    columns: [
      { key: 'Waiting', label: 'Waiting', width: 170 },
      { key: 'Applications', label: 'Applications', kind: 'number', width: 120 },
      { key: 'Share', label: 'Share of queue (%)', kind: 'percent', width: 150 },
    ],
    rows: (ageing.buckets || []).map((bucket) => ({
      Waiting: bucket.label,
      Applications: bucket.count,
      Share: pct(bucket.count, ageing.total),
    })),
  });

  // -------------------------------------------------------------------------
  sections.push({
    key: 'outcomes',
    name: 'Outcomes',
    title: 'Outcomes by status',
    columns: [
      { key: 'Status', label: 'Status', width: 180 },
      { key: 'Count', label: 'Applications', kind: 'number', width: 120 },
      { key: 'Share', label: 'Share (%)', kind: 'percent', width: 110 },
    ],
    rows: [
      { Status: 'Approved', Count: approved.length, Share: pct(approved.length, applications.length) },
      { Status: 'Not approved', Count: declined.length, Share: pct(declined.length, applications.length) },
      { Status: 'Awaiting a decision', Count: pending.length, Share: pct(pending.length, applications.length) },
      { Status: 'Never submitted', Count: draft.length, Share: pct(draft.length, applications.length) },
    ],
  });

  // -------------------------------------------------------------------------
  sections.push({
    key: 'age',
    name: 'Age',
    title: 'Applicants by age',
    note: `Derived from ID numbers. Median age ${demographics.medianAge ?? 'not available'}. `
      + `${demographics.unknownAge} application(s) had no usable ID number.`,
    columns: [
      { key: 'Band', label: 'Age band', width: 160 },
      { key: 'Count', label: 'Applicants', kind: 'number', width: 120 },
      { key: 'Share', label: 'Share (%)', kind: 'percent', width: 110 },
    ],
    rows: (demographics.ageBands || []).map((band) => ({
      Band: band.label,
      Count: band.count,
      Share: pct(band.count, applications.length - demographics.unknownAge),
    })),
  });

  sections.push({
    key: 'sex',
    name: 'Sex',
    title: 'Applicants by sex',
    note: 'Taken from the ID number unless the applicant corrected it.',
    columns: [
      { key: 'Sex', label: 'Sex', width: 160 },
      { key: 'Count', label: 'Applicants', kind: 'number', width: 120 },
      { key: 'Share', label: 'Share (%)', kind: 'percent', width: 110 },
    ],
    rows: (demographics.gender || []).map((row) => ({
      Sex: row.label,
      Count: row.count,
      Share: pct(row.count, applications.length),
    })),
  });

  // -------------------------------------------------------------------------
  sections.push({
    key: 'disability',
    name: 'Functioning',
    title: 'Disability and functioning',
    note: 'From the Washington Group Short Set. A household counts as including a person with a '
      + 'disability where the answer was "a lot of difficulty" or "cannot do at all" in at least one '
      + `domain — the Stats SA threshold. ${disability.withDisability} of ${disability.answered} `
      + `who answered (${disability.percent}%).`,
    columns: [
      { key: 'Domain', label: 'Domain', width: 250 },
      { key: 'Count', label: 'Significant difficulty', kind: 'number', width: 170 },
      { key: 'Share', label: 'Share of those who answered (%)', kind: 'percent', width: 230 },
    ],
    rows: (disability.byDomain || []).map((domain) => ({
      Domain: domain.label,
      Count: domain.count,
      Share: pct(domain.count, disability.answered),
    })),
  });

  // -------------------------------------------------------------------------
  sections.push({
    key: 'households',
    name: 'Household size',
    title: 'Household size',
    note: `Median ${households.medianSize ?? 'not available'} people, average ${households.averageSize ?? 'not available'}. `
      + `${households.withChildren} household(s) include children under 18 and ${households.withPensioners} include a pensioner. `
      + `${households.totalPeople} people are covered in total.`,
    columns: [
      { key: 'Size', label: 'People on the property', width: 200 },
      { key: 'Count', label: 'Households', kind: 'number', width: 120 },
      { key: 'Share', label: 'Share (%)', kind: 'percent', width: 110 },
    ],
    rows: (households.bands || []).map((band) => ({
      Size: band.label,
      Count: band.count,
      Share: pct(band.count, households.recorded),
    })),
  });

  // -------------------------------------------------------------------------
  sections.push({
    key: 'income',
    name: 'Income',
    title: 'Declared household income',
    note: `Against the municipal threshold of R${threshold.toLocaleString('en-ZA')} a month. `
      + `Median R${Number(income.medianIncome || 0).toLocaleString('en-ZA')}. `
      + `${income.aboveThreshold} declared more than the threshold (${income.aboveThresholdPercent}%) — not necessarily `
      + 'wrong, since a large household is assessed per person, but it is the set a reviewer should look at.',
    columns: [
      { key: 'Band', label: 'Monthly household income', width: 220 },
      { key: 'Count', label: 'Households', kind: 'number', width: 120 },
      { key: 'Share', label: 'Share (%)', kind: 'percent', width: 110 },
    ],
    rows: (income.bands || []).map((band) => ({
      Band: band.label,
      Count: band.count,
      Share: pct(band.count, income.recorded),
    })),
  });

  // -------------------------------------------------------------------------
  sections.push({
    key: 'wards',
    name: 'By ward',
    title: 'Applications by ward',
    note: `${geography.withCoordinates} application(s) have a captured location. `
      + `${geography.withoutAddress} have no address at all.`,
    columns: [
      { key: 'Ward', label: 'Ward', width: 220 },
      { key: 'Count', label: 'Applications', kind: 'number', width: 120 },
    ],
    rows: (geography.wards || []).map((ward) => ({ Ward: ward.name, Count: ward.count })),
  });

  if ((geography.suburbs || []).length) {
    sections.push({
      key: 'suburbs',
      name: 'By suburb',
      title: 'Applications by suburb',
      note: 'Read from the address where no ward was recorded.',
      columns: [
        { key: 'Suburb', label: 'Suburb', width: 220 },
        { key: 'Count', label: 'Applications', kind: 'number', width: 120 },
      ],
      rows: geography.suburbs.map((s) => ({ Suburb: s.name, Count: s.count })),
    });
  }

  // -------------------------------------------------------------------------
  sections.push({
    key: 'channels',
    name: 'How they applied',
    title: 'How applications reached the municipality',
    note: 'Door-to-door capture against people applying for themselves. The split shows whether the '
      + 'field programme is reaching households the portal does not.',
    columns: [
      { key: 'Channel', label: 'Channel', width: 200 },
      { key: 'Total', label: 'Applications', kind: 'number', width: 120 },
      { key: 'Approved', label: 'Approved', kind: 'number', width: 110 },
      { key: 'Declined', label: 'Not approved', kind: 'number', width: 120 },
      { key: 'Pending', label: 'Awaiting', kind: 'number', width: 110 },
      { key: 'Rate', label: 'Approval rate (%)', kind: 'percent', width: 150 },
    ],
    rows: (channels || []).map((row) => ({
      Channel: humanise(row.label || row.key),
      Total: row.total,
      Approved: row.approved,
      Declined: row.declined,
      Pending: row.pending,
      Rate: row.approvalRate,
    })),
  });

  // -------------------------------------------------------------------------
  sections.push({
    key: 'documents',
    name: 'Missing documents',
    title: 'What is holding applications up',
    note: 'Outstanding documents on applications not yet decided. The top row is where a reminder '
      + 'campaign would clear the most cases.',
    columns: [
      { key: 'Document', label: 'Document', width: 240 },
      { key: 'Outstanding', label: 'Outstanding', kind: 'number', width: 120 },
      { key: 'Uploaded', label: 'Supplied', kind: 'number', width: 110 },
      { key: 'Rejected', label: 'Rejected', kind: 'number', width: 110 },
      { key: 'Required', label: 'Required?', width: 110 },
    ],
    rows: (bottlenecks || []).map((item) => ({
      Document: item.name,
      Outstanding: item.outstanding,
      Uploaded: item.uploaded,
      Rejected: item.rejected,
      Required: item.importance === 'REQUIRED' ? 'Required' : 'Optional',
    })),
  });

  // -------------------------------------------------------------------------
  sections.push({
    key: 'funnel',
    name: 'Drop-off',
    title: 'Where people give up',
    note: 'The largest fall is where the process is costing the municipality applications it wanted.',
    columns: [
      { key: 'Stage', label: 'Stage', width: 220 },
      { key: 'Count', label: 'People', kind: 'number', width: 110 },
      { key: 'OfStart', label: 'Share of registered (%)', kind: 'percent', width: 180 },
      { key: 'Lost', label: 'Lost since previous stage', kind: 'number', width: 190 },
    ],
    rows: (funnel || []).map((step) => ({
      Stage: step.label,
      Count: step.count,
      OfStart: step.percentOfStart,
      Lost: step.dropFromPrevious,
    })),
  });

  // -------------------------------------------------------------------------
  if ((performance || []).length) {
    sections.push({
      key: 'councillors',
      name: 'Field capture',
      title: 'Applications captured door to door',
      note: 'By the councillor who registered the household. An unfinished share well above the '
        + 'others usually means captures are being started at the gate and never completed.',
      columns: [
        { key: 'Officer', label: 'Officer', width: 200 },
        { key: 'Ward', label: 'Ward', width: 120 },
        { key: 'Captured', label: 'Captured', kind: 'number', width: 110 },
        { key: 'Submitted', label: 'Submitted', kind: 'number', width: 110 },
        { key: 'Approved', label: 'Approved', kind: 'number', width: 110 },
        { key: 'Rate', label: 'Approval rate (%)', kind: 'percent', width: 150 },
        { key: 'Unfinished', label: 'Left unfinished (%)', kind: 'percent', width: 160 },
      ],
      rows: performance.map((c) => ({
        Officer: c.name,
        Ward: c.ward || 'Not set',
        Captured: c.captured,
        Submitted: c.submitted,
        Approved: c.approved,
        Rate: c.approvalRate,
        Unfinished: c.unfinishedPercent,
      })),
    });
  }

  // -------------------------------------------------------------------------
  sections.push({
    key: 'employment',
    name: 'Employment',
    title: 'Employment status of applicants',
    columns: [
      { key: 'Category', label: 'Employment status', width: 220 },
      { key: 'Count', label: 'Applicants', kind: 'number', width: 120 },
      { key: 'Share', label: 'Share (%)', kind: 'percent', width: 110 },
    ],
    rows: Object.entries(tally(applications, (a) => a.employmentStatus))
      .map(([key, count]) => ({ Category: humanise(key), Count: count, Share: pct(count, applications.length) }))
      .sort((a, b) => b.Count - a.Count),
  });

  return {
    generatedAt: new Date(),
    generatedBy,
    municipality,
    periodDays: days,
    filters,
    headline: {
      applications: applications.length,
      approved: approved.length,
      declined: declined.length,
      pending: pending.length,
      approvalRate: pct(approved.length, decided),
      medianTurnaround: turnaround.medianDays,
      withinSlaPercent: turnaround.withinSlaPercent,
    },
    sections,
  };
}

/** Turn the report into the sheet definitions the workbook writer wants. */
/**
 * The workbook's sheets, with the criteria as the first one.
 *
 * A spreadsheet outlives the screen it was exported from and gets forwarded,
 * renamed and pasted into a council pack. Without the filters travelling inside
 * the file, a ward-level export is indistinguishable from a register-wide one
 * the moment it leaves the browser — and somebody will read it as the whole
 * municipality.
 */
const toSheets = (report) => [
  {
    name: 'Criteria',
    title: 'What these figures cover',
    note: `Generated ${new Date(report.generatedAt).toLocaleString('en-ZA')}`
      + `${report.generatedBy ? ` by ${report.generatedBy}` : ''}.`,
    columns: [{ key: 'label', label: 'Filter' }, { key: 'value', label: 'Applied' }],
    rows: (report.filters || []).map((f) => ({ label: f.label, value: f.value })),
  },
  ...report.sections.map((section) => ({
    name: section.name,
    title: section.title,
    note: section.note,
    columns: section.columns,
    rows: section.rows,
  })),
];

module.exports = { build, toSheets };
