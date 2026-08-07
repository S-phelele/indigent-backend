/**
 * Eligibility rules.
 *
 * Previously the qualifying threshold lived in a code comment and in landing-page
 * copy, and nothing ever compared it against the income the applicant actually
 * declared. `incomeBelowThreshold` is a self-declared tick box, while
 * `totalHouseholdIncome` is computed from the five income components — so an
 * applicant could tick "R4 200 or less" alongside R8 000 of declared income and
 * reach the review queue looking clean.
 *
 * This module is the single place those rules live. It only ever *reports*; it
 * never blocks a submission. A household that is over the threshold may still
 * have grounds to apply, and that judgement belongs to a municipal official —
 * but the official must be able to see the conflict.
 */

/** Monthly gross household income at or below which a household qualifies. */
const INCOME_THRESHOLD = Number(process.env.INCOME_THRESHOLD || 4200);

/** The figure quoted publicly for "you may qualify" guidance. */
const INCOME_GUIDANCE_CEILING = Number(process.env.INCOME_GUIDANCE_CEILING || 7500);

const SEVERITY = { INFO: 'INFO', WARNING: 'WARNING' };

const toNumber = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Assess one application against the rules.
 * Returns a plain object safe to embed in an API response.
 */
function assess(application, { threshold = INCOME_THRESHOLD } = {}) {
  const declared = application?.incomeBelowThreshold ?? null;
  const computed = toNumber(application?.totalHouseholdIncome);
  const perPerson = toNumber(application?.totalIncomePerPerson);

  // The threshold that applied when this was submitted, if it was recorded, so a
  // later change to the municipal figure does not retroactively rewrite history.
  const appliedThreshold = toNumber(application?.incomeThresholdApplied) ?? threshold;

  const flags = [];
  let meetsIncomeTest = null;

  if (computed !== null) {
    meetsIncomeTest = computed <= appliedThreshold;

    if (declared !== null && declared !== meetsIncomeTest) {
      flags.push({
        code: 'INCOME_DECLARATION_MISMATCH',
        severity: SEVERITY.WARNING,
        message: declared
          ? `Applicant declared their income is R${appliedThreshold.toLocaleString('en-ZA')} or less, but the income captured totals R${computed.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}.`
          : `Applicant declared their income is above R${appliedThreshold.toLocaleString('en-ZA')}, but the income captured totals only R${computed.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}.`,
      });
    }

    if (!meetsIncomeTest) {
      flags.push({
        code: 'ABOVE_INCOME_THRESHOLD',
        severity: SEVERITY.WARNING,
        message: `Household income of R${computed.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} exceeds the R${appliedThreshold.toLocaleString('en-ZA')} threshold.`,
      });
    }
  } else if (declared !== null) {
    flags.push({
      code: 'NO_INCOME_CAPTURED',
      severity: SEVERITY.INFO,
      message: 'The applicant answered the income question but no income figures were captured.',
    });
  }

  if (application?.isFullTimeOccupant === false) {
    flags.push({
      code: 'NOT_FULL_TIME_OCCUPANT',
      severity: SEVERITY.WARNING,
      message: 'Applicant is not a full-time occupant of the property.',
    });
  }

  if (application?.ownsImmovableProperty === false) {
    flags.push({
      code: 'NO_IMMOVABLE_PROPERTY',
      severity: SEVERITY.INFO,
      message: 'Applicant does not own immovable property in or out of the municipal area.',
    });
  }

  // A household of zero people would make the per-person figure meaningless.
  const people = application?.peopleOnProperty;
  if (computed !== null && computed > 0 && (people === null || people === undefined || people < 1)) {
    flags.push({
      code: 'HOUSEHOLD_SIZE_MISSING',
      severity: SEVERITY.INFO,
      message: 'Income was captured but the number of people on the property was not.',
    });
  }

  return {
    threshold: appliedThreshold,
    guidanceCeiling: INCOME_GUIDANCE_CEILING,
    declaredBelowThreshold: declared,
    computedHouseholdIncome: computed,
    computedIncomePerPerson: perPerson,
    meetsIncomeTest,
    // Anything a reviewer should look at before deciding.
    requiresReview: flags.some((f) => f.severity === SEVERITY.WARNING),
    flags,
  };
}

module.exports = { assess, INCOME_THRESHOLD, INCOME_GUIDANCE_CEILING, SEVERITY };
