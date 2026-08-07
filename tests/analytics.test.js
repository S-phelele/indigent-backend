const test = require('node:test');
const assert = require('node:assert/strict');

const analytics = require('../src/lib/analytics');

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

test('percentile picks by nearest rank', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(analytics.percentile(values, 50), 5);
  assert.equal(analytics.percentile(values, 90), 9);
  assert.equal(analytics.percentile(values, 100), 10);
});

test('percentile of nothing is null, not zero', () => {
  // Zero would render as "median turnaround: 0 days", which reads as excellent
  // performance rather than as no data.
  assert.equal(analytics.percentile([], 50), null);
});

test('the median resists one catastrophic outlier', () => {
  // The case this protects against: one application that sat for eight months
  // while a death certificate was chased drags the average into meaninglessness.
  const durations = [3, 4, 4, 5, 5, 6, 240];
  assert.equal(analytics.percentile(durations, 50), 5);
  assert.ok(analytics.mean(durations) > 30);
});

// ---------------------------------------------------------------------------
// Turnaround
// ---------------------------------------------------------------------------

test('turnaround measures submission to decision against the standard', () => {
  const decided = [
    { submittedAt: daysAgo(20), reviewedAt: daysAgo(18) }, // 2 days
    { submittedAt: daysAgo(30), reviewedAt: daysAgo(20) }, // 10 days
    { submittedAt: daysAgo(40), reviewedAt: daysAgo(10) }, // 30 days — breached
  ];
  const result = analytics.turnaround(decided, 14);

  assert.equal(result.decided, 3);
  assert.equal(result.medianDays, 10);
  assert.equal(result.withinSla, 2);
  assert.equal(result.breached, 1);
  assert.equal(result.withinSlaPercent, 67);
  assert.equal(result.fastestDays, 2);
  assert.equal(result.slowestDays, 30);
});

test('turnaround ignores applications that were never submitted', () => {
  const result = analytics.turnaround(
    [{ submittedAt: null, reviewedAt: daysAgo(1) }, { submittedAt: daysAgo(5), reviewedAt: daysAgo(3) }],
    14
  );
  assert.equal(result.decided, 1);
});

test('turnaround with no decisions reports null rather than a misleading zero', () => {
  const result = analytics.turnaround([], 14);
  assert.equal(result.decided, 0);
  assert.equal(result.medianDays, null);
  assert.equal(result.withinSlaPercent, null);
});

test('a decision recorded before submission never produces a negative duration', () => {
  // Clock skew or a hand-corrected record should not read as "-3 days".
  const result = analytics.turnaround([{ submittedAt: daysAgo(2), reviewedAt: daysAgo(5) }], 14);
  assert.equal(result.medianDays, 0);
});

// ---------------------------------------------------------------------------
// Queue ageing
// ---------------------------------------------------------------------------

test('pending applications are bucketed by how long they have waited', () => {
  const pending = [
    { submittedAt: daysAgo(1) },
    { submittedAt: daysAgo(6) },
    { submittedAt: daysAgo(10) },
    { submittedAt: daysAgo(20) },
    { submittedAt: daysAgo(45) },
  ];
  const result = analytics.pendingAgeing(pending, 14);
  const bucket = (key) => result.buckets.find((b) => b.key === key).count;

  assert.equal(bucket('0-7'), 2);
  assert.equal(bucket('8-14'), 1);
  assert.equal(bucket('15-30'), 1);
  assert.equal(bucket('30+'), 1);
  assert.equal(result.overdue, 2, '20 and 45 days are past a 14-day standard');
  assert.equal(result.oldestDays, 45);
});

test('an empty queue is not reported as overdue', () => {
  const result = analytics.pendingAgeing([], 14);
  assert.equal(result.total, 0);
  assert.equal(result.overduePercent, 0);
  assert.equal(result.oldestDays, 0);
});

// ---------------------------------------------------------------------------
// Demographics
// ---------------------------------------------------------------------------

test('age and gender are derived from the ID number', () => {
  const applications = [
    { idNumber: '9202204720082' }, // sequence 4720 -> female
    { idNumber: '8801015800085' }, // sequence 5800 -> male
  ];
  const result = analytics.demographics(applications);

  const gender = Object.fromEntries(result.gender.map((g) => [g.key, g.count]));
  assert.equal(gender.FEMALE, 1);
  assert.equal(gender.MALE, 1);
  assert.equal(gender.UNKNOWN, 0);
  assert.equal(result.unknownAge, 0);
});

