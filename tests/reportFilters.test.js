const test = require('node:test');
const assert = require('node:assert/strict');

const filters = require('../src/lib/reportFilters');

/**
 * Which applications a report covers.
 *
 * Reports were whole-register only, which answers almost no question a
 * municipality actually has. Most of what is protected here is that the
 * criteria travel with the numbers: a figure whose scope the reader cannot see
 * is worse than no figure, because it will be read as covering everything.
 */

const labels = (parsed) => parsed.applied.map((f) => f.label);
const valueFor = (parsed, label) => parsed.applied.find((f) => f.label === label)?.value;

// ---------------------------------------------------------------------------
// The criteria always travel
// ---------------------------------------------------------------------------

test('an unfiltered report still states its scope', () => {
  // Saying nothing would leave the reader to assume, and they will assume the
  // whole municipality.
  const parsed = filters.parse({});
  assert.ok(parsed.applied.length > 0);
  assert.equal(valueFor(parsed, 'Area'), 'All wards');
});

test('every filter applied appears in the description', () => {
  const parsed = filters.parse({ ward: '12', status: 'APPROVED', disability: 'yes' });
  assert.ok(labels(parsed).includes('Ward'));
  assert.ok(labels(parsed).includes('Status'));
  assert.ok(labels(parsed).includes('Disability'));
});

test('a filter that was dropped is not described as applied', () => {
  const parsed = filters.parse({ status: 'NONSENSE' });
  assert.equal(parsed.where.status, undefined);
  assert.ok(!labels(parsed).includes('Status'), 'a dropped filter must not be claimed');
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test('all wards means no ward condition at all', () => {
  for (const ward of ['', 'all', 'ALL', undefined]) {
    const parsed = filters.parse({ ward });
    assert.equal(parsed.where.wardNumber, undefined);
  }
});

test('one ward narrows to it', () => {
  const parsed = filters.parse({ ward: '12' });
  assert.equal(parsed.where.wardNumber, '12');
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test('submitted and decided are different questions', () => {
  const submitted = filters.parse({ from: '2026-01-01' });
  const decided = filters.parse({ from: '2026-01-01', dateField: 'decided' });

  assert.ok(submitted.where.submittedAt, 'defaults to date submitted');
  assert.ok(decided.where.reviewedAt, 'decided filters on the decision date');
  assert.equal(decided.where.submittedAt, undefined);
});

test('the description says which date was used', () => {
  assert.ok(labels(filters.parse({ from: '2026-01-01' })).includes('Submitted between'));
  assert.ok(labels(filters.parse({ from: '2026-01-01', dateField: 'decided' })).includes('Decided between'));
});

test('the closing day is included in full', () => {
  // Somebody asking for a range ending on the 31st means the whole of the 31st,
  // not midnight at its start — which would silently drop a day of decisions.
  const parsed = filters.parse({ to: '2026-03-31' });
  const end = parsed.where.submittedAt.lte;
  assert.equal(end.getHours(), 23);
  assert.equal(end.getMinutes(), 59);
});

test('an unparseable date is ignored rather than throwing', () => {
  const parsed = filters.parse({ from: 'not-a-date' });
  assert.equal(parsed.where.submittedAt, undefined);
});

// ---------------------------------------------------------------------------
// Disability: three states, not two
// ---------------------------------------------------------------------------

test('not-asked is its own filter, distinct from no-disability', () => {
  assert.equal(filters.parse({ disability: 'yes' }).where.hasDisability, true);
  assert.equal(filters.parse({ disability: 'no' }).where.hasDisability, false);
  assert.equal(filters.parse({ disability: 'unknown' }).where.hasDisability, null);
});

test('the three disability states are all offered to a client', () => {
  const values = filters.options().disability.map((d) => d.value);
  assert.deepEqual(values.sort(), ['no', 'unknown', 'yes']);
});

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

test('declaring no income is a filter, not the absence of one', () => {
  // A household that said it has nothing is a different group from one whose
  // income section was never reached, and the register cares about the first.
  const parsed = filters.parse({ incomeType: 'NONE' });
  assert.equal(parsed.where.declaredNoIncome, true);
  assert.equal(parsed.where.incomeSources, undefined);
});

test('a source type matches households holding any row of that type', () => {
  const parsed = filters.parse({ incomeType: 'OLD_AGE_PENSION' });
  assert.deepEqual(parsed.where.incomeSources, { some: { type: 'OLD_AGE_PENSION' } });
});

test('an unknown income type is dropped rather than matching nothing silently', () => {
  const parsed = filters.parse({ incomeType: 'LOTTERY' });
  assert.equal(parsed.where.incomeSources, undefined);
  assert.equal(parsed.where.declaredNoIncome, undefined);
});

// ---------------------------------------------------------------------------
// Household size
// ---------------------------------------------------------------------------

test('the largest band has no upper bound', () => {
  const parsed = filters.parse({ householdSize: '7+' });
  assert.equal(parsed.where.peopleOnProperty.gte, 7);
  assert.equal(parsed.where.peopleOnProperty.lte, undefined);
});

test('a band bounds both ends', () => {
  const parsed = filters.parse({ householdSize: '2-3' });
  assert.deepEqual(parsed.where.peopleOnProperty, { gte: 2, lte: 3 });
});

// ---------------------------------------------------------------------------
// The options a client renders
// ---------------------------------------------------------------------------

test('every filterable enum is offered, so the portal cannot drift from it', () => {
  const options = filters.options();
  for (const key of ['statuses', 'stages', 'categories', 'tenures', 'channels',
    'householdSizes', 'disability', 'incomeTypes', 'dateFields', 'renewalStatuses']) {
    assert.ok(Array.isArray(options[key]) && options[key].length > 0, `${key} is missing`);
  }
});

test('every offered status is one the parser will actually accept', () => {
  for (const option of filters.options().statuses) {
    assert.equal(filters.parse({ status: option.value }).where.status, option.value);
  }
});

test('every offered income type is one the parser will actually accept', () => {
  for (const option of filters.options().incomeTypes) {
    const parsed = filters.parse({ incomeType: option.value });
    const matched = parsed.where.declaredNoIncome === true || parsed.where.incomeSources !== undefined;
    assert.ok(matched, `${option.value} is offered but not accepted`);
  }
});

test('filters compose rather than overwriting each other', () => {
  const parsed = filters.parse({
    ward: '12', status: 'APPROVED', disability: 'yes',
    householdSize: '4-6', incomeType: 'CHILD_GRANT', from: '2026-01-01',
  });
  assert.equal(parsed.where.wardNumber, '12');
  assert.equal(parsed.where.status, 'APPROVED');
  assert.equal(parsed.where.hasDisability, true);
  assert.deepEqual(parsed.where.peopleOnProperty, { gte: 4, lte: 6 });
  assert.deepEqual(parsed.where.incomeSources, { some: { type: 'CHILD_GRANT' } });
  assert.ok(parsed.where.submittedAt);
});
