const eligibility = require('./eligibility');

/**
 * The means test.
 *
 * The assessment officer's question: does this household fall under the
 * municipal income threshold?
 *
 * ## Why this is not a single comparison
 *
 * Two figures matter, and municipal policies differ on which governs:
 *
 *   - **Household gross income** against the threshold. Simple, and what most
 *     policies state.
 *   - **Income per person.** A household of nine on R7 000 has R778 a head; a
 *     person living alone on R7 000 has R7 000. Judging both by the household
 *     figure alone would refuse the family and approve the individual, which is
 *     the opposite of what the policy is for.
 *
 * So both are computed, the household figure is the primary test, and the
 * per-person figure is surfaced whenever it would change the answer. The
 * officer decides; this module makes sure they cannot decide without seeing the
 * number that matters.
 *
 * ## Verified income beats declared income
 *
 * Where verification found income the household did not declare, the assessment
 * uses the higher figure and says so. An assessment that quietly uses the
 * declaration when SARS said something different is not an assessment.
 */

/** The municipal threshold in force. Set INCOME_THRESHOLD in the environment. */
const THRESHOLD = Number(process.env.INCOME_THRESHOLD || eligibility.INCOME_THRESHOLD);

/**
 * Per-person figure below which a household qualifies regardless of its total.
 *
 * Defaults to the social grant level, because a household whose members each
 * live on less than an old age grant is indigent by any reading of the policy,
 * however many of them there are.
 */
const PER_PERSON_FLOOR = Number(process.env.INCOME_PER_PERSON_FLOOR || 2090);

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * Assess one application.
 *
 * Pure: takes the application and its checks, returns the finding. Persisting
 * the result and who decided it is the route's job.
 */
function assess(application, { checks = [], household = [], threshold = THRESHOLD } = {}) {
  const declared = num(application.totalHouseholdIncome) ?? 0;

  // Income any external check actually found, and where.
  const found = checks
    .filter((c) => num(c.amountFound) !== null)
    .map((c) => ({ source: c.source, amount: Number(c.amountFound) }));
  const highestFound = found.length ? Math.max(...found.map((f) => f.amount)) : null;

  // Household members' own income, which the declaration sometimes omits.
  const memberIncome = household.reduce((sum, m) => sum + (num(m.monthlyIncome) ?? 0), 0);

  /**
   * The figure the test runs against.
   *
   * The highest of what was declared, what was verified, and what the household
   * roll adds up to. Using anything lower would mean assessing a household on a
   * number we already know to be wrong.
   */
  const assessedIncome = Math.max(declared, highestFound ?? 0, memberIncome);

  const people = Math.max(1, application.peopleOnProperty || household.length + 1 || 1);
  const perPerson = Math.round((assessedIncome / people) * 100) / 100;

  const overThreshold = assessedIncome > threshold;
  const underPerPersonFloor = perPerson <= PER_PERSON_FLOOR;

  // Not enough to decide on. Better to say so than to pass a household on a
  // figure nobody supplied.
  const noIncomeInformation = declared === 0 && highestFound === null && memberIncome === 0
    && !application.employmentStatus;

  let result;
  if (noIncomeInformation) result = 'INSUFFICIENT_DATA';
  else if (!overThreshold) result = 'QUALIFIES';
  else result = 'ABOVE_THRESHOLD';

  const notes = [];

  if (highestFound !== null && highestFound > declared) {
    const source = found.find((f) => f.amount === highestFound)?.source;
    notes.push({
      severity: 'high',
      code: 'VERIFIED_ABOVE_DECLARED',
      message: `${source} showed R${highestFound.toLocaleString('en-ZA')} against a declared `
        + `R${declared.toLocaleString('en-ZA')}. The assessment uses the higher figure.`,
    });
  }

  if (memberIncome > declared) {
    notes.push({
      severity: 'medium',
      code: 'MEMBERS_ABOVE_DECLARED',
      message: `Household members' own income totals R${memberIncome.toLocaleString('en-ZA')}, `
        + `more than the R${declared.toLocaleString('en-ZA')} declared for the household.`,
    });
  }

  // The case the household figure alone gets wrong.
  if (overThreshold && underPerPersonFloor) {
    notes.push({
      severity: 'high',
      code: 'LARGE_HOUSEHOLD_UNDER_PER_PERSON',
      message: `Over the household threshold, but ${people} people share it — R${perPerson.toLocaleString('en-ZA')} `
        + `each, below the R${PER_PERSON_FLOOR.toLocaleString('en-ZA')} per-person level. `
        + 'Most policies allow approval on this basis; record your reasons if you do.',
    });
  }

  if (application.ownsOtherProperty) {
    notes.push({
      severity: 'medium',
      code: 'OTHER_PROPERTY',
      message: 'Another property was declared. Confirm it does not disqualify before approving.',
    });
  }

  if (!application.incomeEvidence) {
    notes.push({
      severity: 'low',
      code: 'NO_EVIDENCE_ROUTE',
      message: 'The household did not state which income evidence they were providing.',
    });
  }

  return {
    result,
    threshold,
    perPersonFloor: PER_PERSON_FLOOR,
    declaredIncome: declared,
    verifiedIncome: highestFound,
    memberIncome,
    assessedIncome,
    people,
    perPerson,
    overThreshold,
    /** How far over, so an officer can see whether it is R50 or R5 000. */
    marginOverThreshold: overThreshold ? Math.round((assessedIncome - threshold) * 100) / 100 : 0,
    underPerPersonFloor,
    notes,
    /**
     * What the arithmetic alone would say. Deliberately called a suggestion:
     * the officer decides, and a household can qualify on grounds a formula
     * cannot see.
     */
    suggestion: result === 'QUALIFIES'
      ? 'APPROVE'
      : result === 'ABOVE_THRESHOLD' && underPerPersonFloor
        ? 'APPROVE'
        : result === 'INSUFFICIENT_DATA'
          ? 'RETURN'
          : 'REJECT',
  };
}

/** A sentence explaining the finding, for a case file or a printed form. */
function explain(finding) {
  const money = (n) => `R${Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;

  if (finding.result === 'INSUFFICIENT_DATA') {
    return 'No income information was supplied, so the means test could not be completed.';
  }

  const base = `Assessed household income ${money(finding.assessedIncome)} a month across `
    + `${finding.people} ${finding.people === 1 ? 'person' : 'people'} `
    + `(${money(finding.perPerson)} each), against a threshold of ${money(finding.threshold)}.`;

  if (!finding.overThreshold) return `${base} The household falls under the threshold and qualifies.`;
  if (finding.underPerPersonFloor) {
    return `${base} The household is over the threshold in total, but under the per-person level of `
      + `${money(finding.perPersonFloor)}.`;
  }
  return `${base} The household is ${money(finding.marginOverThreshold)} over the threshold.`;
}

module.exports = { assess, explain, THRESHOLD, PER_PERSON_FLOOR };
