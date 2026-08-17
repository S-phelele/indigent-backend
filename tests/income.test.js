const test = require('node:test');
const assert = require('node:assert/strict');

const income = require('../src/lib/income');

/**
 * The income questionnaire.
 *
 * The five columns this replaces could hold five kinds of income and no more.
 * Most of what is tested here is the thing that made them inadequate: a
 * household with two grants, or a pension and a lodger, or a business and piece
 * work on the side.
 */

const source = (type, monthlyAmount, extra = {}) => ({ type, monthlyAmount, ...extra });

// ---------------------------------------------------------------------------
// The types themselves
// ---------------------------------------------------------------------------

test('every type carries a label and a hint for the form to render', () => {
  for (const t of income.TYPES) {
    assert.ok(t.value, 'a type needs a value');
    assert.ok(t.label, `${t.value} needs a label`);
    assert.ok(t.hint, `${t.value} needs a hint`);
    assert.ok(Array.isArray(t.asks), `${t.value} needs an asks list`);
  }
});

test('every required field is one the type actually asks for', () => {
  for (const t of income.TYPES) {
    for (const field of t.required) {
      assert.ok(t.asks.includes(field), `${t.value} requires ${field} but never asks for it`);
    }
  }
});

test('the grants people actually receive are all offered', () => {
  for (const t of ['CHILD_GRANT', 'OLD_AGE_PENSION', 'DISABILITY_GRANT', 'FOSTER_CARE_GRANT', 'CARE_DEPENDENCY_GRANT']) {
    assert.ok(income.VALUES.includes(t), `${t} is missing`);
  }
});