test('an unusable ID number is counted as unknown, never guessed', () => {
  const result = analytics.demographics([
    { idNumber: null },
    { idNumber: 'not-an-id' },
    { idNumber: '9902301234' }, // too short
  ]);
  assert.equal(result.unknownAge, 3);
  assert.equal(result.gender.find((g) => g.key === 'UNKNOWN').count, 3);
  assert.equal(result.medianAge, null);
});

test('age bands cover every adult age without gaps or overlaps', () => {
  const bands = analytics.AGE_BANDS;
  for (let i = 1; i < bands.length; i += 1) {
    assert.equal(bands[i].min, bands[i - 1].max + 1, `gap between ${bands[i - 1].key} and ${bands[i].key}`);
  }
});

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

test('income handles Prisma Decimal columns arriving as strings', () => {
  // Prisma serialises Decimal to a string. Comparing those as text would sort
  // "9000" below "10000" and quietly misreport who is above the threshold.
  const result = analytics.income(
    [{ totalHouseholdIncome: '9000.00' }, { totalHouseholdIncome: '10000.00' }],
    4200
  );
  assert.equal(result.aboveThreshold, 2);
  assert.equal(result.medianIncome, 9000);
});

test('income counts declarations above the qualifying threshold', () => {
  const result = analytics.income(
    [
      { totalHouseholdIncome: 0 },
      { totalHouseholdIncome: 1500 },
      { totalHouseholdIncome: 4000 },
      { totalHouseholdIncome: 8000 },
    ],
    4200
  );
  assert.equal(result.recorded, 4);
  assert.equal(result.aboveThreshold, 1);
  assert.equal(result.aboveThresholdPercent, 25);
  assert.equal(result.bands.find((b) => b.key === 'none').count, 1);
});

