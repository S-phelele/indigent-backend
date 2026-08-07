const test = require('node:test');
const assert = require('node:assert/strict');

const eligibility = require('../src/lib/eligibility');

/**
 * These rules decide who receives municipal support. They are the highest-value
 * thing in the codebase to protect against silent regression.
 */

const flagCodes = (result) => result.flags.map((f) => f.code);

test('flags a household that declares "below threshold" while declaring income above it', () => {
  const result = eligibility.assess({
    incomeBelowThreshold: true,
    totalHouseholdIncome: '8000',
    incomeThresholdApplied: '4200',
    peopleOnProperty: 4,
  });

  assert.equal(result.meetsIncomeTest, false);
  assert.ok(flagCodes(result).includes('INCOME_DECLARATION_MISMATCH'));
  assert.ok(flagCodes(result).includes('ABOVE_INCOME_THRESHOLD'));
  assert.equal(result.requiresReview, true);
});

test('does not flag a consistent qualifying household', () => {
  const result = eligibility.assess({
    incomeBelowThreshold: true,
    totalHouseholdIncome: '4000',
    incomeThresholdApplied: '4200',
    peopleOnProperty: 5,
    isFullTimeOccupant: true,
    ownsImmovableProperty: true,
  });

  assert.equal(result.meetsIncomeTest, true);
  assert.equal(result.requiresReview, false);
  assert.deepEqual(flagCodes(result), []);
});

test('income exactly at the threshold qualifies', () => {
  const result = eligibility.assess({
    incomeBelowThreshold: true,
    totalHouseholdIncome: '4200',
    incomeThresholdApplied: '4200',
    peopleOnProperty: 3,
  });

  assert.equal(result.meetsIncomeTest, true, 'the rule is "R4 200 or less", so the boundary qualifies');
  assert.equal(result.requiresReview, false);
});

test('one cent over the threshold does not qualify', () => {
  const result = eligibility.assess({
    incomeBelowThreshold: false,
    totalHouseholdIncome: '4200.01',
    incomeThresholdApplied: '4200',
    peopleOnProperty: 3,
  });

  assert.equal(result.meetsIncomeTest, false);
  assert.ok(flagCodes(result).includes('ABOVE_INCOME_THRESHOLD'));
  // Declared "above" and computed "above" agree, so no mismatch flag.
  assert.ok(!flagCodes(result).includes('INCOME_DECLARATION_MISMATCH'));
});

test('flags the inverse mismatch: declared above, computed below', () => {
  const result = eligibility.assess({
    incomeBelowThreshold: false,
    totalHouseholdIncome: '1200',
    incomeThresholdApplied: '4200',
    peopleOnProperty: 2,
  });

  assert.equal(result.meetsIncomeTest, true);
  assert.ok(flagCodes(result).includes('INCOME_DECLARATION_MISMATCH'));
});

test('uses the threshold frozen at submission, not the current one', () => {
  const result = eligibility.assess(
    { incomeBelowThreshold: true, totalHouseholdIncome: '5000', incomeThresholdApplied: '6000' },
    { threshold: 4200 } // current municipal figure, lower than the one applied
  );

  assert.equal(result.threshold, 6000);
  assert.equal(result.meetsIncomeTest, true, 'decided under the old, higher threshold');
});

test('falls back to the configured threshold when none was recorded', () => {
  const result = eligibility.assess(
    { incomeBelowThreshold: true, totalHouseholdIncome: '5000' },
    { threshold: 4200 }
  );

  assert.equal(result.threshold, 4200);
  assert.equal(result.meetsIncomeTest, false);
});

test('reports when the income question was answered but no figures captured', () => {
  const result = eligibility.assess({ incomeBelowThreshold: true, totalHouseholdIncome: null });

  assert.equal(result.meetsIncomeTest, null);
  assert.ok(flagCodes(result).includes('NO_INCOME_CAPTURED'));
});

test('flags an applicant who is not a full-time occupant', () => {
  const result = eligibility.assess({ isFullTimeOccupant: false });
  assert.ok(flagCodes(result).includes('NOT_FULL_TIME_OCCUPANT'));
  assert.equal(result.requiresReview, true);
});

test('flags income captured without a household size', () => {
  const result = eligibility.assess({
    totalHouseholdIncome: '3000',
    incomeThresholdApplied: '4200',
    peopleOnProperty: null,
  });
  assert.ok(flagCodes(result).includes('HOUSEHOLD_SIZE_MISSING'));
});

test('an empty application produces no warnings', () => {
  const result = eligibility.assess({});
  assert.equal(result.requiresReview, false);
  assert.equal(result.meetsIncomeTest, null);
});

test('handles Prisma Decimal values arriving as strings', () => {
  // Prisma serialises Decimal columns as strings; a naive comparison would
  // compare "8000" > 4200 lexically and get the wrong answer.
  const result = eligibility.assess({
    totalHouseholdIncome: '8000',
    incomeThresholdApplied: '4200',
    peopleOnProperty: 1,
  });
  assert.equal(result.computedHouseholdIncome, 8000);
  assert.equal(typeof result.computedHouseholdIncome, 'number');
  assert.equal(result.meetsIncomeTest, false);
});