test('a state old age grant and a private fund are different types', () => {
  assert.ok(income.VALUES.includes('OLD_AGE_PENSION'));
  assert.ok(income.VALUES.includes('RETIREMENT_FUND'));
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('an unknown type is refused, naming what is accepted', () => {
  const result = income.validate({ type: 'LOTTERY', monthlyAmount: 100 });
  assert.equal(result.valid, false);
  assert.match(result.reason, /SALARY/);
});

test('an amount is always required', () => {
  const result = income.validate({ type: 'CHILD_GRANT' });
  assert.equal(result.valid, false);
  assert.match(result.reason, /how much/i);
});

test('zero is a legitimate amount — a business can have a bad month', () => {
  const result = income.validate({ type: 'BUSINESS', monthlyAmount: 0, businessName: 'Spaza' });
  assert.equal(result.valid, true);
  assert.equal(result.data.monthlyAmount, 0);
});

test('a negative amount is refused', () => {
  const result = income.validate({ type: 'SALARY', monthlyAmount: -5, jobDescription: 'x' });
  assert.equal(result.valid, false);
});

test('salary must say what the work is, in the applicant\'s own terms', () => {
  const result = income.validate({ type: 'SALARY', monthlyAmount: 4000 });
  assert.equal(result.valid, false);
  assert.match(result.reason, /street vendor|what the work is/i);
});

test('a business must be named', () => {
  const result = income.validate({ type: 'BUSINESS', monthlyAmount: 900 });
  assert.equal(result.valid, false);
  assert.match(result.reason, /name of the business/i);
});

test('"something else" must say what it is', () => {
  const result = income.validate({ type: 'OTHER', monthlyAmount: 200 });
  assert.equal(result.valid, false);
  assert.match(result.reason, /what this income is/i);
});

test('a grant needs no follow-up questions', () => {
  const result = income.validate({ type: 'CHILD_GRANT', monthlyAmount: 530 });
  assert.equal(result.valid, true);
});

test('detail fields belonging to another type are dropped', () => {
  // A grant carrying a business name is a client bug; storing it would attach a
  // trading name to a record that has no business.
  const result = income.validate({
    type: 'CHILD_GRANT',
    monthlyAmount: 530,
    businessName: 'Should not survive',
    jobDescription: 'Nor this',
  });
  assert.equal(result.valid, true);
  assert.equal(result.data.businessName, null);
  assert.equal(result.data.jobDescription, null);
});

test('informal and registered are both recordable, and neither is assumed', () => {
  const informal = income.validate({ type: 'BUSINESS', monthlyAmount: 700, businessName: 'Spaza', isRegistered: false });
  const formal = income.validate({ type: 'BUSINESS', monthlyAmount: 700, businessName: 'Spaza', isRegistered: true });
  const unstated = income.validate({ type: 'BUSINESS', monthlyAmount: 700, businessName: 'Spaza' });

  assert.equal(informal.data.isRegistered, false);
  assert.equal(formal.data.isRegistered, true);
  assert.equal(unstated.data.isRegistered, null, 'not stated must not become false');
});

// ---------------------------------------------------------------------------
// Totals — the thing five columns could not do
// ---------------------------------------------------------------------------

test('two grants of the same kind both count', () => {
  const figures = income.totals([source('CHILD_GRANT', 530), source('CHILD_GRANT', 530)], { people: 1 });
  assert.equal(figures.total, 1060);
});

test('a pension, a grant and a lodger add up', () => {
  const figures = income.totals(
    [source('OLD_AGE_PENSION', 2090), source('CHILD_GRANT', 530), source('RENTAL', 800)],
    { people: 4 }
  );
  assert.equal(figures.total, 3420);
  assert.equal(figures.perPerson, 855);
});

test('household members\' own income is counted too', () => {
  const figures = income.totals([source('CHILD_GRANT', 530)], {
    people: 3,
    household: [{ monthlyIncome: 1500 }, { monthlyIncome: null }],
  });
  assert.equal(figures.total, 2030);
  assert.equal(figures.fromSources, 530);
  assert.equal(figures.fromMembers, 1500);
});

test('no sources at all totals zero rather than failing', () => {
  const figures = income.totals([], { people: 5 });
  assert.equal(figures.total, 0);
  assert.equal(figures.perPerson, 0);
});

test('a headcount of zero never divides by zero', () => {
  const figures = income.totals([source('SALARY', 1000)], { people: 0 });
  assert.equal(figures.perPerson, 1000);
});

test('amounts are rounded to cents, not left as binary fractions', () => {
  const figures = income.totals([source('SALARY', 1000.1), source('RENTAL', 0.2)], { people: 3 });
  assert.equal(figures.total, 1000.3);
  assert.equal(figures.perPerson, 333.43);
});

// ---------------------------------------------------------------------------
// Employment status, derived rather than asked
// ---------------------------------------------------------------------------

test('a salary makes somebody employed', () => {
  assert.equal(income.employmentStatusFor([source('SALARY', 5000)]), 'EMPLOYED');
});

test('working for yourself is self-employed, not unemployed', () => {
  assert.equal(income.employmentStatusFor([source('SELF_EMPLOYMENT', 900)]), 'SELF_EMPLOYED');
  assert.equal(income.employmentStatusFor([source('BUSINESS', 900)]), 'SELF_EMPLOYED');
});

test('what somebody does outranks what they receive', () => {
  // Plenty of employed people also hold a child grant. The job is the answer.
  const status = income.employmentStatusFor([source('CHILD_GRANT', 530), source('SALARY', 4000)]);
  assert.equal(status, 'EMPLOYED');
});

test('a pension makes somebody a pensioner', () => {
  assert.equal(income.employmentStatusFor([source('OLD_AGE_PENSION', 2090)]), 'PENSIONER');
  assert.equal(income.employmentStatusFor([source('RETIREMENT_FUND', 3000)]), 'PENSIONER');
});

test('grants alone are OTHER, not unemployed', () => {
  assert.equal(income.employmentStatusFor([source('CHILD_GRANT', 530)]), 'OTHER');
});

test('an explicit "nothing at all" is unemployed; silence is not', () => {
  assert.equal(income.employmentStatusFor([], { declaredNoIncome: true }), 'UNEMPLOYED');
  assert.equal(income.employmentStatusFor([], { declaredNoIncome: false }), null,
    'an unanswered section must not be recorded as unemployed');
});

// ---------------------------------------------------------------------------
// Answered — the distinction the old schema could not make
// ---------------------------------------------------------------------------

test('an empty list is not an answer', () => {
  assert.equal(income.answered([], { declaredNoIncome: false }), false);
});

test('declaring no income is an answer', () => {
  assert.equal(income.answered([], { declaredNoIncome: true }), true);
});

test('listing a source is an answer', () => {
  assert.equal(income.answered([source('CHILD_GRANT', 530)]), true);
});

// ---------------------------------------------------------------------------
// How it reads to a reviewer
// ---------------------------------------------------------------------------

test('a salary reads with the work and the employer', () => {
  const sentence = income.describe(source('SALARY', 4000, { jobDescription: 'Cleaner', employerName: 'Shoprite' }));
  assert.match(sentence, /Cleaner/);
  assert.match(sentence, /Shoprite/);
});

test('a business says whether it is registered', () => {
  const formal = income.describe(source('BUSINESS', 900, { businessName: 'Spaza', isRegistered: true }));
  const informal = income.describe(source('BUSINESS', 900, { businessName: 'Spaza', isRegistered: false }));
  assert.match(formal, /registered/);
  assert.match(informal, /informal/);
});

test('a grant reads as its own plain label', () => {
  assert.equal(income.describe(source('CHILD_GRANT', 530)), 'Child support grant');
});