test('applications with no income declared are excluded from the median', () => {
  const result = analytics.income(
    [{ totalHouseholdIncome: null }, { totalHouseholdIncome: 2000 }, { totalHouseholdIncome: undefined }],
    4200
  );
  assert.equal(result.recorded, 1);
  assert.equal(result.medianIncome, 2000);
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

test('channels compare self-service against assisted capture', () => {
  const result = analytics.channels([
    { captureChannel: 'SELF', status: 'APPROVED' },
    { captureChannel: 'SELF', status: 'DECLINED' },
    { captureChannel: 'COUNCILLOR', status: 'APPROVED' },
    { captureChannel: 'COUNCILLOR', status: 'APPROVED' },
    { captureChannel: 'COUNCILLOR', status: 'PENDING' },
    { captureChannel: 'COUNCILLOR', status: 'DRAFT' },
  ]);

  const councillor = result.find((c) => c.key === 'COUNCILLOR');
  assert.equal(councillor.total, 4);
  assert.equal(councillor.approved, 2);
  assert.equal(councillor.pending, 1);
  assert.equal(councillor.draft, 1);
  assert.equal(councillor.approvalRate, 100, 'of the decided ones');

  const self = result.find((c) => c.key === 'SELF');
  assert.equal(self.approvalRate, 50);
});

test('an application with no recorded channel counts as self-service', () => {
  // Everything predating the councillor feature was somebody applying themselves.
  const result = analytics.channels([{ captureChannel: null, status: 'APPROVED' }]);
  assert.equal(result[0].key, 'SELF');
});

test('a channel with no decisions reports a null approval rate, not zero', () => {
  const result = analytics.channels([{ captureChannel: 'COUNCILLOR', status: 'PENDING' }]);
  assert.equal(result[0].approvalRate, null);
});

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

test('suburb is taken from a geocoded address, never from free text', () => {
  assert.equal(
    analytics.suburbFrom({ addressFormatted: '12 Vilakazi Street, Orlando West, Soweto, Gauteng, South Africa' }),
    'Orlando West'
  );
  // Hand-typed addresses have no reliable structure, so nothing is guessed.
  assert.equal(analytics.suburbFrom({ residentialAddress: '12 Vilakazi Street Soweto' }), null);
  assert.equal(analytics.suburbFrom({ addressFormatted: 'Soweto' }), null);
});

test('geography ranks wards and counts what has no address at all', () => {
  const result = analytics.geography([
    { capturedWard: 'Ward 12', addressFormatted: 'A, Orlando West, Soweto', addressLatitude: -26.2 },
    { capturedWard: 'Ward 12', addressFormatted: 'B, Orlando West, Soweto', addressLatitude: null },
    { capturedWard: 'Ward 3', residentialAddress: 'somewhere', addressLatitude: null },
    { capturedWard: null, residentialAddress: null, addressFormatted: null, addressLatitude: null },
  ]);

  assert.deepEqual(result.wards[0], { name: 'Ward 12', count: 2 });
  assert.deepEqual(result.suburbs[0], { name: 'Orlando West', count: 2 });
  assert.equal(result.withCoordinates, 1);
  assert.equal(result.withoutAddress, 1);
});

// ---------------------------------------------------------------------------
// Documents and funnel
// ---------------------------------------------------------------------------

test('document bottlenecks rank by what is holding applications up', () => {
  const result = analytics.documentBottlenecks([
    { name: 'ID Copy', type: 'ID_COPY', status: 'Uploaded' },
    { name: 'ID Copy', type: 'ID_COPY', status: 'Rejected' },
    { name: 'Affidavit', type: 'AFFIDAVIT', status: 'Pending' },
    { name: 'Affidavit', type: 'AFFIDAVIT', status: 'Pending' },
    { name: 'Affidavit', type: 'AFFIDAVIT', status: 'Pending' },
  ]);

  assert.equal(result[0].name, 'Affidavit');
  assert.equal(result[0].outstanding, 3);

  const idCopy = result.find((r) => r.name === 'ID Copy');
  // Uploaded then refused signals unclear guidance, not a missing document.
  assert.equal(idCopy.rejectionRate, 50);
});

test('a slot nobody has attempted has a null rejection rate', () => {
  const result = analytics.documentBottlenecks([{ name: 'Affidavit', type: 'AFFIDAVIT', status: 'Pending' }]);
  assert.equal(result[0].rejectionRate, null);
});

test('the funnel shows where people are lost', () => {
  const steps = analytics.funnel({ registered: 100, started: 80, submitted: 60, decided: 50, approved: 40 });

  assert.equal(steps[0].dropFromPrevious, null, 'nothing precedes registration');
  assert.equal(steps[1].dropFromPrevious, 20, 'arrived, met the form, left');
  assert.equal(steps[1].percentOfStart, 80);
  assert.equal(steps[4].percentOfStart, 40);
});

test('an empty register does not divide by zero', () => {
  const steps = analytics.funnel({ registered: 0, started: 0, submitted: 0, decided: 0, approved: 0 });
  assert.ok(steps.every((s) => s.percentOfStart === 0));
});

// ---------------------------------------------------------------------------
// Councillor performance
// ---------------------------------------------------------------------------

test('councillor performance counts captures and their outcomes', () => {
  const councillors = [
    { id: 'c1', firstName: 'Thandi', lastName: 'Dlamini', ward: 'Ward 12', isActive: true },
    { id: 'c2', firstName: 'Sipho', lastName: 'Nkosi', ward: 'Ward 3', isActive: false, email: 's@x.gov.za' },
  ];
  const applications = [
    { capturedById: 'c1', status: 'APPROVED' },
    { capturedById: 'c1', status: 'APPROVED' },
    { capturedById: 'c1', status: 'DECLINED' },
    { capturedById: 'c1', status: 'DRAFT' },
    { capturedById: 'c2', status: 'PENDING' },
    { capturedById: null, status: 'APPROVED' },
  ];

  const result = analytics.councillorPerformance(applications, councillors);

  assert.equal(result[0].name, 'Thandi Dlamini');
  assert.equal(result[0].captured, 4);
  assert.equal(result[0].submitted, 3);
  assert.equal(result[0].approvalRate, 67);
  assert.equal(result[0].unfinishedPercent, 25);

  const sipho = result.find((r) => r.id === 'c2');
  assert.equal(sipho.captured, 1);
  assert.equal(sipho.approvalRate, null, 'nothing decided yet');
});

test('a councillor who has captured nothing still appears, at zero', () => {
  const result = analytics.councillorPerformance([], [{ id: 'c1', firstName: 'New', lastName: 'Starter' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].captured, 0);
  assert.equal(result[0].unfinishedPercent, 0);
});
